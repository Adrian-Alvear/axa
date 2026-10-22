// AXA mission control in the terminal: `axa` opens it.
// A sidebar with AXA (the commander) and every session, sorted by what needs you, next to the live,
// fully interactive view of one session (or two side by side), rendered here through a headless
// terminal. tmux-style: everything you type goes to the session in focus; the prefix key (Ctrl-b by
// default) then a key is an AXA action: Ctrl-b : opens a palette of every action, Ctrl-b ? lists keys.
// Settings (theme, prefix, sidebar, bell) live in $AXA_HOME/ui.json (theme shared with the web console) and Ctrl-b , edits them live.
// Same backend as the web console, so the browser, phone and this window always agree.
//
// The app is one shared state object (c) that each part adds its functions to:
//   theme.mjs    colors (../theme.mjs), status looks (../look.mjs), text width helpers
//   settings.mjs ui.json: load, save, pick up a theme changed in the web console
//   events.mjs   the event stream and what's derived from it (helpers, tallies, activity, feed)
//   sidebar.mjs  sessions, workspaces, display order, the sidebar
//   views.mjs    layout, live panes, drawing, copy-on-select
//   map.mjs      the map and the agents/helper panels
//   overlays.mjs floating panels: search, browse, briefing, history, diff, verify, new session…
//   palette.mjs  the prefix actions, the palette and settings
//   index.mjs    (this file) settings file, console API, polling, clipboard paste, input, start
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { ESC, DEFAULTS, theme, needsYou, question, reasonOf } from "./theme.mjs";
import { createFrames, takeReplies, PROBE, FOCUS_ON, FOCUS_OFF, SYNC_END } from "./output.mjs";
import { createNotifier } from "./notify.mjs";
import { colorDepth } from "../theme.mjs";
import { settingsFile } from "./settings.mjs";
import { createEvents, streamEvents } from "./events.mjs";
import { sidebar } from "./sidebar.mjs";
import { views } from "./views.mjs";
import { map } from "./map.mjs";
import { overlays } from "./overlays.mjs";
import { palette } from "./palette.mjs";
import { PARK_AFTER_MS } from "./views.mjs";

const require = createRequire(import.meta.url);
const out = process.stdout;
// polling the session list: every second while anything happens, easing off to this when all is quiet
const POLL_BUSY = 1000, POLL_IDLE = 5000, QUIET_AFTER = 10_000, KICK_DELAY = 150;
// the shared tick: fast while something works (spinners, flowing links), else once a second (clock)
const TICK_BUSY = 100, TICK_IDLE = 1000, WHICH_KEY_DELAY = 400, FPS = 60;

