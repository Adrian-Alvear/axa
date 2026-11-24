// Your attention: when AXA's voice may interrupt, how it says who's talking, and what it keeps for later. Ideas
// from research/voice-narration.md (heard, echo.ai, readless, pchalasani's plugin, Codex, Claude Code agent view,
// Hashimoto: "context switching is very expensive"). Pure rules; server.mjs and the hub wire them.
import { createHash } from "node:crypto";
import { mergeLine, salienceLine, sentence1 } from "./narrator.mjs";

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------- 4. the agent's own spoken line ----------
// AXA's worker sessions are asked (UserPromptSubmit additionalContext, hooks/spoken-line.mjs) to end a finished
// turn with "🔊 <= 12 words, the outcome". The daemon says that line the moment the turn stops: no model, no
// wait. The user's own sessions get it only if they opt in (AXA_SPOKEN_LINE=1).
export const SPOKEN_MARK = "🔊";
export const SPOKEN_WORDS = 12;
export const SPOKEN_INSTRUCTION = `AXA reads the outcome of your turn aloud to the user, who may not be looking at the screen. When you finish a turn, end your final reply with one last line that starts with ${SPOKEN_MARK} followed by at most ${SPOKEN_WORDS} plain words stating the outcome (for example: "${SPOKEN_MARK} Tests pass; the settings page now uses the new form library."). No markdown or paths in that line, and nothing after it.`;
export const wantsSpokenLine = (env = process.env) => env.AXA_ROLE === "worker" || env.AXA_SPOKEN_LINE === "1";
// { line (<= 12 words, or null), rest (the text without that line) }
export function spokenLineOf(text) {
  const t = String(text || "");
  const re = /^[ \t]*(?:[-*>]\s*)?🔊[ \t]*(.+?)[ \t]*$/gmu;
  let m, last = null;
  while ((m = re.exec(t))) last = m;
  if (!last) return { line: null, rest: t };
  const words = last[1].replace(/[*_`]/g, "").trim().split(/\s+/).filter(Boolean);
  let line = words.slice(0, SPOKEN_WORDS).join(" ");
  if (words.length > SPOKEN_WORDS) line = line.replace(/[,;:]$/, "");
  const rest = (t.slice(0, last.index) + t.slice(last.index + last[0].length)).replace(/\n{3,}/g, "\n\n").trim();
  return { line: line ? line.replace(/([^.!?])$/, "$1.") : null, rest };
}
export const stripSpoken = (text) => spokenLineOf(text).rest;

// ---------- 5. re-alerts (echo.ai) ----------
// A "needs you" nobody answered is said again (short) after 60 s, then 3 and 10 min: at most 3 times, and never
// once it's answered or you've typed in that session since it started waiting.
export const REALERT_AT = [60_000, 3 * 60_000, 10 * 60_000];
export function realertDue({ since, count = 0, now, typedAt = 0 }) {
  if (count >= REALERT_AT.length || typedAt > since) return false;
  return now - since >= REALERT_AT[count];
}
export const realertLine = (name, n = 1) => `${cap(name)} is still waiting for you${n > 1 ? ", again" : ""}.`;

// ---------- 7. heartbeat (readless) ----------
// For work expected to take over 2 min (the duration store): at most once a minute, <= 10 words. Chatty only
// (at normal, the 5-minute liveness line is enough).
export const HEARTBEAT_MIN_MS = 2 * 60_000, HEARTBEAT_EVERY_MS = 60_000;
export function heartbeatLine({ name, doing, expectedMs, sinceSaid, verbosity = "normal" }) {
  if (verbosity !== "chatty" || !(expectedMs > HEARTBEAT_MIN_MS) || sinceSaid < HEARTBEAT_EVERY_MS) return null;
  const d = sentence1(String(doing || "").replace(/^(?:Bash|Edit|Write|Read|Grep|Glob|Task|Agent) · /, ""), 60).replace(/[.!?]$/, "");
  const words = `${name}, still working${d ? `: ${d.replace(/^(\w)/, (c) => c.toLowerCase())}` : ""}`.split(/\s+/).slice(0, 10).join(" ").replace(/[,:;]$/, "");
  return `${words}.`;
}

// ---------- 3. who's talking, by ear: a voice per project ----------
// ui.json "voicePerProject": "on" (default off): each project speaks in its own Kokoro voice, stable (a hash of
// its name), never the main voice; AXA itself keeps the main one. English voices only.
export function voiceFor(project, base, voices) {
  const pool = voices.filter((v) => /^[ab][fm]_/.test(v) && v !== base && v !== "am_santa");
  if (!project || !pool.length) return base;
  const h = createHash("sha256").update(String(project).toLowerCase()).digest().readUInt32BE(0);
  return pool[h % pool.length];
}

// ---------- 8. "while you were away" (Claude Code's agent view) ----------
// Back at the hub after >= 10 min idle: one recap of what happened, the latest state of each session (templates;
// the daemon has it summarised when it's long).
export const RECAP_IDLE_MS = 10 * 60_000;
export function recapLine(notes) {
  const last = new Map();
  for (const n of notes || []) last.set(n.session || `${n.project}:${n.kind}`, n);
  const items = [...last.values()].map((n) => ({ kind: n.kind, name: n.project || "a session", text: `${n.title}${n.body ? `: ${n.body}` : ""}` }));
  if (!items.length) return null;
  return `While you were away: ${mergeLine(items)}`;
}

// ---------- 9. the user controls interruptions ----------
// ui.json "notify": { "mode": "live" | "digest" | "quiet", "digestMin": 15 }.
//   live    everything as it happens (by tier)
//   digest  only one-way doors (needs you to push, deploy, spend, touch accounts) and failures interrupt; the
//           rest is held and said as one digest every digestMin minutes, or when you press `w`
//   quiet   nothing interrupts; everything is held for when you ask (`w`)
export const MODES = ["live", "digest", "quiet"];
const DOOR = /\b(push|deploy|publish|release|spend|pay|purchase|billing|account|delete|drop|production|prod|main)\b/i;
// how much is at stake when something needs you: a one-way door > a question > a routine approval
export function blastOf(it) {
  if (!["waiting", "needs_trust", "escalate", "realert"].includes(it.kind)) return null;
  const t = `${it.reason || ""} ${it.text || ""}`;
  if (/one-way door/i.test(t) || DOOR.test(t)) return "door";
  if (/\basks\b|\?/.test(t) || it.question) return "question";
  return "approval";
}
// null: say it now; "hold": keep it for the digest
export function modeAdmit(it, mode = "live") {
  if (mode === "live" || it.asked) return null;
  if (mode === "digest" && (it.kind === "failed" || (it.tier === "important" && (it.blast || blastOf(it)) === "door"))) return null;
  return "hold";
}
// The digest: the latest per session and kind, what needs you ranked by blast radius first, all named
export function digestLine(held) {
  const last = new Map();
  for (const it of held || []) last.set(`${it.session || it.name}:${it.kind}`, it);
  const items = [...last.values()].filter((i) => i.tier !== "routine" && i.text);
  if (!items.length) return null;
  return `Since the last digest: ${salienceLine(items.map((i) => ({ ...i, blast: i.blast || blastOf(i) })), null)}`;
}
