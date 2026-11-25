// The live lanes' motion (docs/tasks/map-alive.md): packets, branches, breathing glyphs, shimmer, slides, sends,
// colour blending with its fallback, and the reduced/off modes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOLD_MS, FLASH_MS, GROW_MS, PACKET_MS, SEND_MS, SLIDE_MS, addPacket, branchBudget, branchView, breath, createAlive, doneFade, dotRow, feedEvents, flicker, flickerNext, glyphSet, heartbeat, observeSessions, packetAt, sendTarget, shimmer, slideKey, slideOrder, spinFrames, toolKind, typeIn, wave } from "../src/tui/alive.mjs";
import { laneRows } from "../src/tui/lanes.mjs";
import { mix, setTheme } from "../src/tui/draw.mjs";
import { gw, graphemes, strWidth } from "../src/tui/width.mjs";

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const T0 = 1_800_000_000_000;
const S = (id, status, extra = {}) => ({ id, name: id, mode: "claude", alive: true, status, created: T0 - 3600_000, ...extra });

test("packets: leave from the name, reach the doing text in ~600 ms, at most 3 in flight per row", () => {
  const p = { track: "l:a", kind: "read", start: T0 };
  assert.equal(packetAt(p, T0 - 1, 20), null, "not left yet");
  assert.equal(packetAt(p, T0, 20), 0);
  const cols = [0, 100, 200, 300, 400, 500, 590].map((dt) => packetAt(p, T0 + dt, 20));
  for (let i = 1; i < cols.length; i++) assert.ok(cols[i] >= cols[i - 1], `moves forward: ${cols}`);
  assert.ok(cols.at(-1) >= 18, "almost there by the end");
  assert.equal(packetAt(p, T0 + PACKET_MS, 20), null, "arrived");
  assert.equal(packetAt(p, T0 + 10, 0), null, "no track, no packet");
  let list = [];
  for (let i = 0; i < 5; i++) list = addPacket(list, { track: "l:a", kind: "edit", start: T0 + i * 10 }, T0 + i * 10);
  list = addPacket(list, { track: "l:b", kind: "bash", start: T0 + 50 }, T0 + 50);
  assert.equal(list.filter((q) => q.track === "l:a").length, 3, "the cap");
  assert.deepEqual(list.filter((q) => q.track === "l:a").map((q) => q.start), [T0 + 20, T0 + 30, T0 + 40], "the oldest go");
  assert.equal(addPacket(list, { track: "l:c", start: T0 + 5000 }, T0 + 5000).length, 1, "finished ones are dropped");
  assert.deepEqual(["Read", "Grep", "Edit", "Write", "Bash", "WebSearch", "Agent", "mcp__x__y"].map(toolKind), ["read", "read", "edit", "edit", "bash", "web", "agent", "other"]);
});

test("agent branches: grow, type in, steady; a finished one flashes ✓, folds back and goes", () => {
  const born = { born: T0, ended: 0 };
  assert.deepEqual(branchView(born, T0, 10), { run: 0, chars: 0, mark: "", flash: 0, gone: false });
  const mid = branchView(born, T0 + GROW_MS / 2, 10);
  assert.ok(mid.run > 0 && mid.run < 10 && mid.chars === 0, "half grown, no name yet");
  const typing = branchView(born, T0 + GROW_MS + 100, 10);
  assert.equal(typing.run, 10); assert.equal(typing.mark, "spin"); assert.ok(typing.chars > 1 && typing.chars < 12);
  assert.equal(branchView({ born: 0, ended: 0 }, T0, 10).chars, Infinity, "there before the hub started: whole");
  const end = { born: 0, ended: T0 };
  assert.deepEqual(branchView(end, T0 + 10, 10), { run: 10, chars: Infinity, mark: "done", flash: 1 - 10 / FLASH_MS, gone: false });
  const fold = branchView(end, T0 + (FLASH_MS + FOLD_MS) / 2, 10);
  assert.ok(fold.run > 0 && fold.run < 10 && fold.chars === 0, "folding back");
  assert.equal(branchView(end, T0 + FOLD_MS, 10).gone, true);
  assert.equal(branchView({ ...end, failed: true }, T0, 10).mark, "fail");
  // rows: the selected lane gets all, the others up to 3; the biggest give up rows first
  assert.deepEqual(branchBudget([5, 2, 6], 0, 99), [5, 2, 3]);
  assert.deepEqual(branchBudget([5, 2, 6], 0, 8), [5, 1, 2]);
  assert.deepEqual(branchBudget([5, 2, 6], 0, 3), [3, 0, 0]);
  assert.deepEqual(branchBudget([1, 1], -1, 0), [0, 0]);
  assert.deepEqual(branchBudget([0, 2, 2], 0, 1), [0, 0, 0], "one row for two lanes: neither (no lone branch)");
  assert.deepEqual(branchBudget([2, 2, 2], 0, 3), [2, 0, 0], "the selected one keeps its own");
});

