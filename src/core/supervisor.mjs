// AXA wakes itself, and links fire.
//
// Supervisor: when a project session finishes, gets stuck, exits or needs you, the daemon tells the AXA
// commander session (if one is open) so it can check the work, take the next step and report. The note
// is written here, never copied from a session's screen (the one exception: a review's verdict line, the
// reviewer's own words about the findings, clipped and redacted). It's typed
// only when the commander is idle and you haven't typed into it for a while. AXA_SUPERVISOR=0 turns it off.
//
// Links: "when launches finishes, tell feed: rebase on it". Saved in ~/.axa/chains.json. A link fires
// once, on a "done" that comes after it was made and has held DONE_MS (so a verify-gate bounce settles
// first), and only when the next session is idle.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { files } from "../paths.mjs";
import { lastInputAt, listSessions, sendText } from "./sessions.mjs";
import { lastRun, logEvent, onRunStart } from "./events.mjs";
import { diffOf, headOf } from "./git.mjs";
import { BLOCK_PREFIX, blockMessage, citedSpecs, confirmBlock, gitState, nextStep, reviewOf, reviewPrompt, reviewSettings, runReviewer, setReview, shouldReview, verdictLine } from "./reviewer.mjs";
import { clip } from "./text.mjs";

const SUPERVISE = process.env.AXA_SUPERVISOR !== "0";
const WAIT_MS = 15_000; // a prompt must stay open this long to count as needing you
const QUIET_MS = 30_000; // don't type while you're typing in the commander
const DONE_MS = Number(process.env.AXA_DONE_MS) || 6_000; // "done" must hold this long
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

// ---------- the independent reviewer (reviewer.mjs) ----------
// A worker's "done" that changed code is reviewed before the commander hears of it. A pending "done"
// carries gate: undefined (not decided yet) | "reviewing" | "skip" | "done" (+ line, the verdict line).
const rounds = new Map(), reviewing = new Set();
// what the supervisor reaches outside itself (tests swap these)
export const deps = { send: sendText, review: runReviewer, diff: diffOf, log: logEvent, lastInputAt };
function gateDone(p, s) {
  const run = lastRun(s.id), { review, send, diff, log } = deps, isCurrent = () => pending.get(p.id) === p;
  const settings = reviewSettings(s.cwd);
  const changed = run?.git_start != null ? gitState(s.cwd) !== run.git_start : null;
  const why = shouldReview(s, run, { changed, settings });
  if (!why.review) { p.gate = "skip"; return null; }
  p.gate = "reviewing"; reviewing.add(s.id);
  setReview(s.id, { verdict: "reviewing", at: Date.now(), run: run.id });
  const fix = String(run.prompt || "").startsWith(BLOCK_PREFIX) && rounds.has(s.id);
  const goal = fix ? rounds.get(s.id).goal : run.instruction || run.prompt;
  // the whole instruction's work: from where its first turn started (a fix round continues it)
  const since = (fix && rounds.get(s.id).head) || run.head_start || null;
  const job = (async () => {
    let raw;
    try {
      const d = await diff(s.cwd, since);
      raw = await review({ cwd: s.cwd, settings, prompt: reviewPrompt({ goal, report: s.last_report || run.report, diff: d.diff, untracked: d.untracked || [], truncated: d.truncated, since: d.since, head: d.head, commits: d.commits || [], specs: citedSpecs(goal), round: fix ? rounds.get(s.id).blocks : 0 }) });
    } catch (e) { raw = { verdict: "error", summary: `the reviewer failed: ${e.message}`, checks: [], findings: [] }; }
    const r = confirmBlock(raw, s.cwd);
    const step = nextStep(rounds, s.id, run, r.verdict, settings.rounds);
    const st = rounds.get(s.id);
    if (st && !st.head) st.head = since;
    const out = { verdict: r.verdict, raw_verdict: raw.verdict, summary: r.summary, checks: r.checks, findings: r.findings, dropped: r.dropped?.length || 0, at: Date.now(), run: run.id, round: step.round, exhausted: step.exhausted };
    setReview(s.id, out); run.review = out; reviewing.delete(s.id);
    log({ event: "Review", terminal: s.id, role: "console", verdict: r.verdict, raw_verdict: raw.verdict, findings: r.findings.length, round: step.round, summary: r.summary, model: settings.model });
    if (!isCurrent()) return out; // the session moved on while it was reviewed: just record it
    if (step.to === "worker") {
      const sent = await send(s.id, blockMessage(r.findings));
      if (sent?.ok) { pending.delete(p.id); return out; }
      out.unsent = sent?.error || "not sent";
    }
    p.line = verdictLine(out) + (out.unsent ? ` (couldn't send it back to the worker: ${out.unsent})` : "");
    p.gate = "done";
    return out;
  })().finally(() => { reviewing.delete(s.id); jobs.delete(job); });
  jobs.add(job);
  return job;
}
const jobs = new Set();
export const reviewsSettled = () => Promise.all([...jobs]); // tests: wait for running reviews
// Fingerprint git when a run starts, and forget a review once the session took a new instruction
// (at the run's start when the daemon sees it live; else on the next tick, as a fallback)
function noteStart(run, cwd) {
  if (!run || run.git_start !== undefined || !cwd) return;
  run.git_start = gitState(cwd);
  run.head_start = run.git_start ? headOf(cwd) : null;
}
onRunStart((run) => noteStart(run, run.cwd));
export function trackReviews(list) {
  for (const s of list) {
    if (s.mode !== "claude") continue;
    const run = lastRun(s.id);
    if (run?.status === "running") noteStart(run, s.cwd);
    const rv = reviewOf(s.id);
    if (rv && rv.verdict !== "reviewing" && run && run.id !== rv.run && !String(run.prompt || "").startsWith(BLOCK_PREFIX)) setReview(s.id, null);
  }
}

