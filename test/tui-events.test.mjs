// The terminal app's event-derived state (console/tui/events.mjs): a replayed history block must
// replace what came before, never add to it (a console restart used to double-count everything).
import test from "node:test";
import assert from "node:assert/strict";
import { createEvents, ingest, replayHistory, parseSse, applyBlock, wakeLimitText, spark, describe } from "../console/tui/events.mjs";

const NOW = 1_800_000_000_000;
const at = (s) => NOW - s * 1000;
const history = [
  { ts: at(600), terminal: "t1", event: "UserPromptSubmit", prompt: "fix the login bug" },
  { ts: at(590), terminal: "t1", event: "PreToolUse", tool: "Read", summary: "src/login.js" },
  { ts: at(580), terminal: "t1", event: "PreToolUse", tool: "Agent", summary: "review the fix", subagent_type: "axa:reviewer", prompt: "review it" },
  { ts: at(570), terminal: "t1", event: "SubagentStart", agent_id: "a1", agent_type: "axa:reviewer" },
  { ts: at(560), terminal: "t1", event: "PreToolUse", agent_id: "a1", tool: "Grep", summary: "login" },
  { ts: at(550), terminal: "t1", event: "PostToolUseFailure", agent_id: "a1", tool: "Bash", error: "exit 1" },
  { ts: at(540), terminal: "t1", event: "SubagentStop", agent_id: "a1", message: "looks good" },
  { ts: at(400), terminal: "t2", event: "PreToolUse", tool: "Edit", summary: "README.md" },
  { ts: at(300), terminal: "t2", event: "AxaDecision", decision: "allow", reason: "read-only" },
  { ts: at(200), terminal: "t2", event: "Stop", message: "done" },
  { ts: at(100), terminal: "t1", event: "PreToolUse", tool: "Edit", summary: "src/login.js" },
];

// a plain snapshot of everything derived (Maps and nested Maps turned into arrays)
const plain = (v) => (v instanceof Map ? [...v.entries()].map(([k, x]) => [k, plain(x)]) : Array.isArray(v) ? v.map(plain) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);
const snap = (st) => plain(st);

test("replaying the same history twice gives the same state as once", () => {
  const once = createEvents();
  replayHistory(once, history, NOW);
  const twice = createEvents();
  replayHistory(twice, history, NOW);
  replayHistory(twice, history, NOW);
  assert.deepEqual(snap(twice), snap(once));
  // and the counts are the real ones, not doubled
  assert.equal(once.helpers.get("t1").length, 1);
  assert.equal(once.helpers.get("t1")[0].calls.get("Grep").count, 1);
  assert.equal(once.helpers.get("t1")[0].failures, 1);
  assert.equal(once.helpers.get("t1")[0].status, "done");
  assert.equal(once.sessCalls.get("t1").get("Edit").count, 1);
  assert.equal(once.activity.get("t1").length, 8);
  assert.equal(once.feed.length, history.filter((e) => describe(e)).length);
});

test("a reconnect's history replaces live events already ingested", () => {
  // live: the app saw the events as they happened; then the console restarted and sent them all again
  const live = createEvents();
  for (const e of history) ingest(live, e, NOW);
  applyBlock(live, { kind: "history", data: JSON.stringify(history) }, NOW);
  const fresh = createEvents();
  replayHistory(fresh, history, NOW);
  assert.deepEqual(snap(live), snap(fresh));
});

test("events after a history block add on top of it", () => {
  const st = createEvents();
  replayHistory(st, history, NOW);
  applyBlock(st, { kind: undefined, data: JSON.stringify({ ts: at(50), terminal: "t1", event: "PreToolUse", tool: "Edit", summary: "b.js" }) }, NOW);
  assert.equal(st.sessCalls.get("t1").get("Edit").count, 2);
  assert.equal(st.activity.get("t1").length, 9);
});

test("SSE parsing: complete blocks out, partial data kept", () => {
  const { blocks, rest } = parseSse(`event: history\ndata: [1,2]\n\n: ping\n\ndata: {"a":1}\n\ndata: {"b"`);
  assert.deepEqual(blocks, [{ kind: "history", data: "[1,2]" }, { kind: undefined, data: '{"a":1}' }]);
  assert.equal(rest, `data: {"b"`);
  // a bad block is skipped, not thrown
  assert.equal(applyBlock(createEvents(), { kind: undefined, data: "{not json" }), false);
});

test("wake limit: shown while in force, cleared once resets_at passes, stale ones ignored", () => {
  const st = createEvents();
  const limit = { ts: at(60), event: "SupervisorLimit", role: "console", terminal: "cmd", limit: 30, pending: ["a", "b", "c"], resets_at: NOW + 10 * 60_000 };
  ingest(st, limit, NOW);
  const text = wakeLimitText(st, NOW);
  assert.match(text, /^AXA wake limit reached \(30\/h\) · 3 updates waiting · resumes \d\d:\d\d$/);
  assert.equal(wakeLimitText(st, NOW + 11 * 60_000), null);
  assert.equal(st.wakeLimit, null);
  // from history, an old one that has already lifted shows nothing
  const old = createEvents();
  replayHistory(old, [{ ...limit, ts: at(7200), resets_at: NOW - 3600_000 }], NOW);
  assert.equal(wakeLimitText(old, NOW), null);
  // a later wake means it lifted
  const woke = createEvents();
  replayHistory(woke, [limit, { ts: at(10), terminal: "cmd", event: "SupervisorWake", items: ["x"] }], NOW);
  assert.equal(wakeLimitText(woke, NOW), null);
  // seconds and ISO dates work as resets_at too
  const sec = createEvents();
  ingest(sec, { ...limit, pending: ["a"], resets_at: Math.floor((NOW + 60_000) / 1000) }, NOW);
  assert.match(wakeLimitText(sec, NOW), /1 update waiting/);
  const iso = createEvents();
  ingest(iso, { ...limit, resets_at: new Date(NOW + 60_000).toISOString() }, NOW);
  assert.ok(wakeLimitText(iso, NOW));
  // a history replay without it clears it
  replayHistory(iso, [], NOW);
  assert.equal(wakeLimitText(iso, NOW), null);
});

test("sparkline needs activity in at least three buckets", () => {
  const st = createEvents();
  replayHistory(st, [at(30), at(400), at(800)].map((ts) => ({ ts, terminal: "t", event: "PreToolUse", tool: "Read" })), NOW);
  assert.equal(spark(st, "t", NOW).length, 10);
  replayHistory(st, [at(30)].map((ts) => ({ ts, terminal: "t", event: "PreToolUse", tool: "Read" })), NOW);
  assert.equal(spark(st, "t", NOW), "");
});
