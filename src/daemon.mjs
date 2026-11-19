// The AXA daemon: one background server that owns the sessions (in tmux), tracks their status from
// the hook events, and serves the API that the terminal UI, the web console and the MCP tools use.
// This module starts it when needed, stops it, and talks to it.
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { files, home, pluginRoot, port, readToken, srcDir } from "./paths.mjs";

// Call the daemon's API. headers: extra headers (the TUI marks itself so it may answer prompts)
export async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { host: `localhost:${port}`, cookie: `axa_token=${readToken()}`, ...(body ? { "content-type": "application/json" } : {}), ...headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `AXA daemon returned ${res.status}`);
  return data;
}

export async function daemonUp() {
  if (!readToken()) return false;
  try { await api("/api/health"); return true; } catch { return false; }
}

const depsMissing = () => {
  let deps = [];
  try { deps = Object.keys(JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")).dependencies || {}); } catch {}
  return deps.some((d) => !existsSync(join(pluginRoot, "node_modules", d, "package.json")));
};

// Start the daemon detached (it outlives the terminal that started it); it logs to ~/.axa/console.log
export async function ensureDaemon() {
  if (await daemonUp()) return true;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (depsMissing()) spawnSync("npm", ["install", "--no-fund", "--no-audit", "--omit=dev"], { cwd: pluginRoot, stdio: "ignore" });
  const log = openSync(files.daemonLog, "a");
  spawn(process.execPath, [join(srcDir, "core", "server.mjs")], { cwd: pluginRoot, detached: true, stdio: ["ignore", log, log], env: process.env }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await daemonUp()) return true;
  }
  return false;
}

// Stop the daemon. Sessions keep running in tmux unless all is set.
export async function stopDaemon({ all = false } = {}) {
  let stopped = false;
  if (existsSync(files.pid)) {
    try { process.kill(Number(readFileSync(files.pid, "utf8")), "SIGTERM"); stopped = true; } catch {}
  }
  if (all) {
    await new Promise((r) => setTimeout(r, 300));
    // Sessions live on AXA's own tmux socket: ending that server ends them all (your own tmux is untouched)
    spawnSync("tmux", ["-L", `axa-${port}`, "kill-server"], { stdio: "ignore" });
    try { unlinkSync(files.sessions); } catch {}
  }
  return stopped;
}
