// The Workspace tab's pure parts: layout math for 1-4 panes and both splits, focus movement, zoom, layout tabs
// (save and restore), the sidebar's rows and lines, the pane title bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTheme, width } from "../src/tui/draw.mjs";
import { COMPACT_W, MAX_PANES, SIDE_W, addTab, agentShort, closeTab, compose, cornerOf, ctxPct, cycleFocus, inner, moveSel, neighbor, normWorkspace, paneAt, paneBlock, paneHeader, paneParts, paneRects, placeRef, pruneTabs, removePane, saveWorkspace, sideWidth, sidebarLines, sidebarRows, slimOrder, slimRows, slimWanted, statusRole, toggleZoom, topLine, wsHit } from "../src/tui/workspace.mjs";

setTheme("mono");
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const SIZES = [[178, 50], [78, 25], [101, 31], [40, 12]];

test("paneRects tiles the area exactly for 1-4 panes, both splits, several sizes", () => {
  for (const [w, h] of SIZES) for (const split of ["v", "h"]) for (let n = 1; n <= MAX_PANES; n++) {
    const rs = paneRects(n, w, h, { split });
    assert.equal(rs.length, n);
    const cells = new Uint8Array(w * h);
    for (const r of rs) {
      assert.ok(r.w >= 1 && r.h >= 1 && r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h, JSON.stringify({ n, split, w, h, r }));
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) cells[y * w + x]++;
    }
    assert.ok(cells.every((c) => c === 1), `n=${n} ${split} ${w}x${h}: every cell in exactly one pane`);
  }
});

test("paneRects: the shapes (1 full, 2 side by side or stacked, 3 big + two stacked, 4 a 2x2 grid)", () => {
  assert.deepEqual(paneRects(1, 100, 40), [{ x: 0, y: 0, w: 100, h: 40 }]);
  assert.deepEqual(paneRects(2, 100, 40), [{ x: 0, y: 0, w: 50, h: 40 }, { x: 50, y: 0, w: 50, h: 40 }]);
  assert.deepEqual(paneRects(2, 100, 40, { split: "h" }), [{ x: 0, y: 0, w: 100, h: 20 }, { x: 0, y: 20, w: 100, h: 20 }]);
  assert.deepEqual(paneRects(3, 101, 41), [{ x: 0, y: 0, w: 51, h: 41 }, { x: 51, y: 0, w: 50, h: 21 }, { x: 51, y: 21, w: 50, h: 20 }]);
  const four = paneRects(4, 100, 40);
  assert.deepEqual(four.map((r) => [r.x, r.y]), [[0, 0], [50, 0], [0, 20], [50, 20]]);
  assert.deepEqual(paneRects(0, 100, 40), []);
  assert.equal(paneRects(9, 100, 40).length, 4);
  assert.deepEqual(inner({ x: 10, y: 5, w: 20, h: 8 }), { x: 11, y: 6, w: 18, h: 6 });
});

test("zoom: the zoomed pane takes the whole area, the others are hidden", () => {
  const rs = paneRects(4, 120, 40, { zoom: 2 });
  assert.deepEqual(rs, [null, null, { x: 0, y: 0, w: 120, h: 40 }, null]);
  assert.equal(paneRects(2, 120, 40, { zoom: 5 }).filter(Boolean).length, 2); // a stale zoom is ignored
  const t = toggleZoom({ panes: [{ kind: "map" }, { kind: "map" }], focus: 1, zoom: null, split: "v" });
  assert.equal(t.zoom, 1);
  assert.equal(toggleZoom(t).zoom, null);
  assert.equal(cycleFocus(t, 1).zoom, 0, "the zoom follows the focus");
});

