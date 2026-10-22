// Session status and run history from traced events: a pure state machine (no files, no timers) so
// it can be unit-tested. The server feeds it every event from the log (track) and asks it for a
// session's status (statusOf) and the run history (runsSince). Time comes from `now`, injectable.
import { basename } from "node:path";

// Each Claude session AXA starts tags its events with AXA_TERMINAL_ID; the latest events say
// whether it's working, done (and its last report), waiting on the user, or failed.
// "Stuck": a tool started and nothing has happened in the session for STUCK_MS. Measured from the
// session's last event (not the tool's start) so a long helper agent that is still busy isn't flagged.
export const STUCK_MS = 20 * 60_000;
export const APPROVER_MS = 75_000; // longer than the approver hook's own timeout
export const GATE_MS = 10_000; // a Stop and its VerifyGate are logged this close together
export const RUNS_MAX = 1000;
// Looping, beyond the idle timer: the same tool call this many times in a row, this many refusals
// (AXA or policy) or verify-gate bounces since the last real progress, or a streak of failed tool
// calls. The session is flagged to the user ("looks stuck: ..."), never stopped.
export const LOOP = { repeat: 5, denied: 3, gate: 3, failures: 4 };
// Edits to one file look alike in the log (only the file name is traced): never counted as a loop
const NO_REPEAT = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "TodoWrite"]);
const PROGRESS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// StopFailure: the turn ended on an API error (Claude Code's error codes), in a few words
export const FAILURE = { rate_limit: "rate limit", overloaded: "overloaded", authentication_failed: "login needed", oauth_org_not_allowed: "organization not allowed", account_on_hold: "account on hold", billing_error: "billing", invalid_request: "invalid request", model_not_found: "model not found", server_error: "server error", max_output_tokens: "output too long", cloud_credential_error: "cloud credentials" };
export const failureText = (code) => FAILURE[code] || "API error";
// Tool names go into the reason, which reaches the supervisor note and phone pushes: plain names only
const toolName = (t) => String(t || "tool").replace(/[^\w.-]/g, "").slice(0, 40) || "tool";
// Why a working session looks stuck, in AXA's own words (never session text), or undefined
export function loopReason(s, limits = LOOP) {
  if (s.repeat?.n >= limits.repeat) return `looks stuck: the same ${toolName(s.repeat.tool)} call ${s.repeat.n} times in a row`;
  if (s.failStreak >= limits.failures) return `looks stuck: ${s.failStreak} failed tool calls in a row`;
  if (s.denied >= limits.denied) return `looks stuck: refused ${s.denied} times without progress`;
  if (s.gates >= limits.gate) return `looks stuck: sent back by the verify gate ${s.gates} times`;
}
const TALLY_MAX = 300; // per session: recent decisions and failures, for the commander's digest
const clipText = (v, n) => (v == null ? undefined : String(v).slice(0, n));

