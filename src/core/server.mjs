// The AXA daemon: owns the sessions, tracks their status, serves the API used by the terminal UI (`axa`),
// the web console and the commander's MCP tools. Started in the background by src/daemon.mjs.
//
// Security: binds to 127.0.0.1 only, rejects foreign Host/Origin headers (DNS rebinding, other
// websites), and requires a secret token (~/.axa/console-token) exchanged for a SameSite=Strict cookie.
import { createServer } from "node:http";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { expand, files, inHome, pluginRoot, port, srcDir } from "../paths.mjs";
import { activity, historyLines, logEvent, onChatSeen, onCommanderReply, onLine, runsSince, startTail, statusOf } from "./events.mjs";
import * as V from "./voice.mjs";
import * as S from "./sessions.mjs";
import { addLink, listLinks, removeLink, startSupervisor } from "./supervisor.mjs";
import { getMilestoneReview, listMilestoneReviews, startMilestone } from "./milestone.mjs";
import { listAgents, listProjects, readRoster } from "./catalog.mjs";
import { chatMessages, findChat, listChats } from "./claude-data.mjs";
import { safe } from "./text.mjs";
import { desktopWants, notifier, notifySettings, showDesktop, voiceHooks } from "./notify.mjs";
import { createNarrator, lineFor, livenessLine, logLine, sentence1 } from "./narrator.mjs";
import { earconFile, earconFor } from "./earcons.mjs";
import { createTracker, fileStore } from "./durations.mjs";
import { admitItem, escalationLine, isEscalation, whatsUp } from "./anticipate.mjs";
import { blastOf, digestLine, heartbeatLine, modeAdmit, realertDue, realertLine, recapLine, spokenLineOf, voiceFor } from "./attention.mjs";
import { DEFAULT_VOICE, VOICES } from "./kokoro.mjs";
import { SHORT } from "./speech.mjs";
import { RUNAWAY, byProjectDay, limitsText, readLimits, runawayCheck, runawayText } from "./usage.mjs";
import { headOf } from "./git.mjs";
import { commentMessage, diffLines, validComments } from "./diffcomments.mjs";
import { branchFacts, capRefusal, createCheckTracker, createSendQueue, maxWorking, queueRow, queueText, sortQueue } from "./queue.mjs";
import { briefNotification, briefTick, reviewProjects } from "./projects.mjs";
import { MORE_DETAIL, firstLine, notesNeedSummary, prefetchSummary, spokenReply, summaryMode } from "./summary.mjs";
import { readMilestones } from "./milestone.mjs";

// every project in progress (projects.mjs; cached 60 s, sessions always fresh)
const projectReview = (fresh = false) => reviewProjects({ projects: listProjects(), sessions: S.listSessions(), reviews: listMilestoneReviews(), stored: readMilestones(), fresh });
// the daily brief (ui.json "notify": { "brief_at": "09:00" }): one notification a day about all projects
setInterval(async () => {
  try {
    // (when it last went out is the daemon's own state, brief.json: clearing notifications doesn't resend it)
    await briefTick({ brief_at: notifySettings().brief_at, review: () => projectReview(true), push: (n) => notifier.push(n) });
  } catch {}
}, 30_000).unref();

if (!existsSync(files.token)) writeFileSync(files.token, randomBytes(24).toString("hex"), { mode: 0o600 });
const token = readFileSync(files.token, "utf8").trim();
const base = `http://localhost:${port}`;

// ---------- access control ----------
const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
const origins = new Set([...hosts].map((h) => "http://" + h));
const safeEq = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieToken = (req) => (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === "axa_token")?.[1] || "";
const hostOk = (req) => hosts.has(req.headers.host);
const authed = (req) => hostOk(req) && (!req.headers.origin || origins.has(req.headers.origin)) && safeEq(cookieToken(req), token);
// Answering a prompt is yours alone: from the web page (browsers stamp Sec-Fetch-Site, which page scripts
// can't set) or the terminal UI (x-axa-client: tui). The commander's tools send neither. Project sessions
// can't reach the token (policy) or AXA's tmux (no $TMUX in sessions).
const fromUser = (req) => (req.headers["sec-fetch-site"] === "same-origin" && req.headers.origin) || req.headers["x-axa-client"] === "tui";

