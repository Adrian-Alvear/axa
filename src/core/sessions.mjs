// Sessions: each Claude Code (or shell) session AXA runs lives in its own tmux session on AXA's private
// socket (tmux -L axa-<port>; your own tmux is untouched). They keep running when the daemon or the UI
// stops. The daemon attaches one tmux client per session (in a PTY) to stream it to the web console,
// reads screens with capture-pane and types with send-keys. The terminal UI attaches its own clients.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dangerousShell } from "../../lib/safety.mjs";
import { expand, files, home, inHome, pluginRoot } from "../paths.mjs";
import { SOCKET, TMUX_CONF, tmuxEnv } from "./tmux-client.mjs";
import { safe } from "./text.mjs";
import { gitInfo, diffOf, makeWorktree, removeWorktree } from "./git.mjs";
import { reviewOf } from "./reviewer.mjs";
import { CHAT_ID, usageOf } from "./claude-data.mjs";
import { parseChoices, promptOnScreen } from "./screen.mjs";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

// node-pty's prebuilt spawn-helper sometimes ships without the execute bit ("posix_spawnp failed")
try {
  const prebuilds = join(dirname(require.resolve("node-pty/package.json")), "prebuilds");
  for (const arch of readdirSync(prebuilds)) { const h = join(prebuilds, arch, "spawn-helper"); if (existsSync(h)) chmodSync(h, 0o755); }
} catch {}

// ---------- tmux ----------
const tmux = (...args) => spawnSync("tmux", ["-L", SOCKET, "-f", TMUX_CONF, ...args], { encoding: "utf8", env: tmuxEnv(), timeout: 5000 });
// 3.2 -> 3.02 so versions compare as numbers; null when tmux isn't installed
const tmuxVersion = (() => {
  try {
    const m = spawnSync("tmux", ["-V"], { encoding: "utf8", timeout: 3000 }).stdout?.match(/(\d+)\.(\d+)/);
    return m ? Number(m[1]) + Number(m[2]) / 100 : null;
  } catch { return null; }
})();
export const hasTmux = !!tmuxVersion;
export const tmuxName = (id) => `axa-${id}`;
const pane = (id) => `=axa-${id}:`;
const tmuxHas = (id) => tmux("has-session", "-t", `=${tmuxName(id)}`).status === 0;