test("focus moves by direction (left of the leftmost: -1, the sidebar), and o cycles", () => {
  const four = paneRects(4, 100, 40);
  assert.equal(neighbor(four, 0, "right"), 1);
  assert.equal(neighbor(four, 0, "down"), 2);
  assert.equal(neighbor(four, 3, "left"), 2);
  assert.equal(neighbor(four, 3, "up"), 1);
  assert.equal(neighbor(four, 0, "left"), -1);
  assert.equal(neighbor(four, 0, "up"), -1);
  const three = paneRects(3, 100, 40);
  assert.equal(neighbor(three, 0, "right"), 1, "the big pane goes to the top one of the stack");
  assert.equal(neighbor(three, 2, "left"), 0);
  assert.equal(neighbor(three, 1, "down"), 2);
  const zoomed = paneRects(3, 100, 40, { zoom: 1 });
  assert.equal(neighbor(zoomed, 1, "left"), -1);
  const tab = { panes: [1, 2, 3].map((i) => ({ kind: "session", id: `s${i}` })), focus: 2, zoom: null, split: "v" };
  assert.equal(cycleFocus(tab, 1).focus, 0);
  assert.equal(cycleFocus(tab, -1).focus, 1);
  assert.equal(paneAt(four, 60, 30), 3);
  assert.equal(paneAt(four, 200, 30), -1);
});

test("placing: a pane already there gets the focus, fewer than 4 adds one, 4 replaces the focused one", () => {
  let t = { panes: [], split: "v", zoom: null, focus: -1 };
  t = placeRef(t, { kind: "session", id: "a" });
  t = placeRef(t, { kind: "session", id: "b" });
  assert.deepEqual([t.panes.length, t.focus], [2, 1]);
  t = placeRef(t, { kind: "session", id: "a" });
  assert.deepEqual([t.panes.length, t.focus], [2, 0]);
  t = placeRef(placeRef(t, { kind: "map" }), { kind: "session", id: "c" });
  assert.equal(t.panes.length, 4);
  t = { ...t, focus: 1 };
  t = placeRef(t, { kind: "session", id: "d" });
  assert.deepEqual(t.panes.map((p) => p.id || p.kind), ["a", "d", "map", "c"]);
  assert.equal(t.focus, 1);
  // removing: the session isn't touched, the focus stays sensible
  let r = removePane(t, 1);
  assert.deepEqual(r.panes.map((p) => p.id || p.kind), ["a", "map", "c"]);
  assert.equal(r.focus, 1);
  r = removePane({ ...r, focus: 2 }, 0);
  assert.equal(r.focus, 1);
  r = removePane(removePane(r, 0), 0);
  assert.deepEqual([r.panes.length, r.focus], [0, -1]);
});

test("layout tabs: add, close, save and restore (bad data falls back to one empty tab)", () => {
  let ws = normWorkspace(undefined);
  assert.deepEqual(ws, { tabs: [{ panes: [], split: "v", zoom: null, focus: -1 }], active: 0 });
  ws = addTab(ws);
  assert.deepEqual([ws.tabs.length, ws.active], [2, 1]);
  ws.tabs[1] = placeRef(placeRef(ws.tabs[1], { kind: "session", id: "x" }), { kind: "map" });
  ws.tabs[1] = { ...ws.tabs[1], split: "h", zoom: 1 };
  const back = normWorkspace(JSON.parse(JSON.stringify(saveWorkspace(ws))));
  assert.deepEqual(back, ws);
  const junk = normWorkspace({ active: 7, tabs: [{ panes: [{ kind: "session", id: "a" }, { kind: "session", id: "a" }, { kind: "nope" }, null, { kind: "map" }, { kind: "session", id: "b" }, { kind: "session", id: "c" }, { kind: "session", id: "d" }], focus: 9, zoom: "x", split: "diagonal" }] });
  assert.deepEqual(junk.tabs[0].panes.map((p) => p.id || p.kind), ["a", "map", "b", "c"]);
  assert.deepEqual([junk.active, junk.tabs[0].focus, junk.tabs[0].zoom, junk.tabs[0].split], [0, 0, null, "v"]);
  assert.equal(closeTab(ws, 1).tabs.length, 1);
  assert.equal(closeTab(ws, 0).active, 0);
  assert.equal(closeTab(normWorkspace(), 0).tabs.length, 1, "the last tab is never closed, only emptied");
  // a closed session leaves every layout
  const pruned = pruneTabs(ws, new Set());
  assert.deepEqual(pruned.tabs[1].panes, [{ kind: "map" }]);
  assert.equal(pruneTabs(ws, new Set(["x"])), ws, "nothing gone: the same object");
});