S.setStatusSource(statusOf);
// notifications (notify.mjs): from the live event log; spoken when the voice is on and idle
onLine((line) => { try { notifier.event(JSON.parse(line)); } catch {} });
onChatSeen(S.noteChat);
// AXA's voice. Everything it says goes through the narrator (narrator.mjs): one queue by priority, coalesced,
// stale or obsolete items dropped, bursts said as one line, a P0 cutting in after the current sentence.
// A long reply is spoken as a summary a fast model writes (summary.mjs); the hub never waits for it, and Esc
// (POST /api/voice/stop) cancels one still being written. voiceNow is what the status bar shows.
let summarizing = 0, voiceGen = 0, voiceNow = null, voiceAbort = new AbortController();
// what a notification says about its session's state: it stops being true when the state changes (you answered
// the prompt, it started working again)
const EXPECT = { done: ["done"], waiting: ["waiting", "needs_trust"], needs_trust: ["needs_trust", "waiting"], failed: ["failed"], limited: ["limited"], exited: ["exited"], stuck: ["stuck"] };
function stillTrue(it) {
  if (it.gen != null && it.gen !== voiceGen) return false; // Esc, mute, or a newer reply since
  if (it.toolUse && !tracker.running(it.toolUse)) return false; // the command it was about has finished
  if (!it.session || !it.expect) return true;
  const s = S.listSessions().find((x) => x.id === it.session);
  return s ? it.expect.includes(s.status) : it.kind === "exited";
}
// time to first audio, from the event (t0) to the first sound and the first words: logged for every line
const ttfa = (items) => {
  const t0 = Math.min(...items.map((i) => i.t0 ?? i.at)), what = [...new Set(items.map((i) => i.how || i.kind))].join("+");
  return (k) => console.log(`[${new Date().toISOString()}] voice: first ${k} ${Date.now() - t0} ms after the event (${what})`);
};
// the session you're looking at in the hub (POST /api/focus, refreshed while you are): no progress chatter about it
let focus = { id: null, at: 0 };
const focusedId = () => (Date.now() - focus.at < 60_000 ? focus.id : null);
// digest / quiet mode (attention.mjs): what doesn't interrupt is held here and said as one digest
let held = [], lastDigestAt = Date.now();
const narrator = createNarrator({
  speak: async (text, { items, shouldYield }) => {
    voiceNow = items.some((i) => i.how === "summary") ? "speaking summary" : "speaking";
    const vs = V.settings();
    // an earcon first (it plays while the first sentence is made): what kind of news, before the words
    const tone = vs.earcons ? earconFor(items) : null;
    // a voice per project (voicePerProject on, Kokoro): one session's line in its project's own voice
    const one = items.length === 1 && items[0].session && items[0].name && items[0].name !== "AXA" ? items[0].name : null;
    const name = vs.perProject && vs.engine === "kokoro" && one ? voiceFor(one, vs.name || DEFAULT_VOICE, VOICES) : undefined;
    // the sentences actually heard: after a preemption the narrator says only the rest
    const chunks = V.chunkText(text, V.CHUNK, V.FIRST_CHUNK); let heard = 0;
    try { await V.speak(text, { between: shouldYield, onStart: ttfa(items), intro: tone ? earconFile(tone) : null, onHeard: (i) => { heard = Math.max(heard, i + 1); }, ...(name ? { name } : {}) }); }
    finally { if (!V.speaking()) voiceNow = null; }
    return { heard: chunks.slice(0, heard).join(" ") };
  },
  earcon: (name) => V.playEarcon(name),
  isCurrent: stillTrue,
  // verbosity, quiet hours (a P0 becomes a desktop toast, unless the desktop setting already shows it), typing
  // ...the focus gate, and the interruption mode (digest / quiet: held for the digest)
  admit: (it) => {
    const vs = V.settings(), why = admitItem(it, { verbosity: vs.verbosity, quiet: vs.quiet, typingAt: it.session ? S.lastInputAt(it.session) : 0, focus: focusedId() });
    if (why && it.priority === 0 && why.startsWith("quiet hours") && !desktopWants(notifySettings().desktop, { needsUser: true })) showDesktop("AXA", it.text);
    if (why) return why;
    if (modeAdmit(it, notifySettings().mode) === "hold") { held.push(it); if (held.length > 100) held = held.slice(-100); return "held for the digest"; }
    return null;
  },
  log: (e) => console.log(`[${new Date().toISOString()}] ${logLine(e)}`),
});
// a notification as a narrator item
// (a template line: said the moment it happens, no model)
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const noteItem = (n) => {
  const it = { kind: n.kind, session: n.session || null, name: n.project || "AXA", expect: n.session ? EXPECT[n.kind] : undefined, t0: n.at,
    text: cap(V.toSpeech(safe(lineFor(n)), { more: false })), question: /^asks you:/i.test(n.body || "") };
  return { ...it, blast: blastOf({ ...it, text: `${n.title} ${n.body || ""}` }) || undefined };
};
Object.assign(voiceHooks, { on: () => V.settings().on, add: (n) => (n.kind === "brief" ? speakBrief(n) : narrator.add(noteItem(n))) });
// fn(signal) -> { text, how }: Esc and mute abort the signal, which kills a summary still being written (its
// claude -p child). What it returns goes to the narrator as `item` (superseded by a newer reply or by Esc).
async function planned(fn, item) {
  const gen = ++voiceGen, signal = voiceAbort.signal;
  summarizing++; voiceNow = "writing summary";
  let plan;
  try { plan = await fn(signal); } catch { plan = { text: "" }; } finally { summarizing--; if (gen === voiceGen && voiceNow === "writing summary") voiceNow = null; }
  if (gen !== voiceGen || !plan.text) return;
  narrator.add({ ...item, text: plan.text, how: plan.how, gen });
}
// Stop everything: what's speaking (the player is killed), a summary still being written, queued items
function hush() { cancelSummaries(); voiceGen++; voiceNow = null; narrator.clear(); V.stop(); }
function cancelSummaries() { voiceAbort.abort(); voiceAbort = new AbortController(); }
// Muting takes effect at once however it's done (the hub's m or settings, or ui.json edited): checked every
// 500 ms while anything is speaking, written or queued
setInterval(() => {
  if (!(V.speaking() || summarizing > 0 || narrator.pending() > 0) || V.settings().on) return;
  if (V.speaking() && !V.silenceIfMuted()) return; // (the settings screen's forced voice test plays on)
  cancelSummaries(); voiceGen++; voiceNow = null; narrator.clear();
}, 500).unref();
// AXA's reply: its first sentence at once (a short reply whole); a long one's summary follows when it's ready
// (started at Stop, speculatively: prefetchSummary). If the summary fails, the reply's question (if any) and
// "There's more detail in the chat." follow instead. A question for you is always said.
onLine((line) => {
  let e; try { e = JSON.parse(line); } catch { return; }
  if (e.event === "Stop" && e.role === "commander" && !e.agent_id && e.message && V.settings().on) prefetchSummary(safe(e.message));
});
onCommanderReply((id, message, t0) => {
  const vs = V.settings();
  if (S.listSessions().find((s) => s.id === id)?.mode !== "axa" || !vs.on) return;
  const md = safe(message), item = { kind: "reply", key: "reply", session: id, name: "AXA", solo: true, t0 };
  if (summaryMode() !== "model") return planned((signal) => spokenReply(md, { more: vs.moreHint, signal }), item);
  const f = firstLine(md), gen = ++voiceGen;
  narrator.add({ ...item, text: f.text, how: f.long ? "first sentence" : "short", gen });
  if (!f.long) return;
  const signal = voiceAbort.signal;
  summarizing++;
  spokenReply(md, { more: false, signal }).catch(() => ({ how: "failed" })).then((r) => {
    if (gen !== voiceGen) return;
    const text = r.how === "summary" ? r.text : [f.question, vs.moreHint ? MORE_DETAIL : ""].filter(Boolean).join(" ");
    if (text) narrator.add({ ...item, text, how: r.how === "summary" ? "summary" : "rest", gen, t0: Date.now() });
  }).finally(() => { summarizing--; });
});
// Anticipating (anticipate.mjs, durations.mjs): the approval heads-up the moment AXA's approver (or the policy)
// sends a step to you; "usually about a minute" when a command that usually takes a while starts, and "taking
// longer than usual" once; the turn's ETA for "what's up". Durations are learned into <AXA home>/durations.json.
const sessionName = (id) => S.listSessions().find((x) => x.id === id)?.name || "a session";
const tracker = createTracker({ store: fileStore(), nameOf: sessionName, say: (it) => V.settings().on && narrator.add({ ...it, name: sessionName(it.session), text: V.toSpeech(safe(it.text), { more: false }), expect: ["working"] }) });
onLine((line) => {
  let e; try { e = JSON.parse(line); } catch { return; }
  try { tracker.event(e); } catch {}
  if (isEscalation(e) && V.settings().on) {
    const name = sessionName(e.terminal);
    narrator.add({ kind: "escalate", session: e.terminal, name, t0: e.ts, expect: ["working", "waiting", "needs_trust"], text: V.toSpeech(safe(escalationLine(e, name)), { more: false }), blast: blastOf({ kind: "escalate", reason: e.reason, text: e.summary }) });
  }
  // a worker's turn ended: its own spoken line ("🔊 ...", asked for by hooks/spoken-line.mjs) at once; without
  // one, a short report's first sentence, or a long one's Haiku summary (the template if that fails). The
  // notification's "finished" that follows is then not said again (one turn, one "finished").
  if (e.event === "Stop" && e.role === "worker" && !e.agent_id && e.terminal && e.message && V.settings().on) speakWorkerStop(e);
});
function speakWorkerStop(e) {
  const name = sessionName(e.terminal), item = { kind: "done", session: e.terminal, name, t0: e.ts, expect: ["done"] };
  const { line, rest } = spokenLineOf(safe(e.message));
  if (line) return narrator.add({ ...item, how: "agent line", text: V.toSpeech(`${name} finished: ${line}`, { more: false }) });
  const all = V.toSpeech(rest, { full: true });
  if (!all) return;
  if (all.length <= SHORT || summaryMode() !== "model") return narrator.add({ ...item, how: "template", text: V.toSpeech(`${name} finished: ${sentence1(all)}`, { more: false }) });
  spokenReply(rest, { mode: "model", more: false }).catch(() => ({ how: "failed" })).then((r) => {
    narrator.add({ ...item, how: r.how === "summary" ? "summary" : "template", text: r.how === "summary" ? `${name} finished. ${r.text}` : V.toSpeech(`${name} finished: ${sentence1(all)}`, { more: false }) });
  });
}
setInterval(() => { try { tracker.tick(); } catch {} }, 5_000).unref();
// "what's up": every session in 1-3 sentences, said at once when the voice is on (you asked: verbosity doesn't
// hold it back)
const whatsUpNow = () => whatsUp(S.listSessions(), { etaOf: (s) => tracker.eta(s.id) });

