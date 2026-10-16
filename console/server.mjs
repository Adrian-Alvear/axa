// AXA console server: serves the UI, streams ~/.axa/events.jsonl over SSE, and (when its npm
// dependencies are installed) hosts real terminals for running Claude Code from the dashboard.
// Usage: node server.mjs [--open]   (env: AXA_PORT, AXA_HOME)
//
// Security: binds to 127.0.0.1 only, rejects foreign Host/Origin headers (DNS rebinding, other
// websites), and requires a secret token (~/.axa/console-token) exchanged for a SameSite=Strict cookie.
import { createServer } from "node:http";
import { readFileSync, statSync, openSync, readSync, closeSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, chmodSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openUrl } from "./ensure.mjs";
import { randomBytes, timingSafeEqual } from "node:crypto";

const port = Number(process.env.AXA_PORT || 4747);
const home = process.env.AXA_HOME || join(homedir(), ".axa");
const logPath = join(home, "events.jsonl");
const here = dirname(fileURLToPath(import.meta.url));
const HISTORY_BYTES = 4 * 1024 * 1024; // replay at most the last 4MB on connect
const MAX_LOG_BYTES = 50 * 1024 * 1024; // past this, the log moves to events.1.jsonl (one old copy kept)

// The log holds prompts, commands and reports: only you can read the folder and the files
mkdirSync(home, { recursive: true, mode: 0o700 });
if (!existsSync(logPath)) writeFileSync(logPath, "", { mode: 0o600 });
try { chmodSync(home, 0o700); chmodSync(logPath, 0o600); } catch {}

const tokenPath = join(home, "console-token");
if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(24).toString("hex"), { mode: 0o600 });
const token = readFileSync(tokenPath, "utf8").trim();
const url = `http://localhost:${port}`;
const unlockUrl = `${url}/?t=${token}`;

const rosterFile = () => [join(home, "roster.md"), join(here, "..", "roster.example.md")].find(existsSync);

// Terminals are optional: they need `npm install` in this folder.
let T = null, termError = null;
try { T = await import("./terminals.mjs"); } catch (e) { termError = "Run `npm install` in " + here + " to enable terminals."; }

const openBrowser = () => {
  if (process.argv.includes("--open")) openUrl(unlockUrl);
};

// ---------- access control ----------
const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
const allowedOrigins = new Set([...allowedHosts].map((h) => "http://" + h));
const safeEq = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieToken = (req) => (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === "axa_token")?.[1] || "";
const hostOk = (req) => allowedHosts.has(req.headers.host);
const originOk = (req) => !req.headers.origin || allowedOrigins.has(req.headers.origin);
const authed = (req) => hostOk(req) && originOk(req) && safeEq(cookieToken(req), token);

// ---------- event log tail ----------
function readRange(start, end) {
  if (end <= start) return "";
  const fd = openSync(logPath, "r");
  const buf = Buffer.alloc(end - start);
  readSync(fd, buf, 0, buf.length, start);
  closeSync(fd);
  return buf.toString("utf8");
}

