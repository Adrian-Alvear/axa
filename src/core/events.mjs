// The event log (~/.axa/events.jsonl, written by AXA's hooks in every session it starts) and what the
// daemon learns from it: each session's status, its helper agents, and its runs (one per instruction).
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { files, home } from "../paths.mjs";
import { clip } from "./text.mjs";

const HISTORY_BYTES = 4 * 1024 * 1024; // replayed on start and to new web clients
const MAX_LOG_BYTES = 50 * 1024 * 1024; // past this, the log moves to events.1.jsonl (one old copy kept)
const STUCK_MS = (Number(process.env.AXA_STUCK_MINUTES) || 20) * 60_000;
const APPROVER_MS = 75_000; // longer than the approver hook's own timeout

// The log holds prompts, commands and reports: only you can read it
mkdirSync(home, { recursive: true, mode: 0o700 });
if (!existsSync(files.log)) writeFileSync(files.log, "", { mode: 0o600 });
try { chmodSync(home, 0o700); chmodSync(files.log, 0o600); } catch {}

export function logEvent(ev) {
  try { appendFileSync(files.log, JSON.stringify({ ts: Date.now(), ...ev }) + "\n"); } catch {}
}
export function readRange(start, end) {
  if (end <= start) return "";
  const fd = openSync(files.log, "r");
  try { const buf = Buffer.alloc(end - start); readSync(fd, buf, 0, buf.length, start); return buf.toString("utf8"); } finally { closeSync(fd); }
}

// ---------- status per session ----------
const status = new Map(); // terminal -> { status, doing, report, error, at, inflight, asking, session, helpers, ... }
export function statusOf(id) {
  const s = status.get(id);
  if (!s) return null;
  const out = { ...s, helpers: helpersOf(id) };
  // AXA's approver answers within seconds; a request still open after that is on screen for you
  if (s.status === "working" && s.asking && Date.now() - s.asking > APPROVER_MS) return { ...out, status: "waiting" };
  // Stuck: working, a step open and nothing heard for STUCK_MS. Time spent waiting for a permission
  // (the approver's or yours) is never counted: neither for the silence nor for the step's age.
  if (s.status === "working" && !s.asking && s.inflight?.size && Date.now() - Math.max(s.at, s.waitEnd || 0) > STUCK_MS) {
    const [first] = s.inflight.values();
    const paused = (s.paused || 0) - (first.paused0 || 0);
    return { ...out, status: "stuck", stuck_minutes: Math.round((Date.now() - first.since - paused) / 60_000) };
  }
  return out;
}

// A usage limit's reset time, as Claude Code words it ("resets 3pm (Europe/Paris)", "reset at 15:00")
const resetsOf = (...texts) => { for (const t of texts) { const m = /\breset(?:s|ting)?\s+(?:at\s+|in\s+)?([^.;\n]{1,60})/i.exec(String(t || "")); if (m) return m[1].trim(); } return undefined; };
const LIMIT_RE = /rate.?limit|usage.?limit|quota|limit (?:reached|exceeded)|out of (?:credits|usage)|billing/i;
// Notification types: which status each means (others, e.g. auth_success, change nothing)
const NOTIFY = { permission_prompt: "waiting", elicitation_dialog: "waiting", agent_needs_input: "waiting", idle_prompt: "ready" };

let onChat = () => {};
export const onChatSeen = (fn) => (onChat = fn);
// The commander finished a turn (live events only, never the history replayed at start): its final reply
let onReply = () => {};
export const onCommanderReply = (fn) => (onReply = fn);
const GATE_WAIT_MS = 1500; // the verify gate's event can land just after Stop and send it back to work