test("breathing glyphs: the ping-pong spinner, the needs-you wave, the stuck flicker, the done flash", () => {
  assert.deepEqual(spinFrames(), ["·", "✢", "*", "✶", "✻", "✽", "✻", "✶", "*", "✢"]);
  assert.equal(spinFrames("ascii").length, 10);
  assert.equal(breath(0), "·"); assert.equal(breath(450), "✻"); assert.equal(breath(500), "✽"); assert.equal(breath(1000), "·");
  for (const g of [...spinFrames(), "•", "▏", "╱", "╲", "├", "└", "✓", "✗"]) assert.equal(strWidth(g), 1, `${g} is one column`);
  assert.equal(glyphSet({ TERM: "linux" }), "ascii"); assert.equal(glyphSet({ TERM: "xterm-256color" }), "safe");
  assert.equal(wave(0), 0); assert.ok(Math.abs(wave(800) - 1) < 1e-9); assert.ok(wave(400) > 0.4 && wave(400) < 0.6);
  assert.equal(flicker(0), true); assert.equal(flicker(1000), false);
  assert.equal(flickerNext(1000), 1600, "the clock sleeps until the next dip");
  assert.equal(doneFade(100), 0, "the flash"); assert.ok(doneFade(1200) > 0 && doneFade(1200) < 1); assert.equal(doneFade(5000), 1, "rests dim");
});

test("shimmer and type-in: a bright band slides across; new text types in", () => {
  const a = shimmer(20, 0, 0), b = shimmer(20, 300, 0);
  const peak = (xs) => xs.indexOf(Math.max(...xs));
  assert.ok(Math.max(...b) > 0 && peak(b) > peak(a), "the band moves right");
  assert.ok(a.every((x) => x >= 0 && x <= 1));
  assert.equal(typeIn("npm run build", 0, T0), "npm run build", "there from the start: whole");
  assert.equal(typeIn("npm run build", T0, T0), "np");
  assert.ok(typeIn("npm run build", T0, T0 + 100).length > 2);
  assert.equal(typeIn("npm run build", T0, T0 + 2000), "npm run build");
});

test("colour: an RGB blend between theme roles, the nearer named colour without truecolor", () => {
  setTheme("axa");
  assert.equal(mix("wait", "waitHi", 0), "wait"); assert.equal(mix("wait", "waitHi", 1), "waitHi");
  assert.match(mix("wait", "waitHi", 0.5), /^1;38;2;255;207;125$/);
  assert.match(mix("text", "hi", 0.25), /^38;2;\d+;\d+;\d+$/, "bold follows the nearer one");
  setTheme("terminal");
  assert.equal(mix("wait", "waitHi", 0.3), "wait"); assert.equal(mix("wait", "waitHi", 0.7), "waitHi");
  setTheme("mono");
  assert.equal(mix("text", "hi", 0.6), "hi");
  setTheme("axa");
});

