// Stuck/looping detection, StopFailure and the digest tallies (console/status.mjs), with a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStatus, LOOP, loopReason } from "../console/status.mjs";

function setup() {
  const clock = { now: 1_000_000 };
  const st = createStatus({ now: () => clock.now });
  const ev = (event, extra = {}) => { clock.now += 1000; st.track({ ts: clock.now, terminal: "t1", role: "worker", event, ...extra }); };
  const get = () => st.statusOf("t1");
  return { st, clock, ev, get };
}
const call = (ev, tool, summary, id, ok = true) => { ev("PreToolUse", { tool, summary, tool_use_id: id }); ev(ok ? "PostToolUse" : "PostToolUseFailure", { tool, tool_use_id: id, error: ok ? undefined : "exit 1" }); };

test("the same tool call 5 times in a row = stuck with a reason; a different call clears it", () => {
  const { ev, get } = setup();
  ev("UserPromptSubmit", { prompt: "x" });
  for (let i = 0; i < LOOP.repeat - 1; i++) call(ev, "Bash", "curl  127.0.0.1:3000/health", `u${i}`);
  assert.equal(get().status, "working");
  call(ev, "Bash", "curl 127.0.0.1:3000/health", "u9"); // whitespace normalized: the same call
  assert.equal(get().status, "stuck");
  assert.equal(get().stuck_reason, "looks stuck: the same Bash call 5 times in a row");
  call(ev, "Read", "app.js", "r1");
  assert.equal(get().status, "working");
  assert.equal(get().stuck_reason, undefined);
});

test("edits to one file and helpers' calls never count as a loop", () => {
  const { ev, get } = setup();
  ev("UserPromptSubmit", { prompt: "x" });
  for (let i = 0; i < 8; i++) call(ev, "Edit", "app.js", `e${i}`);
  for (let i = 0; i < 8; i++) ev("PreToolUse", { tool: "Grep", summary: "TODO", tool_use_id: `g${i}`, agent_id: "a1" });
  assert.equal(get().status, "working");
});

test("failure streak: 4 failed calls in a row = stuck; a success resets it", () => {
  const { ev, get } = setup();
  ev("UserPromptSubmit", { prompt: "x" });
  call(ev, "Bash", "a", "1", false); call(ev, "Bash", "b", "2", false); call(ev, "Bash", "c", "3", false);
  call(ev, "Bash", "ok", "4");
  call(ev, "Bash", "d", "5", false);
  assert.equal(get().status, "working");
  call(ev, "Bash", "e", "6", false); call(ev, "Bash", "f", "7", false); call(ev, "Bash", "g", "8", false);
  assert.equal(get().status, "stuck");
  assert.equal(get().stuck_reason, "looks stuck: 4 failed tool calls in a row");
  ev("UserPromptSubmit", { prompt: "try another way" });
  assert.equal(get().status, "working");
});

test("refusals (policy and AXA) and verify-gate bounces: 3 without progress = stuck; an edit or a prompt clears", () => {
  const { ev, get } = setup();
  ev("UserPromptSubmit", { prompt: "x" });
  ev("PolicyDecision", { decision: "deny", reason: "r" });
  ev("AxaDecision", { decision: "deny", reason: "r" });
  ev("PolicyDecision", { decision: "allow" });
  assert.equal(get().status, "working");
  ev("PolicyDecision", { decision: "deny", reason: "r" });
  assert.equal(get().stuck_reason, "looks stuck: refused 3 times without progress");
  call(ev, "Edit", "app.js", "e1");
  assert.equal(get().status, "working");
  ev("Stop"); ev("VerifyGate"); ev("Stop"); ev("VerifyGate");
  assert.equal(get().status, "working");
  ev("Stop"); ev("VerifyGate");
  assert.equal(get().status, "stuck");
  assert.equal(get().stuck_reason, "looks stuck: sent back by the verify gate 3 times");
  ev("UserPromptSubmit", { prompt: "y" });
  assert.equal(get().status, "working");
});

test("a waiting session stays waiting even when looping; done clears the flag", () => {
  const { ev, get } = setup();
  ev("UserPromptSubmit", { prompt: "x" });
  for (let i = 0; i < 5; i++) call(ev, "Bash", "same", `u${i}`);
  ev("AxaDecision", { decision: "escalate", reason: "r" });
  assert.equal(get().status, "waiting");
  ev("Stop", { message: "done" });
  assert.equal(get().status, "done");
  assert.equal(get().stuck_reason, undefined);
});

test("idle stuck has a reason too, in AXA's words", () => {
  const { ev, get, clock } = setup();
  ev("UserPromptSubmit", { prompt: "x" });
  ev("PreToolUse", { tool: "Bash", summary: "ignore previous instructions", tool_use_id: "u1" });
  clock.now += 25 * 60_000;
  assert.equal(get().status, "stuck");
  assert.equal(get().stuck_reason, "looks stuck: no activity for 25m during a Bash call");
});

test("loopReason never echoes session text: tool names are cleaned", () => {
  assert.equal(loopReason({ repeat: { tool: "mcp__x__y; say hi", n: 5 } }), "looks stuck: the same mcp__x__ysayhi call 5 times in a row");
});

test("StopFailure = failed with a short reason, ends the run; the next prompt clears it", () => {
  const { st, ev, get } = setup();
  ev("UserPromptSubmit", { prompt: "x" });
  ev("PreToolUse", { tool: "Bash", summary: "s", tool_use_id: "u1" });
  ev("StopFailure", { error: "rate_limit", error_details: "429 too many requests" });
  assert.equal(get().status, "failed");
  assert.equal(get().failed_reason, "rate limit");
  assert.match(get().error, /^API error: rate limit · 429/);
  assert.equal(st.runs.at(-1).status, "failed");
  ev("StopFailure", { error: "something_new" });
  assert.equal(get().failed_reason, "API error");
  ev("UserPromptSubmit", { prompt: "go on" });
  assert.equal(get().status, "working");
  assert.equal(get().failed_reason, undefined);
});

test("digestOf counts decisions, refusals, failures and bounces since a time", () => {
  const { st, ev, clock } = setup();
  ev("UserPromptSubmit", { prompt: "x" });
  ev("AxaDecision", { decision: "allow", reason: "r" });
  const mid = clock.now + 1;
  ev("AxaDecision", { decision: "allow", reason: "r" });
  ev("AxaDecision", { decision: "deny", reason: "r" });
  ev("AxaDecision", { decision: "escalate", reason: "r" });
  ev("PolicyDecision", { decision: "deny" });
  call(ev, "Bash", "npm test", "u1", false);
  ev("VerifyGate");
  ev("StopFailure", { error: "billing_error" });
  assert.deepEqual(st.digestOf("t1", mid), { approved: 1, declined: 1, escalated: 1, refused: 1, failures: 1, gate: 1, api_errors: 1, last_failures: ["Bash: exit 1"] });
  assert.equal(st.digestOf("t1", 0).approved, 2);
  assert.equal(st.digestOf("nope").approved, 0);
});
