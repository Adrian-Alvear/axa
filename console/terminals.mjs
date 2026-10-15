// Embedded terminals for the AXA console: sessions run in tmux (when available) and are streamed to
// xterm.js over WebSocket, so they survive console restarts; reloading the page reattaches.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { consoleDir, home, pluginRoot, port } from "./ensure.mjs";
import { cleanText, dangerousShell, redact } from "../lib/safety.mjs";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const { WebSocketServer } = require("ws");
const { Terminal: Headless } = require("@xterm/headless");

// node-pty's prebuilt spawn-helper sometimes ships without the execute bit ("posix_spawnp failed").
try {
  const prebuilds = join(dirname(require.resolve("node-pty/package.json")), "prebuilds");
  for (const arch of readdirSync(prebuilds)) {
    const helper = join(prebuilds, arch, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
} catch {}

const SCROLLBACK = 256 * 1024;
const terms = new Map(); // id -> { id, name, cwd, mode, proc, buf, alive, created, sockets, tmux, screen? }

// Don't leak the parent Claude Code session's identity into terminals we launch.
function cleanEnv() {
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  return env;
}

const shq = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
// Every Claude session AXA starts loads the AXA plugin, so its hooks trace it (and the commander gets
// its session tools). Project sessions run in "accept edits" mode plus AXA's permission policy
// (hooks/policy.mjs): safe actions are auto-approved, dangerous ones refused, the rest asks.
const claudeCmd = (role) =>
  role === "commander"
    ? `claude --plugin-dir ${shq(pluginRoot)} --append-system-prompt-file ${shq(join(pluginRoot, "commander.md"))}`
    : `claude --plugin-dir ${shq(pluginRoot)} --permission-mode acceptEdits`;

const expand = (p) => resolve(p.replace(/^~(?=$|\/)/, homedir()));
// Inside the home folder (a real containment check: "/home/me2" is not inside "/home/me")
const inHome = (p) => {
  const rel = relative(homedir(), p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export function listProjects(rosterFile) {
  const seen = new Map();
  const add = (path) => {
    const p = expand(path);
    try { if (statSync(p).isDirectory() && !seen.has(p)) seen.set(p, { name: basename(p), path: p }); } catch {}
  };
  // projects named in the roster first, then git repos in ~/projects and directly in your home folder
  if (rosterFile && existsSync(rosterFile)) {
    let inProjects = false;
    for (const line of readFileSync(rosterFile, "utf8").split("\n")) {
      if (line.startsWith("## ")) inProjects = /projects/i.test(line);
      if (inProjects) for (const m of line.matchAll(/`(~?\/[^`]+)`/g)) add(m[1]);
    }
  }
  const root = join(homedir(), "projects");
  try { for (const d of readdirSync(root, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith(".")) add(join(root, d.name)); } catch {}
  try {
    for (const d of readdirSync(homedir(), { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith(".") && existsSync(join(homedir(), d.name, ".git"))) add(join(homedir(), d.name));
    }
  } catch {}
  return [...seen.values()];
}

// ---------- previous Claude Code chats (to continue one as the commander) ----------
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const head = (file, bytes = 64 * 1024) => {
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(bytes);
  const n = readSync(fd, buf, 0, bytes, 0);
  closeSync(fd);
  return buf.subarray(0, n).toString("utf8");
};
// Most recent chats first: id, title (Claude's own title, else the first message), folder, last update
export function listChats(limit = 12) {
  const root = join(homedir(), ".claude", "projects");
  const files = [];
  try {
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const f of readdirSync(join(root, dir.name))) {
        if (f.endsWith(".jsonl") && CHAT_ID.test(f.slice(0, -6))) {
          const path = join(root, dir.name, f);
          files.push({ path, id: f.slice(0, -6), updated: statSync(path).mtimeMs });
        }
      }
    }
  } catch {}
  const chats = [];
  for (const f of files.sort((a, b) => b.updated - a.updated)) {
    if (chats.length >= limit) break;
    let title, cwd;
    for (const line of head(f.path).split("\n")) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      title ??= o.aiTitle || o.agentName;
      cwd ??= o.cwd;
      if (!title && o.type === "user" && typeof o.message?.content === "string") title = o.message.content.slice(0, 80);
      if (title && cwd) break;
    }
    if (cwd && inHome(cwd) && existsSync(cwd)) chats.push({ id: f.id, title: title || "Untitled chat", cwd, updated: f.updated });
  }
  return chats;
}

// Live status per session comes from its traced events (set by the server); the screen check is a backup
let statusOf = () => null;
export const setStatusSource = (fn) => (statusOf = fn);

// Text that came out of a session (its screen, report, current step) is shown cleaned of hidden
// characters and secrets: it is data, never instructions
const safe = (v) => (v == null ? v : redact(cleanText(v)));

// ---------- tmux backend ----------
// Each session runs in its own tmux session on AXA's private socket (tmux -L axa-<port>, so your own
// tmux is untouched). It keeps running when the console stops or restarts; the console attaches to it
// through a PTY for the browser, reads its screen with capture-pane and types with send-keys.
// Without tmux (or with AXA_NO_TMUX=1) sessions are plain PTYs that end with the console.
const SOCKET = `axa-${port}`;
const TMUX_CONF = join(consoleDir, "tmux.conf");
const tmuxEnv = () => {
  const env = cleanEnv();
  for (const k of ["TMUX", "TMUX_PANE", "AXA_TERMINAL_ID", "AXA_ROLE"]) delete env[k];
  return env;
};
const tmux = (...args) => spawnSync("tmux", ["-L", SOCKET, "-f", TMUX_CONF, ...args], { encoding: "utf8", env: tmuxEnv(), timeout: 5000 });
// 3.2 -> 3.02, 3.10 -> 3.1 (so versions compare as numbers); null when tmux isn't there
const tmuxVersion = (() => {
  if (process.env.AXA_NO_TMUX) return null;
  try {
    const r = spawnSync("tmux", ["-V"], { encoding: "utf8", timeout: 3000 });
    const m = r.status === 0 && r.stdout.match(/(\d+)\.(\d+)/);
    return m ? Number(m[1]) + Number(m[2]) / 100 : null;
  } catch { return null; }
})();
export const backend = tmuxVersion ? "tmux" : "pty";
const tmuxName = (id) => `axa-${id}`;
const paneTarget = (id) => `=axa-${id}:`;
const tmuxHas = (id) => tmux("has-session", "-t", `=${tmuxName(id)}`).status === 0;

// What each tmux session is (so a console restart shows it again, and a machine restart can resume
// its Claude chat): $AXA_HOME/sessions.json, readable only by you
const metaPath = join(home, "sessions.json");
const meta = new Map(); // id -> { id, name, cwd, mode, created, resume, claudeSession, recovered }
try { for (const m of JSON.parse(readFileSync(metaPath, "utf8"))) if (m?.id) meta.set(String(m.id), m); } catch {}
function saveMeta() {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const tmp = `${metaPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...meta.values()], null, 2), { mode: 0o600 });
    renameSync(tmp, metaPath);
    chmodSync(metaPath, 0o600);
  } catch {}
}
// The server reports which Claude chat each session is running (from its traced events)
export function noteSession(terminalId, sessionId) {
  const m = meta.get(terminalId);
  if (!m || !CHAT_ID.test(String(sessionId)) || m.claudeSession === sessionId) return;
  m.claudeSession = sessionId;
  saveMeta();
}

const summary = (t) => {
  const traced = statusOf(t.id);
  // While AXA's approver is deciding, the prompt is already drawn on screen: not the user's turn yet
  const waiting = t.alive && (traced?.status === "waiting" || (!traced?.asking && awaitingPermission(t)));
  return {
    id: t.id, name: t.name, cwd: t.cwd, mode: t.mode, alive: t.alive, created: t.created,
    // "waiting" wins over "stuck": a prompt on screen is the more specific reason
    status: !t.alive ? "exited" : waiting ? "waiting" : traced?.status || "starting",
    stuck_minutes: traced?.stuck_minutes,
    doing: safe(traced?.doing), tool: traced?.tool, summary: safe(traced?.summary), skill: traced?.skill,
    last_report: safe(traced?.report), error: safe(traced?.error), last_event_at: traced?.at,
    idle_seconds: Math.round((Date.now() - t.lastOutput) / 1000),
    awaiting_permission: waiting,
    // relaunched (resuming its chat) after the machine restarted
    recovered: !!t.recovered,
  };
};

// ---------- reading and typing into terminals (used by AXA's terminal tools) ----------
function screenLines(t, lines = 60) {
  const n = Math.max(1, Math.min(lines, 400));
  let out;
  if (t.tmux) {
    // -J rejoins lines the terminal wrapped, so a long secret split across two rows is still recognized.
    // Briefly cached: the session list checks every screen for permission prompts.
    const c = t.capture;
    if (!(c && Date.now() - c.at < 500 && c.n >= n) && t.alive) {
      const r = tmux("capture-pane", "-p", "-J", "-t", paneTarget(t.id), "-S", `-${n}`);
      if (r.status === 0) t.capture = { at: Date.now(), n, lines: r.stdout.split("\n").map((l) => l.trimEnd()) };
    }
    out = [...(t.capture?.lines || [])];
  } else {
    const b = t.screen.buffer.active;
    out = [];
    // Rejoin lines the terminal wrapped, so a long secret split across two rows is still recognized
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i);
      const text = line?.translateToString(true) ?? "";
      if (line?.isWrapped && out.length) out[out.length - 1] += text;
      else out.push(text);
    }
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.slice(-n);
}
// Claude Code's permission dialogs: AXA must never answer these on the user's behalf. The traced
// PermissionRequest/Notification events are the main signal; this screen check is a backup.
// Any of Claude Code's choice dialogs counts (permission, folder trust, new MCP server...): they all
// end with "Enter to confirm · Esc to cancel/exit" and number their options.
const PERMISSION_RE = /Do you want to (proceed|make this edit|create|allow)|Do you trust the files|trust this folder|Yes, and don't ask again|❯\s*1\.\s*Yes|MCP servers? found|Enter to confirm · Esc to (cancel|exit)/i;
function awaitingPermission(t) { return PERMISSION_RE.test(screenLines(t, 25).join("\n")); }

export function readTerm(id, lines = 60) {
  const t = terms.get(id);
  if (!t) return null;
  return { ...summary(t), screen: safe(screenLines(t, lines).join("\n")) };
}

const typeText = (t, text) => {
  if (!t.tmux) return t.proc.write(text);
  // tmux reads a lone ";" (or a trailing "\;") as a command separator: send those as hex bytes
  if (text) {
    if (text === ";" || text.endsWith("\\;")) tmux("send-keys", "-t", paneTarget(t.id), "-H", ...[...Buffer.from(text)].map((b) => b.toString(16)));
    else tmux("send-keys", "-t", paneTarget(t.id), "-l", "--", text);
  }
  t.capture = null;
};
const pressEnter = (t) => {
  if (!t.tmux) return t.proc.write("\r");
  tmux("send-keys", "-t", paneTarget(t.id), "Enter");
  t.capture = null;
};

// confirmed: the user explicitly approved this exact command (needed for dangerous shell commands)
export async function sendToTerm(id, text, { enter = true, confirmed = false } = {}) {
  const t = terms.get(id);
  if (!t) return { ok: false, error: "no such terminal" };
  if (!t.alive) return { ok: false, error: "terminal has exited" };
  // Plain shells run whatever is typed, so dangerous commands need the user's explicit OK.
  // Claude sessions are covered by Claude Code's own permission checks instead.
  const danger = t.mode === "shell" && dangerousShell(text);
  if (danger && !confirmed) return { ok: false, error: `Not sent: this looks dangerous (${danger}). Ask the user to approve this exact command first, then resend with confirmed_by_user: true.` };
  if (awaitingPermission(t) || statusOf(t.id)?.status === "waiting") return { ok: false, error: "This session is waiting on a permission/trust prompt. Only the user may answer it — tell them which session needs attention." };
  typeText(t, text);
  // submit separately so TUIs treat it as Enter, not part of a paste
  if (enter) { await new Promise((r) => setTimeout(r, 60)); pressEnter(t); }
  return { ok: true };
}
export const listTerms = () => [...terms.values()].map(summary);
// When the user last typed into a session from the browser (the supervisor waits until they stop)
export const lastInputAt = (id) => terms.get(id)?.lastInput || 0;

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// resume: continue a previous chat (an id from listChats) instead of starting a new one
export function createTerm({ cwd, mode = "claude", cols = 100, rows = 30, resume }) {
  if (resume !== undefined && !CHAT_ID.test(String(resume))) throw new Error("not a chat id");
  const dir = expand(cwd || homedir());
  if (!inHome(dir) || !isDir(dir)) throw new Error("cwd must be an existing folder in your home folder");
  const id = randomUUID().slice(0, 8);
  return summary(launch({ id, cwd: dir, mode, cols, rows, resume, created: Date.now() }));
}

function launch({ id, cwd, mode, cols, rows, resume, created, recovered = false }) {
  const resumeArg = resume ? ` --resume ${resume}` : "";
  const shell = process.env.SHELL || "/bin/bash";
  // claude/axa: run Claude Code (traced), and drop to a normal shell if it exits
  const args = mode === "claude" ? ["-l", "-c", `${claudeCmd("worker")}${resumeArg}; exec "$SHELL" -l`]
    : mode === "axa" ? ["-l", "-c", `${claudeCmd("commander")}${resumeArg}; exec "$SHELL" -l`]
    : ["-l"];
  // AXA_TERMINAL_ID tags this session's events so the console knows its status
  const tag = { AXA_TERMINAL_ID: id, AXA_ROLE: mode === "axa" ? "commander" : "worker" };
  const t = { id, name: mode === "axa" ? "AXA" : basename(cwd), cwd, mode, buf: "", alive: true, created, lastOutput: Date.now(), sockets: new Set(), recovered, tmux: backend === "tmux" };
  if (t.tmux) {
    // tmux 3.2+ sets the session's env with -e; older versions get it through `env`
    const withEnv = tmuxVersion >= 3.02;
    const cmd = "exec " + [...(withEnv ? [] : ["env", ...Object.entries(tag).map(([k, v]) => `${k}=${v}`)]), shell, ...args].map(shq).join(" ");
    const envArgs = withEnv ? Object.entries(tag).flatMap(([k, v]) => ["-e", `${k}=${v}`]) : [];
    const r = tmux("new-session", "-d", "-s", tmuxName(id), "-c", cwd, "-x", String(cols), "-y", String(rows), ...envArgs, cmd);
    if (r.status !== 0) throw new Error(`couldn't start the session in tmux: ${(r.stderr || r.error?.message || "").trim()}`);
    meta.set(id, { ...meta.get(id), id, name: t.name, cwd, mode, created, resume: resume || null, recovered });
    saveMeta();
    attach(t, cols, rows);
  } else {
    const proc = pty.spawn(shell, args, { name: "xterm-256color", cols, rows, cwd, env: { ...cleanEnv(), ...tag } });
    t.proc = proc;
    t.screen = new Headless({ cols, rows, scrollback: 2000, allowProposedApi: true });
    proc.onData((d) => {
      t.buf = (t.buf + d).slice(-SCROLLBACK);
      t.lastOutput = Date.now();
      t.screen.write(d);
      for (const ws of t.sockets) ws.send(d);
    });
    proc.onExit(({ exitCode }) => {
      t.alive = false;
      for (const ws of t.sockets) ws.send(`\r\n\x1b[2m[process exited ${exitCode}]\x1b[0m\r\n`);
    });
  }
  terms.set(id, t);
  return t;
}

// The browser's view of a tmux session: a tmux client in a PTY owned by this server. Only this client
// ends with the console; the session keeps running. The replay buffer is what streamed since attaching
// (tmux redraws the whole screen on attach).
function attach(t, cols, rows) {
  const proc = pty.spawn("tmux", ["-L", SOCKET, "-f", TMUX_CONF, "attach-session", "-t", `=${tmuxName(t.id)}`],
    { name: "xterm-256color", cols, rows, cwd: homedir(), env: tmuxEnv() });
  t.proc = proc;
  proc.onData((d) => {
    t.buf = (t.buf + d).slice(-SCROLLBACK);
    t.lastOutput = Date.now();
    for (const ws of t.sockets) ws.send(d);
  });
  proc.onExit(({ exitCode }) => {
    if (t.closing) return; // the console is stopping or the session was closed
    t.alive = false;
    // Its program exited and the tmux session is gone: forget it, so a restart doesn't bring it back
    if (!tmuxHas(t.id)) { meta.delete(t.id); saveMeta(); }
    for (const ws of t.sockets) ws.send(`\r\n\x1b[2m[process exited ${exitCode}]\x1b[0m\r\n`);
  });
}

// On console start: show the tmux sessions still running (same id, name and mode). If the tmux server
// itself is gone (the machine restarted), Claude sessions are relaunched resuming their chat; shells
// are dropped. tmux sessions on AXA's socket with no record are adopted as shells.
export function restoreTerms() {
  if (backend !== "tmux") return [];
  const r = tmux("list-sessions", "-F", "#{session_name}\t#{session_path}\t#{window_width}\t#{window_height}\t#{session_created}");
  const serverUp = r.status === 0; // tmux.conf keeps the server up with no sessions, so "no server" means it was stopped
  const live = new Map();
  if (serverUp) {
    for (const line of r.stdout.split("\n")) {
      const [name, path, w, h, made] = line.split("\t");
      const m = name?.match(/^axa-([\w-]+)$/);
      if (m) live.set(m[1], { path: path || homedir(), cols: Number(w) || 100, rows: Number(h) || 30, created: Number(made) * 1000 || Date.now() });
    }
  }
  const restored = [];
  for (const [id, s] of live) {
    if (terms.has(id)) continue;
    if (!meta.has(id)) meta.set(id, { id, name: basename(s.path), cwd: s.path, mode: "shell", created: s.created, resume: null, recovered: false });
    const m = meta.get(id);
    // a session that was already running isn't "recovered" any more
    if (m.recovered) { m.recovered = false; saveMeta(); }
    const t = { id, name: m.name, cwd: m.cwd, mode: m.mode, buf: "", alive: true, created: m.created, lastOutput: Date.now(), sockets: new Set(), recovered: false, tmux: true };
    attach(t, s.cols, s.rows);
    terms.set(id, t);
    restored.push(id);
  }
  for (const m of [...meta.values()]) {
    if (live.has(m.id) || terms.has(m.id)) continue;
    const chat = [m.claudeSession, m.resume].find((c) => CHAT_ID.test(String(c)));
    if (!serverUp && (m.mode === "claude" || m.mode === "axa") && chat && inHome(m.cwd) && isDir(m.cwd)) {
      try {
        launch({ id: m.id, cwd: m.cwd, mode: m.mode, cols: 100, rows: 30, resume: chat, created: m.created || Date.now(), recovered: true });
        restored.push(m.id);
        continue;
      } catch {}
    }
    meta.delete(m.id);
  }
  saveMeta();
  return restored;
}

export function killTerm(id) {
  const t = terms.get(id);
  if (!t) return false;
  t.closing = true;
  if (t.tmux) { tmux("kill-session", "-t", `=${tmuxName(id)}`); meta.delete(id); saveMeta(); }
  try { t.proc?.kill(); } catch {}
  try { t.screen?.dispose(); } catch {}
  for (const ws of t.sockets) ws.close();
  terms.delete(id);
  return true;
}

// Console stopping: detach from tmux sessions (they keep running); plain PTY sessions end with it
export function killAll() {
  for (const t of [...terms.values()]) {
    if (!t.tmux) { killTerm(t.id); continue; }
    t.closing = true;
    try { t.proc?.kill(); } catch {}
    for (const ws of t.sockets) ws.close();
    terms.delete(t.id);
  }
}
// End every session, tmux ones included
export function closeAll() { for (const id of [...terms.keys()]) killTerm(id); }

// WebSocket endpoint: /pty/<id>. `authorize(req)` decides whether the upgrade is allowed.
export function attachWebSocket(server, authorize) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const m = req.url.match(/^\/pty\/([\w-]+)/);
    const t = m && terms.get(m[1]);
    if (!t || !authorize(req)) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => {
      t.sockets.add(ws);
      if (t.buf) ws.send(t.buf);
      ws.on("message", (raw) => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        if (!t.alive) return;
        if (msg.t === "i" && typeof msg.d === "string") { t.proc.write(msg.d); t.lastInput = Date.now(); }
        if (msg.t === "r" && msg.c > 0 && msg.r > 0) { const c = Math.min(msg.c, 500), r = Math.min(msg.r, 300); t.proc.resize(c, r); t.screen?.resize(c, r); t.capture = null; }
      });
      ws.on("close", () => t.sockets.delete(ws));
    });
  });
}