// Liveness: a session you gave a /goal, working > 3 min with nothing said about it: one short line, at most
// every ~5 min (narrator.livenessLine), at verbosity normal or chatty
const goals = new Set(), workingSince = new Map();
onLine((line) => { try { const e = JSON.parse(line); if (e.event === "UserPromptSubmit" && e.terminal && /^\s*\/goal\b/.test(e.prompt || "")) goals.add(e.terminal); } catch {} });
setInterval(() => {
  const vs = V.settings();
  if (!vs.on) return;
  const now = Date.now();
  for (const s of S.listSessions()) {
    if (s.status !== "working" || !s.alive) { workingSince.delete(s.id); continue; }
    if (!workingSince.has(s.id)) workingSince.set(s.id, now);
    if (!goals.has(s.id)) continue;
    const last = narrator.lastSaidAbout(s.id);
    const text = livenessLine({ name: s.name, doing: s.doing, workingFor: now - workingSince.get(s.id), sinceSaid: last ? now - last : Infinity, verbosity: vs.verbosity });
    if (text) narrator.add({ kind: "liveness", key: "liveness", session: s.id, name: s.name, text: V.toSpeech(safe(text), { more: false }), expect: ["working"] });
  }
}, 20_000).unref();
// Heartbeat (chatty): work expected to take over 2 min (the duration store) gets a <= 10-word status at most once
// a minute. Re-alerts: a "needs you" not answered is said again after 60 s, 3 and 10 min (at most 3 times),
// stopped the moment it's answered or you type in that session.
const waitingSince = new Map(); // id -> { since, count }
setInterval(() => {
  const vs = V.settings(), now = Date.now();
  for (const s of S.listSessions()) {
    if (!s.alive || s.mode === "shell") continue;
    if (vs.on && s.status === "working" && workingSince.has(s.id)) {
      const last = narrator.lastSaidAbout(s.id);
      const text = heartbeatLine({ name: s.name, doing: s.doing, expectedMs: tracker.expected(s.id), sinceSaid: last ? now - last : Infinity, verbosity: vs.verbosity });
      if (text) narrator.add({ kind: "heartbeat", key: "heartbeat", session: s.id, name: s.name, text: V.toSpeech(safe(text), { more: false }), expect: ["working"] });
    }
    if (!["waiting", "needs_trust"].includes(s.status)) { waitingSince.delete(s.id); continue; }
    if (!waitingSince.has(s.id)) waitingSince.set(s.id, { since: now, count: 0 });
    const w = waitingSince.get(s.id);
    if (!vs.on || !realertDue({ since: w.since, count: w.count, now, typedAt: S.lastInputAt(s.id) })) continue;
    w.count++;
    narrator.add({ kind: "realert", key: `realert${w.count}`, session: s.id, name: s.name, expect: ["waiting", "needs_trust"], text: realertLine(s.name, w.count) });
  }
}, 10_000).unref();
// the digest (digest mode): every digestMin minutes, what was held, as one line (ranked: what needs you by
// blast radius first). `w` says it at once too.
function digestNow() {
  const text = digestLine(held.filter((it) => { try { return !it.session || !it.expect || stillTrue(it); } catch { return true; } }));
  held = []; lastDigestAt = Date.now();
  return text;
}
setInterval(() => {
  const st = notifySettings();
  if (st.mode !== "digest" || !held.length || Date.now() - lastDigestAt < st.digestMin * 60_000) return;
  const text = digestNow();
  if (text && V.settings().on) narrator.add({ kind: "digest", key: "digest", asked: true, text: V.toSpeech(safe(text), { more: false }) });
}, 30_000).unref();
// the daily brief: one long notification, always summarised (when summaries are on)
function speakBrief(n) {
  const text = `${n.title}${n.body ? `: ${n.body}` : ""}`;
  if (!notesNeedSummary(text, [n]) || summaryMode() !== "model") return narrator.add(noteItem(n));
  return planned((signal) => spokenReply(safe(text), { mode: "model", signal }), { kind: "brief", name: "axa" });
}