// ---------- what each session is: $AXA_HOME/sessions.json (so a restart shows it again, or resumes its chat) ----------
const meta = new Map(); // id -> { id, name, cwd, mode, created, resume, claudeSession, recovered, worktree }
try { for (const m of JSON.parse(readFileSync(files.sessions, "utf8"))) if (m?.id) meta.set(String(m.id), m); } catch {}
function saveMeta() {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const tmp = `${files.sessions}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...meta.values()], null, 2), { mode: 0o600 });
    renameSync(tmp, files.sessions);
  } catch {}
}
// The daemon learns from the hook events which Claude chat each session runs
export function noteChat(id, chat) {
  const m = meta.get(id);
  if (!m || !CHAT_ID.test(String(chat)) || m.claudeSession === chat) return;
  m.claudeSession = chat;
  saveMeta();
}

// Live status per session comes from its traced events (set by the server)
let traced = () => null;
export const setStatusSource = (fn) => (traced = fn);

const SCROLLBACK = 256 * 1024;
const terms = new Map(); // id -> { id, name, cwd, mode, proc, buf, alive, created, lastOutput, lastInput, sockets, capture, width }

// ---------- screen ----------
function screenLines(t, n = 60) {
  n = Math.max(1, Math.min(n, 400));
  // -J rejoins wrapped lines (so a long secret split across rows is still recognized). Briefly cached.
  const c = t.capture;
  if (!(c && Date.now() - c.at < 500 && c.n >= n) && t.alive) {
    const r = tmux("capture-pane", "-p", "-J", "-t", pane(t.id), "-S", `-${n}`);
    if (r.status === 0) t.capture = { at: Date.now(), n, lines: r.stdout.split("\n").map((l) => l.trimEnd()) };
  }
  const out = [...(t.capture?.lines || [])];
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.slice(-n);
}
const paneWidth = (t) => {
  if (!(t.width && Date.now() - t.width.at < 2000)) t.width = { at: Date.now(), n: Number(tmux("display-message", "-p", "-t", pane(t.id), "#{pane_width}").stdout) || 100 };
  return t.width.n;
};
const promptOpen = (t) => promptOnScreen(screenLines(t, 40));
function choicesOf(t) {
  const c = parseChoices(screenLines(t, 40), paneWidth(t));
  return c && { ...c, question: safe(c.question), options: c.options.map((o) => ({ ...o, label: safe(o.label) })) };
}

// ---------- the summary every client sees ----------
function summary(t) {
  const tr = traced(t.id) || null;
  // While AXA's approver is deciding, the prompt is already on screen: not your turn yet
  const waiting = t.alive && (tr?.status === "waiting" || (!tr?.asking && promptOpen(t)));
  const m = meta.get(t.id) || {};
  return {
    id: t.id, name: t.name, cwd: t.cwd, mode: t.mode, alive: t.alive, created: t.created,
    status: !t.alive ? "exited" : waiting ? "waiting" : tr?.status || (t.mode === "shell" ? "ready" : "starting"),
    stuck_minutes: tr?.stuck_minutes,
    doing: safe(tr?.doing), tool: tr?.tool, skill: tr?.skill,
    last_report: safe(tr?.report), error: safe(tr?.error), last_event_at: tr?.at,
    idle_seconds: Math.round((Date.now() - t.lastOutput) / 1000),
    awaiting_permission: waiting,
    git: t.alive && t.mode !== "axa" ? gitInfo(t.cwd) : null,
    usage: t.mode === "shell" ? null : usageOf(m.claudeSession, t.cwd, t.alive),
    choices: waiting ? choicesOf(t) : undefined,
    chat: m.claudeSession || m.resume || null,
    helpers: tr?.helpers || [],
    worktree: m.worktree,
    recovered: !!t.recovered,
    review: t.mode === "claude" ? reviewOf(t.id) : null, // the independent reviewer's latest verdict
  };
}
export const listSessions = () => [...terms.values()].map(summary);
export const getSession = (id) => (terms.has(id) ? summary(terms.get(id)) : null);
export const lastInputAt = (id) => terms.get(id)?.lastInput || 0;

export function readScreen(id, lines = 60) {
  const t = terms.get(id);
  return t ? { ...summary(t), screen: safe(screenLines(t, lines).join("\n")) } : null;
}
export async function diffSession(id) {
  const t = terms.get(id);
  return t ? { ...summary(t), ...(await diffOf(t.cwd)) } : null;
}

// ---------- typing ----------
function typeText(t, text) {
  if (!text) return;
  // tmux reads a lone ";" (or a trailing "\;") as a command separator: send those as hex bytes
  if (text === ";" || text.endsWith("\\;")) tmux("send-keys", "-t", pane(t.id), "-H", ...[...Buffer.from(text)].map((b) => b.toString(16)));
  else tmux("send-keys", "-t", pane(t.id), "-l", "--", text);
  t.capture = null;
}
// confirmed: you explicitly approved this exact command (needed for dangerous shell commands)
export async function sendText(id, text, { enter = true, confirmed = false } = {}) {
  const t = terms.get(id);
  if (!t) return { ok: false, error: "no such session" };
  if (!t.alive) return { ok: false, error: "the session has exited" };
  // Shells run whatever is typed, so dangerous commands need your explicit OK (Claude has its own checks)
  const danger = t.mode === "shell" && dangerousShell(text);
  if (danger && !confirmed) return { ok: false, error: `Not sent: this looks dangerous (${danger}). Ask the user to approve this exact command first, then resend with confirmed_by_user: true.` };
  if (promptOpen(t) || traced(t.id)?.status === "waiting") return { ok: false, error: "This session is waiting on a permission/trust prompt. Only the user may answer it: tell them which session needs attention." };
  typeText(t, text);
  // submit separately so TUIs treat it as Enter, not part of a paste
  if (enter) { await new Promise((r) => setTimeout(r, 60)); tmux("send-keys", "-t", pane(t.id), "Enter"); t.capture = null; }
  return { ok: true };
}
// You picked option n (and saw `label`): move the menu cursor there and press Enter, only if the same
// menu is still on screen, so an answer never lands on a different prompt
export function answer(id, n, label) {
  const t = terms.get(id);
  if (!t || !t.alive) return { ok: false, error: "That session isn't running." };
  t.capture = null;
  const c = promptOpen(t) && choicesOf(t);
  if (!c) return { ok: false, error: "That prompt is no longer on screen." };
  const o = c.options.find((x) => x.n === Number(n));
  if (!o || o.label !== label) return { ok: false, error: "The prompt changed. Look again before answering." };
  const moves = o.n - 1 - c.cursor;
  tmux("send-keys", "-t", pane(t.id), ...Array(Math.abs(moves)).fill(moves > 0 ? "Down" : "Up"), "Enter");
  t.capture = null;
  return { ok: true, option: o, question: c.question };
}
// Someone typed into the session from a UI (the supervisor waits until you stop)
export function noteInput(id) { const t = terms.get(id); if (t) t.lastInput = Date.now(); }

// ---------- starting sessions ----------
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
// Every Claude session AXA starts loads the AXA plugin so its hooks trace it. Project sessions run in
// accept-edits mode under AXA's permission policy; the commander gets AXA's prompt and session tools.
const claudeCmd = (role) =>
  role === "commander"
    ? `claude --plugin-dir ${shq(pluginRoot)} --append-system-prompt-file ${shq(join(pluginRoot, "commander.md"))}`
    : `claude --plugin-dir ${shq(pluginRoot)} --permission-mode acceptEdits`;
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// mode: claude | axa (the commander) | shell. resume: a chat id to continue. worktree: true or a name.
export function createSession({ cwd, mode = "claude", cols = 100, rows = 30, resume, worktree, name }) {
  if (!hasTmux) throw new Error("AXA needs tmux: install it (sudo apt install tmux / brew install tmux) and try again");
  if (!["claude", "axa", "shell"].includes(mode)) throw new Error("mode must be claude, axa or shell");
  if (resume !== undefined && resume !== null && !CHAT_ID.test(String(resume))) throw new Error("not a chat id");
  let dir = expand(cwd || homedir());
  if (!inHome(dir) || !isDir(dir)) throw new Error("cwd must be an existing folder in your home folder");
  let wt = null;
  if (worktree && mode !== "axa") { wt = makeWorktree(dir, worktree); dir = wt.path; }
  const id = randomUUID().slice(0, 8);
  const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : wt?.name;
  return summary(launch({ id, cwd: dir, mode, cols, rows, resume: resume || null, created: Date.now(), name: label, worktree: wt ? { repo: wt.repo, path: wt.path, branch: wt.branch } : undefined }));
}

function launch({ id, cwd, mode, cols, rows, resume, created, recovered = false, name, worktree }) {
  const shell = process.env.SHELL || "/bin/bash";
  const resumeArg = resume ? ` --resume ${resume}` : "";
  // claude/axa: run Claude Code (traced), and drop to a normal shell if it exits
  const args = mode === "shell" ? ["-l"] : ["-l", "-c", `${claudeCmd(mode === "axa" ? "commander" : "worker")}${resumeArg}; exec "$SHELL" -l`];
  // AXA_TERMINAL_ID tags this session's hook events so the daemon knows its status
  const tag = { AXA_TERMINAL_ID: id, AXA_ROLE: mode === "axa" ? "commander" : "worker" };
  const withEnv = tmuxVersion >= 3.02; // tmux 3.2+ sets the session's env with -e; older ones get it through `env`
  // `env -u TMUX`: a session must not be able to reach AXA's tmux (and type into other sessions)
  const cmd = "exec " + ["env", "-u", "TMUX", "-u", "TMUX_PANE", ...(withEnv ? [] : Object.entries(tag).map(([k, v]) => `${k}=${v}`)), shell, ...args].map(shq).join(" ");
  const envArgs = withEnv ? Object.entries(tag).flatMap(([k, v]) => ["-e", `${k}=${v}`]) : [];
  const r = tmux("new-session", "-d", "-s", tmuxName(id), "-c", cwd, "-x", String(cols), "-y", String(rows), ...envArgs, cmd);
  if (r.status !== 0) throw new Error(`couldn't start the session in tmux: ${(r.stderr || r.error?.message || "").trim()}`);
  const t = { id, name: mode === "axa" ? "AXA" : name || meta.get(id)?.name || (cwd === homedir() ? "home" : basename(cwd)), cwd, mode, buf: "", alive: true, created, lastOutput: Date.now(), sockets: new Set(), recovered };
  meta.set(id, { ...meta.get(id), id, name: t.name, cwd, mode, created, resume, recovered, ...(worktree ? { worktree } : {}) });
  saveMeta();
  attachStream(t, cols, rows);
  terms.set(id, t);
  return t;
}