// ---------- recent activity: the last events (for the hub's log) and events per minute (its chart) ----------
const recent = []; // compact copies of the latest events
const KEEP = ["ts", "event", "terminal", "role", "tool", "summary", "skill", "agent_id", "agent_type", "subagent_type", "decision", "reason", "answer", "from", "to", "items", "verdict", "raw_verdict", "findings", "round"];
function remember(e) {
  const c = {};
  for (const k of KEEP) if (e[k] !== undefined) c[k] = typeof e[k] === "string" ? clip(e[k], 160) : e[k];
  if (e.event === "UserPromptSubmit") c.prompt = clip(e.prompt, 160);
  if (e.event === "Stop" || e.event === "SubagentStop") c.message = clip(e.message, 160);
  if (e.event === "PostToolUseFailure") c.error = clip(e.error, 160);
  recent.push(c);
  if (recent.length > 4000) recent.splice(0, recent.length - 3000);
}
export function activity(minutes = 60, limit = 60) {
  const now = Date.now(), perMinute = Array(minutes).fill(0);
  for (let i = recent.length - 1; i >= 0; i--) {
    const age = Math.floor((now - recent[i].ts) / 60_000);
    if (age >= minutes) break;
    if (age >= 0) perMinute[minutes - 1 - age]++;
  }
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const today = runs.filter((r) => r.start >= day.getTime());
  return {
    events: recent.filter((e) => !["PostToolUse", "Notification", "SessionStart", "PermissionRequest"].includes(e.event)).slice(-limit),
    perMinute,
    lanes: laneTimes(now),
    runs: { today: today.length, done: today.filter((r) => r.status === "done").length, failed_steps: today.reduce((n, r) => n + r.failures, 0), running: today.filter((r) => r.status === "running").length, approvals: today.reduce((n, r) => n + r.approvals, 0), helpers: today.reduce((n, r) => n + r.helpers, 0) },
  };
}

// Each session's event times over the last 15 minutes (newest last, at most LANE_MAX each): the Control lanes'
// activity strips. Helpers' steps count for the session that started them.
const LANE_MS = 15 * 60_000, LANE_MAX = 600;
export function laneTimes(now = Date.now(), list = recent) {
  const out = {};
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (now - e.ts > LANE_MS) break;
    if (!e.terminal) continue;
    const a = (out[e.terminal] ||= []);
    if (a.length < LANE_MAX) a.push(e.ts);
  }
  for (const a of Object.values(out)) a.reverse();
  return out;
}

// "list sessions (axa terminals)" rather than "mcp__plugin_axa_terminals__list_sessions · {}"
function doingText(e) {
  const m = /^mcp__(?:plugin_)?(.+?)__(.+)$/.exec(e.tool || "");
  const tool = m ? `${m[2].replace(/_/g, " ")} (${m[1].replace(/_/g, " ")})` : e.tool;
  const summary = e.summary && !/^\{\s*\}$/.test(e.summary) && !m ? e.summary : "";
  return [e.skill ? `skill ${e.skill}` : tool, summary].filter(Boolean).join(" · ");
}