export async function runTui({ port, readToken, openUrl, root, home }) {
  const env = { ...process.env, TERM: "xterm-256color" };
  for (const k of ["TMUX", "TMUX_PANE"]) delete env[k];

  // ---------- settings ----------
  // (theme and themeSync are shared with the web console: see settings.mjs)
  const settingsStore = settingsFile(join(home, "ui.json"), DEFAULTS);
  const { cfg, path: cfgPath, save: saveCfg } = settingsStore;
  const depth = colorDepth(process.env);

  // ---------- console API ----------
  const api = async (path, { method = "GET", body, headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { host: `localhost:${port}`, cookie: `axa_token=${readToken()}`, ...(body ? { "content-type": "application/json" } : {}), ...headers },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `console returned ${res.status}`);
    return data;
  };

  // ---------- the shared state ----------
  const c = {
    port, readToken, openUrl, root, home, out, env, SOCK: `axa-${port}`,
    pty: require("node-pty"), Headless: require("@xterm/headless").Terminal,
    cfg, cfgPath, saveCfg, depth, noColor: depth === "mono", api,
    list: [], err: "", chainsList: [], ev: createEvents(),
    overlay: null, prefix: false, quitting: false, zoom: false, updated: false,
    mapMode: false, mapSel: 0, mapNodes: [], mapWant: null, // the map view, its selected node (session or helper)
    briefSince: cfg.lastSeenAt || 0, // when you last had mission control open (for "since you left")
    W: out.columns || 120, H: out.rows || 36,
    views: [], focus: 0, // live panes: { id, proc, term, cursorOn, cols, rows, dead, lastRows }; which one gets your typing
    seen: new Map(), // session id -> when it was last on screen
    lastTitle: "", lastCursor: "", fullRedraw: true, clearScreen: true, toastTimer: null,
    tickN: 0, // the shared animation tick (spinners, the map's flowing links)
    sync: null, focused: null, // the terminal: supports synchronized output? is its window focused? (null: not known)
    whichKey: false, whichTimer: null, // the which-key popup, shown a moment after the prefix
    tabHits: [], sideHits: [], // what each tab / sidebar row is, for clicks (rebuilt on every draw)
    selection: null, lastClick: { at: 0, x: -1, y: -1 }, notice: null, selClear: null,
  };
  Object.assign(c, theme(c));
  Object.assign(c, sidebar(c), views(c), map(c), overlays(c));
  Object.assign(c, palette(c));
  c.frames = createFrames(() => c.draw(), { fps: FPS });
  const { schedule, show, layout } = c;
  const notify = createNotifier({ out });

  // ---------- polling the session list ----------
  // Never two at once (a slow console doesn't pile up requests); every second while anything is
  // working, waiting or stuck or just changed, easing off to 5s when everything is idle. The event
  // stream is the main change signal: an event polls right away (debounced).
  let prev = null, inflight = null, queued = null, lastSig = "", lastChange = Date.now(), pollTimer = null, kickTimer = null;
  async function pollOnce() {
    // a theme picked in the web console (with sync on): the file's mtime says whether to read it
    if (settingsStore.sync()) schedule();
    try { c.list = await api("/api/terms"); c.err = ""; } catch (e) { c.err = e.message; }
    try { c.chainsList = await api("/api/chains"); } catch {}
    const sig = JSON.stringify([c.list, c.chainsList, c.err], (k, v) => (k === "idle_seconds" ? undefined : v)); // (idle time ticks every poll)
    if (sig === lastSig) return; // nothing new: the clock's tick redraws anyway
    lastSig = sig; lastChange = Date.now();
    const now = new Map(c.list.map((s) => [s.id, s.status]));
    // something started needing you: the bell (and a toast, if you opted in) when you aren't looking
    if (prev) {
      const started = c.list.filter((s) => needsYou(s) && prev.get(s.id) !== s.status).map((s) => ({ name: c.nameOf(s), why: reasonOf(s) || (s.choices ? question(s.choices) : "") }));
      if (started.length) notify({ started, focused: c.focused, cfg });
    }
    prev = now;
    c.views.forEach((v) => { const s = v && c.list.find((x) => x.id === v.id); if (v && !v.dead && (!s || !s.alive)) v.dead = "Session ended."; });
    schedule();
  }
  // a poll asked for while one runs waits for it, then runs once more (so it sees the latest)
  function poll() {
    if (inflight) return (queued ||= inflight.then(() => { queued = null; return poll(); }));
    inflight = pollOnce().finally(() => { inflight = null; });
    return inflight;
  }
  c.poll = poll;
  const pollDelay = () => {
    const busy = c.list.some((s) => ["working", "waiting", "stuck"].includes(s.status));
    const quiet = Date.now() - lastChange;
    return busy || quiet < QUIET_AFTER ? POLL_BUSY : Math.min(POLL_IDLE, POLL_BUSY + Math.floor((quiet - QUIET_AFTER) / 5000) * 1000);
  };
  function pollLoop() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => poll().finally(() => { if (!c.quitting) pollLoop(); }), pollDelay());
  }
  // something happened (an event on the stream): poll soon, and keep the fast pace for a while
  function kick() {
    lastChange = Date.now();
    if (kickTimer) return;
    kickTimer = setTimeout(() => { kickTimer = null; poll().finally(() => { if (!c.quitting) pollLoop(); }); }, KICK_DELAY);
  }

  // ---------- paste an image from your clipboard into the focused session ----------
  // Ctrl-b i (or Ctrl+V, below) grabs the clipboard image itself, saves it as a PNG in the
  // session's project (.claude/axa-pastes, kept out of git status) and types its path into the session.
  function grabClipboardImage(file) {
    return new Promise((done) => {
      if (process.env.AXA_PASTE_IMAGE_FROM) { try { copyFileSync(process.env.AXA_PASTE_IMAGE_FROM, file); return done(true); } catch { return done(false); } } // for tests
      const has = (cmd) => spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
      let cmd, args, viaStdout = false;
      if (has("powershell.exe") && has("wslpath")) { // WSL: the Windows clipboard
        const win = spawnSync("wslpath", ["-w", file], { encoding: "utf8" }).stdout.trim().replace(/'/g, "''");
        cmd = "powershell.exe"; args = ["-NoProfile", "-STA", "-Command", `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $i = [System.Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${win}', [System.Drawing.Imaging.ImageFormat]::Png); 'ok' }`];
      } else if (process.platform === "darwin") { cmd = "osascript"; args = ["-e", `set f to open for access POSIX file "${file.replace(/"/g, "")}" with write permission`, "-e", "write (the clipboard as «class PNGf») to f", "-e", "close access f"]; }
      else if (has("wl-paste")) { cmd = "wl-paste"; args = ["--type", "image/png"]; viaStdout = true; }
      else if (has("xclip")) { cmd = "xclip"; args = ["-selection", "clipboard", "-t", "image/png", "-o"]; viaStdout = true; }
      else return done(null);
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }), chunks = [];
      p.stdout.on("data", (d) => chunks.push(d));
      const timer = setTimeout(() => { try { p.kill(); } catch {} done(false); }, 15000);
      p.on("error", () => { clearTimeout(timer); done(null); });
      p.on("close", (code) => {
        clearTimeout(timer);
        if (viaStdout) { const b = Buffer.concat(chunks); if (code === 0 && b.length > 8 && b[0] === 0x89) { writeFileSync(file, b, { mode: 0o600 }); return done(true); } return done(false); }
        try { done(statSync(file).size > 0); } catch { done(false); }
      });
    });
  }
  // Where a pasted image goes: the session's project, .claude/axa-pastes (kept out of git status)
  function pasteTarget(s) {
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: s.cwd, encoding: "utf8" });
    const base = top.status === 0 ? top.stdout.trim() : s.cwd;
    return { top, base, dir: join(base, ".claude", "axa-pastes"), file: join(base, ".claude", "axa-pastes", `paste-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`) };
  }
  async function pasteImage(grabbed) {
    const v = c.views[c.focus], s = c.sel();
    if (!v?.proc || v.dead || !s) return c.flash("Pick a session first", ["The image is pasted into the session you're looking at."]);
    const { top, base, dir, file: target } = grabbed || pasteTarget(s);
    const file = target;
    if (!grabbed) {
      try { mkdirSync(dir, { recursive: true }); } catch (e) { return c.flash("Couldn't save the image", [e.message]); }
      c.notice = { text: "reading the clipboard…", until: Date.now() + 15000, hint: " " }; schedule();
      const ok = await grabClipboardImage(file);
      if (!ok) { c.notice = null; return c.flash("No image on the clipboard", [ok === null ? "No clipboard tool was found on this machine." : `Copy an image first (on Windows: Win+Shift+S for a screenshot), then press Ctrl+V or ${c.keyName()} i.`]); }
    }
    // keep pasted images out of the project's git status (local only, nothing committed)
    if (top.status === 0) try {
      const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: base, encoding: "utf8" }).stdout.trim(), ex = join(common, "info", "exclude");
      const cur = existsSync(ex) ? readFileSync(ex, "utf8") : "";
      if (!cur.split("\n").includes("/.claude/axa-pastes/")) writeFileSync(ex, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "/.claude/axa-pastes/\n");
    } catch {}
    if (!writable(v)) return; // (the pane was closed while the clipboard was read)
    v.proc.write(`${file} `); // Claude Code reads image files by path
    c.notice = { text: "image pasted", until: Date.now() + 3000, hint: ` ${file.replace(homedir(), "~")}` }; schedule();
  }
  c.pasteImage = pasteImage;

  // ---------- Ctrl+V: paste an image if the clipboard has one, else its text ----------
  // Needs the terminal to pass Ctrl+V through (Windows Terminal binds it to its own text paste unless
  // unbound; its Ctrl+Shift+V still pastes text the usual way). One clipboard read decides: an image is
  // saved and its path typed in (like Ctrl-b i); text goes in as a bracketed paste. Typing during the
  // read is held back and sent after it, so nothing lands out of order.
  function readClipboard(file) {
    return new Promise((done) => {
      const has = (cmd) => spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
      if (process.env.AXA_PASTE_IMAGE_FROM) { try { copyFileSync(process.env.AXA_PASTE_IMAGE_FROM, file); return done({ image: true }); } catch {} }
      if (process.env.AXA_PASTE_TEXT != null) return done({ text: process.env.AXA_PASTE_TEXT }); // for tests
      let cmd, args;
      if (has("powershell.exe") && has("wslpath")) {
        const win = spawnSync("wslpath", ["-w", file], { encoding: "utf8" }).stdout.trim().replace(/'/g, "''");
        cmd = "powershell.exe"; args = ["-NoProfile", "-STA", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $i = [System.Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${win}', [System.Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write('IMG') } else { [Console]::Out.Write('TXT' + [System.Windows.Forms.Clipboard]::GetText()) }`];
      } else {
        // elsewhere: try the image tools first, then the text ones
        return grabClipboardImage(file).then((ok) => {
          if (ok) return done({ image: true });
          const t = process.platform === "darwin" ? ["pbpaste", []] : has("wl-paste") ? ["wl-paste", ["-n"]] : has("xclip") ? ["xclip", ["-selection", "clipboard", "-o"]] : null;
          if (!t) return done(null);
          const r = spawnSync(t[0], t[1], { encoding: "utf8", timeout: 5000 });
          done(r.status === 0 ? { text: r.stdout } : null);
        });
      }
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }), chunks = [];
      p.stdout.on("data", (d) => chunks.push(d));
      const timer = setTimeout(() => { try { p.kill(); } catch {} done(null); }, 15000);
      p.on("error", () => { clearTimeout(timer); done(null); });
      p.on("close", () => {
        clearTimeout(timer);
        const outp = Buffer.concat(chunks).toString("utf8");
        if (outp.startsWith("IMG")) return done({ image: true });
        if (outp.startsWith("TXT")) return done({ text: outp.slice(3).replace(/\r\n/g, "\n") });
        done(null);
      });
    });
  }
  // a pane can be closed (switched away from) while a clipboard read is awaited
  const writable = (v) => !!v?.proc && !v.dead && !v.closed;
  let pasting = null; // the Ctrl+V in progress; input typed meanwhile waits for it
  const held = [];
  function ctrlV() {
    const v = c.views[c.focus], s = c.sel();
    if (!v?.proc || v.dead || !s) return;
    const t = pasteTarget(s);
    try { mkdirSync(t.dir, { recursive: true }); } catch {}
    c.notice = { text: "reading the clipboard…", until: Date.now() + 15000, hint: " " }; schedule();
    pasting = readClipboard(t.file).then(async (r) => {
      c.notice = null;
      if (r?.image) await pasteImage(t);
      else if (r?.text) { if (writable(v)) v.proc.write(`${ESC}[200~${r.text.replace(/\x1b\[20[01]~/g, "")}${ESC}[201~`); }
      else c.flash("Nothing to paste", ["The clipboard is empty, or no clipboard tool was found."]);
      schedule();
    }).finally(() => {
      pasting = null;
      const rest = held.splice(0).join("");
      if (rest && writable(v)) send(v, rest);
    });
  }
  // Text for the focused session; Ctrl+V (0x16) is handled above instead of being passed on
  function send(v, chunk) {
    if (pasting) return held.push(chunk);
    if (!writable(v)) return;
    const k = chunk.indexOf("\x16");
    if (k < 0) return v.proc.write(chunk);
    if (k) v.proc.write(chunk.slice(0, k));
    ctrlV();
    if (chunk.length > k + 1) held.push(chunk.slice(k + 1));
  }

  // ---------- an open window notices when AXA itself was updated ----------
  // (the newest change to any of the terminal app's own files)
  const here = dirname(fileURLToPath(import.meta.url));
  const selfMtime = () => { let m = 0; for (const f of [join(here, "..", "tui.mjs"), ...(() => { try { return readdirSync(here).filter((f) => f.endsWith(".mjs")).map((f) => join(here, f)); } catch { return []; } })()]) try { m = Math.max(m, statSync(f).mtimeMs); } catch {} return m; };
  const startMtime = selfMtime();
  setInterval(() => { if (!c.updated && selfMtime() !== startMtime) { c.updated = true; schedule(); } }, 15000);

  // ---------- input: prefix keys, mouse, everything else to the focused session ----------
  // one keypress at a time for AXA's own screens: escape sequences (arrows, PgUp…) or single characters
  const keysOf = (d) => d.match(/\x1b\[[0-9;?]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu) || [];
  const decoder = new StringDecoder("utf8");
  const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  function onMouse(b, x, y, up) {
    const L = layout();
    if (c.overlay) return;
    if (L.side && x > L.sideX && x <= L.sideX + L.side) {
      if (up || b !== 0) return;
      const hit = c.sideHits[y - 1] || "";
      // a helper-agents row opens the agents panel; any other row opens that session
      if (hit.startsWith("agents:")) return c.sessionDetail(c.list.find((s) => s.id === hit.slice(7)));
      const s = hit && c.list.find((x) => x.id === hit);
      if (s) show(s);
      return;
    }
    // a tab in the tab row
    if (y === 1 && !c.mapMode) { if (!up && b === 0) { const t = c.tabHits.find((h) => x >= h.x0 && x <= h.x1); if (t) show(c.list.find((s) => s.id === t.id)); } return; }
    if (L.alert && y > L.mainH && y <= L.mainH + 2) { if (!up && b === 0 && x > L.mainX + Math.floor(L.mainW * 0.6)) show(L.alert); return; }
    // a drag that started in a pane keeps selecting even if the pointer strays outside it
    const i = c.selection?.active ? c.selection.pane : L.panes.findIndex((p) => x > p.x && x <= p.x + p.w && y > p.y && y <= p.y + p.h);
    if (i < 0 || c.mapMode) return;
    const v = c.views[i], p = L.panes[i];
    const left = (b & 3) === 0 && !(b & 64), motion = (b & 32) !== 0;
    if (cfg.copyOnSelect && left && v?.term && !v.dead) {
      const cx = Math.max(0, Math.min(p.cols - 1, x - p.x - 1 - p.ix)), cy = Math.max(0, Math.min(p.rows - 1, y - p.y - 1 - p.hdr));
      if (!up && !motion) { // press
        if (i !== c.focus) c.focus = i;
        const dbl = Date.now() - c.lastClick.at < 400 && c.lastClick.x === cx && c.lastClick.y === cy;
        c.lastClick = { at: Date.now(), x: cx, y: cy };
        if (dbl) return c.selectWord(i, cx, cy);
        c.selection = { pane: i, a: { x: cx, y: cy }, b: { x: cx, y: cy }, active: true };
      } else if (motion && c.selection?.active) c.selection.b = { x: cx, y: cy };
      else if (up && c.selection?.active) {
        c.selection.active = false;
        const same = c.selection.a.x === c.selection.b.x && c.selection.a.y === c.selection.b.y;
        if (same) c.selection = null; else { const t = c.selText(); if (t.trim()) c.copyText(t); else c.selection = null; }
      }
      return schedule();
    }
    if (i !== c.focus && !up && b === 0) { c.focus = i; schedule(); }
    // inside the session: forward when its program asked for the mouse (tmux does: scroll, click)
    if (v?.term && !v.dead && y >= p.y + 1 + p.hdr && v.term.modes.mouseTrackingMode !== "none") v.proc.write(`\x1b[<${b};${x - p.x - p.ix};${y - p.y - p.hdr}${up ? "m" : "M"}`);
  }
  process.stdin.on("data", (buf) => {
    // the terminal's own replies (synchronized-output probe, focus in/out) never reach keys or sessions
    let d = takeReplies(decoder.write(buf), c);
    d = d.replace(MOUSE, (_, b, x, y, m) => { onMouse(Number(b), Number(x), Number(y), m === "m"); return ""; });
    if (!d) return;
    if (c.overlay) return keysOf(d).forEach((k) => c.overlay && c.overlayKey(k));
    const P = String.fromCharCode(c.PREFIX());
    while (d) {
      if (c.prefix) {
        c.prefix = false; c.whichKey = false; clearTimeout(c.whichTimer);
        const k = d.startsWith(ESC + "[") ? (d.match(/^\x1b\[[0-9;]*[A-Za-z~]/) || [d])[0] : [...d][0];
        d = d.slice(k.length);
        c.action(k); schedule();
        if (c.overlay) { keysOf(d).forEach((k) => c.overlay && c.overlayKey(k)); return; }
        continue;
      }
      const i = d.indexOf(P);
      const chunk = i < 0 ? d : d.slice(0, i);
      const v = c.views[c.focus];
      if (chunk && c.selection && !c.selection.active) { c.selection = null; schedule(); } // typing clears a finished selection
      if (chunk && c.mapMode) keysOf(chunk).forEach(c.mapKey); // on the map, keys move around it
      else if (chunk && v?.proc && !v.dead) send(v, chunk);
      if (i < 0) break;
      c.prefix = true; d = d.slice(i + 1); schedule();
      // still waiting for the key after a moment: show which keys can follow
      clearTimeout(c.whichTimer); c.whichTimer = setTimeout(() => { if (c.prefix && !c.overlay) { c.whichKey = true; schedule(); } }, WHICH_KEY_DELAY);
    }
  });

  // ---------- start: AXA is always there ----------
  // mouse: clicks and wheel (1000), drags (1002, for copy-on-select), in SGR form (1006)
  // focus reports (1004) say whether the window is in front; the probe asks about synchronized output
  const enter = () => { out.write(`${ESC}[?1049h${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h${FOCUS_ON}${ESC}[2J${PROBE}`); process.stdin.setRawMode(true); process.stdin.resume(); };
  const leave = () => { out.write(`${SYNC_END}${FOCUS_OFF}${ESC}[?1002l${ESC}[?1000l${ESC}[?1006l${ESC}[0m${ESC}[?25h${ESC}[?1049l`); try { process.stdin.setRawMode(false); } catch {} };
  function quit() { c.quitting = true; cfg.lastSeenAt = Date.now(); saveCfg(); c.views.forEach(c.closeView); leave(); console.log("AXA keeps running: `axa` reopens this, `axa console` opens the web console."); process.exit(0); }
  c.quit = quit;
  process.on("SIGTERM", quit); process.on("SIGHUP", quit);
  process.on("uncaughtException", (e) => { c.quitting = true; try { c.views.forEach(c.closeView); } catch {} leave(); console.error(e); process.exit(1); });
  out.on("resize", () => { c.clearScreen = true; c.resizeViews(); schedule(); });

  await poll();
  if (c.err) throw new Error(`The console isn't answering: ${c.err}`);
  // the commander: reuse the console's, or start one (in this folder when it's inside your home)
  let cmd = c.list.find((s) => s.mode === "axa" && s.alive), cmdError = null;
  if (!cmd) {
    const rel = relative(homedir(), process.cwd());
    const cwd = rel && !rel.startsWith("..") && !isAbsolute(rel) ? process.cwd() : homedir();
    try { const t = await api("/api/terms", { method: "POST", body: { mode: "axa", cwd } }); await poll(); cmd = c.list.find((s) => s.id === t.id); }
    catch (e) { cmdError = e.message; }
  }
  enter();
  c.views.push(null);
  show(c.list.find((s) => s.status === "waiting" && s.mode !== "axa") || cmd || c.ordered()[0], 0);
  if (cmdError) c.flash("Couldn't start the AXA commander", [cmdError, "", "Sessions still work; start it later from the web console (Ctrl-b o)."]);
  pollLoop();
  streamEvents({ port, readToken, st: c.ev, onChange: () => { kick(); schedule(); }, stopped: () => c.quitting });
  // One shared tick drives every animation (braille spinners, the map's and the sidebar's flowing
  // links): every 100 ms while a session works, else once a second, when only the clock (HH:MM) can
  // change. A frame that changes nothing writes nothing, so an idle window sends ~0 bytes.
  const busyNow = () => c.list.some((s) => s.status === "working") || [...c.ev.helpers.values()].some((hs) => hs.some((h) => h.status === "running"));
  (function tick() {
    if (c.quitting) return;
    const busy = busyNow();
    if (busy) c.tickN++;
    // panes hidden behind the map give their terminals back after a while
    if (c.mapMode && Date.now() - (c.mapSince || 0) > PARK_AFTER_MS) c.park();
    schedule();
    setTimeout(tick, busy ? TICK_BUSY : TICK_IDLE);
  })();
  // "since you left" counts from when mission control was last open
  setInterval(() => { cfg.lastSeenAt = Date.now(); saveCfg(); }, 60_000);
  if (!cmdError) setTimeout(() => { if (!c.overlay) c.briefing(true); }, 1500);
}