// The daemon's own view of a session (for the web console): a tmux client in a PTY. Only this client
// ends with the daemon; the session keeps running.
function attachStream(t, cols, rows) {
  const proc = pty.spawn("tmux", ["-L", SOCKET, "-f", TMUX_CONF, "attach-session", "-t", `=${tmuxName(t.id)}`], { name: "xterm-256color", cols, rows, cwd: homedir(), env: tmuxEnv() });
  t.proc = proc;
  proc.onData((d) => {
    t.buf = (t.buf + d).slice(-SCROLLBACK);
    t.lastOutput = Date.now();
    for (const ws of t.sockets) ws.send(d);
  });
  proc.onExit(({ exitCode }) => {
    if (t.closing) return;
    t.alive = false;
    // its program exited and the tmux session is gone: forget it, so a restart doesn't bring it back
    if (!tmuxHas(t.id)) { meta.delete(t.id); saveMeta(); }
    for (const ws of t.sockets) ws.send(`\r\n\x1b[2m[process exited ${exitCode}]\x1b[0m\r\n`);
  });
}

// On daemon start: show the tmux sessions still running. If the tmux server itself is gone (the machine
// restarted), Claude sessions are relaunched resuming their chat; shells are dropped.
export function restoreSessions() {
  if (!hasTmux) return [];
  const r = tmux("list-sessions", "-F", "#{session_name}\t#{session_path}\t#{window_width}\t#{window_height}\t#{session_created}");
  const serverUp = r.status === 0; // tmux.conf keeps the server up when empty, so "no server" means a restart
  const live = new Map();
  if (serverUp) for (const line of r.stdout.split("\n")) {
    const [nm, path, w, h, made] = line.split("\t");
    const m = nm?.match(/^axa-([\w-]+)$/);
    if (m) live.set(m[1], { path: path || homedir(), cols: Number(w) || 100, rows: Number(h) || 30, created: Number(made) * 1000 || Date.now() });
  }
  const restored = [];
  for (const [id, s] of live) {
    if (terms.has(id)) continue;
    if (!meta.has(id)) meta.set(id, { id, name: basename(s.path), cwd: s.path, mode: "shell", created: s.created, resume: null });
    const m = meta.get(id);
    m.recovered = false;
    const t = { id, name: m.name, cwd: m.cwd, mode: m.mode, buf: "", alive: true, created: m.created, lastOutput: Date.now(), sockets: new Set(), recovered: false };
    attachStream(t, s.cols, s.rows);
    terms.set(id, t);
    restored.push(id);
  }
  for (const m of [...meta.values()]) {
    if (live.has(m.id) || terms.has(m.id)) continue;
    const chat = [m.claudeSession, m.resume].find((c) => CHAT_ID.test(String(c)));
    if (!serverUp && m.mode !== "shell" && chat && inHome(m.cwd) && isDir(m.cwd)) {
      try { launch({ id: m.id, cwd: m.cwd, mode: m.mode, cols: 100, rows: 30, resume: chat, created: m.created || Date.now(), recovered: true, name: m.name, worktree: m.worktree }); restored.push(m.id); continue; } catch {}
    }
    meta.delete(m.id);
  }
  saveMeta();
  return restored;
}

