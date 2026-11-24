// Anticipating: speaking before you're needed, and saying how things stand when you ask. Pure (templates and
// rules); server.mjs feeds it the event log and the session list, and the narrator speaks what comes out.
//   - escalationLine: the approver or the policy decided a step goes to YOU: said right away, P0 ("feed is
//     about to need you: it wants to push to main"), before Claude Code's own permission notice arrives
//   - whatsUp: every session's state in 1-3 sentences (who needs you, who's working on what and its ETA, what's
//     done), for the hub's `w` on Control and `axa whatsup`
//   - admitItem: verbosity (quiet: only P0; normal: P0, P1 and heads-ups; chatty: everything), quiet hours
//     (nothing is said; a P0 becomes a desktop toast), and no progress chatter about a session you're typing in
import { sentence1 } from "./narrator.mjs";

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const names = (xs) => (xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

// ---------- the approval heads-up ----------
const VERB = { Bash: "run", Edit: "edit", MultiEdit: "edit", Write: "write", NotebookEdit: "edit", WebFetch: "fetch", WebSearch: "search for", Read: "read" };
// e: an AxaDecision (decision "escalate") or PolicyDecision (decision "ask") event; name: the session's name
export function escalationLine(e, name) {
  const reason = String(e.reason || "").trim();
  const door = /^one-way door:\s*(.+)$/i.exec(reason)?.[1];
  const thing = sentence1(String(e.summary || ""), 80).replace(/[.!?]$/, "");
  const act = door ? door.replace(/[.!?]$/, "") : VERB[e.tool] && thing ? `${VERB[e.tool]} ${thing}` : e.tool ? `use ${e.tool}` : "take a step";
  const why = !door && reason && !/^AXA couldn't decide/i.test(reason) ? `: ${sentence1(reason, 100).replace(/[.!?]$/, "")}` : "";
  return `${name} is about to need you: it wants to ${act}${why}.`;
}
export const isEscalation = (e) => !!e?.terminal && !e.agent_id && ((e.event === "AxaDecision" && e.decision === "escalate") || (e.event === "PolicyDecision" && e.decision === "ask"));

// ---------- what's up ----------
const NEEDS = new Set(["waiting", "needs_trust", "stuck", "failed", "limited"]);
const doingOf = (s) => sentence1(String(s.doing || "").replace(/^(?:Bash|Edit|Write|Read|Grep|Glob|Task|Agent) · /, "").replace(/^AXA (?:reviewing|approved|declined) · /, ""), 70).replace(/[.!?]$/, "");
// sessions: the daemon's list; etaOf(session) -> "usually done in about 4 minutes" | "taking longer than usual" | null
export function whatsUp(sessions, { etaOf = () => null } = {}) {
  const ss = (sessions || []).filter((s) => s.alive && s.mode !== "shell" && s.mode !== "axa");
  if (!ss.length) return "Nothing is running right now.";
  const out = [];
  const needs = ss.filter((s) => NEEDS.has(s.status));
  if (needs.length === 1) {
    const s = needs[0], appr = /^needs (?:your )?approval · (.+)/i.exec(String(s.doing || "")), d = doingOf(s);
    if (appr) out.push(`${cap(s.name)} needs your approval: ${sentence1(appr[1], 70).replace(/[.!?]$/, "")}.`);
    else out.push(`${cap(s.name)} ${s.status === "failed" ? "failed" : s.status === "limited" ? "hit a usage limit" : s.status === "stuck" ? "looks stuck" : "needs you"}${d && s.status !== "limited" ? `: ${d}` : ""}.`);
  }
  else if (needs.length > 1) out.push(`${cap(names(needs.map((s) => s.name)))} need you.`);
  const work = ss.filter((s) => s.status === "working" || s.status === "starting");
  if (work.length === 1 || work.length === 2) {
    out.push(work.map((s) => { const d = doingOf(s), eta = etaOf(s); return `${cap(s.name)} is working${d ? ` (${d.replace(/^(\w)/, (c) => c.toLowerCase())})` : ""}${eta ? `, ${eta}` : ""}`; }).join("; ") + ".");
  } else if (work.length > 2) out.push(`${cap(NUM[work.length] || String(work.length))} sessions are working: ${names(work.map((s) => s.name))}.`);
  const done = ss.filter((s) => s.status === "done");
  if (done.length && out.length < 3) out.push(done.length === 1 ? `${cap(done[0].name)} is done.` : `${cap(NUM[done.length] || String(done.length))} are done: ${names(done.map((s) => s.name))}.`);
  if (!out.length) return `${cap(NUM[ss.length] || String(ss.length))} ${ss.length === 1 ? "session is" : "sessions are"} open, all idle.`;
  return out.slice(0, 3).join(" ");
}

// ---------- what may be said now ----------
export const TYPING_MS = 15_000;
export const HEADS_UP_KINDS = new Set(["eta", "longer", "liveness", "escalate"]);
// "22:00-07:00" -> { from, to } in minutes, or null
export function parseQuiet(v) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v || "").trim());
  return m ? { from: +m[1] * 60 + +m[2], to: +m[3] * 60 + +m[4] } : null;
}
export function inQuietHours(range, date = new Date()) {
  const q = typeof range === "string" ? parseQuiet(range) : range;
  if (!q || q.from === q.to) return false;
  const t = date.getHours() * 60 + date.getMinutes();
  return q.from < q.to ? t >= q.from && t < q.to : t >= q.from || t < q.to;
}
// null: say it. Otherwise why not. it.asked (you asked: "what's up") passes verbosity and typing, not quiet hours.
// focus: the session you're viewing (or typing in) in the hub: no P2/P3 about it (Codex's "only when unfocused")
export function admitItem(it, { verbosity = "normal", quiet = null, now = Date.now(), typingAt = 0, focus = null } = {}) {
  if (quiet && inQuietHours(quiet, new Date(now))) return it.priority === 0 ? "quiet hours (a desktop toast instead)" : "quiet hours";
  if (it.asked) return null;
  if (verbosity === "quiet" && it.priority > 0) return "verbosity quiet";
  if (verbosity === "normal" && it.priority >= 2 && !HEADS_UP_KINDS.has(it.kind)) return "verbosity normal";
  if (it.priority >= 2 && typingAt && now - typingAt < TYPING_MS) return "you're typing in it";
  if (it.priority >= 2 && focus && it.session === focus) return "you're looking at it";
  return null;
}
