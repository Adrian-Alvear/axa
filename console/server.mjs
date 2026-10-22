// AXA console server: serves the UI, streams ~/.axa/events.jsonl over SSE, and (when its npm
// dependencies are installed) hosts real terminals for running Claude Code from the dashboard.
// Usage: node server.mjs [--open]   (env: AXA_PORT, AXA_HOME)
//
// Security: binds to 127.0.0.1 only, rejects foreign Host/Origin headers (DNS rebinding, other
// websites), and requires a secret token (~/.axa/console-token) exchanged for a SameSite=Strict cookie.
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, chmodSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openUrl } from "./ensure.mjs";
import { createStatus } from "./status.mjs";
import { createSupervisor } from "./supervisor.mjs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { themeId, DEFAULT_THEME } from "./theme.mjs";

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

// ---------- session status and runs (from traced events, see status.mjs) ----------
const status = createStatus({ stuckMs: (Number(process.env.AXA_STUCK_MINUTES) || 20) * 60_000, onChat: (terminal, chat) => T?.noteSession?.(terminal, chat) });
const { sessions, track, statusOf } = status;
const runsSince = (since, limit) => status.runsSince(since, limit, T?.listTerms() || []);
const logEvent = (ev) => { try { appendFileSync(logPath, JSON.stringify(ev) + "\n"); } catch {} };

const clients = new Set();
let offset = statSync(logPath).size;
let partial = "";
// Recent events, kept in memory for each new page's `history` replay (instead of re-reading the
// file on every connect): raw JSON lines, at most HISTORY_BYTES / HISTORY_EVENTS, oldest dropped first
const HISTORY_EVENTS = 20_000;
const history = [];
let historyBytes = 0;
function remember(line) {
  history.push(line); historyBytes += line.length + 1;
  let drop = 0;
  while (history.length - drop > 1 && (historyBytes > HISTORY_BYTES || history.length - drop > HISTORY_EVENTS)) historyBytes -= history[drop++].length + 1;
  if (drop) history.splice(0, drop);
}
// Rebuild statuses from recent history (sessions in tmux keep running across console restarts)
{
  const start = Math.max(0, offset - HISTORY_BYTES), lines = readRange(start, offset).split("\n");
  if (start > 0) lines.shift(); // drop the cut-off first line
  for (const line of lines) { if (!line.trim()) continue; try { track(JSON.parse(line)); remember(line); } catch {} }
}
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
    let e;
    try { e = JSON.parse(line); } catch {}
    if (e) { try { track(e); } catch {} remember(line); }
    for (const res of clients) res.write(`data: ${line}\n\n`);
  }
  // Keep the log from growing forever: move it aside and start a fresh one
  if (size > MAX_LOG_BYTES) {
    try { renameSync(logPath, logPath.replace(/\.jsonl$/, ".1.jsonl")); writeFileSync(logPath, "", { mode: 0o600 }); offset = 0; partial = ""; } catch {}
  }
}, 250);