test("the strip: the commander's heartbeat, the dot of a send down the gutter", () => {
  assert.equal(heartbeat([null, 0, 3, 0, 0, 1, 2, 0]).map(([c]) => c).join(""), " ─╱╲─╱╲─");
  assert.equal(heartbeat([0, 1, 0], "ascii").map(([c]) => c).join(""), "-/\\");
  assert.deepEqual(sendTarget({ summary: '{"id":"s3","text":"go"}' }), { id: "s3" });
  assert.deepEqual(sendTarget({ summary: '{"project":"~/code/web","mode":"claude"}' }), { name: "web" });
  const d = { start: T0 };
  assert.equal(dotRow(d, T0, 0, 8), 0); assert.equal(dotRow(d, T0 + SEND_MS / 2, 0, 8), 4); assert.equal(dotRow(d, T0 + SEND_MS, 0, 8), null);
});

test("row slides: a lane changing group moves through the rows in between", () => {
  const A = createAlive();
  assert.deepEqual(slideOrder(A, ["axa", "a", "b", "c", "d"], T0), ["axa", "a", "b", "c", "d"]);
  // d needs you now: it belongs at 1
  const at = (dt) => slideOrder(A, ["axa", "d", "a", "b", "c"], T0 + dt);
  assert.deepEqual(at(0), ["axa", "a", "b", "c", "d"], "it starts where it was");
  const mid = at(SLIDE_MS / 2);
  assert.ok(mid.indexOf("d") > 1 && mid.indexOf("d") < 4, `on its way: ${mid}`);
  assert.deepEqual(at(SLIDE_MS), ["axa", "d", "a", "b", "c"], "and lands");
  assert.equal(slideKey({ idx: 3, from: 3, start: 0 }, T0), 3);
});

test("events: the first poll primes, then new ones are played back in their rhythm (packets, pulses, sends)", () => {
  const A = createAlive();
  const ev = (dt, extra) => ({ ts: T0 + dt, terminal: "a", event: "PreToolUse", tool: "Read", ...extra });
  assert.equal(feedEvents(A, [ev(-5000), ev(-4000)], T0), 0, "what was there doesn't animate");
  assert.equal(A.packets.length, 0);
  const n = feedEvents(A, [ev(-5000), ev(-4000), ev(-2000), ev(-1500, { agent_id: "h1", tool: "Edit" }), ev(-1000, { terminal: "cmd", tool: "mcp__plugin_axa_terminals__send_to_session", summary: '{"id":"a"}' })], T0);
  assert.equal(n, 3);
  assert.deepEqual(A.packets.map((p) => [p.track, p.kind, p.start - T0]), [["l:a", "read", 0], ["a:h1", "edit", 500], ["l:cmd", "other", 1000]]);
  assert.deepEqual(A.sends.map((d) => [d.from, d.to.id, d.start - T0]), [["cmd", "a", 1000]]);
  assert.equal(A.pulses.get("a"), T0 + 500);
  assert.equal(feedEvents(A, [ev(-1000, { terminal: "cmd", tool: "mcp__plugin_axa_terminals__send_to_session", summary: '{"id":"a"}' })], T0 + 2000), 0, "seen ones aren't replayed");
  assert.equal(feedEvents(A, [ev(-60_000 + 1), ev(-20_000)], T0 + 100), 0, "nor old ones (the lanes weren't on screen)");
});

test("sessions: new agents grow, finished ones fold, a new lane fades in, done flashes", () => {
  const A = createAlive();
  const a = S("a", "working", { helpers: [{ id: "h1", type: "x:builder", status: "running" }] });
  observeSessions(A, [a], T0);
  assert.equal(A.agents.get("a:h1").born, 0, "there at start: drawn whole");
  observeSessions(A, [{ ...a, status: "done", helpers: [{ id: "h1", status: "done" }, { id: "h2", type: "Plan", status: "running" }] }, S("b", "working")], T0 + 1000);
  assert.equal(A.agents.get("a:h2").born, T0 + 1000);
  assert.equal(A.agents.get("a:h1").ended, T0 + 1000);
  assert.equal(A.status.get("a").since, T0 + 1000);
  assert.equal(A.born.get("b"), T0 + 1000);
  observeSessions(A, [{ ...a, helpers: [] }], T0 + 1000 + FOLD_MS + 1);
  assert.equal(A.agents.has("a:h1"), false, "folded and gone");
});

