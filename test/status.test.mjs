// Part B of docs/tasks/reliability.md: correct status detection, replayed from hook event sequences.
// Exits (SessionEnd, or a shell left in the pane), StopFailure (failed / limited), Notification types,
// AskUserQuestion, the submit check, and no false "stuck" while a permission waits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-status-test-")));
process.env.HOME = join(base, "home");
process.env.AXA_HOME = join(base, "axahome");
process.env.AXA_PORT = "4854";
process.env.AXA_SUPERVISOR = "1";
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.AXA_HOME, { recursive: true });

const { trackEvent, statusOf, lastRun } = await import("../src/core/events.mjs");
const S = await import("../src/core/sessions.mjs");
const { parseChoices, promptOnScreen } = await import("../src/core/screen.mjs");
const { deps, supervise } = await import("../src/core/supervisor.mjs");

let n = 0;
const term = () => `t${++n}`;
const ev = (terminal, event, o = {}) => trackEvent({ event, terminal, role: "worker", session: "chat-1", ...o });
const MIN = 60_000;

// ---------- exits ----------
test("SessionEnd marks the session exited; /clear doesn't; a new start makes it ready again", () => {
  const t = term();
  ev(t, "SessionStart"); ev(t, "UserPromptSubmit", { prompt: "x" }); ev(t, "PreToolUse", { tool: "Bash", tool_use_id: "a" });
  ev(t, "SessionEnd", { reason: "clear" });
  assert.equal(statusOf(t).status, "working");
  ev(t, "SessionEnd", { reason: "prompt_input_exit" });
  assert.equal(statusOf(t).status, "exited");
  assert.equal(statusOf(t).inflight.size, 0);
  assert.equal(lastRun(t).status, "exited");
  ev(t, "SessionStart", { session: "chat-2" });
  assert.equal(statusOf(t).status, "ready");
});

test("a SessionEnd of another chat (a nested claude run) doesn't end this session", () => {
  const t = term();
  ev(t, "SessionStart");
  ev(t, "SessionEnd", { reason: "other", session: "nested-run" });
  assert.equal(statusOf(t).status, "ready");
});

test("exited wins in a live pane: from SessionEnd, or a shell left where Claude ran", () => {
  assert.equal(S.deriveStatus({ alive: true, mode: "claude", tr: { status: "exited" } }), "exited");
  assert.equal(S.deriveStatus({ alive: true, mode: "claude", tr: { status: "working" }, gone: true }), "exited");
  assert.equal(S.deriveStatus({ alive: true, mode: "axa", tr: { status: "ready" }, gone: true }), "exited");
  assert.equal(S.deriveStatus({ alive: true, mode: "shell", tr: null, gone: true }), "ready");
  assert.match(S.inputRefusal({ alive: true, mode: "claude", status: "exited", started: true }), /Claude has exited in this session/);
  assert.equal(S.inputRefusal({ alive: true, mode: "shell", status: "ready", started: true }), null);
});

test("a shell in the pane means Claude is gone; Claude's own process names don't", () => {
  for (const c of ["bash", "-bash", "zsh", "sh", "fish", "dash"]) assert.equal(S.claudeGone(c, "/bin/bash"), true, c);
  assert.equal(S.claudeGone("mysh", "/usr/local/bin/mysh"), true);
  for (const c of ["claude", "node", "2.1.30", "", undefined]) assert.equal(S.claudeGone(c, "/bin/bash"), false, String(c));
});

test("the exited wake reaches the commander", async () => {
  const sent = [];
  deps.send = async (id, text) => { sent.push({ id, text }); return { ok: true }; };
  deps.lastInputAt = () => 0;
  deps.log = () => {};
  const cmd = { id: "c1", name: "axa", mode: "axa", alive: true, status: "ready" };
  const w = (status) => ({ id: "w-exit", name: "feed", mode: "claude", alive: true, status });
  supervise([w("working"), cmd]);
  supervise([w("exited"), cmd]);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /feed \(w-exit\) exited/);
});

