#!/usr/bin/env node
// Performance check for the Verification section: starts a throwaway console on a private port and
// home with N shell sessions, then measures
//   1. event-loop delay in the server while the web page and the terminal app poll the session list
//      (monitorEventLoopDelay, preloaded with --import, so old and new servers measure the same way)
//   2. bytes the terminal app (bin/axa, 120x32 in a PTY) writes per idle second
//   node scripts/perf.mjs [--sessions=8] [--seconds=30] [--port=4861] [--json]
// Never touches port 4747 or ~/.axa: everything runs on --port with a temporary AXA_HOME.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1]) || d;
const N = arg("sessions", 8), SECS = arg("seconds", 30), PORT = arg("port", 4861);
if (PORT === 4747) { console.error("refusing to use the live console's port"); process.exit(1); }
const home = mkdtempSync(join(tmpdir(), "axa-perf-"));
const eld = join(home, "eld.jsonl");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, AXA_PORT: String(PORT), AXA_HOME: home, AXA_SUPERVISOR: "0", AXA_ELD_OUT: eld };
for (const k of ["TMUX", "TMUX_PANE", "AXA_TERMINAL_ID", "AXA_ROLE"]) delete env[k];

const server = spawn(process.execPath, ["--import", join(root, "scripts/perf/eld-preload.mjs"), join(root, "console/server.mjs")], { env, stdio: "ignore" });
const cleanup = () => {
  try { server.kill(); } catch {}
  spawnSync("tmux", ["-L", `axa-${PORT}`, "kill-server"], { stdio: "ignore" });
  rmSync(home, { recursive: true, force: true });
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

let token = "";
for (let i = 0; i < 100 && !token; i++) { await sleep(100); try { token = readFileSync(join(home, "console-token"), "utf8").trim(); } catch {} }
const headers = { host: `localhost:${PORT}`, cookie: `axa_token=${token}`, "content-type": "application/json" };
const api = async (path, opts = {}) => { const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers, ...opts }); return r.json(); };
for (let i = 0; i < 50; i++) { try { await api("/api/terms"); break; } catch { await sleep(100); } }
for (let i = 0; i < N; i++) await api("/api/terms", { method: "POST", body: JSON.stringify({ mode: "shell", cwd: root, cols: 100, rows: 30 }) });
await sleep(2000);

// 1. event-loop delay: the web page polls every 2s, the terminal app every 1s, a phone every 2s
const t0 = Date.now();
const pollers = [1000, 2000, 2000].map((ms) => setInterval(() => api("/api/terms").catch(() => {}), ms));
const reqTimes = [];
const timed = setInterval(async () => { const s = performance.now(); await api("/api/terms").catch(() => {}); reqTimes.push(performance.now() - s); }, 500);

// 2. the terminal app's output while nothing happens (after it settles)
let tuiBytes = 0, tuiCounting = false, tui = null;
try {
  const pty = createRequire(join(root, "console/package.json"))("node-pty");
  tui = pty.spawn(process.execPath, [join(root, "bin/axa")], { name: "xterm-256color", cols: 120, rows: 32, cwd: root, env: { ...env, COLORTERM: "truecolor", LANG: "C.UTF-8" } });
  tui.onData((d) => { if (tuiCounting) tuiBytes += Buffer.byteLength(d); });
} catch (e) { console.error(`terminal app not measured: ${e.message}`); }
await sleep(Math.min(8000, SECS * 300));
const tuiStart = Date.now(); tuiCounting = true;
await sleep(Math.max(1000, SECS * 1000 - (Date.now() - t0)));
tuiCounting = false;
const tuiSecs = (Date.now() - tuiStart) / 1000;
for (const p of pollers) clearInterval(p);
clearInterval(timed);
try { tui?.kill(); } catch {}
await sleep(1200);

const rows = existsSync(eld) ? readFileSync(eld, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ts >= t0) : [];
const max = Math.max(0, ...rows.map((r) => r.max));
const p99 = rows.length ? rows.map((r) => r.p99).sort((a, b) => a - b)[Math.floor(rows.length * 0.99)] ?? 0 : 0;
const stalls = rows.filter((r) => r.max > 50).length;
const sorted = reqTimes.slice().sort((a, b) => a - b);
const result = {
  sessions: N, seconds: rows.length,
  loop_max_ms: +max.toFixed(1), loop_p99_ms: +p99.toFixed(1), seconds_with_stall_over_50ms: stalls,
  terms_req_median_ms: +(sorted[Math.floor(sorted.length / 2)] || 0).toFixed(1), terms_req_max_ms: +(sorted.at(-1) || 0).toFixed(1),
  tui_idle_bytes_per_sec: tui ? Math.round(tuiBytes / tuiSecs) : null,
};
if (process.argv.includes("--json")) console.log(JSON.stringify(result));
else {
  console.log(`| Measure | Value |\n|---|---|`);
  for (const [k, v] of Object.entries(result)) console.log(`| ${k} | ${v} |`);
}
process.exit(0);
