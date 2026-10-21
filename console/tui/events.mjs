// The console's event stream, and everything the terminal app derives from it: activity sparklines,
// helper agents and their tool calls, each session's own tool tallies, the described feed, and the
// supervisor's wake-limit notice. Pure (no terminal, no network) except streamEvents().
// The stream starts with an `event: history` block on every (re)connect: it replaces what came
// before, so a console restart never counts anything twice.
import { clean, clip } from "./theme.mjs";

export const SPARK = "▁▂▃▄▅▆▇█", SPARK_BUCKETS = 10, SPARK_MIN = 3; // activity over the last 30 minutes, 3 minutes per bar
export const PLUMBING = /^(ToolSearch|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskOutput|EnterPlanMode|ExitPlanMode)$/;
const FEED_MAX = 300;

// derived state: everything here is rebuilt from the events alone
export function createEvents() {
  return {
    feed: [], // described events, newest last
    activity: new Map(), // terminal id -> event times (last 30 minutes)
    helpers: new Map(), // terminal id -> helper agents [{ id, type, desc, prompt, status, start, ts, calls, failures, ... }]
    spawnQueue: new Map(), // terminal id -> Agent/Task calls waiting for their SubagentStart
    sessCalls: new Map(), // terminal id -> Map(tool -> tally) of the session's own tool calls
    wakeLimit: null, // the latest SupervisorLimit still in force: { ts, limit, pending, resetsAt }
  };
}
export function resetEvents(st) {
  st.feed.length = 0;
  st.activity.clear(); st.helpers.clear(); st.spawnQueue.clear(); st.sessCalls.clear();
  st.wakeLimit = null;
}

