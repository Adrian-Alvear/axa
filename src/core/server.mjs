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
import { clearVoiceQueue, notifier, notifySettings, voiceHooks, voicePending } from "./notify.mjs";
import { briefNotification, briefTick, reviewProjects } from "./projects.mjs";
import { notesNeedSummary, spokenReply, summaryMode } from "./summary.mjs";
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
Object.assign(voiceHooks, { on: () => V.settings().on, busy: () => V.speaking() || summarizing > 0, speak: (text, items = []) => speakNotes(text, items) });
onChatSeen(S.noteChat);
// AXA's voice: only the commander's own session, only when voice is on (re-read from ui.json each time)
// A long reply is spoken as a summary a fast model writes (summary.mjs); the hub never waits for it, and Esc
// (POST /api/voice/stop) cancels one still being written. voiceNow is what the status bar shows.
let summarizing = 0, voiceGen = 0, voiceNow = null, voiceAbort = new AbortController();
async function say(plan, gen) {
  if (gen !== voiceGen || !plan.text) return;
  voiceNow = plan.how === "summary" ? "speaking summary" : "speaking";
  try { await V.speak(plan.text); } finally { if (gen === voiceGen && !V.speaking()) voiceNow = null; }
}
// fn(signal): Esc and mute abort the signal, which kills a summary still being written (its claude -p child)
async function planned(fn) {
  const gen = ++voiceGen;
  const signal = voiceAbort.signal;
  summarizing++; voiceNow = "writing summary";
  let plan;
  try { plan = await fn(signal); } catch { plan = { text: "" }; } finally { summarizing--; if (gen === voiceGen) voiceNow = null; }
  return say(plan, gen);
}
// Stop everything: what's speaking (the player is killed), a summary still being written, queued notifications
function hush() { cancelSummaries(); voiceGen++; voiceNow = null; clearVoiceQueue(); V.stop(); }
function cancelSummaries() { voiceAbort.abort(); voiceAbort = new AbortController(); }
// Muting takes effect at once however it's done (the hub's m or settings, or ui.json edited): checked every
// 500 ms while anything is speaking, written or queued
setInterval(() => {
  if (!(V.speaking() || summarizing > 0 || voicePending() > 0) || V.settings().on) return;
  if (V.speaking() && !V.silenceIfMuted()) return; // (the settings screen's forced voice test plays on)
  cancelSummaries(); voiceGen++; voiceNow = null; clearVoiceQueue();
}, 500).unref();
onCommanderReply((id, message) => {
  const vs = V.settings();
  if (S.listSessions().find((s) => s.id === id)?.mode !== "axa" || !vs.on) return;
  planned((signal) => spokenReply(safe(message), { more: vs.moreHint, signal }));
});
// notifications: one is said as it is; a batch, or one long one (the daily brief), is summarised the same way
function speakNotes(text, items) {
  const long = notesNeedSummary(text, items);
  if (!long || summaryMode() !== "model") return planned(async () => ({ text: V.toSpeech(safe(text), { more: false }), how: "short" }));
  const md = items.map((n) => `- ${n.title}${n.body ? `: ${n.body}` : ""}`).join("\n");
  return planned(async (signal) => {
    const r = await spokenReply(safe(md), { mode: "model", signal });
    return r.how === "summary" ? r : { text: items.length > 1 ? V.toSpeech(safe(text), { more: false }) : r.text, how: "fallback" };
  });
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
  ["GET", /^\/api\/terms$/, () => [200, S.listSessions()]],
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
  ["GET", /^\/api\/terms\/([\w-]+)\/diff$/, async (m) => { const r = await S.diffSession(m[1]); return [r ? 200 : 404, r || { error: "no such session" }]; }],
  ["POST", /^\/api\/terms\/([\w-]+)\/input$/, async (m, req) => {
    const b = await readBody(req);
    if (typeof b.text !== "string") return [400, { error: "text required" }];
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

// Everything the hub shows, in one call
async function hub(chatLimit) {
  // the projects' review (cached 60 s): the hub's Projects tab shows it; a slow first look isn't waited for
  const review = await Promise.race([projectReview().catch(() => null), new Promise((r) => setTimeout(r, 1500, null))]);
  const byPath = new Map((review || []).map((r) => [r.path, r]));
  const sessions = S.listSessions();
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