// Roles table from ~/.axa/roster.md (falls back to the plugin's example roster).
function readRoster() {
  const file = rosterFile();
  if (!file) return [];
  const roles = [];
  let inRoles = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("## ")) inRoles = /roles/i.test(line);
    if (!inRoles || !line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim().replace(/`/g, ""));
    if (cells.length < 4 || /^-+$/.test(cells[0]) || cells[0].toLowerCase() === "role") continue;
    roles.push({ role: cells[0], subagent_type: cells[1], model: cells[2], use: cells[3] });
  }
  return roles;
}

// ---------- session status (from traced events) ----------
// Each Claude session AXA starts tags its events with AXA_TERMINAL_ID; the latest events say
// whether it's working, done (and its last report), waiting on the user, or failed.
// "Stuck": a tool started and nothing has happened in the session for this long. Measured from the
// session's last event (not the tool's start) so a long helper agent that is still busy isn't flagged.
const STUCK_MS = (Number(process.env.AXA_STUCK_MINUTES) || 20) * 60_000;
const APPROVER_MS = 75_000; // longer than the approver hook's own timeout
const sessions = new Map(); // terminal id -> { status, doing, report, error, at, inflight, asking }
function statusOf(id) {
  const s = sessions.get(id);
  if (!s) return s;
  // AXA's approver normally answers within seconds; a request still open after that is on screen
  if (s.status === "working" && s.asking && Date.now() - s.asking > APPROVER_MS) return { ...s, status: "waiting" };
  if (s.status === "working" && s.inflight?.size && Date.now() - s.at > STUCK_MS) {
    const [first] = s.inflight.values();
    return { ...s, status: "stuck", stuck_minutes: Math.round((Date.now() - first.since) / 60_000) };
  }
  return s;
}
function track(e) {
  if (!e?.terminal) return;
  // Remember which Claude chat each session runs, so it can be resumed after a machine restart
  // Only a session's own start (or /clear) names its chat, so a Claude run *inside* a session
  // (e.g. `claude -p` from its Bash tool) can't replace the chat that gets resumed after a reboot
  if (e.session && e.event === "SessionStart" && e.role && e.source !== "compact") T?.noteSession?.(e.terminal, e.session);
  const s = sessions.get(e.terminal) || { inflight: new Map() };
  s.at = e.ts;
  switch (e.event) {
    case "SessionStart": s.status = "ready"; s.inflight.clear(); break;
    case "UserPromptSubmit": s.status = "working"; s.doing = "reading the instruction"; s.tool = s.summary = undefined; s.error = undefined; s.asking = null; s.inflight.clear(); break;
    case "PreToolUse":
      s.status = "working"; s.doing = [e.tool, e.summary].filter(Boolean).join(" · "); s.tool = e.tool; s.summary = e.skill || e.summary; s.skill = e.skill;
      if (e.tool_use_id) s.inflight.set(e.tool_use_id, { tool: e.tool, summary: e.summary, since: e.ts });
      break;
    case "PostToolUse": if (s.status === "waiting") s.status = "working"; s.asking = null; s.inflight.delete(e.tool_use_id); break;
    case "PostToolUseFailure": s.error = [e.tool, e.error].filter(Boolean).join(": "); s.asking = null; s.inflight.delete(e.tool_use_id); break;
    // A permission request goes to AXA's approver first (hooks/approver.mjs). The session only waits
    // on the user when the approver escalates it, or the prompt is still open after APPROVER_MS.
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
    case "Stop": s.status = "done"; s.doing = s.tool = s.summary = s.skill = undefined; s.asking = null; s.inflight.clear(); if (e.message) s.report = e.message; break;
  }
  sessions.set(e.terminal, s);
}

const clients = new Set();
let offset = statSync(logPath).size;
let partial = "";
// Rebuild statuses from recent history (sessions in tmux keep running across console restarts)
for (const line of readRange(Math.max(0, offset - HISTORY_BYTES), offset).split("\n")) { try { track(JSON.parse(line)); } catch {} }
setInterval(() => {
  let size;
  try { size = statSync(logPath).size; } catch { return; }
  if (size < offset) offset = 0; // log was truncated/rotated
  if (size === offset) return;
  const chunk = partial + readRange(offset, size);
  offset = size;
  const lines = chunk.split("\n");
  partial = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try { track(JSON.parse(line)); } catch {}
    for (const res of clients) res.write(`data: ${line}\n\n`);
  }
  // Keep the log from growing forever: move it aside and start a fresh one
  if (size > MAX_LOG_BYTES) {
    try { renameSync(logPath, logPath.replace(/\.jsonl$/, ".1.jsonl")); writeFileSync(logPath, "", { mode: 0o600 }); offset = 0; partial = ""; } catch {}
  }
}, 250);

// ---------- supervisor: AXA wakes itself ----------
// When a project session finishes, gets stuck, exits, or needs the user, the console tells the AXA
// commander session (if one is open) so it can check the work, take the next step and report, without
// the user having to ask. The note is written here, never copied from a session's screen, so it
// carries no untrusted text. It's only typed when the commander is idle and the user hasn't typed
// into it for a while; updates queue up meanwhile. AXA_SUPERVISOR=0 turns this off.
const SUPERVISE = process.env.AXA_SUPERVISOR !== "0";
const WAIT_MS = 15_000; // how long a prompt must stay open before it counts as needing the user
const QUIET_MS = 30_000; // don't type while the user is typing in the commander tab
const WAKES_PER_HOUR = Number(process.env.AXA_WAKES_PER_HOUR) || 30;
const NOTABLE = { done: "finished its turn", waiting: "needs the user's approval", stuck: "looks stuck", exited: "exited" };
const lastSeen = new Map(), pending = new Map(), wakes = [];
let primed = false;

function supervise() {
  if (!T || !SUPERVISE) return;
  const list = T.listTerms();
  for (const s of list) {
    if (s.mode !== "claude") continue;
    const prev = lastSeen.get(s.id);
    lastSeen.set(s.id, s.status);
    // the first pass only learns the current states; afterwards, report changes into a notable state
    if (!primed || prev === undefined || prev === s.status) continue;
    if (NOTABLE[s.status]) pending.set(s.id, { name: s.name, status: s.status, since: Date.now() });
    else pending.delete(s.id); // back to work before AXA got to it
  }
  // A prompt can show on screen a moment before the approver picks it up: "needs the user" only
  // counts once it has lasted WAIT_MS
  const ready = [...pending.entries()].filter(([, p]) => p.status !== "waiting" || Date.now() - p.since >= WAIT_MS);
  for (const id of lastSeen.keys()) if (!list.some((s) => s.id === id)) { lastSeen.delete(id); pending.delete(id); }
  primed = true;
  if (!ready.length) return;

  const cmd = list.find((s) => s.mode === "axa" && s.alive);
  if (!cmd || !["ready", "done"].includes(cmd.status) || cmd.awaiting_permission) return;
  if (Date.now() - (T.lastInputAt?.(cmd.id) || 0) < QUIET_MS) return;
  while (wakes.length && Date.now() - wakes[0] > 3600_000) wakes.shift();
  if (wakes.length >= WAKES_PER_HOUR) return; // a runaway loop: updates wait (the needs-you badge still shows them)

  const items = ready.map(([id, p]) => `${p.name} (${id}) ${NOTABLE[p.status]}`);
  const text = `[AXA supervisor: automatic update from the console, not typed by the user] ${items.join("; ")}. Handle this under your supervisor rules: check each one, verify any claims, take the next step if it is within what the user asked, and end with a short report for the user.`;
  T.sendToTerm(cmd.id, text).then((r) => {
    if (!r.ok) return;
    wakes.push(Date.now());
    for (const [id] of ready) pending.delete(id);
    const ev = { ts: Date.now(), event: "SupervisorWake", terminal: cmd.id, role: "console", items };
    try { appendFileSync(logPath, JSON.stringify(ev) + "\n"); } catch {}
  });
}
setInterval(supervise, 3000);

// ---------- http ----------
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c).length > 1e5 && req.destroy()); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } }); });
const VENDOR = {
  "/vendor/xterm.js": ["@xterm/xterm/lib/xterm.js", "text/javascript"],
  "/vendor/xterm.css": ["@xterm/xterm/css/xterm.css", "text/css"],
  "/vendor/addon-fit.js": ["@xterm/addon-fit/lib/addon-fit.js", "text/javascript"],
};

const server = createServer(async (req, res) => {
  if (!hostOk(req)) return res.writeHead(403).end("forbidden host");
  const u = new URL(req.url, url);
  const path = u.pathname;

  if (path === "/" || path === "/index.html") {
    const t = u.searchParams.get("t");
    if (t) {
      if (!safeEq(t, token)) return res.writeHead(403).end("bad token");
      u.searchParams.delete("t");
      res.writeHead(302, {
        "set-cookie": `axa_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        location: "/" + (u.search || ""),
      });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(readFileSync(join(here, "index.html")));
  }
  if (VENDOR[path]) {
    const file = join(here, "node_modules", VENDOR[path][0]);
    if (!existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": VENDOR[path][1] });
    return res.end(readFileSync(file));
  }

  // everything below needs the token cookie
  if (!authed(req)) return json(res, 401, { error: "locked", hint: "Open the console with /axa:console or the unlock link it prints." });

  if (path === "/roster") return json(res, 200, readRoster());
  if (path === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const start = Math.max(0, offset - HISTORY_BYTES);
    const lines = readRange(start, offset).split("\n");
    if (start > 0) lines.shift(); // drop the cut-off first line
    res.write(`event: history\ndata: ${JSON.stringify(lines.filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean))}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => { clients.delete(res); clearInterval(ping); });
    return;
  }

  // terminals
  if (path.startsWith("/api/")) {
    if (!T) return json(res, 503, { error: termError });
    if (path === "/api/projects") return json(res, 200, T.listProjects(rosterFile()));
    if (path === "/api/chats") return json(res, 200, T.listChats());
    if (path === "/api/terms" && req.method === "GET") return json(res, 200, T.listTerms());
    if (path === "/api/terms" && req.method === "POST") {
      try {
        const body = await readBody(req);
        // Continuing a previous chat: it must run in that chat's own folder
        if (body.resume) {
          const chat = T.listChats(200).find((c) => c.id === body.resume);
          if (!chat) return json(res, 404, { error: "No such chat" });
          body.cwd = chat.cwd;
        }
        // A project can be named instead of a folder ("launches")
        if (!body.cwd && body.project) {
          const p = T.listProjects(rosterFile()).find((x) => x.name.toLowerCase() === String(body.project).toLowerCase());
          if (!p) return json(res, 404, { error: `No project called "${body.project}". Known: ${T.listProjects(rosterFile()).map((x) => x.name).join(", ") || "none"}` });
          body.cwd = p.path;
        }
        return json(res, 200, T.createTerm(body));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    const m = path.match(/^\/api\/terms\/([\w-]+)$/);
    if (m && req.method === "DELETE") return json(res, T.killTerm(m[1]) ? 200 : 404, {});
    const sm = path.match(/^\/api\/terms\/([\w-]+)\/screen$/);
    if (sm && req.method === "GET") { const r = T.readTerm(sm[1], Number(u.searchParams.get("lines")) || 60); return json(res, r ? 200 : 404, r || { error: "no such terminal" }); }
    const dm = path.match(/^\/api\/terms\/([\w-]+)\/diff$/);
    if (dm && req.method === "GET") { const r = await T.diffTerm(dm[1]); return json(res, r ? 200 : 404, r || { error: "no such terminal" }); }
    const im = path.match(/^\/api\/terms\/([\w-]+)\/input$/);
    if (im && req.method === "POST") { const b = await readBody(req); if (typeof b.text !== "string") return json(res, 400, { error: "text required" }); const r = await T.sendToTerm(im[1], b.text, { enter: b.enter !== false, confirmed: b.confirmed_by_user === true }); return json(res, r.ok ? 200 : 409, r); }
  }
  res.writeHead(404).end();
});

if (T) { T.attachWebSocket(server, authed); T.setStatusSource(statusOf); }

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`AXA console already running → ${unlockUrl}`);
    openBrowser();
    process.exit(0);
  }
  throw err;
});

const pidPath = join(home, "console.pid");
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { T?.killAll(); try { unlinkSync(pidPath); } catch {} process.exit(0); });

server.listen(port, "127.0.0.1", () => {
  writeFileSync(pidPath, String(process.pid));
  // Sessions still running in tmux show up again; after a machine restart, Claude sessions resume
  let restored = [];
  try { restored = T?.restoreTerms?.() || []; } catch (e) { console.log(`  couldn't restore sessions: ${e.message}`); }
  console.log(`AXA console → ${unlockUrl}`);
  console.log(`  events: ${logPath}`);
  console.log(`  terminals: ${T ? `enabled (${T.backend === "tmux" ? "tmux: sessions survive restarts" : "no tmux: sessions end with the console"})` : "disabled — " + termError}`);
  if (restored.length) console.log(`  restored sessions: ${restored.join(", ")}`);
  openBrowser();
});
