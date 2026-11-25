// Three small hub glitches: the needs-you counts agree everywhere, counters say "1 step" not "1 steps", and the
// commander's hints fit whole (never cut mid-word) at 100x30 and 80x24.
import { test } from "node:test";
import assert from "node:assert/strict";
import { needTally, needText } from "../src/tui/lanes.mjs";
import { APPROVE_HINTS, INPUT_HINTS, axaStatusLine, controlRows, fitTag, panel } from "../src/tui/control.mjs";
import { fitFirst, plural, width } from "../src/tui/draw.mjs";

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const NOW = Date.now();
const S = (id, status, o = {}) => ({ id, name: id, mode: "claude", alive: true, status, cwd: `/home/me/${id}`, created: NOW - 60_000, ...o });
const cmd = { ...S("axa", "ready"), mode: "axa", name: "AXA" };
const ctx = (sessions, o = {}) => ({ motion: "off", sessions: [cmd, ...sessions], act: null, selId: null, focusInput: false, input: "", nameOf: (s) => s.name, question: (c) => c.question, yesOpt: () => ({}), noOpt: () => ({}), waiting: null, waitingCount: 0, armed: false, order: [], chats: [], zone: "map", chatSel: 0, cmdStatus: null, mapHits: [], chatHits: [], apHits: [], cmdMsgs: [], cmdScroll: 0, ...o });

test("needs you: the title's chip, the lanes' header and the status line count the same set", () => {
  const ss = [S("a", "waiting"), S("b", "needs_trust"), S("c", "stuck"), S("d", "working"), S("e", "waiting", { alive: false }),
    S("f", "done", { idle_seconds: 99_999 })];
  const t = needTally([cmd, ...ss]);
  assert.deepEqual(t, { need: 2, stuck: 1, total: 3 }, "a dead session doesn't count");
  assert.equal(needText(t), "2 need you · 1 stuck", "the parts visibly add up to the chip's 3");
  assert.equal(needText({ need: 1, stuck: 0 }), "1 needs you");
  assert.equal(needText({ need: 0, stuck: 2 }), "2 stuck");
  assert.equal(needText({ need: 0, stuck: 0 }), "");
  const rows = controlRows(ctx(ss), 160, 45).map(plain);
  assert.match(rows[5], /─ 4 sessions · 2 need you · 1 stuck · 1 idle ─/, "the lanes' header");
  const status = plain(axaStatusLine(cmd, [cmd, ...ss], 200).join("\n"));
  assert.match(status, /5 sessions · 1 working · 2 need you · 1 stuck/, "the commander's status line (idle ones too)");
  // the "Needs you" tile shows the same total as the title's chip
  assert.match(rows[1], /3 {2}NEEDS YOU/);
});

test("counters are singular for one: 1 step, 1 agent, 1 session, 1 run", () => {
  assert.equal(plural(1, "step"), "1 step");
  assert.equal(plural(2, "step"), "2 steps");
  assert.equal(plural(0, "agent"), "0 agents");
  const h = (calls) => ({ id: `h${calls}`, type: "axa:builder", status: "running", calls, start: NOW - 60_000, at: NOW, doing: "Edit x" });
  const one = controlRows(ctx([S("a", "working", { helpers: [h(1)] })], { act: { runs: { today: 1, done: 0 } } }), 160, 45).map(plain).join("\n");
  assert.match(one, /1 step · 1m/); assert.doesNotMatch(one, /1 steps|1 agents|1 sessions|1 runs/);
  assert.match(one, /1 session · 1 agent ─/); assert.match(one, /1 run today/);
  const two = controlRows(ctx([S("a", "working", { helpers: [h(2), h(3)] }), S("b", "working")]), 160, 45).map(plain).join("\n");
  assert.match(two, /2 steps · 1m/); assert.match(two, /2 sessions · 2 agents ─/);
});

test("hints and panel tags fit whole, never cut mid-word", () => {
  assert.equal(fitFirst(INPUT_HINTS, 40), "Click here or press : to talk to AXA…");
  assert.equal(fitFirst(INPUT_HINTS, 23), "Press : to talk to AXA…");
  assert.equal(fitFirst(INPUT_HINTS, 22), "Press : to talk to AXA", "at 100 columns");
  assert.equal(fitFirst(INPUT_HINTS, 13), ": talk to AXA");
  assert.equal(fitFirst(INPUT_HINTS, 5), "");
  assert.equal(fitTag("14 sessions · 3 need you · 27 agents", 30), " 14 sessions · 3 need you ", "whole parts from the start");
  assert.equal(fitTag("27 running", 8), "");
  for (const w of [20, 30, 40]) assert.equal(width(plain(panel("Agents at work", w, 3, [])[0])), w, `a ${w}-wide panel's top edge`);
  // the Control screen at 100x30 (the narrowest that shows it): the commander's input hint and the approval hint
  // are a whole variant; every row is exactly the screen's width
  const w = S("billing", "waiting", { choices: { question: "Do you want to proceed?", options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }] } });
  const many = Array.from({ length: 12 }, (_, i) => S(`p${i}`, "working", { helpers: [{ id: `h${i}`, type: "x:general-purpose", status: "running", calls: 2, start: NOW - 60_000, at: NOW }] }));
  for (const [W, B] of [[100, 28], [120, 34], [160, 45]]) {
    const rows = controlRows(ctx([w, ...many], { waiting: w, waitingCount: 1 }), W, B).map(plain);
    for (const r of rows) assert.equal(width(r), W, `${W}x${B}: ${r}`);
    const all = rows.join("\n");
    assert.ok(INPUT_HINTS.filter(Boolean).some((h) => all.includes(`› ${h}`)), `${W}: a whole input hint`);
    assert.ok(APPROVE_HINTS.filter(Boolean).some((h) => all.includes(`  ${h} `) || all.includes(`  ${h}│`)), `${W}: a whole approval hint`);
    assert.doesNotMatch(all, /› [a-z]{1,3} :|li┐|d…│/, `${W}: nothing cut at the front or mid-word`);
  }
});
