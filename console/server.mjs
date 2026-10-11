// AXA console server: serves the UI, streams ~/.axa/events.jsonl over SSE, and (when its npm
// dependencies are installed) hosts real terminals for running Claude Code from the dashboard.
// Usage: node server.mjs [--open]   (env: AXA_PORT, AXA_HOME)
//
// Security: binds to 127.0.0.1 only, rejects foreign Host/Origin headers (DNS rebinding, other
// websites), and requires a secret token (~/.axa/console-token) exchanged for a SameSite=Strict cookie.
import { createServer } from "node:http";
import { readFileSync, statSync, openSync, readSync, closeSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";

const port = Number(process.env.AXA_PORT || 4747);
const home = process.env.AXA_HOME || join(homedir(), ".axa");
const logPath = join(home, "events.jsonl");
const here = dirname(fileURLToPath(import.meta.url));
const HISTORY_BYTES = 4 * 1024 * 1024; // replay at most the last 4MB on connect

mkdirSync(home, { recursive: true });
if (!existsSync(logPath)) writeFileSync(logPath, "");

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
  if (!process.argv.includes("--open")) return;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${unlockUrl}"`);
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

const clients = new Set();
let offset = statSync(logPath).size;
let partial = "";
setInterval(() => {
  let size;
  try { size = statSync(logPath).size; } catch { return; }
  if (size < offset) offset = 0; // log was truncated/rotated
  if (size === offset) return;
  const chunk = partial + readRange(offset, size);
  offset = size;
  const lines = chunk.split("\n");
  partial = lines.pop();
  for (const line of lines) if (line.trim()) for (const res of clients) res.write(`data: ${line}\n\n`);
}, 250);

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
    if (path === "/api/terms" && req.method === "GET") return json(res, 200, T.listTerms());
    if (path === "/api/terms" && req.method === "POST") {
      try { return json(res, 200, T.createTerm(await readBody(req))); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    const m = path.match(/^\/api\/terms\/([\w-]+)$/);
    if (m && req.method === "DELETE") return json(res, T.killTerm(m[1]) ? 200 : 404, {});
  }
  res.writeHead(404).end();
});

if (T) T.attachWebSocket(server, authed);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`AXA console already running → ${unlockUrl}`);
    openBrowser();
    process.exit(0);
  }
  throw err;
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { T?.killAll(); process.exit(0); });

server.listen(port, "127.0.0.1", () => {
  console.log(`AXA console → ${unlockUrl}`);
  console.log(`  events: ${logPath}`);
  console.log(`  terminals: ${T ? "enabled" : "disabled — " + termError}`);
  openBrowser();
});