// ---------- StopFailure ----------
test("StopFailure: a usage limit is 'limited' with its reset time, another error 'failed'", () => {
  const t = term();
  ev(t, "SessionStart"); ev(t, "UserPromptSubmit", { prompt: "x" }); ev(t, "PreToolUse", { tool: "Bash", tool_use_id: "a" });
  ev(t, "StopFailure", { error: "rate_limit", error_details: "Claude usage limit reached. Your limit resets 3pm (Europe/Paris)." });
  let s = statusOf(t);
  assert.equal(s.status, "limited");
  assert.equal(s.limit_resets, "3pm (Europe/Paris)");
  assert.equal(s.inflight.size, 0);
  assert.equal(lastRun(t).status, "limited");
  ev(t, "UserPromptSubmit", { prompt: "go on" });
  assert.equal(statusOf(t).status, "working");
  assert.equal(statusOf(t).limit_resets, undefined);
  ev(t, "StopFailure", { error: "server_error", error_details: "API Error: 500 Internal server error" });
  s = statusOf(t);
  assert.equal(s.status, "failed");
  assert.match(s.error, /server_error: API Error: 500/);
  assert.equal(lastRun(t).status, "failed");
  ev(t, "StopFailure", { error: "billing_error" });
  assert.equal(statusOf(t).status, "limited");
});

// ---------- Notification types ----------
test("notification types map to waiting / ready / limited", () => {
  const t = term();
  ev(t, "SessionStart"); ev(t, "UserPromptSubmit", { prompt: "x" });
  ev(t, "Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  assert.equal(statusOf(t).status, "waiting");
  ev(t, "PostToolUse", { tool: "Bash" });
  assert.equal(statusOf(t).status, "working");
  for (const type of ["elicitation_dialog", "agent_needs_input"]) {
    ev(t, "Notification", { notification_type: type, message: "input needed" });
    assert.equal(statusOf(t).status, "waiting", type);
    ev(t, "PostToolUse", { tool: "x" });
  }
  // idle: a working session that went quiet is ready; a finished one keeps "done"
  ev(t, "PreToolUse", { tool: "Bash", tool_use_id: "q" });
  ev(t, "Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" });
  assert.equal(statusOf(t).status, "ready");
  assert.equal(statusOf(t).inflight.size, 0);
  ev(t, "UserPromptSubmit", { prompt: "y" }); ev(t, "Stop", { message: "all done" });
  ev(t, "Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" });
  assert.equal(statusOf(t).status, "done");
  // usage notices: limited, with the reset time
  ev(t, "Notification", { notification_type: "usage_limit", message: "You've hit your usage limit · resets at 5pm" });
  assert.equal(statusOf(t).status, "limited");
  assert.equal(statusOf(t).limit_resets, "5pm");
  ev(t, "UserPromptSubmit", { prompt: "z" });
  ev(t, "Notification", { message: "Approaching your quota" });
  assert.equal(statusOf(t).status, "limited");
  // a type with no meaning for status changes nothing
  ev(t, "UserPromptSubmit", { prompt: "w" });
  ev(t, "Notification", { notification_type: "auth_success", message: "Signed in" });
  assert.equal(statusOf(t).status, "working");
  // older Claude Code: no type, the message says permission
  ev(t, "Notification", { message: "Claude needs your permission to use Write" });
  assert.equal(statusOf(t).status, "waiting");
});

// ---------- AskUserQuestion ----------
test("an AskUserQuestion waits for the user until it's answered, even through an idle notice", () => {
  const t = term();
  ev(t, "SessionStart"); ev(t, "UserPromptSubmit", { prompt: "x" });
  ev(t, "PreToolUse", { tool: "AskUserQuestion", tool_use_id: "q1", summary: "Which database should I use?" });
  let s = statusOf(t);
  assert.equal(s.status, "waiting");
  assert.match(s.doing, /asks you: Which database/);
  assert.equal(s.inflight.size, 0);
  ev(t, "Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" });
  assert.equal(statusOf(t).status, "waiting");
  ev(t, "PostToolUse", { tool: "AskUserQuestion", tool_use_id: "q1" });
  assert.equal(statusOf(t).status, "working");
});