const S = (id, extra = {}) => ({ id, name: id, alive: true, mode: "claude", status: "ready", created: 0, ...extra });
const H = (type, doing = "") => ({ id: `${type}-${doing}`, type, status: "running", doing });
test("sidebar rows: spaces only (the commander first, then by start); the focused pane's space nests its agents (4, +N)", () => {
  const ss = [S("b", { created: 2, helpers: [H("axa:researcher", "Grep flaky"), H("general-purpose"), H("Plan"), H("axa:builder"), H("Explore"), { type: "x", status: "done" }] }), S("a", { created: 1, helpers: [H("axa:reviewer")] }), S("cmd", { mode: "axa", created: 9 }), S("dead", { alive: false })];
  const kinds = (rows) => rows.map((r) => r.kind + (r.s && r.kind === "space" ? `:${r.s.id}` : "") + (r.kind === "more" ? `+${r.n}` : ""));
  assert.deepEqual(kinds(sidebarRows(ss)), ["head", "space:cmd", "space:a", "space:b", "gap", "map"], "no agents listed when no pane is focused");
  const rows = sidebarRows(ss, "b");
  assert.deepEqual(kinds(rows), ["head", "space:cmd", "space:a", "space:b", "agent", "agent", "agent", "agent", "more+1", "gap", "map"]);
  assert.deepEqual(rows.filter((r) => r.kind === "space").map((r) => r.n), [0, 1, 5]);
  assert.equal(moveSel(rows, 1, -1), 1, "stays on the first selectable row");
  assert.equal(moveSel(rows, 7, 1), 10, "skips the +N and the gap");
  assert.deepEqual(["axa:researcher", "general-purpose", "Explore", "Plan", "axa:reviewer", ""].map(agentShort), ["researcher", "helper", "explore", "plan", "reviewer", "agent"]);
});

test("sidebar lines: a dot, the name, a dim agent count; the focused pane's space has the accent bar; compact below 120", () => {
  const ss = [S("cmd", { mode: "axa" }), S("api", { created: 1, status: "working", helpers: [H("axa:researcher", "Grep flaky"), H("Explore")] }), S("billing", { created: 2, status: "waiting" })];
  const rows = sidebarRows(ss, "api");
  const { lines, at } = sidebarLines(rows, SIDE_W, 20, { sel: 2, focused: true, current: "api" });
  assert.equal(lines.length, 20);
  for (const l of lines) assert.equal(width(plain(l)), SIDE_W);
  const txt = lines.map(plain);
  assert.match(txt[0], /^ spaces/);
  assert.match(txt[at.indexOf(1)], /^ ● axa/);
  assert.match(txt[at.indexOf(2)], /^▎● api +·2 │$/);
  assert.match(txt[at.indexOf(3)], /^ {4}researcher Grep/);
  assert.match(txt[at.indexOf(4)], /^ {4}explore/);
  assert.match(txt.at(at.indexOf(5)), /billing/);
  for (const l of txt) assert.doesNotMatch(l, /general-purpose|AGENTS|researc…|explo…/);
  // compact: a dot and 3 letters, no agents, no label
  const c = sidebarLines(rows, COMPACT_W, 10, { current: "api" });
  for (const l of c.lines) assert.equal(width(plain(l)), COMPACT_W);
  assert.deepEqual(c.lines.slice(0, 5).map(plain), [" ● axa│", "▎● api│", " ● bil│", "      │", " ◫    │"]);
  // too many to fit: the selection stays on screen
  const many = sidebarRows(Array.from({ length: 40 }, (_, i) => S(`s${i}`, { created: i })));
  const r2 = sidebarLines(many, SIDE_W, 15, { sel: 35 });
  assert.ok(r2.at.includes(35));
  assert.equal(r2.lines.length, 15);
  assert.deepEqual([sideWidth(200), sideWidth(119), sideWidth(100), sideWidth(89), sideWidth(80, true), sideWidth(200, false)], [SIDE_W, COMPACT_W, COMPACT_W, 0, COMPACT_W, 0]);
});