// ---------- usage: runaway spending (usage.mjs) ----------
// Every minute: each working session's tokens (official, from its transcript), its HEAD (a commit resets the
// clock) and its last turn end. Past the policy's "runaway" threshold: a needs-you notification, once an hour.
const spend = new Map(); // id -> { samples: [{at, tokens}], head, lastCommitAt, lastStopAt, warnedAt }
onLine((line) => { try { const e = JSON.parse(line); if (e.event === "Stop" && e.terminal && !e.agent_id && spend.has(e.terminal)) spend.get(e.terminal).lastStopAt = e.ts; } catch {} });
const runawayLimit = () => { try { return Number(JSON.parse(readFileSync(files.policy, "utf8")).runaway?.tokens15m) || RUNAWAY.tokens; } catch { return RUNAWAY.tokens; } };
setInterval(() => {
  const now = Date.now();
  for (const s of S.listSessions()) {
    if (!s.alive || s.mode === "shell" || !s.usage) { spend.delete(s.id); continue; }
    const r = spend.get(s.id) || { samples: [], head: null, lastCommitAt: 0, lastStopAt: 0, warnedAt: 0 };
    spend.set(s.id, r);
    r.samples.push({ at: now, tokens: s.usage.tokens });
    r.samples = r.samples.filter((x) => x.at >= now - 30 * 60_000);
    const head = headOf(s.worktree?.path || s.cwd);
    if (head && r.head && head !== r.head) r.lastCommitAt = now;
    r.head = head || r.head;
    if (now - r.warnedAt < 3600_000) continue;
    const hit = runawayCheck(r.samples, { now, limit: runawayLimit(), lastCommitAt: r.lastCommitAt, lastStopAt: r.lastStopAt, doneAt: r.lastStopAt });
    if (hit) { r.warnedAt = now; notifier.push({ kind: "runaway", session: s.id, project: s.name, title: `${s.name} may be looping`, body: runawayText(s.name, hit), needsUser: true }); }
  }
}, 60_000).unref();
// ---------- review capacity (queue.mjs): the review queue and the worker cap ----------
const checks = createCheckTracker();
onLine((line) => { try { checks.event(JSON.parse(line)); } catch {} });
const uiCfg = () => { try { return JSON.parse(readFileSync(files.ui, "utf8")); } catch { return {}; } };
const capQueue = createSendQueue({ send: (it) => S.sendText(it.id, it.text, { enter: true, confirmed: false }).then((r) => console.log(`[${new Date().toISOString()}] queue: ${r.ok ? "sent" : `couldn't send (${r.error})`} the queued message to ${it.id}`)) });
setInterval(() => { capQueue.tick(S.listSessions(), maxWorking(uiCfg())).catch(() => {}); }, 5_000).unref();
function reviewQueue() {
  const ms = listMilestoneReviews();
  const rows = S.listSessions().filter((s) => s.alive && s.mode === "claude").map((s) => {
    const repo = s.worktree?.repo || s.cwd, mv = ms.filter((r) => r.repo === repo && r.verdict).sort((a, b) => b.started - a.started)[0]?.verdict;
    return queueRow(s, branchFacts(s.worktree?.path || s.cwd), checks.of(s.id), s.review?.verdict || mv || null);
  });
  const list = sortQueue(rows);
  return { rows: list, text: queueText(list), waiting: capQueue.list(), max_working: maxWorking(uiCfg()) };
}
// GET /api/usage: per session (tokens official, cost estimate), per project per day, the account's limits
function usageReport() {
  const ss = S.listSessions().filter((s) => s.usage);
  const sessions = ss.map((s) => ({ id: s.id, name: s.name, project: s.worktree?.repo || s.cwd, alive: s.alive, model: s.usage.model, tokens: s.usage.tokens, input: s.usage.input, output: s.usage.output, cached: s.usage.cached, cost: s.usage.cost, tokens_label: "official", cost_label: "estimate", budget: s.usage.budget, over_budget: s.usage.over_budget }));
  const limits = readLimits();
  return { sessions, projects: byProjectDay(ss), limits, limits_text: limitsText(limits), total_cost: Math.round(sessions.reduce((a, x) => a + (x.cost || 0), 0) * 100) / 100 };
}

// ---------- http ----------
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c).length > 1e5 && req.destroy()); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } }); });
const VENDOR = {
  "/vendor/xterm.js": ["@xterm/xterm/lib/xterm.js", "text/javascript"],
  "/vendor/xterm.css": ["@xterm/xterm/css/xterm.css", "text/css"],
  "/vendor/addon-fit.js": ["@xterm/addon-fit/lib/addon-fit.js", "text/javascript"],
  "/vendor/addon-search.js": ["@xterm/addon-search/lib/addon-search.js", "text/javascript"],
  "/vendor/addon-web-links.js": ["@xterm/addon-web-links/lib/addon-web-links.js", "text/javascript"],
  "/vendor/addon-webgl.js": ["@xterm/addon-webgl/lib/addon-webgl.js", "text/javascript"],
};