function track(e, live = false) {
  if (!e?.terminal) return;
  remember(e);
  // Only a session's own start (or /clear) names its chat, not a `claude -p` run inside it
  if (e.session && e.event === "SessionStart" && e.role && e.source !== "compact") onChat(e.terminal, e.session);
  const s = status.get(e.terminal) || { inflight: new Map() };
  s.at = e.ts;
  const chat = s.session;
  // (a SessionEnd is checked against the chat this session runs, so it never renames it)
  if (e.session && e.role && e.event !== "SessionEnd") s.session = e.session;
  const wasWaiting = s.status === "waiting" || !!s.asking;
  switch (e.event) {
    case "SessionStart": Object.assign(s, { status: "ready", started: true, ended: undefined, limit_resets: undefined }); s.inflight.clear(); break;
    // Claude Code exited (the pane drops to a shell). /clear also ends a session, then starts a new one.
    case "SessionEnd":
      if (e.reason === "clear" || (e.session && chat && e.session !== chat)) break;
      Object.assign(s, { status: "exited", ended: e.reason || "exit", doing: undefined, tool: undefined, skill: undefined, asking: null });
      s.inflight.clear();
      break;
    // The turn ended on an API error: a usage/rate limit ("limited", with its reset time when given) or
    // another failure ("failed")
    case "StopFailure": {
      const limited = LIMIT_RE.test(`${e.error || ""} ${e.error_details || ""} ${e.message || ""}`);
      Object.assign(s, { status: limited ? "limited" : "failed", doing: undefined, tool: undefined, skill: undefined, asking: null, stopAt: null, gateAt: null,
        error: [e.error, e.error_details].filter(Boolean).join(": ") || "the turn failed", limit_resets: limited ? resetsOf(e.error_details, e.message, e.error) : undefined });
      s.inflight.clear();
      break;
    }
    case "UserPromptSubmit": Object.assign(s, { status: "working", doing: "reading the instruction", tool: undefined, error: undefined, asking: null, stopAt: null, gateAt: null, limit_resets: undefined, promptAt: e.ts }); s.inflight.clear(); break;
    case "PreToolUse":
      if (e.agent_id) break; // a helper's step: tracked under its helper
      // a question for you (AskUserQuestion): the session waits for your answer
      if (e.tool === "AskUserQuestion") { Object.assign(s, { status: "waiting", asking: null, doing: `asks you: ${e.summary || "a question"}`, tool: e.tool, skill: undefined }); break; }
      Object.assign(s, { status: "working", doing: doingText(e), tool: e.tool, skill: e.skill });
      if (e.tool_use_id) s.inflight.set(e.tool_use_id, { tool: e.tool, since: e.ts, paused0: s.paused || 0 });
      break;
    case "PostToolUse": if (s.status === "waiting") s.status = "working"; s.asking = null; s.inflight.delete(e.tool_use_id); break;
    case "PostToolUseFailure": s.error = [e.tool, e.error].filter(Boolean).join(": "); s.asking = null; s.inflight.delete(e.tool_use_id); break;
    // A permission request goes to AXA's approver first (hooks/approver.mjs); a session only waits on you
    // when the approver escalates, or the prompt is still open after APPROVER_MS
    case "PermissionRequest":
      if (e.role === "worker") Object.assign(s, { status: "working", asking: e.ts, doing: `AXA reviewing · ${[e.tool, e.summary].filter(Boolean).join(" ")}` });
      else Object.assign(s, { status: "waiting", doing: `needs approval · ${[e.tool, e.summary].filter(Boolean).join(" ")}` });
      break;
    case "AxaDecision":
      s.asking = null;
      if (e.decision === "escalate") Object.assign(s, { status: "waiting", doing: `needs your approval · ${e.reason}` });
      else s.doing = `AXA ${e.decision === "allow" ? "approved" : "declined"} · ${e.reason}`;
      break;
    case "Notification": {
      const type = e.notification_type || "", text = `${type} ${e.message || ""}`;
      const to = NOTIFY[type] || (LIMIT_RE.test(text) ? "limited" : /permission/i.test(text) ? "waiting" : null);
      if (to === "waiting") Object.assign(s, { status: "waiting", asking: null, doing: e.message });
      else if (to === "limited") Object.assign(s, { status: "limited", asking: null, doing: undefined, error: e.message, limit_resets: resetsOf(e.message) });
      // idle: Claude waits for input. A finished turn keeps its "done" (and its report)
      // (an open question menu stays "waiting" until it's answered)
      else if (to === "ready" && !["done", "exited", "failed", "limited"].includes(s.status) && !(s.status === "waiting" && s.tool === "AskUserQuestion")) { Object.assign(s, { status: "ready", asking: null, doing: undefined }); s.inflight.clear(); }
      break;
    }
    case "Stop":
      // AXA's verify gate sent it back to check its work (the two hooks log in either order)
      if (s.gateAt && Math.abs(e.ts - s.gateAt) < 10_000) { Object.assign(s, { gateAt: null, status: "working", doing: "verify gate: checking its work before reporting" }); break; }
      Object.assign(s, { stopAt: e.ts, status: "done", doing: undefined, tool: undefined, skill: undefined, asking: null });
      s.inflight.clear();
      if (e.message) s.report = e.message;
      break;
    case "VerifyGate":
      if (s.stopAt && e.ts - s.stopAt < 10_000) s.stopAt = null; else s.gateAt = e.ts;
      Object.assign(s, { status: "working", doing: "verify gate: checking its work before reporting" });
      break;
    // You answered its prompt: declining stops the step and Claude waits for you
    case "UserAnswer":
      s.asking = null;
      if (/^(?:no\b|continue without|cancel|deny|reject|don'?t)/i.test(e.answer || "")) { Object.assign(s, { status: "ready", doing: `you declined (${e.answer})` }); s.inflight.clear(); }
      else Object.assign(s, { status: "working", doing: `you answered: ${e.answer}` });
      break;
  }
  // time spent waiting on a permission prompt or a question (the approver's or yours) is set aside:
  // it never makes a step look stuck
  const isWaiting = s.status === "waiting" || !!s.asking;
  if (!wasWaiting && isWaiting) s.waitSince = e.ts;
  else if (wasWaiting && !isWaiting) { s.paused = (s.paused || 0) + Math.max(0, e.ts - (s.waitSince ?? e.ts)); s.waitEnd = e.ts; s.waitSince = null; }
  status.set(e.terminal, s);
  trackHelpers(e);
  trackRun(e, s, live);
}

// tests: feed an event as if logged live, or ({ live: false }) as if replayed from history at start
export const trackEvent = (e, { live = true } = {}) => track({ ts: Date.now(), ...e }, live);
// A live run started (never the history replayed at start): the supervisor records git's HEAD then
let onStart = () => {};
export const onRunStart = (fn) => (onStart = fn);

// ---------- helper agents per session: spawned -> running -> done ----------
const helpers = new Map(), spawnQueue = new Map(); // terminal -> [helper] / [pending Agent calls]
function trackHelpers(e) {
  const t = e.terminal, at = e.ts || Date.now();
  if (e.event === "PreToolUse" && !e.agent_id && (e.tool === "Agent" || e.tool === "Task")) {
    spawnQueue.set(t, [...(spawnQueue.get(t) || []), { desc: e.summary, type: e.subagent_type }].slice(-10));
  } else if (e.event === "PreToolUse" && e.agent_id) {
    const h = (helpers.get(t) || []).find((x) => x.id === e.agent_id);
    if (h) { h.calls++; h.doing = doingText(e); h.at = at; h.recent = [...(h.recent || []), { at, text: clip(h.doing, 160) }].slice(-15); }
  } else if (e.event === "SubagentStart") {
    const sp = (spawnQueue.get(t) || []).shift();
    helpers.set(t, [...(helpers.get(t) || []), { id: e.agent_id, type: String(e.agent_type || sp?.type || "helper"), desc: clip(sp?.desc || "", 120), status: "running", start: at, at, calls: 0 }].slice(-12));
  } else if (e.event === "SubagentStop") {
    const h = (helpers.get(t) || []).find((x) => x.id === e.agent_id);
    if (h) Object.assign(h, { status: "done", end: at, at, doing: undefined, report: clip(e.message, 400) });
  } else if (e.event === "UserPromptSubmit") {
    // a new instruction: forget helpers that finished long ago
    helpers.set(t, (helpers.get(t) || []).filter((h) => h.status === "running" || at - h.at < 30 * 60_000));
  }
}
const helpersOf = (id) => (helpers.get(id) || []).map((h) => ({ ...h }));

// ---------- runs: each instruction a session got, from the prompt to its result ----------
const runs = [], openRuns = new Map();
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function trackRun(e, s, live) {
  const r = openRuns.get(e.terminal);
  if (e.event === "UserPromptSubmit") {
    if (/^\s*<task-notification>/.test(e.prompt || "")) return;
    if (r) { r.status = "replaced"; r.end = e.ts; }
    const run = { id: `${e.terminal}-${e.ts}`, terminal: e.terminal, cwd: e.cwd, role: e.role, prompt: clip(e.prompt, 400), instruction: clip(e.prompt, 4000), start: e.ts, steps: 0, helpers: 0, approvals: 0, declined: 0, escalated: 0, refused: 0, gate: 0, failures: 0, edits: 0, answers: [], status: "running" };
    runs.push(run); openRuns.set(e.terminal, run);
    if (runs.length > 1000) runs.splice(0, runs.length - 1000);
    if (live) try { onStart(run); } catch {}
    return;
  }
  if (!r) return;
  switch (e.event) {
    case "PreToolUse":
      if (!e.agent_id) { r.steps++; if (e.tool === "Agent" || e.tool === "Task") r.helpers++; }
      if (EDIT_TOOLS.has(e.tool)) r.edits++; // a helper's edits count too: the turn changed code
      break;
    case "PostToolUseFailure": r.failures++; break;
    case "AxaDecision": if (e.decision === "allow") r.approvals++; else if (e.decision === "deny") r.declined++; else r.escalated++; break;
    case "PolicyDecision": if (e.decision === "deny") r.refused++; break;
    case "VerifyGate": r.gate++; break;
    case "UserAnswer": r.answers.push(clip(e.answer, 80)); break;
    case "Stop": if (s.status === "done") { Object.assign(r, { status: "done", end: e.ts, report: clip(e.message, 600) }); openRuns.delete(e.terminal); } break;
    case "StopFailure": Object.assign(r, { status: s.status === "limited" ? "limited" : "failed", end: e.ts, report: clip(s.error, 600) }); openRuns.delete(e.terminal); break;
    case "SessionEnd": if (s.status === "exited") { Object.assign(r, { status: "exited", end: e.ts }); openRuns.delete(e.terminal); } break;
  }
}
// the session's latest run (open or just finished), for the reviewer
export const lastRun = (terminal) => { for (let i = runs.length - 1; i >= 0; i--) if (runs[i].terminal === terminal) return runs[i]; return null; };
export const runsSince = (since, limit = 200) => runs.filter((r) => (r.end || r.start) >= since).slice(-limit).reverse();

// ---------- tail the log ----------
let offset = statSync(files.log).size, partial = "";
const listeners = new Set(); // (line) => void, for the web console's live stream
export const onLine = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const historyLines = () => {
  const start = Math.max(0, offset - HISTORY_BYTES);
  const lines = readRange(start, offset).split("\n");
  if (start > 0) lines.shift(); // the cut-off first line
  return lines.filter((l) => l.trim());
};
// Rebuild statuses from recent history (sessions in tmux keep running across daemon restarts)
for (const line of historyLines()) { try { track(JSON.parse(line)); } catch {} }

export function startTail() {
  setInterval(() => {
    let size;
    try { size = statSync(files.log).size; } catch { return; }
    if (size < offset) offset = 0; // truncated or rotated
    if (size === offset) return;
    const lines = (partial + readRange(offset, size)).split("\n");
    offset = size;
    partial = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        track(e, true);
        if (e.event === "Stop" && e.role === "commander" && !e.agent_id && e.message && e.terminal) {
          setTimeout(() => { const s = status.get(e.terminal); if (s?.status === "done" && s.stopAt === e.ts) onReply(e.terminal, e.message, e.ts); }, GATE_WAIT_MS);
        }
      } catch {}
      for (const fn of listeners) fn(line);
    }
    if (size > MAX_LOG_BYTES) {
      try { renameSync(files.log, files.log.replace(/\.jsonl$/, ".1.jsonl")); writeFileSync(files.log, "", { mode: 0o600 }); offset = 0; partial = ""; } catch {}
    }
  }, 250);
}
