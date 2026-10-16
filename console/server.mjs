// AXA console server: serves the UI, streams ~/.axa/events.jsonl over SSE, and (when its npm
// dependencies are installed) hosts real terminals for running Claude Code from the dashboard.
// Usage: node server.mjs [--open]   (env: AXA_PORT, AXA_HOME)
//
// Security: binds to 127.0.0.1 only, rejects foreign Host/Origin headers (DNS rebinding, other
// websites), and requires a secret token (~/.axa/console-token) exchanged for a SameSite=Strict cookie.
import { createServer } from "node:http";
import { readFileSync, statSync, openSync, readSync, closeSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, chmodSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
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
    case "Stop":
      // AXA's verify gate sent it back to check its work (hooks/verify-gate.mjs): it isn't done yet
      // (the two hooks log in either order; each marker is used once)
      if (s.gateAt && Math.abs(e.ts - s.gateAt) < 10_000) { s.gateAt = null; s.status = "working"; s.doing = "AXA verify gate: checking its work before reporting"; break; }
      s.stopAt = e.ts;
      s.status = "done"; s.doing = s.tool = s.summary = s.skill = undefined; s.asking = null; s.inflight.clear(); if (e.message) s.report = e.message; break;
    case "VerifyGate":
      if (s.stopAt && e.ts - s.stopAt < 10_000) s.stopAt = null; // its Stop was already logged
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
const RUNS_MAX = 1000;
const clipText = (v, n) => (v == null ? undefined : String(v).slice(0, n));
function trackRun(e, s) {
  const r = openRuns.get(e.terminal);
  if (e.event === "UserPromptSubmit") {
    if (/^\s*<task-notification>/.test(e.prompt || "")) return;
    if (r) { r.status = "replaced"; r.end = e.ts; }
    const run = { id: `${e.terminal}-${e.ts}`, terminal: e.terminal, cwd: e.cwd, role: e.role, prompt: clipText(e.prompt, 400), start: e.ts, steps: 0, helpers: 0, approvals: 0, declined: 0, escalated: 0, refused: 0, gate: 0, failures: 0, answers: [], status: "running" };
    runs.push(run); openRuns.set(e.terminal, run);
    if (runs.length > RUNS_MAX) runs.splice(0, runs.length - RUNS_MAX);
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
function runsSince(since, limit) {
  const terms = new Map((T?.listTerms() || []).map((t) => [t.id, t]));
  return runs.filter((r) => (r.end || r.start) >= since).slice(-limit).reverse().map((r) => {
    const t = terms.get(r.terminal);
    const name = t ? (t.mode === "axa" ? "AXA" : t.name) : r.role === "commander" ? "AXA" : basename(r.cwd || "") || r.terminal;
    return { ...r, name, status: r.status === "running" && (!t || !t.alive) ? "unfinished" : r.status };
  });
}

// ---------- links: when one session finishes, AXA sends the next instruction to another ----------
// Saved in $AXA_HOME/chains.json. A link fires once, on a "done" that comes after it was made and has
// held DONE_MS (so a verify-gate bounce settles first), and only when the next session is idle.
const chainsPath = join(home, "chains.json");
let chains = [];
try { chains = JSON.parse(readFileSync(chainsPath, "utf8")).filter((c) => c?.id); } catch {}
const saveChains = () => { try { writeFileSync(chainsPath, JSON.stringify(chains.map(({ sending, ...c }) => c), null, 2), { mode: 0o600 }); chmodSync(chainsPath, 0o600); } catch {} };
const chainSeen = new Map(); // session -> { status, since }
function runChains(list) {
  const now = Date.now();
  for (const s of list) { const c = chainSeen.get(s.id); if (!c || c.status !== s.status) chainSeen.set(s.id, { status: s.status, since: now }); }
  for (const ch of chains) {
    if (ch.fired || ch.failed || ch.sending) continue;
    const from = list.find((s) => s.id === ch.from), to = list.find((s) => s.id === ch.to);
    if (!from || !to || !to.alive) { ch.failed = !from ? "the first session was closed" : "the next session was closed"; saveChains(); continue; }
    if (from.status !== "done" || (from.last_event_at || 0) <= ch.created || now - chainSeen.get(from.id).since < DONE_MS) continue;
    if (!["ready", "done"].includes(to.status) || to.awaiting_permission) continue; // the next one is busy: wait for it
    ch.sending = true;
    // Claude sessions get a note saying where the instruction comes from; shells get just the command
    T.sendToTerm(to.id, to.mode === "shell" ? ch.text : `[AXA link: ${from.name} just finished] ${ch.text}`).then((r) => {
      ch.sending = false;
      if (!r.ok) { if (/dangerous/i.test(r.error || "")) { ch.failed = r.error; saveChains(); } return; }
      ch.fired = Date.now(); saveChains();
      const ev = { ts: Date.now(), event: "ChainFired", terminal: to.id, role: "console", from: from.name, to: to.name, text: clipText(ch.text, 200) };
      try { appendFileSync(logPath, JSON.stringify(ev) + "\n"); } catch {}
    });
  }
}
const chainsView = () => { const terms = new Map((T?.listTerms() || []).map((t) => [t.id, t])); return chains.map(({ sending, ...c }) => ({ ...c, from_name: terms.get(c.from)?.name, to_name: terms.get(c.to)?.name })); };

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
const DONE_MS = 6_000; // "done" must hold this long (a verify-gate bounce flips it back to working)
const NOTABLE = { done: "finished its turn", waiting: "needs the user's approval", stuck: "looks stuck", exited: "exited", over_budget: "went over its token budget: don't give it more work; report its usage to the user" };
const lastSeen = new Map(), pending = new Map(), wakes = [], budgetTold = new Set();
let primed = false;

function supervise() {
  if (!T) return;
  const list = T.listTerms();
  runChains(list);
  if (!SUPERVISE) return;
  for (const s of list) {
    if (s.mode !== "claude") continue;
    const prev = lastSeen.get(s.id);
    lastSeen.set(s.id, s.status);
    // over budget: tell AXA once per session
    if (primed && s.usage?.over_budget && !budgetTold.has(s.id)) { budgetTold.add(s.id); pending.set(`${s.id}:budget`, { id: s.id, name: s.name, status: "over_budget", since: Date.now() }); }
    // the first pass only learns the current states; afterwards, report changes into a notable state
    if (!primed || prev === undefined || prev === s.status) continue;
    if (NOTABLE[s.status]) pending.set(s.id, { name: s.name, status: s.status, since: Date.now() });
    else pending.delete(s.id); // back to work before AXA got to it
  }
  // A prompt can show on screen a moment before the approver picks it up: "needs the user" only
  // counts once it has lasted WAIT_MS
  const ready = [...pending.entries()].filter(([, p]) => (p.status === "waiting" ? Date.now() - p.since >= WAIT_MS : p.status === "done" ? Date.now() - p.since >= DONE_MS : true));
  for (const id of lastSeen.keys()) if (!list.some((s) => s.id === id)) { lastSeen.delete(id); pending.delete(id); pending.delete(`${id}:budget`); budgetTold.delete(id); }
  primed = true;
  if (!ready.length) return;

  const cmd = list.find((s) => s.mode === "axa" && s.alive);
  if (!cmd || !["ready", "done"].includes(cmd.status) || cmd.awaiting_permission) return;
  if (Date.now() - (T.lastInputAt?.(cmd.id) || 0) < QUIET_MS) return;
  while (wakes.length && Date.now() - wakes[0] > 3600_000) wakes.shift();
  if (wakes.length >= WAKES_PER_HOUR) return; // a runaway loop: updates wait (the needs-you badge still shows them)

  const items = ready.map(([id, p]) => `${p.name} (${p.id || id}) ${NOTABLE[p.status]}`);
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
  "/vendor/addon-search.js": ["@xterm/addon-search/lib/addon-search.js", "text/javascript"],
  "/vendor/addon-web-links.js": ["@xterm/addon-web-links/lib/addon-web-links.js", "text/javascript"],
  "/vendor/addon-webgl.js": ["@xterm/addon-webgl/lib/addon-webgl.js", "text/javascript"],
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
  if (path === "/api/runs") return json(res, 200, runsSince(Number(u.searchParams.get("since")) || 0, Math.min(500, Number(u.searchParams.get("limit")) || 200)));
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
    if (path === "/api/chains" && req.method === "GET") return json(res, 200, chainsView());
    if (path === "/api/chains" && req.method === "POST") {
      const b = await readBody(req), terms = T.listTerms();
      const from = terms.find((t) => t.id === b.from), to = terms.find((t) => t.id === b.to), text = typeof b.text === "string" ? b.text.trim() : "";
      if (!from || !to) return json(res, 404, { error: "Both sessions must be open (ids from list_sessions)." });
      if (from.id === to.id) return json(res, 400, { error: "A session can't be linked to itself." });
      if (!text || text.length > 4000) return json(res, 400, { error: "Give the next session an instruction (up to 4000 characters)." });
      const ch = { id: randomBytes(4).toString("hex"), from: from.id, to: to.id, text, created: Date.now() };
      chains.push(ch); saveChains();
      return json(res, 200, { ...ch, from_name: from.name, to_name: to.name });
    }
    const cm = path.match(/^\/api\/chains\/([\w-]+)$/);
    if (cm && req.method === "DELETE") { const n = chains.length; chains = chains.filter((c) => c.id !== cm[1]); saveChains(); return json(res, chains.length < n ? 200 : 404, {}); }
    const m = path.match(/^\/api\/terms\/([\w-]+)$/);
    if (m && req.method === "DELETE") { const r = T.killTerm(m[1], { removeWorktree: u.searchParams.get("remove_worktree") === "1" }); return json(res, r ? 200 : 404, r || {}); }
    // The user answering a prompt: from the console page (browsers stamp Sec-Fetch-Site, which page
    // scripts can't set) or the `axa` terminal UI (x-axa-client: tui). AXA's session tools never send
    // either. Neither is a secret: what keeps project sessions out is that they can't reach the token
    // (policy) or AXA's tmux (no $TMUX in sessions).
    const am = path.match(/^\/api\/terms\/([\w-]+)\/answer$/);
    if (am && req.method === "POST") {
      const fromPage = req.headers["sec-fetch-site"] === "same-origin" && req.headers.origin, fromTui = req.headers["x-axa-client"] === "tui";
      if (!fromPage && !fromTui) return json(res, 403, { error: "Only you can answer a prompt, from the console or the axa terminal UI." });
      const b = await readBody(req);
      const r = T.answerTerm(am[1], b.n, String(b.label ?? ""));
      if (r.ok) {
        const ev = { ts: Date.now(), event: "UserAnswer", terminal: am[1], session: sessions.get(am[1])?.session, role: "console", answer: r.option.label.slice(0, 120), summary: r.question.slice(-200) };
        try { appendFileSync(logPath, JSON.stringify(ev) + "\n"); } catch {}
      }
      return json(res, r.ok ? 200 : 409, r);
    }
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
