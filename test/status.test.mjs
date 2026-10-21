// The session status state machine and run tracking (console/status.mjs), with a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStatus, STUCK_MS, APPROVER_MS } from "../console/status.mjs";

// A status tracker for one session "t1" whose clock is `clock.now`; ev() logs an event at that time
function setup(opts = {}) {
  const clock = { now: 1_000_000 };
  const st = createStatus({ now: () => clock.now, ...opts });
  const ev = (event, extra = {}) => st.track({ ts: clock.now, terminal: "t1", role: "worker", event, ...extra });
  const tick = (ms) => (clock.now += ms);
  const status = () => st.statusOf("t1")?.status;
  return { st, clock, ev, tick, status };
}

test("prompt, tool, Stop = done with its report", () => {
  const { st, ev, tick, status } = setup();
  ev("SessionStart", { session: "s1" });
  assert.equal(status(), "ready");
  ev("UserPromptSubmit", { prompt: "fix the bug" });
  assert.equal(status(), "working");
  tick(1000); ev("PreToolUse", { tool: "Bash", summary: "npm test", tool_use_id: "u1" });
  assert.equal(st.statusOf("t1").doing, "Bash · npm test");
  tick(1000); ev("PostToolUse", { tool: "Bash", tool_use_id: "u1" });
  tick(1000); ev("Stop", { message: "Fixed it." });
  assert.equal(status(), "done");
  assert.equal(st.statusOf("t1").report, "Fixed it.");
  assert.equal(st.statusOf("t1").inflight.size, 0);
});

test("verify-gate bounce: Stop then VerifyGate stays working, a later real Stop = done", () => {
  const { ev, tick, status } = setup();
  ev("UserPromptSubmit", { prompt: "x" });
  tick(1000); ev("Stop");
  assert.equal(status(), "done");
  tick(200); ev("VerifyGate");
  assert.equal(status(), "working");
  tick(30_000); ev("Stop", { message: "Checked and done." });
  assert.equal(status(), "done");
});

test("verify-gate bounce: VerifyGate then Stop stays working, a later real Stop = done", () => {
  const { st, ev, tick, status } = setup();
  ev("UserPromptSubmit", { prompt: "x" });
  tick(1000); ev("VerifyGate");
  tick(300); ev("Stop");
  assert.equal(status(), "working");
  assert.match(st.statusOf("t1").doing, /verify gate/);
  tick(20_000); ev("Stop", { message: "ok" });
  assert.equal(status(), "done");
});

test("a VerifyGate long after a Stop is its own bounce, not the Stop's", () => {
  const { ev, tick, status } = setup();
  ev("UserPromptSubmit", { prompt: "x" });
  tick(1000); ev("Stop");
  tick(15_000); ev("VerifyGate");
  assert.equal(status(), "working");
  tick(500); ev("Stop"); // pairs with that VerifyGate: still checking
  assert.equal(status(), "working");
});

test("worker PermissionRequest = working + asking, waiting after the approver timeout", () => {
  const { st, ev, tick, status } = setup();
  ev("UserPromptSubmit", { prompt: "x" });
  ev("PermissionRequest", { tool: "Bash", summary: "rm -rf build" });
  assert.equal(status(), "working");
  assert.ok(st.statusOf("t1").asking);
  assert.match(st.statusOf("t1").doing, /^AXA reviewing/);
  tick(APPROVER_MS - 1000);
  assert.equal(status(), "working");
  tick(2000);
  assert.equal(status(), "waiting");
  assert.equal(APPROVER_MS, 75_000);
});

test("non-worker PermissionRequest = waiting at once", () => {
  const { st, status } = setup();
  st.track({ ts: 1_000_000, terminal: "t1", role: "commander", event: "PermissionRequest", tool: "Bash", summary: "git push" });
  assert.equal(status(), "waiting");
  assert.match(st.statusOf("t1").doing, /^needs approval/);
});

test("AxaDecision: escalate = waiting, allow keeps working", () => {
  const { st, ev, status } = setup();
  ev("UserPromptSubmit", { prompt: "x" });
  ev("PermissionRequest", { tool: "Bash", summary: "npm i" });
  ev("AxaDecision", { decision: "allow", reason: "routine" });
  assert.equal(status(), "working");
  assert.equal(st.statusOf("t1").asking, null);
  assert.match(st.statusOf("t1").doing, /AXA approved/);
  ev("PermissionRequest", { tool: "Bash", summary: "npm publish" });
  ev("AxaDecision", { decision: "escalate", reason: "one-way door" });
  assert.equal(status(), "waiting");
  assert.equal(st.statusOf("t1").decisions.length, 2);
});

test("UserAnswer: declining = ready, anything else = working", () => {
  const { ev, status } = setup();
  ev("UserPromptSubmit", { prompt: "x" });
  ev("Notification", { message: "Claude needs your permission to use Bash" });
  assert.equal(status(), "waiting");
  ev("UserAnswer", { answer: "No, and tell Claude what to do differently (esc)" });
  assert.equal(status(), "ready");
  ev("Notification", { message: "Claude needs your permission to use Bash" });
  ev("UserAnswer", { answer: "Yes" });
  assert.equal(status(), "working");
});