export function renameSession(id, name) {
  const t = terms.get(id), m = meta.get(id);
  if (!t || !m) return false;
  t.name = m.name = String(name).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) || basename(t.cwd);
  saveMeta();
  return true;
}

// removeWorktree: also remove its worktree folder (only if nothing is uncommitted; the branch is kept)
export function closeSession(id, { removeWorktree: rm = false } = {}) {
  const t = terms.get(id);
  if (!t) return false;
  const wt = meta.get(id)?.worktree;
  t.closing = true;
  tmux("kill-session", "-t", `=${tmuxName(id)}`);
  meta.delete(id); saveMeta();
  try { t.proc?.kill(); } catch {}
  for (const ws of t.sockets) ws.close();
  terms.delete(id);
  return rm && wt ? { closed: true, ...removeWorktree(wt) } : { closed: true };
}

// Daemon stopping: detach (sessions keep running in tmux)
export function detachAll() {
  for (const t of terms.values()) { t.closing = true; try { t.proc?.kill(); } catch {} for (const ws of t.sockets) ws.close(); }
  terms.clear();
}

// ---------- web console streaming: WebSocket /pty/<id> ----------
export function attachWebSocket(server, authorize) {
  const { WebSocketServer } = require("ws");
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
        if (msg.t === "r" && msg.c > 0 && msg.r > 0) {
          const c = Math.min(msg.c, 500), r = Math.min(msg.r, 300);
          t.proc.resize(c, r); t.capture = null;
          // the window follows whichever screen you're using right now
          tmux("resize-window", "-t", `=${tmuxName(t.id)}:`, "-x", String(c), "-y", String(r));
        }
      });
      ws.on("close", () => t.sockets.delete(ws));
    });
  });
}