test("drawn: full motion flies packets and breathes; reduced keeps only colour; off keeps all still", () => {
  const sessions = () => [{ ...S("cmd", "ready"), mode: "axa" }, S("a", "working", { doing: "npm test", helpers: [{ id: "h1", type: "x:builder", status: "running", doing: "Edit x" }] }), S("w", "waiting", { choices: { question: "ok?" } })];
  const draw = (motion, now) => {
    const A = createAlive();
    observeSessions(A, sessions(), T0 - 5000);
    slideOrder(A, ["cmd", "w", "a"], T0 - 5000);
    feedEvents(A, [], T0 - 5000);
    feedEvents(A, [{ ts: T0, terminal: "a", event: "PreToolUse", tool: "Bash" }, { ts: T0 + 1, terminal: "a", agent_id: "h1", event: "PreToolUse", tool: "Read" }], T0);
    const ctx = { sessions: sessions(), selId: "a", motion, question: (c) => c.question, mapHits: [], alive: A, act: { lanes: { a: [T0 - 1000] } } };
    return { rows: laneRows(ctx, 120, 10, now), ctx };
  };
  setTheme("axa");
  const full = draw("full", T0 + 200);
  const lane = plain(full.rows.find((r) => / a /.test(plain(r)) && /WORKING/.test(plain(r))));
  assert.match(lane, /•/, "the step flies along the lane");
  assert.match(plain(full.rows.find((r) => /builder/.test(plain(r)))), /├?└?─*•─*/, "and the agent's along its branch");
  assert.equal(full.ctx.anim, true);
  const reduced = draw("reduced", T0 + 200);
  assert.doesNotMatch(reduced.rows.map(plain).join("\n"), /•/, "reduced: no packets");
  assert.match(reduced.rows.map(plain).join("\n"), / ✻ builder/, "a still glyph");
  assert.equal(reduced.ctx.anim, true, "but the needs-you pulse and the strip still change colour");
  const off = draw("off", T0 + 200);
  assert.doesNotMatch(off.rows.map(plain).join("\n"), /•/);
  assert.equal(off.ctx.next, null, "off: nothing to redraw for");
  assert.deepEqual(draw("off", T0 + 900).rows, off.rows, "and later frames are the same");
  // still when idle: no motion state changes, nothing working
  const idle = { sessions: [S("d", "done")], motion: "full", mapHits: [], alive: createAlive() };
  laneRows(idle, 100, 4, T0);
  laneRows(idle, 100, 4, T0 + 5000);
  assert.equal(idle.ctx?.anim ?? idle.anim, false);
});

test("width: the fast path agrees with the grapheme path for every character it takes", () => {
  const ranges = [[0x20, 0x7e], [0xa0, 0x2ff], [0x2010, 0x2027], [0x2030, 0x205f], [0x2190, 0x23ff], [0x2500, 0x27bf]];
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
  for (const [a, b] of ranges) for (let c = a; c <= b; c++) {
    const ch = String.fromCodePoint(c);
    assert.equal(gw(ch), 1, ch); assert.equal([...seg.segment(`x${ch}y`)].length, 3, `U+${c.toString(16)}`);
  }
  assert.equal(strWidth("日本 ✔" + String.fromCodePoint(0xfe0f)), 7);
  assert.deepEqual(graphemes("e" + String.fromCodePoint(0x301) + "x"), ["e" + String.fromCodePoint(0x301), "x"]);
});