test("pane header: one line; focused gets the accent bar, zoom and close; needs-you is amber with y / x", () => {
  const s = S("charlie", { status: "working", git: { branch: "main" }, usage: { context: 100_000, model: "claude-opus-5-5" } });
  const f = paneHeader({ s, w: 80, focused: true });
  assert.equal(width(plain(f.text)), 80);
  assert.match(plain(f.text), /^▎ charlie {2}● working {2}. main +□ {2}✕ $/);
  assert.deepEqual(f.hits.map((h) => h.k), ["zoom", "close"]);
  const u = paneHeader({ s: { ...s, usage: { context: 180_000 } }, w: 80 });
  assert.match(plain(u.text), /^ {2}charlie {2}● working {2}. main {2}ctx 90% +$/, "unfocused: no icons; context only when it's high");
  assert.deepEqual(u.hits, []);
  const w = S("billing", { status: "waiting", choices: { question: "Deploy?", options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }] } });
  const tw = paneHeader({ s: w, w: 90 });
  assert.match(plain(tw.text), /^ {2}billing · needs you +y {2}approve {2}x {2}decline $/);
  assert.deepEqual(tw.hits.map((h) => h.k), ["yes", "yes", "no", "no"]);
  const tf = paneHeader({ s: w, w: 90, focused: true });
  assert.deepEqual(tf.hits.map((h) => h.k), ["yes", "yes", "no", "no", "zoom", "close"]);
  for (const h of tf.hits) assert.match(plain(tf.text).slice(h.x0, h.x1 + 1), { yes: /^( y | approve )$/, no: /^( x | decline )$/, zoom: /^ □ $/, close: /^ ✕ $/ }[h.k]);
  assert.match(plain(paneHeader({ s: w, w: 90, armed: true }).text), /click again to approve/);
  assert.match(plain(paneHeader({ kind: "map", w: 40, label: "3 sessions" }).text), /^ {2}live map · 3 sessions/);
  assert.deepEqual(["waiting", "stuck", "failed", "done", "working", "ready", "exited"].map((st) => statusRole({ status: st })), ["wait", "stuck", "stuck", "done", "text", "dim", "dim"]);
  assert.equal(ctxPct({ context: 500_000, model: "claude-opus-5-5[1m]" }), 50);
  assert.equal(ctxPct({}), null);
});

test("panes: no boxes; thin dividers (│ on the left, ─ on top) only between panes, ┼ / ├ / ┬ where they meet", () => {
  const four = paneRects(4, 40, 10);
  assert.deepEqual(paneParts(four[0]), { c: { x: 0, y: 0, w: 20, h: 5 }, b: { x: 1, y: 1, w: 18, h: 4 }, dl: 0, dt: 0 });
  assert.deepEqual(paneParts(four[3]), { c: { x: 21, y: 6, w: 19, h: 4 }, b: { x: 22, y: 7, w: 17, h: 3 }, dl: 1, dt: 1 });
  assert.equal(cornerOf(four[3], four), "┼");
  const three = paneRects(3, 40, 10);
  assert.equal(cornerOf(three[2], three), "├");
  const threeH = paneRects(3, 40, 10, { split: "h" });
  assert.equal(cornerOf(threeH[2], threeH), "┬");
  const rows = four.map((r) => { const { c, b } = paneParts(r); return paneBlock(r, four, paneHeader({ s: S("x"), w: c.w }), Array(b.h).fill("·".repeat(b.w))); });
  const screen = compose(40, 10, four.map((r, i) => ({ ...r, rows: rows[i] }))).map(plain);
  for (const l of screen) assert.equal(width(l), 40);
  assert.match(screen[0], /^ {2}x .*│ {2}x /);
  assert.match(screen[1], /^ ·{18} │ ·{17} $/, "one column of padding each side");
  assert.equal(screen[5], "─".repeat(20) + "┼" + "─".repeat(19));
  assert.doesNotMatch(screen.join(""), /[┌┐└┘]/, "no boxes");
  const one = paneRects(1, 30, 5)[0];
  assert.deepEqual(paneParts(one).c, { x: 0, y: 0, w: 30, h: 5 }, "a single pane has no dividers");
});