// ---------- supervisor ----------
const lastSeen = new Map(), pending = new Map(), wakes = [], budgetTold = new Set();
let primed = false;
export function supervise(list) {
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
  // a settled "done" goes past the reviewer first (one review per session at a time)
  for (const p of pending.values()) {
    if (p.status !== "done" || p.gate !== undefined || Date.now() - p.since < DONE_MS || reviewing.has(p.id)) continue;
    const s = list.find((x) => x.id === p.id);
    if (s) gateDone(p, s); else p.gate = "skip";
  }
  const ready = [...pending.entries()].filter(([, p]) => (p.status === "waiting" ? Date.now() - p.since >= WAIT_MS : p.status === "done" ? Date.now() - p.since >= DONE_MS && (p.gate === "skip" || p.gate === "done") : true));
  if (!ready.length) return;
  const cmd = list.find((s) => s.mode === "axa" && s.alive);
  if (!cmd || !["ready", "done"].includes(cmd.status) || cmd.awaiting_permission) return;
  if (Date.now() - deps.lastInputAt(cmd.id) < QUIET_MS) return;
  while (wakes.length && Date.now() - wakes[0] > 3600_000) wakes.shift();
  if (wakes.length >= WAKES_PER_HOUR) return; // a runaway loop: updates wait (the needs-you badge still shows them)
  const items = ready.map(([, p]) => `${p.name} (${p.id}) ${NOTABLE[p.status]}${p.line ? ` · ${p.line}` : ""}`);
  const text = `[AXA supervisor: automatic update from the console, not typed by the user] ${items.join("; ")}. Handle this under your supervisor rules: check each one, verify any claims, take the next step if it is within what the user asked, and end with a short report for the user.`;
  deps.send(cmd.id, text).then((r) => {
    if (!r.ok) return;
    wakes.push(Date.now());
    for (const [k] of ready) pending.delete(k);
    deps.log({ event: "SupervisorWake", terminal: cmd.id, role: "console", items });
  });
}

export function startSupervisor() {
  setInterval(() => {
    const list = listSessions();
    for (const s of list) { const c = since.get(s.id); if (!c || c.status !== s.status) since.set(s.id, { status: s.status, at: Date.now() }); }
    runLinks(list);
    if (SUPERVISE) { trackReviews(list); supervise(list); }
  }, 3000);
}
