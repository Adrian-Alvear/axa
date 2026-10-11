// Embedded terminals for the AXA console: real PTYs (node-pty) streamed to xterm.js over WebSocket.
// Terminals live in this server process, so reloading the page reattaches with scrollback.
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const { WebSocketServer } = require("ws");

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

const expand = (p) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

export function listProjects(rosterFile) {
  const seen = new Map();
  const add = (path) => {
    const p = expand(path);
    try { if (statSync(p).isDirectory() && !seen.has(p)) seen.set(p, { name: basename(p), path: p }); } catch {}
  };
  // projects named in the roster first, then everything in ~/projects
  if (rosterFile && existsSync(rosterFile)) {
    let inProjects = false;
    for (const line of readFileSync(rosterFile, "utf8").split("\n")) {
      if (line.startsWith("## ")) inProjects = /projects/i.test(line);
      if (inProjects) for (const m of line.matchAll(/`(~?\/[^`]+)`/g)) add(m[1]);
    }
  }
  const root = join(homedir(), "projects");
  try { for (const d of readdirSync(root, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith(".")) add(join(root, d.name)); } catch {}
  return [...seen.values()];
}

const summary = (t) => ({ id: t.id, name: t.name, cwd: t.cwd, mode: t.mode, alive: t.alive, created: t.created });
export const listTerms = () => [...terms.values()].map(summary);

export function createTerm({ cwd, mode = "claude", cols = 100, rows = 30 }) {
  const dir = expand(cwd || homedir());
  if (!dir.startsWith(homedir()) || !statSync(dir).isDirectory()) throw new Error("cwd must be a directory in your home folder");
  const shell = process.env.SHELL || "/bin/zsh";
  // claude mode: run Claude Code, and drop to a normal shell if it exits
  const args = mode === "claude" ? ["-l", "-c", 'claude; exec "$SHELL" -l'] : ["-l"];
  const proc = pty.spawn(shell, args, { name: "xterm-256color", cols, rows, cwd: dir, env: cleanEnv() });
  const t = { id: randomUUID().slice(0, 8), name: basename(dir), cwd: dir, mode, proc, buf: "", alive: true, created: Date.now(), sockets: new Set() };
  proc.onData((d) => {
    t.buf = (t.buf + d).slice(-SCROLLBACK);
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
        if (msg.t === "r" && msg.c > 0 && msg.r > 0) t.proc.resize(Math.min(msg.c, 500), Math.min(msg.r, 300));
      });
      ws.on("close", () => t.sockets.delete(ws));
    });
  });
}