test("stuck after the in-flight timeout, measured from the last event", () => {
  const { st, ev, tick, status } = setup({ stuckMs: STUCK_MS });
  ev("UserPromptSubmit", { prompt: "x" });
  ev("PreToolUse", { tool: "Agent", summary: "research", tool_use_id: "a1" });
  tick(STUCK_MS - 60_000);
  ev("PreToolUse", { tool: "Read", summary: "f", tool_use_id: "r1", agent_id: "helper" }); // the helper is still busy
  tick(STUCK_MS - 1000);
  assert.equal(status(), "working");
  tick(2000);
  assert.equal(status(), "stuck");
  assert.equal(st.statusOf("t1").stuck_minutes, Math.round((2 * STUCK_MS - 59_000) / 60_000));
  // nothing in flight: never stuck
  ev("PostToolUse", { tool_use_id: "a1" }); ev("PostToolUse", { tool_use_id: "r1" });
  tick(STUCK_MS * 2);
  assert.equal(status(), "working");
});

test("a waiting session isn't stuck, and PostToolUse brings it back to working", () => {
  const { ev, tick, status } = setup();
  ev("UserPromptSubmit", { prompt: "x" });
  ev("PreToolUse", { tool: "Bash", tool_use_id: "u1" });
  ev("Notification", { message: "permission needed" });
  tick(STUCK_MS * 2);
  assert.equal(status(), "waiting");
  ev("PostToolUse", { tool_use_id: "u1" });
  assert.equal(status(), "working");
});

test("SessionStart names the chat (not on compact), and unknown sessions have no status", () => {
  const chats = [];
  const { st, ev } = setup({ onChat: (t, s) => chats.push([t, s]) });
  ev("SessionStart", { session: "chat-1" });
  ev("SessionStart", { session: "chat-2", source: "compact" });
  st.track({ ts: 1, terminal: "t1", event: "SessionStart", session: "chat-3" }); // no role: a claude run inside
  assert.deepEqual(chats, [["t1", "chat-1"]]);
  assert.equal(st.statusOf("nope"), undefined);
  st.track({ event: "Stop" }); // no terminal: ignored
  assert.equal(st.sessions.size, 1);
});

test("runs: steps, helpers, approvals, gate count, done on the real Stop", () => {
  const { st, ev, tick } = setup();
  ev("UserPromptSubmit", { prompt: "build it", cwd: "/home/dev/shop" });
  ev("PreToolUse", { tool: "Read", tool_use_id: "1" });
  ev("PreToolUse", { tool: "Agent", tool_use_id: "2" });
  ev("PreToolUse", { tool: "Grep", tool_use_id: "3", agent_id: "h1" }); // a helper's own step: not counted
  ev("PreToolUse", { tool: "Task", tool_use_id: "4" });
  ev("AxaDecision", { decision: "allow", reason: "r" });
  ev("AxaDecision", { decision: "deny", reason: "r" });
  ev("AxaDecision", { decision: "escalate", reason: "r" });
  ev("PolicyDecision", { decision: "deny" });
  ev("PostToolUseFailure", { tool: "Bash", error: "exit 1" });
  ev("UserAnswer", { answer: "Yes" });
  // (gate logged first: with Stop first, today's trackRun closes the run at that Stop)
  tick(1000); ev("VerifyGate");
  tick(100); ev("Stop");
  let [run] = st.runs;
  assert.equal(run.status, "running"); // the bounce isn't the end
  tick(5000); ev("Stop", { message: "Built and tested." });
  [run] = st.runs;
  assert.deepEqual({ steps: run.steps, helpers: run.helpers, approvals: run.approvals, declined: run.declined, escalated: run.escalated, refused: run.refused, gate: run.gate, failures: run.failures, answers: run.answers },
    { steps: 3, helpers: 2, approvals: 1, declined: 1, escalated: 1, refused: 1, gate: 1, failures: 1, answers: ["Yes"] });
  assert.equal(run.status, "done");
  assert.equal(run.report, "Built and tested.");
  assert.equal(run.prompt, "build it");
  // runsSince names runs by their open session, marks closed sessions' open runs unfinished
  ev("UserPromptSubmit", { prompt: "next", cwd: "/home/dev/shop" });
  const open = st.runsSince(0, 10, [{ id: "t1", name: "shop", mode: "claude", alive: true }]);
  assert.deepEqual(open.map((r) => [r.name, r.status]), [["shop", "running"], ["shop", "done"]]);
  const closed = st.runsSince(0, 10, []);
  assert.deepEqual(closed.map((r) => [r.name, r.status]), [["shop", "unfinished"], ["shop", "done"]]);
});

test("runs: a new prompt replaces the open run; task notifications don't start one; capped", () => {
  const { st, ev, tick } = setup({ runsMax: 3 });
  ev("UserPromptSubmit", { prompt: "one" });
  tick(1); ev("UserPromptSubmit", { prompt: "<task-notification>helper done</task-notification>" });
  assert.equal(st.runs.length, 1);
  tick(1); ev("UserPromptSubmit", { prompt: "two" });
  assert.equal(st.runs[0].status, "replaced");
  for (let i = 0; i < 5; i++) { tick(1); ev("UserPromptSubmit", { prompt: `p${i}` }); }
  assert.equal(st.runs.length, 3);
  assert.equal(st.runs.at(-1).prompt, "p4");
});
