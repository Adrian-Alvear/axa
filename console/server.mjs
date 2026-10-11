// AXA console server: serves the UI and streams ~/.axa/events.jsonl over SSE.
// Zero dependencies. Usage: node server.mjs [--open]   (env: AXA_PORT, AXA_HOME)
import { createServer } from "node:http";
import { readFileSync, statSync, openSync, readSync, closeSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

const port = Number(process.env.AXA_PORT || 4747);
const home = process.env.AXA_HOME || join(homedir(), ".axa");
const logPath = join(home, "events.jsonl");
const here = dirname(fileURLToPath(import.meta.url));
const url = `http://localhost:${port}`;
const HISTORY_BYTES = 4 * 1024 * 1024; // replay at most the last 4MB on connect

mkdirSync(home, { recursive: true });
if (!existsSync(logPath)) writeFileSync(logPath, "");

const openBrowser = () => {
  if (!process.argv.includes("--open")) return;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} ${url}`);
};

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
  const file = [join(home, "roster.md"), join(here, "..", "roster.example.md")].find(existsSync);
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

// Tail the log once for all clients.
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

const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/" || path === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(readFileSync(join(here, "index.html")));
  }
  if (path === "/roster") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(readRoster()));
  }
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
  res.writeHead(404).end();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`AXA console already running at ${url}`);
    openBrowser();
    process.exit(0);
  }
  throw err;
});

server.listen(port, () => {
  console.log(`AXA console → ${url}  (reading ${logPath})`);
  openBrowser();
});