test("AskUserQuestion menus ('Enter to select') are read off the screen", () => {
  const screen = ["", "☐ Database", "", "Which database should I use?", "", "❯ 1. Postgres", "     Relational, what we use elsewhere", "  2. SQLite", "     A file, no server", "  3. Type something.", "", "Enter to select · ↑/↓ to navigate · Esc to cancel"];
  assert.equal(promptOnScreen(screen), true);
  const c = parseChoices(screen);
  assert.deepEqual(c.options.map((o) => o.label), ["Postgres", "SQLite", "Type something."]);
  assert.equal(c.cursor, 0);
  assert.match(c.question, /Which database/);
  // the plain input box isn't a menu
  assert.equal(promptOnScreen(["", "> ", "  ? for shortcuts"]), false);
});

test("the question's text is what the log records for AskUserQuestion", () => {
  const src = readFileSync(fileURLToPath(new URL("../hooks/log-event.mjs", import.meta.url)), "utf8");
  assert.match(src, /case "AskUserQuestion"/);
  const hooks = JSON.parse(readFileSync(fileURLToPath(new URL("../hooks/hooks.json", import.meta.url)), "utf8")).hooks;
  for (const h of ["SessionEnd", "StopFailure"]) assert.match(hooks[h][0].hooks[0].command, /log-event\.mjs/, h);
});

// ---------- submit check ----------
test("submit check: confirmed at once, after one more Enter, or an error", async () => {
  let presses = 0, seenAfter = Infinity, checks = 0;
  const run = (o) => S.confirmSubmit({ seen: () => ++checks > seenAfter, pressEnter: () => presses++, promptOpen: () => false, ms: 60, every: 5, ...o });
  seenAfter = 0;
  assert.deepEqual(await run({}), { ok: true, submitted: true });
  assert.equal(presses, 0);
  checks = 0; seenAfter = Infinity;
  let r = await run({ seen: () => presses > 0 });
  assert.deepEqual(r, { ok: true, submitted: true, retried: true });
  assert.equal(presses, 1);
  presses = 0;
  r = await run({ seen: () => false });
  assert.equal(r.ok, false);
  assert.equal(r.unsubmitted, true);
  assert.match(r.error, /didn't confirm the submit/);
  assert.equal(presses, 1);
  // a dialog opened instead: Enter would answer it, so it isn't pressed
  presses = 0;
  r = await run({ seen: () => false, promptOpen: () => true });
  assert.equal(r.ok, false);
  assert.match(r.error, /a prompt opened/);
  assert.equal(presses, 0);
});

test("a link whose text wasn't confirmed submitted is not marked fired, and never retyped", async () => {
  const src = readFileSync(fileURLToPath(new URL("../src/core/supervisor.mjs", import.meta.url)), "utf8");
  assert.match(src, /r\.unsubmitted\) \{ ch\.failed = r\.error; saveChains\(\); \} return; \}\n\s*ch\.fired = Date\.now\(\)/);
});

test("an unconfirmed supervisor wake isn't typed again on the next tick", async () => {
  const sent = [], logged = [];
  deps.send = async (id, text) => { sent.push(text); return { ok: false, unsubmitted: true, error: "not confirmed" }; };
  deps.lastInputAt = () => 0;
  deps.log = (e) => logged.push(e);
  const cmd = { id: "c2", name: "axa", mode: "axa", alive: true, status: "ready" };
  const w = (status) => ({ id: "w-unsub", name: "api", mode: "claude", alive: true, status });
  supervise([w("working"), cmd]);
  supervise([w("exited"), cmd]);
  await new Promise((r) => setTimeout(r, 5));
  supervise([w("exited"), cmd]);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent.filter((t) => t.includes("w-unsub")).length, 1);
  assert.equal(logged.at(-1).unsubmitted, true);
});

