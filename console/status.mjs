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
const clipText = (v, n) => (v == null ? undefined : String(v).slice(0, n));

// onChat(terminal, chatId): a session's own start (or /clear) named the Claude chat it runs
export function createStatus({ stuckMs = STUCK_MS, approverMs = APPROVER_MS, runsMax = RUNS_MAX, now = Date.now, onChat } = {}) {
  const sessions = new Map(); // terminal id -> { status, doing, report, error, at, inflight, asking }
  function statusOf(id) {
    const s = sessions.get(id);
    if (!s) return s;
    // AXA's approver normally answers within seconds; a request still open after that is on screen
    if (s.status === "working" && s.asking && now() - s.asking > approverMs) return { ...s, status: "waiting" };
    if (s.status === "working" && s.inflight?.size && now() - s.at > stuckMs) {
      const [first] = s.inflight.values();
      return { ...s, status: "stuck", stuck_minutes: Math.round((now() - first.since) / 60_000) };
    }
    return s;
  }
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
      case "SessionStart": s.status = "ready"; s.inflight.clear(); break;
      case "UserPromptSubmit": s.status = "working"; s.doing = "reading the instruction"; s.tool = s.summary = undefined; s.error = undefined; s.asking = null; s.stopAt = s.gateAt = null; s.inflight.clear(); break;
      case "PreToolUse":
        s.status = "working"; s.doing = [e.tool, e.summary].filter(Boolean).join(" · "); s.tool = e.tool; s.summary = e.skill || e.summary; s.skill = e.skill;
        if (e.tool_use_id) s.inflight.set(e.tool_use_id, { tool: e.tool, summary: e.summary, since: e.ts });
        break;
      case "PostToolUse": if (s.status === "waiting") s.status = "working"; s.asking = null; s.inflight.delete(e.tool_use_id); break;
      case "PostToolUseFailure": s.error = [e.tool, e.error].filter(Boolean).join(": "); s.asking = null; s.inflight.delete(e.tool_use_id); break;
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
        break;
      case "Notification": if (/permission/i.test(e.notification_type || e.message || "")) { s.status = "waiting"; s.asking = null; s.doing = e.message; } break;
      case "Stop":
        // AXA's verify gate sent it back to check its work (hooks/verify-gate.mjs): it isn't done yet
        // (the two hooks log in either order; each marker is used once)
        if (s.gateAt && Math.abs(e.ts - s.gateAt) < GATE_MS) { s.gateAt = null; s.status = "working"; s.doing = "AXA verify gate: checking its work before reporting"; break; }
        s.stopAt = e.ts;
        s.status = "done"; s.doing = s.tool = s.summary = s.skill = undefined; s.asking = null; s.inflight.clear(); if (e.message) s.report = e.message; break;
      case "VerifyGate":
        if (s.stopAt && e.ts - s.stopAt < GATE_MS) s.stopAt = null; // its Stop was already logged
        else s.gateAt = e.ts;
        s.status = "working"; s.doing = "AXA verify gate: checking its work before reporting"; break;
      // You answered its prompt from the console. Declining stops the step and Claude waits for you (no
      // other event follows), so it's ready for the next instruction; anything else lets it carry on.
      case "UserAnswer":
        s.asking = null;
        if (/^(?:no\b|continue without|cancel|deny|reject|don'?t)/i.test(e.answer || "")) { s.status = "ready"; s.doing = `you declined (${e.answer}); waiting for the next instruction`; s.inflight.clear(); }
        else { s.status = "working"; s.doing = `you answered: ${e.answer}`; }
        break;
    }
    sessions.set(e.terminal, s);
    trackRun(e, s);
  }

  // ---------- runs: each instruction a session got, from the prompt to its result ----------
  // For the run history and the "since you left" briefing. Rebuilt from the event log on start.
  const runs = [], openRuns = new Map(); // terminal -> its current run
  function trackRun(e, s) {
    const r = openRuns.get(e.terminal);
    if (e.event === "UserPromptSubmit") {
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
      case "Stop": if (s.status === "done") { r.status = "done"; r.end = e.ts; r.report = clipText(e.message, 600); openRuns.delete(e.terminal); } break;
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
  return { sessions, runs, track, statusOf, runsSince };
}
