// Embedded terminals for the AXA console: real PTYs (node-pty) streamed to xterm.js over WebSocket.
// Terminals live in this server process, so reloading the page reattaches with scrollback.
import { chmodSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { pluginRoot } from "./ensure.mjs";
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
const terms = new Map(); // id -> { id, name, cwd, mode, proc, buf, alive, created, sockets }

// Don't leak the parent Claude Code session's identity into terminals we launch.
function cleanEnv() {
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  return env;
}

const shq = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
// Every Claude session AXA starts loads the AXA plugin, so its hooks trace it (and the commander gets
// its session tools). Project sessions run in auto mode: they work on their own, and Claude Code still
// stops for risky actions, which the user approves in that session.
const claudeCmd = (role) =>
  role === "commander"
    ? `claude --plugin-dir ${shq(pluginRoot)} --append-system-prompt-file ${shq(join(pluginRoot, "commander.md"))}`
    : `claude --plugin-dir ${shq(pluginRoot)} --permission-mode auto`;

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

const summary = (t) => {
  const traced = statusOf(t.id);
  const waiting = t.alive && (traced?.status === "waiting" || awaitingPermission(t));
  return {
    id: t.id, name: t.name, cwd: t.cwd, mode: t.mode, alive: t.alive, created: t.created,
    // "waiting" wins over "stuck": a prompt on screen is the more specific reason
    status: !t.alive ? "exited" : waiting ? "waiting" : traced?.status || "starting",
    stuck_minutes: traced?.stuck_minutes,
    doing: safe(traced?.doing), tool: traced?.tool, summary: safe(traced?.summary), skill: traced?.skill,
    last_report: safe(traced?.report), error: safe(traced?.error), last_event_at: traced?.at,
    idle_seconds: Math.round((Date.now() - t.lastOutput) / 1000),
    awaiting_permission: waiting,
  };
};

// ---------- reading and typing into terminals (used by AXA's terminal tools) ----------
function screenLines(t, lines = 60) {
  const b = t.screen.buffer.active, out = [];
  // Rejoin lines the terminal wrapped, so a long secret split across two rows is still recognized
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    const text = line?.translateToString(true) ?? "";
    if (line?.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.slice(-Math.max(1, Math.min(lines, 400)));
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
  t.proc.write(text);
  // submit separately so TUIs treat it as Enter, not part of a paste
  if (enter) { await new Promise((r) => setTimeout(r, 60)); t.proc.write("\r"); }
  return { ok: true };
}
export const listTerms = () => [...terms.values()].map(summary);

// resume: continue a previous chat (an id from listChats) instead of starting a new one
export function createTerm({ cwd, mode = "claude", cols = 100, rows = 30, resume }) {
  if (resume !== undefined && !CHAT_ID.test(String(resume))) throw new Error("not a chat id");
  const resumeArg = resume ? ` --resume ${resume}` : "";
  const dir = expand(cwd || homedir());
  let isDir = false;
  try { isDir = statSync(dir).isDirectory(); } catch {}
  if (!inHome(dir) || !isDir) throw new Error("cwd must be an existing folder in your home folder");
  const shell = process.env.SHELL || "/bin/bash";
  const id = randomUUID().slice(0, 8);
  // claude/axa: run Claude Code (traced), and drop to a normal shell if it exits
  const args = mode === "claude" ? ["-l", "-c", `${claudeCmd("worker")}${resumeArg}; exec "$SHELL" -l`]
    : mode === "axa" ? ["-l", "-c", `${claudeCmd("commander")}${resumeArg}; exec "$SHELL" -l`]
    : ["-l"];
  // AXA_TERMINAL_ID tags this session's events so the console knows its status
  const env = { ...cleanEnv(), AXA_TERMINAL_ID: id, AXA_ROLE: mode === "axa" ? "commander" : "worker" };
  const proc = pty.spawn(shell, args, { name: "xterm-256color", cols, rows, cwd: dir, env });
  const screen = new Headless({ cols, rows, scrollback: 2000, allowProposedApi: true });
  const t = { id, name: mode === "axa" ? "AXA" : basename(dir), cwd: dir, mode, proc, screen, buf: "", alive: true, created: Date.now(), lastOutput: Date.now(), sockets: new Set() };
  proc.onData((d) => {
    t.buf = (t.buf + d).slice(-SCROLLBACK);
    t.lastOutput = Date.now();
    screen.write(d);
    for (const ws of t.sockets) ws.send(d);
  });
  proc.onExit(({ exitCode }) => {
    t.alive = false;
    for (const ws of t.sockets) ws.send(`\r\n\x1b[2m[process exited ${exitCode}]\x1b[0m\r\n`);
  });
  terms.set(t.id, t);
  return summary(t);
}

export function killTerm(id) {
  const t = terms.get(id);
  if (!t) return false;
  try { t.proc.kill(); } catch {}
  try { t.screen.dispose(); } catch {}
  for (const ws of t.sockets) ws.close();
  terms.delete(id);
  return true;
}

export function killAll() { for (const id of [...terms.keys()]) killTerm(id); }

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
        if (msg.t === "i" && typeof msg.d === "string") t.proc.write(msg.d);
        if (msg.t === "r" && msg.c > 0 && msg.r > 0) { const c = Math.min(msg.c, 500), r = Math.min(msg.r, 300); t.proc.resize(c, r); t.screen.resize(c, r); }
      });
      ws.on("close", () => t.sockets.delete(ws));
    });
  });
}