// Routes: [method, pattern, handler(match, req, url)] -> [status, body]
const routes = [
  ["GET", /^\/api\/health$/, () => [200, { ok: true, pid: process.pid, tmux: S.hasTmux }]],
  ["GET", /^\/api\/hub$/, async (m, req, u) => [200, await hub(Number(u.searchParams.get("chats")) || 40)]],
  ["GET", /^\/api\/terms$/, () => [200, withEta(S.listSessions())]],
  ["GET", /^\/api\/activity$/, (m, req, u) => [200, activity(Math.min(240, Number(u.searchParams.get("minutes")) || 60), Math.min(300, Number(u.searchParams.get("limit")) || 60))]],
  ["POST", /^\/api\/terms$/, async (m, req) => {
    const b = await readBody(req);
    // Continuing a chat: it runs in that chat's own folder. If it's already open, that session is returned.
    if (b.resume) {
      const open = S.listSessions().find((s) => s.alive && s.chat === b.resume);
      if (open) return [200, open];
      const chat = findChat(b.resume);
      if (!chat) return [404, { error: "No such chat" }];
      b.cwd = chat.cwd;
      b.name ||= chat.title.replace(/\s+/g, " ").slice(0, 40);
    }
    // A project can be named instead of a folder ("launches")
    if (!b.cwd && b.project) {
      const ps = listProjects(), p = ps.find((x) => x.name.toLowerCase() === String(b.project).toLowerCase());
      if (!p) return [404, { error: `No project called "${b.project}". Known: ${ps.map((x) => x.name).join(", ") || "none"}` }];
      b.cwd = p.path;
    }
    const s = S.createSession(b);
    // wait: return once it's ready or waiting on something (a prompt, the trust dialog), at most 60 s
    return [200, b.wait === true ? await S.waitReady(s.id, { timeoutMs: 60_000 }) : s];
  }],
  // each project in progress: name, path, git facts, sessions, last milestone review, handoff (projects.mjs)
  ["GET", /^\/api\/projects$/, async (m, req, u) => [200, await projectReview(u.searchParams.get("fresh") === "1")]],
  ["GET", /^\/api\/chats$/, (m, req, u) => [200, listChats({ limit: Math.min(500, Number(u.searchParams.get("limit")) || 50), q: u.searchParams.get("q") || "" })]],
  ["GET", /^\/api\/agents$/, () => [200, listAgents()]],
  ["GET", /^\/api\/chats\/([0-9a-f-]+)\/messages$/, (m, req, u) => { const r = chatMessages(m[1], Math.min(50, Number(u.searchParams.get("limit")) || 12)); return r ? [200, r.map((x) => ({ ...x, text: safe(x.text) }))] : [404, { error: "no such chat" }]; }],
  ["GET", /^\/roster$/, () => [200, readRoster()]],
  ["GET", /^\/api\/runs$/, (m, req, u) => [200, runsSince(Number(u.searchParams.get("since")) || 0, Math.min(500, Number(u.searchParams.get("limit")) || 200))]],
  ["GET", /^\/api\/chains$/, () => [200, listLinks()]],
  ["POST", /^\/api\/chains$/, async (m, req) => { const b = await readBody(req); return [200, addLink(b.from, b.to, b.text)]; }],
  ["DELETE", /^\/api\/chains\/([\w-]+)$/, (m) => [removeLink(m[1]) ? 200 : 404, {}]],
  ["DELETE", /^\/api\/terms\/([\w-]+)$/, (m, req, u) => { const r = S.closeSession(m[1], { removeWorktree: u.searchParams.get("remove_worktree") === "1" }); return [r ? 200 : 404, r || {}]; }],
  ["POST", /^\/api\/terms\/([\w-]+)\/rename$/, async (m, req) => { const b = await readBody(req); return [S.renameSession(m[1], b.name || "") ? 200 : 404, {}]; }],
  ["POST", /^\/api\/terms\/([\w-]+)\/answer$/, async (m, req) => {
    if (!fromUser(req)) return [403, { error: "Only you can answer a prompt, from the console or the axa terminal UI." }];
    const b = await readBody(req);
    const r = S.answer(m[1], b.n, String(b.label ?? ""));
    if (r.ok) logEvent({ event: "UserAnswer", terminal: m[1], session: statusOf(m[1])?.session, role: "console", answer: r.option.label.slice(0, 120), summary: r.question.slice(-200) });
    return [r.ok ? 200 : 409, r];
  }],
  ["GET", /^\/api\/terms\/([\w-]+)\/screen$/, (m, req, u) => { const r = S.readScreen(m[1], Number(u.searchParams.get("lines")) || 60); return [r ? 200 : 404, r || { error: "no such session" }]; }],
  ["GET", /^\/api\/terms\/([\w-]+)\/diff$/, async (m) => { const r = await S.diffSession(m[1]); return [r ? 200 : 404, r ? { ...r, rows: diffLines(r.diff) } : { error: "no such session" }]; }],
  // comments on a session's diff (diffcomments.mjs): packed into one message and typed into that session through
  // the usual safe send path, so it shows in its chat. Only you comment (the hub or the web page).
  ["POST", /^\/api\/terms\/([\w-]+)\/comments$/, async (m, req) => {
    if (!fromUser(req)) return [403, { error: "only the user comments on a diff (from the hub or the web console)" }];
    const text = commentMessage(validComments(await readBody(req)));
    if (!text) return [400, { error: "no comments to send" }];
    const r = await S.sendText(m[1], text, { enter: true });
    if (r.ok) S.noteInput(m[1]);
    return [r.ok ? 200 : 409, { ...r, text }];
  }],
  ["POST", /^\/api\/terms\/([\w-]+)\/input$/, async (m, req) => {
    const b = await readBody(req);
    if (typeof b.text !== "string") return [400, { error: "text required" }];
    // the worker cap: the commander can't start more than sessions.maxWorking at once (you, from the hub, can)
    if (!fromUser(req)) {
      const no = capRefusal(S.listSessions(), m[1], maxWorking(uiCfg()));
      if (no && b.queue === true) { const n = capQueue.add({ id: m[1], text: b.text }); return [202, { ok: true, queued: true, position: n, note: `Queued (#${n}): AXA types it in when a slot frees.` }]; }
      if (no) return [409, { ok: false, error: no }];
    }
    const r = await S.sendText(m[1], b.text, { enter: b.enter !== false, confirmed: b.confirmed_by_user === true });
    if (r.ok && fromUser(req)) S.noteInput(m[1]);
    return [r.ok ? 200 : 409, r];
  }],
  // milestone reviews (milestone.mjs): the commander's review_changes and `axa review`
  ["GET", /^\/api\/review$/, () => [200, listMilestoneReviews()]],
  ["GET", /^\/api\/review\/([\w-]+)$/, (m) => { const r = getMilestoneReview(m[1]); return [r ? 200 : 404, r || { error: "no such review" }]; }],
  ["POST", /^\/api\/review$/, async (m, req) => {
    const b = await readBody(req);
    let cwd = typeof b.cwd === "string" && b.cwd.trim() ? expand(b.cwd.trim()) : "";
    if (!cwd && b.project) {
      const ps = listProjects(), p = ps.find((x) => x.name.toLowerCase() === String(b.project).toLowerCase());
      if (!p) return [404, { error: `No project called "${b.project}". Known: ${ps.map((x) => x.name).join(", ") || "none"}` }];
      cwd = p.path;
    }
    if (!cwd || !inHome(cwd) || !existsSync(cwd)) return [400, { error: "Give a project, or a folder in your home folder (cwd)." }];
    return [200, startMilestone({ cwd, base: b.base || undefined, goal: b.goal, source: b.source === "cli" ? "cli" : "commander" })];
  }],
  // the daily brief, now (`axa brief now`): doesn't change when the daily one goes out
  // the session you're looking at in the hub (null: the hub itself): the focus gate
  ["POST", /^\/api\/focus$/, async (m, req) => { const b = await readBody(req); focus = { id: typeof b.session === "string" ? b.session : null, at: Date.now() }; return [200, {}]; }],
  // back at the hub after a while: "while you were away", from the notifications since then (summarised when long)
  ["POST", /^\/api\/recap$/, async (m, req) => {
    const b = await readBody(req), since = Number(b.since) || Date.now() - 10 * 60_000;
    const text = recapLine(notifier.list().filter((n) => n.at > since));
    if (!text) return [200, { text: null, spoken: false }];
    const spoken = V.settings().on, item = { kind: "recap", key: "recap", asked: true, solo: true };
    if (spoken) {
      if (text.length > SHORT && summaryMode() === "model") planned((signal) => spokenReply(safe(text), { mode: "model", signal }), item);
      else narrator.add({ ...item, text: V.toSpeech(safe(text), { more: false }) });
    }
    return [200, { text, spoken }];
  }],
  ["GET", /^\/api\/usage$/, () => [200, usageReport()]],
  ["GET", /^\/api\/queue$/, () => [200, reviewQueue()]],
  ["POST", /^\/api\/whatsup$/, () => {
    // in digest / quiet mode, what was held comes first
    const digest = held.length ? digestNow() : null;
    const text = [digest, whatsUpNow()].filter(Boolean).join(" "), spoken = V.settings().on;
    if (spoken) narrator.add({ kind: "whatsup", key: "whatsup", solo: true, asked: true, text: V.toSpeech(safe(text), { more: false }) });
    return [200, { text, spoken }];
  }],
  ["POST", /^\/api\/brief$/, async () => { const n = notifier.push(await briefNotification(() => projectReview(true))); return [200, n || { error: "a brief was just sent" }]; }],
  // notifications for you (notify.mjs), oldest first; since: only those after that time (ms)
  ["GET", /^\/api\/notifications$/, (m, req, u) => { const since = Number(u.searchParams.get("since")) || 0, all = notifier.list(); return [200, { items: all.filter((n) => n.at > since).slice(-Math.min(200, Number(u.searchParams.get("limit")) || 200)), total: all.length }]; }],
  ["POST", /^\/api\/notifications\/clear$/, () => { notifier.clear(); return [200, {}]; }],
  ["GET", /^\/api\/voice$/, async () => [200, await V.info()]],
  ["POST", /^\/api\/voice\/stop$/, () => { hush(); return [200, {}]; }],
  // what the voice is doing now, for the status bar: "writing summary" | "speaking summary" | "speaking" | null
  ["GET", /^\/api\/voice\/now$/, () => [200, { now: voiceNow }]],
  ["POST", /^\/api\/voice\/test$/, () => {
    const b = V.detect(), { engine } = V.settings();
    if (engine !== "kokoro" && !b.name) return [409, { error: b.why }];
    V.speak("AXA voice check.", { force: true }); // the one path that may speak while the voice is off
    return [200, { engine, backend: engine === "kokoro" ? "kokoro" : b.name }];
  }],
  // the terminal UI says when you type into a session (the supervisor waits until you stop)
  ["POST", /^\/api\/terms\/([\w-]+)\/typing$/, (m) => { S.noteInput(m[1]); return [200, {}]; }],
];