test("top line: layout tabs, the needs-you chip, a dim keys hint (or a note) and the clock, with hit boxes", () => {
  const ws = addTab(normWorkspace({ tabs: [{ panes: [{ kind: "map" }] }] }));
  const t = topLine(ws, 120, { needs: 2, clock: "11:30" });
  const p = plain(t.text);
  assert.equal(width(p), 120);
  assert.match(p, /^ ◆ workspace {3}1 {2}2 {2}\+ .* ▲ 2 need you {4}Ctrl-b \? keys {3}11:30 $/);
  for (const h of t.hits) assert.match(p.slice(h.x0 - 1, h.x1), { home: /◆|workspace/, needs: /need you/, help: /keys/, "+": /\+/, 0: /1/, 1: /2/ }[h.k]);
  assert.deepEqual(t.hits.map((h) => h.k), ["home", "home", 0, 1, "+", "needs", "help"]);
  const q = topLine(ws, 120, { needs: 1, note: ["billing: answered \"No\"", "text"] });
  assert.match(plain(q.text), /▲ 1 needs you {4}billing: answered "No"/);
  assert.ok(!q.hits.some((h) => h.k === "help"));
  assert.doesNotMatch(plain(topLine(ws, 120).text), /need/);
});

test("compose", () => {
  const rows = compose(10, 2, [{ x: 0, y: 0, w: 3, h: 2, rows: ["aaa", "bbb"] }, { x: 5, y: 0, w: 2, h: 1, rows: ["cc"] }]);
  assert.deepEqual(rows, ["aaa  cc   ", "bbb       "]);
});

test("wsHit: what a click hits (top line, sidebar, a pane's header buttons, its body, a divider)", () => {
  const rects = paneRects(2, 100, 20);
  const w = S("b", { status: "waiting", choices: { question: "Go?", options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }] } });
  const panes = [{ i: 0, header: paneHeader({ s: S("a"), w: paneParts(rects[0]).c.w, focused: true }) }, { i: 1, header: paneHeader({ s: w, w: paneParts(rects[1]).c.w }) }];
  const geo = { y0: 1, top: 2, sideW: SIDE_W, side: [-1, 1, 2], rects, panes, tabHits: [{ k: 0, x0: 15, x1: 17 }, { k: "+", x0: 18, x1: 20 }, { k: "needs", x0: 150, x1: 160 }] };
  assert.equal(wsHit(geo, 10, 0), null);
  assert.deepEqual(wsHit(geo, 16, 1), { kind: "tab", k: 0 });
  assert.deepEqual(wsHit(geo, 19, 1), { kind: "tab", k: "+" });
  assert.deepEqual(wsHit(geo, 155, 1), { kind: "tab", k: "needs" });
  assert.deepEqual(wsHit(geo, 60, 1), { kind: "bar" });
  assert.deepEqual(wsHit(geo, 3, 3), { kind: "side", i: 1 });
  assert.deepEqual(wsHit(geo, SIDE_W, 2), { kind: "side", i: -1 });
  // each header button at the column it's drawn (pane 2 starts after its divider)
  for (const [i, p] of panes.entries()) {
    const x0 = SIDE_W + 1 + paneParts(rects[i]).c.x;
    for (const h of p.header.hits) assert.deepEqual(wsHit(geo, x0 + h.x0, 2), { kind: "title", pane: i, k: h.k });
  }
  assert.deepEqual(wsHit(geo, SIDE_W + 1 + 3, 2), { kind: "title", pane: 0, k: null });
  assert.deepEqual(wsHit(geo, SIDE_W + 1 + 5, 2 + 3), { kind: "body", pane: 0, ix: 4, iy: 2, inside: true });
  assert.equal(wsHit(geo, SIDE_W + 1 + rects[1].x, 5).inside, false, "the divider");
  assert.equal(wsHit(geo, SIDE_W + 1, 5).inside, false, "the padding column");
  assert.deepEqual(wsHit({ ...geo, sideW: 0 }, 3, 2).kind, "title", "no sidebar: the panes start at column 1");
  assert.equal(wsHit(geo, 500, 8), null);
});