// ---------- supervisor (AXA wakes itself) and links between sessions: see supervisor.mjs ----------
const sup = createSupervisor({ T, home, logEvent, enabled: process.env.AXA_SUPERVISOR !== "0", wakesPerHour: Number(process.env.AXA_WAKES_PER_HOUR) || 30 });
setInterval(sup.supervise, 3000);

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
const vendorCache = new Map(); // path -> file contents (read once; npm install needs a console restart anyway)
// The page's own stylesheets and scripts (console/ui/): only files that were there when the server
// started and have a plain name with one of these types, so nothing else in the folder (or outside
// it) can be fetched. No token needed, like index.html and /vendor.
const UI_TYPES = { css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", svg: "image/svg+xml", json: "application/json", webmanifest: "application/manifest+json" };
const UI_NAME = /^[\w.-]+\.(?:css|js|svg|json|webmanifest)$/;
const uiDir = join(here, "ui");
let uiFiles = new Set();
try { uiFiles = new Set(readdirSync(uiDir, { withFileTypes: true }).filter((d) => d.isFile() && UI_NAME.test(d.name)).map((d) => d.name)); } catch {}

// The design system's shared modules, for the page to import (pure ES modules, nothing secret)
const SHARED = { "/shared/theme.mjs": "theme.mjs", "/shared/look.mjs": "look.mjs" };

// Settings shared with the terminal app ($AXA_HOME/ui.json): the page reads and writes only these
// keys; everything else in the file (the terminal app's own settings) is kept as it is.
const uiPath = join(home, "ui.json");
function readUi() {
  try { const v = JSON.parse(readFileSync(uiPath, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : null; }
  catch (e) { return e.code === "ENOENT" ? {} : null; } // null: there but unreadable, don't overwrite it
}
// the terminal app's own "terminal" and "mono" pass through as they are (the page shows both as AXA HUD)
const TUI_ONLY = new Set(["terminal", "mono"]);
const uiTheme = (t) => (typeof t !== "string" ? null : TUI_ONLY.has(t) ? t : themeId(t));
const uiView = (cfg) => ({ theme: uiTheme(cfg.theme), themeSync: cfg.themeSync === true });
function writeUi(patch) {
  const cfg = readUi();
  if (!cfg) return [500, { error: `${uiPath} isn't valid JSON: not overwriting it` }];
  const next = { ...cfg, ...patch }, tmp = `${uiPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, uiPath); }
  catch (e) { try { unlinkSync(tmp); } catch {} return [500, { error: `couldn't save ${uiPath}: ${e.message}` }]; }
  return [200, uiView(next)];
}
// The user's own clicks only: the console page (browsers stamp Sec-Fetch-Site, which page scripts
// can't set) or the axa terminal app (x-axa-client: tui). See /answer below.
const fromUser = (req) => (req.headers["sec-fetch-site"] === "same-origin" && !!req.headers.origin) || req.headers["x-axa-client"] === "tui";

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
    if (!vendorCache.has(path)) { try { vendorCache.set(path, readFileSync(join(here, "node_modules", VENDOR[path][0]))); } catch { return res.writeHead(404).end(); } }
    res.writeHead(200, { "content-type": VENDOR[path][1] });
    return res.end(vendorCache.get(path));
  }
  if (path.startsWith("/ui/")) {
    const name = path.slice(4);
    if (!uiFiles.has(name)) return res.writeHead(404).end();
    let body;
    try { body = readFileSync(join(uiDir, name)); } catch { return res.writeHead(404).end(); }
    res.writeHead(200, { "content-type": UI_TYPES[name.slice(name.lastIndexOf(".") + 1)], "cache-control": "no-cache" });
    return res.end(body);
  }

  if (SHARED[path]) {
    let body;
    try { body = readFileSync(join(here, SHARED[path])); } catch { return res.writeHead(404).end(); }
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
    return res.end(body);
  }

  // everything below needs the token cookie
  if (!authed(req)) return json(res, 401, { error: "locked", hint: "Open the console with /axa:console or the unlock link it prints." });

  if (path === "/roster") return json(res, 200, readRoster());
  if (path === "/api/runs") return json(res, 200, runsSince(Number(u.searchParams.get("since")) || 0, Math.min(500, Number(u.searchParams.get("limit")) || 200)));
  if (path === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    // the lines are valid JSON already (remember() only keeps those): join them, no re-parsing
    res.write(`event: history\ndata: [${history.join(",")}]\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => { clients.delete(res); clearInterval(ping); });
    return;
  }

  if (path === "/api/ui-settings" && req.method === "GET") {
    const cfg = readUi();
    return json(res, 200, uiView(cfg || {}));
  }
  if (path === "/api/ui-settings" && req.method === "POST") {
    if (!fromUser(req)) return json(res, 403, { error: "Only you can change settings, from the console or the axa terminal UI." });
    const b = await readBody(req), patch = {};
    if ("theme" in b) {
      // a theme name (or an older alias); "terminal" and "mono" are the terminal app's own
      if (typeof b.theme !== "string" || (themeId(b.theme) === DEFAULT_THEME && b.theme !== DEFAULT_THEME && !TUI_ONLY.has(b.theme))) return json(res, 400, { error: "unknown theme" });
      patch.theme = uiTheme(b.theme);
    }
    if ("themeSync" in b) {
      if (typeof b.themeSync !== "boolean") return json(res, 400, { error: "themeSync must be true or false" });
      patch.themeSync = b.themeSync;
    }
    if (!Object.keys(patch).length) return json(res, 400, { error: "nothing to change (theme, themeSync)" });
    return json(res, ...writeUi(patch));
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
        return json(res, 200, await T.createTerm(body));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (path === "/api/chains" && req.method === "GET") return json(res, 200, sup.chainsView());
    if (path === "/api/chains" && req.method === "POST") {
      const b = await readBody(req), terms = T.listTerms();
      return json(res, ...sup.addChain(terms.find((t) => t.id === b.from), terms.find((t) => t.id === b.to), b.text));
    }
    const cm = path.match(/^\/api\/chains\/([\w-]+)$/);
    if (cm && req.method === "DELETE") return json(res, sup.deleteChain(cm[1]) ? 200 : 404, {});
    const m = path.match(/^\/api\/terms\/([\w-]+)$/);
    if (m && req.method === "DELETE") { const r = await T.killTerm(m[1], { removeWorktree: u.searchParams.get("remove_worktree") === "1" }); return json(res, r ? 200 : 404, r || {}); }
    // The user answering a prompt: from the console page (browsers stamp Sec-Fetch-Site, which page
    // scripts can't set) or the `axa` terminal UI (x-axa-client: tui). AXA's session tools never send
    // either. Neither is a secret: what keeps project sessions out is that they can't reach the token
    // (policy) or AXA's tmux (no $TMUX in sessions).
    const am = path.match(/^\/api\/terms\/([\w-]+)\/answer$/);
    if (am && req.method === "POST") {
      if (!fromUser(req)) return json(res, 403, { error: "Only you can answer a prompt, from the console or the axa terminal UI." });
      const b = await readBody(req);
      const r = await T.answerTerm(am[1], b.n, String(b.label ?? ""), String(b.question ?? ""));
      if (r.ok) {
        logEvent({ ts: Date.now(), event: "UserAnswer", terminal: am[1], session: sessions.get(am[1])?.session, role: "console", answer: r.option.label.slice(0, 120), summary: r.question.slice(-200) });
      }
      return json(res, r.ok ? 200 : 409, r);
    }
    const sm = path.match(/^\/api\/terms\/([\w-]+)\/screen$/);
    if (sm && req.method === "GET") { const r = await T.readTerm(sm[1], Number(u.searchParams.get("lines")) || 60); return json(res, r ? 200 : 404, r || { error: "no such terminal" }); }
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

server.listen(port, "127.0.0.1", async () => {
  writeFileSync(pidPath, String(process.pid));
  // Sessions still running in tmux show up again; after a machine restart, Claude sessions resume
  let restored = [];
  try { restored = (await T?.restoreTerms?.()) || []; } catch (e) { console.log(`  couldn't restore sessions: ${e.message}`); }
  console.log(`AXA console → ${unlockUrl}`);
  console.log(`  events: ${logPath}`);
  console.log(`  terminals: ${T ? `enabled (${T.backend === "tmux" ? "tmux: sessions survive restarts" : "no tmux: sessions end with the console"})` : "disabled — " + termError}`);
  if (restored.length) console.log(`  restored sessions: ${restored.join(", ")}`);
  openBrowser();
});
