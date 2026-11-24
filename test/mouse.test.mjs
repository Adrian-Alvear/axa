// src/tui/mouse.mjs: hit boxes for drawn segments, the two-click approve, popup hit-testing
import { test } from "node:test";
import assert from "node:assert/strict";
import { hintKey, hitAt, makeArm, overlayHit, segSpans } from "../src/tui/mouse.mjs";
import { line } from "../src/tui/draw.mjs";

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
// the text line() drew under a span (1-based inclusive columns, line starting at column x0)
const under = (row, sp, x0 = 1) => [...plain(row)].slice(sp.x0 - x0, sp.x1 - x0 + 1).join("");

test("segSpans: left and right segments land where line() draws them", () => {
  const left = [[" ⏎ ", "keycap"], [" open  ", "barDim"], ["", "x"], [" d ", "keycap"], [" changes  ", "barDim"]];
  const right = [[" ? ", "keycap"], [" help  ", "barDim"], [" q ", "keycap"], [" quit", "barDim"]];
  const row = line(left, 80, right), sp = segSpans(left, 80, right);
  assert.deepEqual(sp.left.map((s) => s.i), [0, 1, 3, 4]); // the empty one is skipped
  assert.equal(under(row, sp.left[0]), " ⏎ ");
  assert.equal(under(row, sp.left[2]), " d ");
  assert.deepEqual(sp.right.map((s) => s.i), [0, 1, 2, 3]);
  assert.equal(under(row, sp.right[0]), " ? ");
  assert.equal(under(row, sp.right[2]), " q ");
  assert.equal(under(row, sp.right[3]), " quit "); // the last one ends one column before the edge
  assert.equal(sp.right[3].x1, 80);
});

test("segSpans: an offset start column, empty right segments keep their index, a cut-off segment is dropped", () => {
  const left = [["aaaa", ""], ["bbbbbbbbbb", ""], ["cc", ""]], right = [["", ""], [" ⏎ send ", ""]];
  const sp = segSpans(left, 20, right, 31);
  assert.deepEqual(sp.right, [{ i: 1, x0: 31 + 20 - 8, x1: 31 + 19 }]);
  assert.deepEqual(sp.left.map((s) => s.i), [0, 1]); // "cc" doesn't fit next to the button
  assert.equal(sp.left[0].x0, 31);
  const narrow = segSpans(left, 10, [["a very long right side", ""]]);
  assert.deepEqual(narrow.right, []); // line() leaves out a right side that doesn't fit
});

test("hitAt: by row and column; a box without a row matches any row", () => {
  const hits = [{ y: 3, x0: 5, x1: 9, k: "a" }, { x0: 20, x1: 22, k: "b" }];
  assert.equal(hitAt(hits, 5, 3).k, "a");
  assert.equal(hitAt(hits, 9, 3).k, "a");
  assert.equal(hitAt(hits, 10, 3), null);
  assert.equal(hitAt(hits, 5, 4), null);
  assert.equal(hitAt(hits, 21, 99).k, "b");
});

test("makeArm: the first click arms, a second on the same prompt within 4 s fires", () => {
  let t = 1000;
  const arm = makeArm(4000, () => t);
  assert.equal(arm.armed("p1"), false);
  assert.equal(arm.press("p1"), "armed");
  assert.equal(arm.armed("p1"), true);
  assert.equal(arm.armed(), true);
  t += 3999;
  assert.equal(arm.press("p1"), "fire");
  assert.equal(arm.armed("p1"), false); // firing disarms
});

test("makeArm: it disarms after 4 s, on disarm(), and a different prompt only arms", () => {
  let t = 0;
  const arm = makeArm(4000, () => t);
  arm.press("p1"); t = 4000;
  assert.equal(arm.armed("p1"), false);
  assert.equal(arm.press("p1"), "armed"); // too late: armed again, not fired
  arm.disarm();
  assert.equal(arm.press("p1"), "armed");
  assert.equal(arm.press("p2"), "armed"); // the prompt changed: never approve what you didn't click on
  assert.equal(arm.armed("p1"), false);
  assert.equal(arm.press("p2"), "fire");
});

test("overlayHit: outside, the ✕ corner, the ↓ more button, items and the rest of the box", () => {
  // box at 0-based (10, 5), 30 wide, 8 high; list rows 6..11 (6 of them), scrolled by 2, 20 lines
  const g = { x: 10, y: 5, w: 30, h: 8, listTop: 6, listH: 6, scroll: 2, n: 20, more: [30, 40] };
  assert.equal(overlayHit(g, 10, 6).kind, "outside"); // x 0-based 9
  assert.equal(overlayHit(g, 41, 6).kind, "outside");
  assert.equal(overlayHit(g, 20, 5).kind, "outside");
  assert.equal(overlayHit(g, 20, 14).kind, "outside");
  assert.equal(overlayHit(g, 39, 6).kind, "close"); // top row, last columns
  assert.equal(overlayHit(g, 20, 6).kind, "inside"); // the title
  assert.deepEqual(overlayHit(g, 20, 7), { kind: "item", i: 2 }); // first list row = scroll
  assert.deepEqual(overlayHit(g, 20, 12), { kind: "item", i: 7 });
  assert.equal(overlayHit(g, 11, 7).kind, "inside"); // the left border
  assert.equal(overlayHit(g, 35, 13).kind, "more"); // bottom row, on the ↓ more
  assert.equal(overlayHit(g, 15, 13).kind, "inside"); // bottom row, on the hint
  assert.equal(overlayHit({ ...g, n: 3, scroll: 0 }, 20, 11).kind, "inside"); // past the last line
});

test("hintKey: footer hints to the keys they stand for", () => {
  assert.equal(hintKey("⏎"), "\r");
  assert.equal(hintKey("Esc"), "\x1b");
  assert.equal(hintKey("PgUp"), "\x1b[5~");
  assert.equal(hintKey("→"), "\x1b[C");
  assert.equal(hintKey("?"), "?");
  assert.equal(hintKey(":"), ":");
  assert.equal(hintKey("drag"), null);
});

test("controlRows: no approval buttons of its own (the bar is the one CTA), the input line and its send button are where the hit boxes say", async () => {
  const { controlRows } = await import("../src/tui/control.mjs");
  const now = Date.now();
  const cmd = { id: "c1", mode: "axa", alive: true, status: "ready", name: "axa", cwd: "/tmp", created: now };
  const w = { id: "s1", mode: "claude", alive: true, status: "waiting", name: "web", cwd: "/tmp/web", created: now, choices: { question: "Run it?", options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }] } };
  const ctx = (armed, input = "") => ({ motion: "off", sessions: [cmd, w], act: null, selId: "s1", focusInput: false, input, nameOf: (s) => s.name, question: (c) => c.question, yesOpt: (c) => c.options[0], noOpt: (c) => c.options[1], waiting: w, waitingCount: 1, armed, order: [cmd, w], chats: [], zone: "map", chatSel: 0, cmdStatus: null, mapHits: [], chatHits: [], apHits: [], cmdMsgs: [], cmdScroll: 0 });
  const c = ctx(false), rows = controlRows(c, 160, 50).map(plain);
  const cell = (row, h) => [...rows[row]].slice(h.x0 - 1, h.x1).join("");
  // one urgency component: no buttons of its own (the yellow bar answers), a pointer to it instead
  assert.deepEqual(c.apHits, []);
  assert.ok(rows.some((r) => /answer in the yellow bar: y yes · x no · ! go there/.test(r)));
  assert.match(rows[c.inputRow], /Click here or press : to talk to AXA…/);
  assert.equal(cell(c.inputRow, c.sendHit), " ⏎ send ");
});