// onChat(terminal, chatId): a session's own start (or /clear) named the Claude chat it runs
export function createStatus({ stuckMs = STUCK_MS, approverMs = APPROVER_MS, runsMax = RUNS_MAX, loop = LOOP, now = Date.now, onChat } = {}) {
  const sessions = new Map(); // terminal id -> { status, doing, report, error, at, inflight, asking, ... }
  function statusOf(id) {
    const s = sessions.get(id);
    if (!s) return s;
    // AXA's approver normally answers within seconds; a request still open after that is on screen
    if (s.status === "working" && s.asking && now() - s.asking > approverMs) return { ...s, status: "waiting" };
    if (s.status === "working" && s.inflight?.size && now() - s.at > stuckMs) {
      const [first] = s.inflight.values(), mins = Math.round((now() - first.since) / 60_000);
      return { ...s, status: "stuck", stuck_minutes: mins, stuck_reason: s.loop || `looks stuck: no activity for ${Math.round((now() - s.at) / 60_000)}m during a ${toolName(first.tool)} call` };
    }
    if (s.status === "working" && s.loop) return { ...s, status: "stuck", stuck_reason: s.loop };
    return s;
  }
  // What happened in a session since `since` (ms): AXA's decisions, refusals, failures, gate bounces
  function digestOf(id, since = 0) {
    const d = { approved: 0, declined: 0, escalated: 0, refused: 0, failures: 0, gate: 0, api_errors: 0, last_failures: [] };
    for (const x of sessions.get(id)?.tally || []) {
      if (x.ts < since) continue;
      d[x.k]++;
      if (x.k === "failures" && x.text) d.last_failures.push(x.text);
    }
    d.last_failures = d.last_failures.slice(-3);
    return d;
  }
  const tally = (s, ts, k, text) => { (s.tally ||= []).push({ ts, k, text }); if (s.tally.length > TALLY_MAX) s.tally.splice(0, s.tally.length - TALLY_MAX); };
  const resetLoop = (s) => { s.repeat = null; s.failStreak = s.denied = s.gates = 0; };
  function track(e) {
    if (!e?.terminal) return;
    // Remember which Claude chat each session runs, so it can be resumed after a machine restart
    // Only a session's own start (or /clear) names its chat, so a Claude run *inside* a session
    // (e.g. `claude -p` from its Bash tool) can't replace the chat that gets resumed after a reboot
    if (e.session && e.event === "SessionStart" && e.role && e.source !== "compact") onChat?.(e.terminal, e.session);
    const s = sessions.get(e.terminal) || { inflight: new Map() };
    s.at = e.ts;
    if (e.session && e.role) s.session = e.session;
    switch (e.event) {
      case "SessionStart": s.status = "ready"; s.inflight.clear(); s.failed_reason = undefined; resetLoop(s); break;
      case "UserPromptSubmit": s.status = "working"; s.doing = "reading the instruction"; s.tool = s.summary = undefined; s.error = s.failed_reason = undefined; s.asking = null; s.stopAt = s.gateAt = null; s.inflight.clear(); resetLoop(s); break;
      case "PreToolUse": {
        s.status = "working"; s.doing = [e.tool, e.summary].filter(Boolean).join(" · "); s.tool = e.tool; s.summary = e.skill || e.summary; s.skill = e.skill;
        if (e.tool_use_id) s.inflight.set(e.tool_use_id, { tool: e.tool, summary: e.summary, since: e.ts });
        // the same call again and again (helpers' calls interleave, so only the session's own count)
        const key = `${e.tool}\u0000${String(e.summary ?? "").replace(/\s+/g, " ").trim()}`;
        if (!e.agent_id && !NO_REPEAT.has(e.tool)) s.repeat = s.repeat?.key === key ? { ...s.repeat, n: s.repeat.n + 1 } : { key, tool: e.tool, n: 1 };
        else if (!e.agent_id) s.repeat = null;
        break;
      }
      case "PostToolUse":
        if (s.status === "waiting") s.status = "working"; s.asking = null; s.inflight.delete(e.tool_use_id);
        if (!e.agent_id) s.failStreak = 0;
        // real progress: a change to a file clears refusals and gate bounces counted so far
        if (PROGRESS.has(e.tool)) s.denied = s.gates = 0;
        break;
      case "PostToolUseFailure":
        s.error = [e.tool, e.error].filter(Boolean).join(": "); s.asking = null; s.inflight.delete(e.tool_use_id);
        if (!e.agent_id) s.failStreak = (s.failStreak || 0) + 1;
        tally(s, e.ts, "failures", clipText(s.error, 160));
        break;
      // The turn ended on an API error (rate limit, billing...): it stops until the user steps in
      case "StopFailure":
        s.status = "failed"; s.failed_reason = failureText(e.error); s.doing = s.tool = s.summary = s.skill = undefined; s.asking = null; s.inflight.clear();
        s.error = [`API error: ${s.failed_reason}`, e.error_details].filter(Boolean).join(" · ");
        tally(s, e.ts, "api_errors"); break;
      case "PolicyDecision": if (e.decision === "deny") { s.denied = (s.denied || 0) + 1; tally(s, e.ts, "refused"); } break;
      // A permission request goes to AXA's approver first (hooks/approver.mjs). The session only waits
      // on the user when the approver escalates it, or the prompt is still open after approverMs.
      case "PermissionRequest":
        if (e.role === "worker") { s.status = "working"; s.asking = e.ts; s.doing = `AXA reviewing · ${[e.tool, e.summary].filter(Boolean).join(" ")}`; }
        else { s.status = "waiting"; s.doing = `needs approval · ${[e.tool, e.summary].filter(Boolean).join(" ")}`; }
        s.tool = e.tool; s.summary = e.summary; break;
      case "AxaDecision":
        s.asking = null;
        if (e.decision === "escalate") { s.status = "waiting"; s.doing = `needs your approval · ${e.reason}`; }
        else s.doing = `AXA ${e.decision === "allow" ? "approved" : "declined"} · ${e.reason}`;
        s.decisions = [...(s.decisions || []), { ts: e.ts, decision: e.decision, reason: e.reason, summary: e.summary, by: e.by }].slice(-20);
        if (e.decision === "deny") s.denied = (s.denied || 0) + 1;
        tally(s, e.ts, e.decision === "allow" ? "approved" : e.decision === "deny" ? "declined" : "escalated");
        break;
      case "Notification": if (/permission/i.test(e.notification_type || e.message || "")) { s.status = "waiting"; s.asking = null; s.doing = e.message; } break;
      case "Stop":
        // AXA's verify gate sent it back to check its work (hooks/verify-gate.mjs): it isn't done yet
        // (the two hooks log in either order; each marker is used once)
        if (s.gateAt && Math.abs(e.ts - s.gateAt) < GATE_MS) { s.gateAt = null; s.status = "working"; s.doing = "AXA verify gate: checking its work before reporting"; break; }
        // (refusals and gate bounces still count: its Stop is logged before a VerifyGate that reopens it)
        s.stopAt = e.ts; s.repeat = null; s.failStreak = 0;
        s.status = "done"; s.doing = s.tool = s.summary = s.skill = undefined; s.asking = null; s.inflight.clear(); if (e.message) s.report = e.message; break;
      case "VerifyGate":
        if (s.stopAt && e.ts - s.stopAt < GATE_MS) s.stopAt = null; // its Stop was already logged
        else s.gateAt = e.ts;
        s.gates = (s.gates || 0) + 1; tally(s, e.ts, "gate");
        s.status = "working"; s.doing = "AXA verify gate: checking its work before reporting"; break;
      // You answered its prompt from the console. Declining stops the step and Claude waits for you (no
      // other event follows), so it's ready for the next instruction; anything else lets it carry on.
      case "UserAnswer":
        s.asking = null;
        if (/^(?:no\b|continue without|cancel|deny|reject|don'?t)/i.test(e.answer || "")) { s.status = "ready"; s.doing = `you declined (${e.answer}); waiting for the next instruction`; s.inflight.clear(); }
        else { s.status = "working"; s.doing = `you answered: ${e.answer}`; }
        break;
    }
    s.loop = loopReason(s, loop);
    sessions.set(e.terminal, s);
    trackRun(e, s);
  }

  // ---------- runs: each instruction a session got, from the prompt to its result ----------
  // For the run history and the "since you left" briefing. Rebuilt from the event log on start.
  const runs = [], openRuns = new Map(); // terminal -> its current run
  const closedRuns = new Map(); // terminal -> { run, at }: its run that a Stop just ended
  function trackRun(e, s) {
    let r = openRuns.get(e.terminal);
    // A Stop logged just before its VerifyGate closed the run too early: the gate bounce reopens it
    const shut = closedRuns.get(e.terminal);
    if (!r && e.event === "VerifyGate" && shut && e.ts - shut.at < GATE_MS) {
      r = shut.run; r.status = "running"; r.end = r.report = undefined; openRuns.set(e.terminal, r); closedRuns.delete(e.terminal);
    }
    if (e.event === "UserPromptSubmit") {
      closedRuns.delete(e.terminal);
      if (/^\s*<task-notification>/.test(e.prompt || "")) return;
      if (r) { r.status = "replaced"; r.end = e.ts; }
      const run = { id: `${e.terminal}-${e.ts}`, terminal: e.terminal, cwd: e.cwd, role: e.role, prompt: clipText(e.prompt, 400), start: e.ts, steps: 0, helpers: 0, approvals: 0, declined: 0, escalated: 0, refused: 0, gate: 0, failures: 0, answers: [], status: "running" };
      runs.push(run); openRuns.set(e.terminal, run);
      if (runs.length > runsMax) runs.splice(0, runs.length - runsMax);
      return;
    }
    if (!r) return;
    switch (e.event) {
      case "PreToolUse": if (!e.agent_id) { r.steps++; if (e.tool === "Agent" || e.tool === "Task") r.helpers++; } break;
      case "PostToolUseFailure": r.failures++; break;
      case "AxaDecision": if (e.decision === "allow") r.approvals++; else if (e.decision === "deny") r.declined++; else r.escalated++; break;
      case "PolicyDecision": if (e.decision === "deny") r.refused++; break;
      case "VerifyGate": r.gate++; break;
      case "UserAnswer": r.answers.push(clipText(e.answer, 80)); break;
      // a verify-gate bounce isn't the end of the run (track() keeps it "working")
      case "StopFailure": r.status = "failed"; r.end = e.ts; r.report = `API error: ${failureText(e.error)}`; openRuns.delete(e.terminal); break;
      case "Stop": if (s.status === "done") { r.status = "done"; r.end = e.ts; r.report = clipText(e.message, 600); openRuns.delete(e.terminal); closedRuns.set(e.terminal, { run: r, at: e.ts }); } break;
    }
  }
  // termList: the open sessions (listTerms()), to name each run and mark runs whose session is gone
  function runsSince(since, limit, termList = []) {
    const terms = new Map(termList.map((t) => [t.id, t]));
    return runs.filter((r) => (r.end || r.start) >= since).slice(-limit).reverse().map((r) => {
      const t = terms.get(r.terminal);
      const name = t ? (t.mode === "axa" ? "AXA" : t.name) : r.role === "commander" ? "AXA" : basename(r.cwd || "") || r.terminal;
      return { ...r, name, status: r.status === "running" && (!t || !t.alive) ? "unfinished" : r.status };
    });
  }
  return { sessions, runs, track, statusOf, runsSince, digestOf };
}