export function humanAction(tool, summary, skill) {
  if (skill) return `using the ${skill} skill`;
  if (!tool || PLUMBING.test(tool)) return null;
  const s = clip(summary, 90);
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (m) return `${m[2].replace(/_/g, " ")} (${m[1].replace(/^plugin_/, "").replace(/_/g, " ")})`;
  return { Bash: s ? `ran: ${s}` : "ran a command", Read: `read ${s || "a file"}`, Edit: `edited ${s || "a file"}`, Write: `wrote ${s || "a file"}`, Grep: `searched for ${s}`, Glob: `looked for ${s}`, WebSearch: `searched the web: ${s}`, WebFetch: `read a web page: ${s}`, Agent: `started a helper: ${s}`, Task: `started a helper: ${s}`, Skill: `using the ${s} skill` }[tool] || (s ? `${tool}: ${s}` : tool);
}
export function describe(e) {
  switch (e.event) {
    case "UserPromptSubmit": return /^\s*(\[AXA supervisor|<task-notification>)/.test(e.prompt || "") ? null : { text: `got an instruction: ${clip(e.prompt, 80)}`, role: "accent" };
    case "PreToolUse": { const a = e.agent_id ? null : humanAction(e.tool, e.summary, e.skill); return a ? { text: a, role: "" } : null; }
    case "PostToolUseFailure": return { text: `${e.tool || "a step"} failed: ${clip(e.error, 80)}`, role: "del" };
    case "AxaDecision": return e.decision === "allow" ? { text: `AXA approved: ${clip(e.reason, 80)}`, role: "dim" } : e.decision === "deny" ? { text: `AXA declined: ${clip(e.reason, 80)}`, role: "stuck" } : { text: `needs your approval: ${clip(e.reason, 80)}`, role: "wait" };
    case "PolicyDecision": return e.decision === "deny" ? { text: `policy refused: ${clip(e.reason, 80)}`, role: "stuck" } : null;
    case "Notification": return /permission/i.test(e.notification_type || "") ? { text: "waiting for your approval", role: "wait" } : null;
    case "Stop": return { text: `finished${e.message ? `: ${clip(e.message, 80)}` : ""}`, role: "done" };
    case "VerifyGate": return { text: "verify gate: sent back to check its work", role: "waitSoft" };
    case "UserAnswer": return { text: `you answered: ${clip(e.answer, 60)}`, role: "accent" };
    case "SupervisorWake": return { text: `AXA woke up: ${clip((e.items || []).join("; "), 90)}`, role: "accent" };
    case "SupervisorLimit": return { text: `AXA wake limit reached (${e.limit}/h): ${(e.pending || []).length} updates waiting`, role: "wait" };
    case "ChainFired": return { text: `link: ${clip(e.from, 20)} finished → sent: ${clip(e.text, 70)}`, role: "accent" };
  }
  return null;
}

// helper agents per session (for the map): spawned → running → done
// Each helper: its instruction, its tool calls as they happen (count, recent targets, last time), failures
// and its report, like the web console's agent panel. Sessions' own tool calls are tallied too.
export const toolLabel = (e) => (e.skill ? `skill ${e.skill}` : /^mcp__/.test(e.tool || "") ? String(e.tool).split("__").pop().replace(/_/g, " ") : e.tool);
function tally(m, tool, summary, at) {
  const c = m.get(tool) || { count: 0, recent: [], at: 0 };
  c.count++; c.at = at;
  if (summary) { c.recent.unshift(clip(summary, 60)); c.recent.length = Math.min(c.recent.length, 5); }
  m.set(tool, c);
}
function trackHelpers(st, e) {
  const { helpers, spawnQueue, sessCalls } = st;
  const t = e.terminal, at = e.ts || Date.now();
  const spawn = e.tool === "Agent" || e.tool === "Task";
  if (e.event === "PreToolUse" && !e.agent_id && spawn) { const q = spawnQueue.get(t) || []; q.push({ desc: e.summary, type: e.subagent_type, prompt: e.prompt }); spawnQueue.set(t, q.slice(-10)); }
  else if (e.event === "PreToolUse" && !e.agent_id && e.tool && !PLUMBING.test(e.tool)) { const m = sessCalls.get(t) || new Map(); tally(m, toolLabel(e), e.summary, at); sessCalls.set(t, m); }
  else if (e.event === "PreToolUse" && e.agent_id && e.tool && !PLUMBING.test(e.tool)) { const h = (helpers.get(t) || []).find((x) => x.id === e.agent_id); if (h) tally(h.calls, toolLabel(e), e.summary, at); }
  else if (e.event === "PostToolUseFailure" && e.agent_id) { const h = (helpers.get(t) || []).find((x) => x.id === e.agent_id); if (h) h.failures++; }
  else if (e.event === "SubagentStart") {
    const sp = (spawnQueue.get(t) || []).shift(), arr = helpers.get(t) || [];
    arr.push({ id: e.agent_id, type: String(e.agent_type || sp?.type || "helper").split(":").pop(), desc: clean(sp?.desc || ""), prompt: sp?.prompt || "", status: "running", start: at, ts: at, calls: new Map(), failures: 0 });
    helpers.set(t, arr.slice(-8));
  } else if (e.event === "SubagentStop") { const h = (helpers.get(t) || []).find((x) => x.id === e.agent_id); if (h) { h.status = "done"; h.ts = h.end = at; h.report = e.message || ""; } }
}

// resets_at as ms (the server may write ms, seconds or an ISO date)
const when = (v) => (typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : v ? Date.parse(v) || 0 : 0);
function trackLimit(st, e, now) {
  if (e.event === "SupervisorLimit") {
    const resetsAt = when(e.resets_at);
    // a limit that has already lifted (an old one replayed from history) is not news
    if (resetsAt > now) st.wakeLimit = { ts: e.ts || now, limit: e.limit, pending: [].concat(e.pending || []), resetsAt };
  } else if (e.event === "SupervisorWake" && st.wakeLimit && (e.ts || now) >= st.wakeLimit.ts) st.wakeLimit = null; // it woke again: the limit lifted
}

export function ingest(st, e, now = Date.now()) {
  if (!e || typeof e !== "object") return;
  trackLimit(st, e, now);
  if (!e.terminal) return;
  trackHelpers(st, e);
  const t = st.activity.get(e.terminal) || [];
  t.push(e.ts || now); st.activity.set(e.terminal, t);
  const d = describe(e);
  if (d) { st.feed.push({ ts: e.ts || now, terminal: e.terminal, commander: e.role === "commander", ...d }); if (st.feed.length > FEED_MAX) st.feed.splice(0, st.feed.length - FEED_MAX); }
}
// a history block is the whole story so far: start over, then replay it
export function replayHistory(st, events, now = Date.now()) {
  resetEvents(st);
  for (const e of [].concat(events || [])) ingest(st, e, now);
}

// The wake-limit notice while it's in force, else null (and it clears itself once resets_at passes)
export function wakeLimitText(st, now = Date.now()) {
  const w = st.wakeLimit;
  if (!w) return null;
  if (w.resetsAt <= now) { st.wakeLimit = null; return null; }
  const n = w.pending.length, at = new Date(w.resetsAt).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
  return `AXA wake limit reached${w.limit ? ` (${w.limit}/h)` : ""} · ${n} update${n === 1 ? "" : "s"} waiting · resumes ${at}`;
}

// "  ▂▅█ ▃": events per 3 minutes over the last 30
export function spark(st, id, now = Date.now()) {
  const span = SPARK_MIN * 60_000, b = Array(SPARK_BUCKETS).fill(0);
  const ts = (st.activity.get(id) || []).filter((t) => now - t < span * SPARK_BUCKETS);
  st.activity.set(id, ts);
  for (const t of ts) b[SPARK_BUCKETS - 1 - Math.floor((now - t) / span)]++;
  const max = Math.max(...b);
  if (b.filter(Boolean).length < 3) return "";
  return max ? b.map((n) => (n ? SPARK[Math.min(7, Math.ceil((n / max) * 7))] : " ")).join("") : "";
}

// Server-Sent Events: complete blocks out of buf ({ kind, data }), and what's left over
export function parseSse(buf) {
  const blocks = [];
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const block = buf.slice(0, i); buf = buf.slice(i + 2);
    const kind = /^event: (\w+)/m.exec(block)?.[1], data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
    if (data) blocks.push({ kind, data });
  }
  return { blocks, rest: buf };
}
// Apply one block: a history block replaces the derived state, anything else is one more event
export function applyBlock(st, { kind, data }, now = Date.now()) {
  try { const v = JSON.parse(data); kind === "history" ? replayHistory(st, v, now) : ingest(st, v, now); return true; } catch { return false; }
}

// the console's live event stream; reconnects on its own. onChange() after each batch of events.
export async function streamEvents({ port, readToken, st, onChange, stopped }) {
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/events`, { headers: { host: `localhost:${port}`, cookie: `axa_token=${readToken()}` } });
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const r = parseSse(buf + dec.decode(value, { stream: true }));
        buf = r.rest;
        let any = false;
        for (const b of r.blocks) any = applyBlock(st, b) || any;
        if (any) onChange();
      }
    } catch {}
    if (stopped()) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
}
