// The Workspace tab's pure parts: layout math for 1-4 panes and both splits, focus movement, zoom, layout tabs
// (save and restore), the sidebar's rows and lines, the pane title bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTheme, width } from "../src/tui/draw.mjs";
import { MAX_PANES, addTab, closeTab, compose, ctxPct, cycleFocus, inner, moveSel, neighbor, normWorkspace, paneAt, paneRects, paneTitle, placeRef, pruneTabs, removePane, saveWorkspace, sidebarLines, sidebarRows, tabsBar, toggleZoom } from "../src/tui/workspace.mjs";

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
test("sidebar rows: the commander first, then sessions by when they started; the map; running agents by session", () => {
  const ss = [S("b", { created: 2, helpers: [{ id: "h1", type: "axa:researcher", status: "running", doing: "Grep flaky" }, { id: "h2", type: "x", status: "done" }] }), S("a", { created: 1 }), S("cmd", { mode: "axa", created: 9 }), S("dead", { alive: false })];
  const rows = sidebarRows(ss);
  assert.deepEqual(rows.map((r) => r.kind + (r.s ? `:${r.s.id}` : "")), ["head", "space:cmd", "space:a", "space:b", "map", "gap", "head", "group:b", "agent:b"]);
  assert.deepEqual(sidebarRows([S("a")]).at(-1), { kind: "none", text: "none running" });
  assert.equal(moveSel(rows, 1, -1), 1, "stays on the first selectable row");
  assert.equal(moveSel(rows, 4, 1), 8, "skips the heads and groups");
  assert.equal(moveSel(rows, 0, 1), 1);
  const { lines, at } = sidebarLines(rows, 22, 20, { sel: 2, focused: true, shown: new Map([["a", 2]]) });
  assert.equal(lines.length, 20);
  for (const l of lines) assert.equal(width(plain(l)), 22);
  assert.match(plain(lines[at.indexOf(1)]), /AXA/);
  assert.match(plain(lines[at.indexOf(2)]), /a +2 │$/, "the pane number it's shown in");
  assert.match(plain(lines[at.indexOf(8)]), /\* researcher Grep/);
  // too many to fit: the selection stays on screen
  const many = sidebarRows(Array.from({ length: 40 }, (_, i) => S(`s${i}`, { created: i })));
  const r2 = sidebarLines(many, 22, 15, { sel: 35 });
  assert.ok(r2.at.includes(35));
  assert.equal(r2.lines.length, 15);
});

test("pane title: name, status, branch, context %; a waiting pane is amber with y / x buttons", () => {
  const s = S("charlie", { status: "working", git: { branch: "main" }, usage: { context: 100_000, model: "claude-opus-5-5" } });
  const t = paneTitle({ s, w: 80, focused: true, n: 1 });
  assert.equal(width(plain(t.text)), 80);
  assert.match(plain(t.text), /^┌ 1 .*charlie {2}working {2}. main {2}ctx 50%.*✕ ┐$/);
  assert.equal(t.role, "frameOn");
  assert.deepEqual(t.hits.map((h) => h.k), ["zoom", "close"]);
  const w = S("charlie", { status: "waiting", choices: { question: "Deploy?", options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }] } });
  const tw = paneTitle({ s: w, w: 90, n: 2 });
  assert.equal(tw.role, "wait");
  assert.match(plain(tw.text), /NEEDS YOU.* y  approve  x  decline /);
  assert.deepEqual(tw.hits.map((h) => h.k), ["yes", "yes", "no", "no", "zoom", "close"]);
  const yes = tw.hits[0];
  assert.equal(plain(tw.text).slice(yes.x0, yes.x1 + 1), " y ", "hit columns line up with the text");
  assert.match(plain(paneTitle({ s: w, w: 90, armed: true }).text), /click again to approve/);
  assert.match(plain(paneTitle({ kind: "map", w: 40, n: 3 }).text), /live map/);
  assert.equal(ctxPct({ context: 500_000, model: "claude-opus-5-5[1m]" }), 50);
  assert.equal(ctxPct({}), null);
});

test("compose and the tab bar", () => {
  const rows = compose(10, 2, [{ x: 0, y: 0, w: 3, h: 2, rows: ["aaa", "bbb"] }, { x: 5, y: 0, w: 2, h: 1, rows: ["cc"] }]);
  assert.deepEqual(rows, ["aaa  cc   ", "bbb       "]);
  const ws = addTab(normWorkspace({ tabs: [{ panes: [{ kind: "map" }] }] }));
  const bar = tabsBar(ws, 80);
  assert.equal(width(plain(bar.text)), 80);
  assert.deepEqual(bar.hits.map((h) => h.k), [0, 1, "+"]);
  const p = plain(bar.text);
  for (const h of bar.hits) assert.match(p.slice(h.x0 - 1, h.x1), h.k === "+" ? /\+/ : new RegExp(String(h.k + 1)));
});

test("wsHit: what a click hits (tab bar, sidebar, a pane's title buttons, inside a pane, its border)", async () => {
  const { wsHit, SIDE_W } = await import("../src/tui/workspace.mjs");
  const rects = paneRects(2, 100, 20);
  const w = S("b", { status: "waiting", choices: { question: "Go?", options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }] } });
  const panes = [{ i: 0, title: paneTitle({ s: S("a"), w: rects[0].w }) }, { i: 1, title: paneTitle({ s: w, w: rects[1].w }) }];
  const geo = { y0: 4, top: 5, side: [-1, 1, 2], rects, panes, tabHits: [{ k: 0, x0: 15, x1: 19 }, { k: "+", x0: 21, x1: 23 }] };
  assert.equal(wsHit(geo, 10, 3), null, "above the Workspace");
  assert.deepEqual(wsHit(geo, 16, 4), { kind: "tab", k: 0 });
  assert.deepEqual(wsHit(geo, 22, 4), { kind: "tab", k: "+" });
  assert.deepEqual(wsHit(geo, 60, 4), { kind: "bar" });
  assert.deepEqual(wsHit(geo, 3, 6), { kind: "side", i: 1 });
  assert.deepEqual(wsHit(geo, SIDE_W, 5), { kind: "side", i: -1 });
  // pane 2's title: its y / x / zoom / close buttons, each at the column it's drawn
  const t = panes[1].title, x0 = SIDE_W + 1 + rects[1].x;
  for (const h of t.hits) assert.deepEqual(wsHit(geo, x0 + h.x0, 5), { kind: "title", pane: 1, k: h.k });
  assert.deepEqual(wsHit(geo, x0 + 3, 5), { kind: "title", pane: 1, k: null });
  assert.deepEqual(wsHit(geo, SIDE_W + 1 + 5, 5 + 3), { kind: "body", pane: 0, ix: 4, iy: 2, inside: true });
  assert.equal(wsHit(geo, SIDE_W + 1, 5 + 3).inside, false, "the left border");
  assert.equal(wsHit(geo, 500, 8), null);
});