test("slim map: one calm row per session (dot, name, dim doing, time), needs-you, then working, then the rest; +N more", () => {
  const now = 1_000_000_000;
  const ss = [
    S("cmd", { mode: "axa", status: "ready", created: 0 }),
    S("notes", { created: 1, status: "done", last_report: "README updated", last_event_at: now - 5 * 60_000 }),
    S("api", { created: 2, status: "working", doing: "Bash npm test", turn_start: now - 60_000, helpers: [H("Explore", "Grep x")] }),
    S("billing", { created: 3, status: "waiting", choices: { question: "Deploy?", options: [] }, wait_since: now - 120_000 }),
    S("broken", { created: 4, status: "failed", error: "boom" }),
  ];
  assert.deepEqual(slimOrder(ss).map((s) => s.id), ["billing", "api", "broken", "cmd", "notes"]);
  const ctx = { sessions: ss, selId: "api", motion: "off", mapHits: [] };
  const rows = slimRows(ctx, 60, 8, now).map(plain);
  assert.equal(rows.length, 8);
  for (const r of rows) assert.equal(width(r), 60);
  assert.match(rows[0], /^ ● billing {2}Deploy\? +waiting 2m $/);
  assert.match(rows[1], /^ ✻ api {6}Bash npm test +for 1m $/, "still (motion off): the still glyph, no agents or strips");
  assert.match(rows[2], /^ ● broken {3}boom/);
  assert.match(rows[3], /^ ● AXA /);
  assert.match(rows[4], /^ ● notes {4}README updated +5m ago $/);
  assert.equal(rows[5].trim(), "");
  assert.doesNotMatch(rows.join(""), /[▁▂▃▄▅▆▇█▏├└]|agent|WORKING/);
  assert.deepEqual(ctx.mapHits.map((h) => [h.id, h.row0]), [["billing", 0], ["api", 1], ["broken", 2], ["cmd", 3], ["notes", 4]]);
  assert.equal(ctx.next, null, "nothing moves with motion off");
  // full motion: the working dot breathes and the needs-you dot pulses, so it asks for frames
  const live = { sessions: ss, motion: "full", mapHits: [] };
  slimRows(live, 60, 8, now);
  assert.ok(live.next > 0 && live.next <= 100);
  // not enough rows: the selected one stays in view and the rest are counted
  const small = slimRows({ sessions: ss, selId: "notes", motion: "off" }, 60, 3, now).map(plain);
  assert.match(small[1], /notes/);
  assert.match(small[2], /^ {3}↑ 3 above +$/);
  const top = slimRows({ sessions: ss, motion: "off" }, 60, 3, now).map(plain);
  assert.match(top[2], /^ {3}\+3 more/);
  // narrow: the doing text and the time drop before the names
  const narrow = slimRows({ sessions: ss, motion: "off" }, 16, 6, now).map(plain);
  for (const r of narrow) assert.equal(width(r), 16);
  assert.match(narrow[0], /^ ● billing +$/);
  // the full lanes come back when it's zoomed or has about 120x30
  assert.deepEqual([slimWanted({ w: 89, h: 26 }), slimWanted({ w: 89, h: 26 }, true), slimWanted({ w: 130, h: 40 }), slimWanted({ w: 130, h: 20 })], [true, false, false, true]);
});