// ---------- stuck ----------
test("a permission wait never counts toward stuck (the 40-minute approval case)", () => {
  const t = term(), T = Date.now() - 90 * MIN;
  ev(t, "SessionStart", { ts: T - 1000 });
  ev(t, "UserPromptSubmit", { prompt: "x", ts: T });
  ev(t, "PreToolUse", { tool: "Bash", tool_use_id: "a", ts: T });
  ev(t, "PermissionRequest", { tool: "Bash", ts: T + 1000 });
  ev(t, "AxaDecision", { decision: "escalate", reason: "a one-way door", ts: T + 2000 });
  // waiting on the user, however long: waiting, never stuck
  assert.equal(statusOf(t).status, "waiting");
  // approved after 40 minutes; the step's PostToolUse never came, the worker carried on
  ev(t, "PreToolUse", { tool: "Edit", tool_use_id: "b", ts: T + 42 * MIN });
  ev(t, "PostToolUse", { tool: "Edit", tool_use_id: "b", ts: T + 43 * MIN });
  ev(t, "PreToolUse", { tool: "Bash", tool_use_id: "c", ts: Date.now() - 2 * MIN });
  assert.equal(statusOf(t).status, "working");
  // then silent for 25 minutes: stuck, and step a's age leaves out its 42-minute wait
  const t2 = term(), U = Date.now() - 90 * MIN;
  ev(t2, "SessionStart", { ts: U - 1000 });
  ev(t2, "UserPromptSubmit", { prompt: "x", ts: U });
  ev(t2, "PreToolUse", { tool: "Bash", tool_use_id: "a", ts: U });
  ev(t2, "Notification", { notification_type: "permission_prompt", message: "needs permission", ts: U + 1000 });
  ev(t2, "PostToolUse", { tool: "Bash", tool_use_id: "zz", ts: U + 41 * MIN });
  ev(t2, "PreToolUse", { tool: "Bash", tool_use_id: "b", ts: Date.now() - 25 * MIN });
  const s = statusOf(t2);
  assert.equal(s.status, "stuck");
  assert.ok(s.stuck_minutes <= 50 && s.stuck_minutes >= 48, `stuck_minutes ${s.stuck_minutes}`);
});

test("the approver deciding for a long time is waiting, not stuck", () => {
  const t = term(), T = Date.now() - 60 * MIN;
  ev(t, "SessionStart", { ts: T - 1000 });
  ev(t, "UserPromptSubmit", { prompt: "x", ts: T });
  ev(t, "PreToolUse", { tool: "Bash", tool_use_id: "a", ts: T });
  ev(t, "PermissionRequest", { tool: "Bash", ts: T + 1000 });
  assert.equal(statusOf(t).status, "waiting");
  assert.equal(statusOf(t).stuck_minutes, undefined);
});

test("work right after a long wait isn't stuck", () => {
  const t = term(), T = Date.now() - 50 * MIN;
  ev(t, "SessionStart", { ts: T - 1000 });
  ev(t, "UserPromptSubmit", { prompt: "x", ts: T });
  ev(t, "PreToolUse", { tool: "Bash", tool_use_id: "a", ts: T });
  ev(t, "Notification", { notification_type: "permission_prompt", message: "needs permission", ts: T + 1000 });
  ev(t, "UserAnswer", { answer: "Yes", ts: Date.now() - 5 * MIN, role: "console" });
  assert.equal(statusOf(t).status, "working");
});

test("a shell wrapper with Claude still running as its child is not an exit", async () => {
  assert.equal(S.paneCommandOf("bash", "123", () => true), "claude");
  assert.equal(S.claudeGone(S.paneCommandOf("bash", "123", () => true), "/bin/bash"), false);
  assert.equal(S.claudeGone(S.paneCommandOf("bash", "123", () => false), "/bin/bash"), true);
  assert.equal(S.paneCommandOf("node", "123", () => false), "node");
  // a $SHELL outside the known names is child-checked too
  assert.equal(S.paneCommandOf("mysh", "123", () => true, "/opt/bin/mysh"), "claude");
  assert.equal(S.claudeGone(S.paneCommandOf("mysh", "123", () => false, "/opt/bin/mysh"), "/opt/bin/mysh"), true);
  // the real child check (pgrep -P): this process has a child while one runs
  const { spawn } = await import("node:child_process");
  const kid = spawn("sleep", ["5"]);
  assert.equal(S.paneCommandOf("bash", String(process.pid)), "claude");
  kid.kill();
  await new Promise((r) => kid.on("exit", r));
});