// each working session's time left (the duration store), for the Control lanes
const withEta = (ss) => ss.map((s) => { const eta = s.status === "working" ? tracker.left(s.id) : null; return eta ? { ...s, eta } : s; });
// Everything the hub shows, in one call
async function hub(chatLimit) {
  // the projects' review (cached 60 s): the hub's Projects tab shows it; a slow first look isn't waited for
  const review = await Promise.race([projectReview().catch(() => null), new Promise((r) => setTimeout(r, 1500, null))]);
  const byPath = new Map((review || []).map((r) => [r.path, r]));
  const sessions = withEta(S.listSessions());
  const open = new Map(sessions.filter((s) => s.chat && s.alive).map((s) => [s.chat, s.id]));
  return {
    sessions,
    chats: listChats({ limit: chatLimit }).map((c) => ({ ...c, open_in: open.get(c.id) || null })),
    projects: listProjects().map((p) => ({ ...p, sessions: sessions.filter((s) => s.alive && (s.worktree?.repo || s.cwd) === p.path).length, review: byPath.get(p.path) || null })),
    agents: listAgents(),
    links: listLinks(),
    notifications: notifier.list().slice(-60),
    tmux: S.hasTmux,
  };
}

const server = createServer(async (req, res) => {
  if (!hostOk(req)) return res.writeHead(403).end("forbidden host");
  const u = new URL(req.url, base);
  const path = u.pathname;

  if (path === "/" || path === "/index.html") {
    const t = u.searchParams.get("t");
    if (t) {
      if (!safeEq(t, token)) return res.writeHead(403).end("bad token");
      u.searchParams.delete("t");
      res.writeHead(302, { "set-cookie": `axa_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, location: "/" + (u.search || "") });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(readFileSync(join(srcDir, "web", "index.html")));
  }
  if (VENDOR[path]) {
    const file = join(pluginRoot, "node_modules", VENDOR[path][0]);
    if (!existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": VENDOR[path][1] });
    return res.end(readFileSync(file));
  }
  if (!authed(req)) return json(res, 401, { error: "locked", hint: "Open the console with `axa web` or the unlock link it prints." });

  if (path === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: history\ndata: ${JSON.stringify(historyLines().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean))}\n\n`);
    const off = onLine((line) => res.write(`data: ${line}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => { off(); clearInterval(ping); });
    return;
  }
  for (const [method, re, fn] of routes) {
    const m = req.method === method && path.match(re);
    if (!m) continue;
    try { const [code, body] = await fn(m, req, u); return json(res, code, body); }
    catch (e) { return json(res, e.code === 404 ? 404 : 400, { error: e.message }); }
  }
  res.writeHead(404).end();
});

S.attachWebSocket(server, authed);
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") { console.log(`AXA is already running on port ${port}`); process.exit(0); }
  throw err;
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { V.stop(); S.detachAll(); try { unlinkSync(files.pid); } catch {} process.exit(0); });

server.listen(port, "127.0.0.1", () => {
  writeFileSync(files.pid, String(process.pid));
  let restored = [];
  try { restored = S.restoreSessions(); } catch (e) { console.log(`  couldn't restore sessions: ${e.message}`); }
  startTail();
  startSupervisor();
  console.log(`[${new Date().toISOString()}] AXA daemon on ${base} (pid ${process.pid})${S.hasTmux ? "" : " — tmux not found: sessions can't start"}`);
  if (restored.length) console.log(`  restored sessions: ${restored.join(", ")}`);
});
