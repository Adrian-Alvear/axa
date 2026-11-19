// AXA wakes itself, and links fire.
//
// Supervisor: when a project session finishes, gets stuck, exits or needs you, the daemon tells the AXA
// commander session (if one is open) so it can check the work, take the next step and report. The note
// is written here, never copied from a session's screen, so it carries no untrusted text. It's typed
// only when the commander is idle and you haven't typed into it for a while. AXA_SUPERVISOR=0 turns it off.
//
// Links: "when launches finishes, tell feed: rebase on it". Saved in ~/.axa/chains.json. A link fires
// once, on a "done" that comes after it was made and has held DONE_MS (so a verify-gate bounce settles
// first), and only when the next session is idle.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { files } from "../paths.mjs";
import { lastInputAt, listSessions, sendText } from "./sessions.mjs";
import { logEvent } from "./events.mjs";
import { clip } from "./text.mjs";

const SUPERVISE = process.env.AXA_SUPERVISOR !== "0";
const WAIT_MS = 15_000; // a prompt must stay open this long to count as needing you
const QUIET_MS = 30_000; // don't type while you're typing in the commander
const DONE_MS = 6_000; // "done" must hold this long
const WAKES_PER_HOUR = Number(process.env.AXA_WAKES_PER_HOUR) || 30;
const NOTABLE = { done: "finished its turn", waiting: "needs the user's approval", stuck: "looks stuck", exited: "exited", over_budget: "went over its token budget: don't give it more work; report its usage to the user" };

// ---------- links ----------
let chains = [];
try { chains = JSON.parse(readFileSync(files.chains, "utf8")).filter((c) => c?.id); } catch {}
const saveChains = () => { try { writeFileSync(files.chains, JSON.stringify(chains.map(({ sending, ...c }) => c), null, 2), { mode: 0o600 }); chmodSync(files.chains, 0o600); } catch {} };
export function listLinks() {
  const names = new Map(listSessions().map((s) => [s.id, s.name]));
  return chains.map(({ sending, ...c }) => ({ ...c, from_name: names.get(c.from), to_name: names.get(c.to) }));
}
export function addLink(fromId, toId, text) {
  const list = listSessions(), from = list.find((s) => s.id === fromId), to = list.find((s) => s.id === toId);
  text = typeof text === "string" ? text.trim() : "";
  if (!from || !to) throw Object.assign(new Error("Both sessions must be open (ids from list_sessions)."), { code: 404 });
  if (from.id === to.id) throw new Error("A session can't be linked to itself.");
  if (!text || text.length > 4000) throw new Error("Give the next session an instruction (up to 4000 characters).");
  const ch = { id: randomBytes(4).toString("hex"), from: from.id, to: to.id, text, created: Date.now() };
  chains.push(ch); saveChains();
  return { ...ch, from_name: from.name, to_name: to.name };
}
export function removeLink(id) {
  const n = chains.length;
  chains = chains.filter((c) => c.id !== id);
  saveChains();
  return chains.length < n;
}

const since = new Map(); // session -> { status, at }: how long it has been in its current state
function runLinks(list) {
  const now = Date.now();
  for (const ch of chains) {
    if (ch.fired || ch.failed || ch.sending) continue;
    const from = list.find((s) => s.id === ch.from), to = list.find((s) => s.id === ch.to);
    if (!from || !to || !to.alive) { ch.failed = !from ? "the first session was closed" : "the next session was closed"; saveChains(); continue; }
    if (from.status !== "done" || (from.last_event_at || 0) <= ch.created || now - since.get(from.id).at < DONE_MS) continue;
    if (!["ready", "done"].includes(to.status) || to.awaiting_permission) continue; // busy: wait
    ch.sending = true;
    sendText(to.id, to.mode === "shell" ? ch.text : `[AXA link: ${from.name} just finished] ${ch.text}`).then((r) => {
      ch.sending = false;
      if (!r.ok) { if (/dangerous/i.test(r.error || "")) { ch.failed = r.error; saveChains(); } return; }
      ch.fired = Date.now(); saveChains();
      logEvent({ event: "ChainFired", terminal: to.id, role: "console", from: from.name, to: to.name, text: clip(ch.text, 200) });
    });
  }
}

// ---------- supervisor ----------
const lastSeen = new Map(), pending = new Map(), wakes = [], budgetTold = new Set();
let primed = false;
function supervise(list) {
  for (const s of list) {
    if (s.mode !== "claude") continue;
    const prev = lastSeen.get(s.id);
    lastSeen.set(s.id, s.status);
    if (primed && s.usage?.over_budget && !budgetTold.has(s.id)) { budgetTold.add(s.id); pending.set(`${s.id}:budget`, { id: s.id, name: s.name, status: "over_budget", since: Date.now() }); }
    // the first pass only learns the current states; afterwards, report changes into a notable state
    if (!primed || prev === undefined || prev === s.status) continue;
    if (NOTABLE[s.status]) pending.set(s.id, { id: s.id, name: s.name, status: s.status, since: Date.now() });
    else pending.delete(s.id);
  }
  for (const id of lastSeen.keys()) if (!list.some((s) => s.id === id)) { lastSeen.delete(id); pending.delete(id); pending.delete(`${id}:budget`); budgetTold.delete(id); }
  primed = true;
  const ready = [...pending.entries()].filter(([, p]) => (p.status === "waiting" ? Date.now() - p.since >= WAIT_MS : p.status === "done" ? Date.now() - p.since >= DONE_MS : true));
  if (!ready.length) return;
  const cmd = list.find((s) => s.mode === "axa" && s.alive);
  if (!cmd || !["ready", "done"].includes(cmd.status) || cmd.awaiting_permission) return;
  if (Date.now() - lastInputAt(cmd.id) < QUIET_MS) return;
  while (wakes.length && Date.now() - wakes[0] > 3600_000) wakes.shift();
  if (wakes.length >= WAKES_PER_HOUR) return; // a runaway loop: updates wait (the needs-you badge still shows them)
  const items = ready.map(([, p]) => `${p.name} (${p.id}) ${NOTABLE[p.status]}`);
  const text = `[AXA supervisor: automatic update from the console, not typed by the user] ${items.join("; ")}. Handle this under your supervisor rules: check each one, verify any claims, take the next step if it is within what the user asked, and end with a short report for the user.`;
  sendText(cmd.id, text).then((r) => {
    if (!r.ok) return;
    wakes.push(Date.now());
    for (const [k] of ready) pending.delete(k);
    logEvent({ event: "SupervisorWake", terminal: cmd.id, role: "console", items });
  });
}

export function startSupervisor() {
  setInterval(() => {
    const list = listSessions();
    for (const s of list) { const c = since.get(s.id); if (!c || c.status !== s.status) since.set(s.id, { status: s.status, at: Date.now() }); }
    runLinks(list);
    if (SUPERVISE) supervise(list);
  }, 3000);
}
