// AXA mission control in the terminal: `axa` opens it.
// A sidebar with AXA (the commander) and every session, sorted by what needs you, next to the live,
// fully interactive view of one session (or two side by side), rendered here through a headless
// terminal. tmux-style: everything you type goes to the session in focus; the prefix key (Ctrl-b by
// default) then a key is an AXA action: Ctrl-b : opens a palette of every action, Ctrl-b ? lists keys.
// Settings (theme, prefix, sidebar, bell) live in $AXA_HOME/ui.json and Ctrl-b , edits them live.
// Same backend as the web console, so the browser, phone and this window always agree.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join, relative, isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const out = process.stdout;
const ESC = "\x1b";

// ---------- themes: roles -> SGR codes ----------
// "terminal" uses the 16 basic colors, so your terminal's own theme applies (the default)
const THEMES = {
  terminal: { title: "1;36", accent: "36", wait: "1;33", waitSoft: "33", stuck: "31", work: "36", done: "32", idle: "0", off: "90", dim: "90", sel: "7", rule: "90", tag: "1;7", add: "32", del: "31", hunk: "36" },
  hud: { title: "1;38;2;79;216;255", accent: "38;2;79;216;255", wait: "1;38;2;255;181;71", waitSoft: "38;2;255;181;71", stuck: "38;2;255;138;92", work: "38;2;79;216;255", done: "38;2;94;242;194", idle: "38;2;143;179;196", off: "38;2;108;138;153", dim: "38;2;108;138;153", sel: "48;2;14;48;66;38;2;233;251;255", rule: "38;2;34;78;98", tag: "1;48;2;79;216;255;38;2;3;16;24", add: "38;2;94;242;194", del: "38;2;255;84;104", hunk: "38;2;79;216;255" },
  light: { title: "1;38;5;25", accent: "38;5;25", wait: "1;38;5;130", waitSoft: "38;5;130", stuck: "38;5;160", work: "38;5;25", done: "38;5;28", idle: "0", off: "38;5;245", dim: "38;5;242", sel: "48;5;153;38;5;16", rule: "38;5;250", tag: "1;7", add: "38;5;28", del: "38;5;160", hunk: "38;5;25" },
  contrast: { title: "1;97", accent: "1;96", wait: "1;93", waitSoft: "93", stuck: "1;91", work: "1;96", done: "1;92", idle: "97", off: "37", dim: "37", sel: "1;7", rule: "97", tag: "1;7", add: "1;92", del: "1;91", hunk: "1;96" },
  mono: { title: "1", accent: "1", wait: "1;4", waitSoft: "1", stuck: "1", work: "0", done: "0", idle: "0", off: "2", dim: "2", sel: "7", rule: "2", tag: "7", add: "1", del: "2", hunk: "1" },
};
const PREFIXES = { "C-b": 0x02, "C-a": 0x01, "C-g": 0x07, "C-\\": 0x1c };
const DEFAULTS = { theme: "terminal", prefix: "C-b", sidebar: "left", sidebarWidth: 34, bell: true, newSession: "claude", feed: true, copyOnSelect: true, sidebarStyle: "tree" };
const FEED_ROWS = 4; // the activity strip: a rule plus the latest 3 events
const SPARK = "▁▂▃▄▅▆▇█", SPARK_BUCKETS = 10, SPARK_MIN = 3; // activity over the last 30 minutes, 3 minutes per bar

export async function runTui({ port, readToken, openUrl, root, home }) {
  const pty = require("node-pty");
  const { Terminal: Headless } = require("@xterm/headless");
  const SOCK = `axa-${port}`;
  const env = { ...process.env, TERM: "xterm-256color" };
  for (const k of ["TMUX", "TMUX_PANE"]) delete env[k];

  // ---------- settings ----------
  const cfgPath = join(home, "ui.json");
  let cfg = { ...DEFAULTS };
  try { cfg = { ...DEFAULTS, ...JSON.parse(readFileSync(cfgPath, "utf8")) }; } catch {}
  const saveCfg = () => { try { writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 }); chmodSync(cfgPath, 0o600); } catch {} };
  const noColor = !!process.env.NO_COLOR || process.env.TERM === "dumb";
  const T = () => THEMES[noColor ? "mono" : cfg.theme] || THEMES.terminal;
  const PREFIX = () => PREFIXES[cfg.prefix] ?? 0x02;

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

  // ---------- text helpers ----------
  const sgr = (role, s) => { const c = T()[role] ?? role; return c && c !== "0" ? `${ESC}[${c}m${s}${ESC}[0m` : s; };
  const LOOK = { waiting: ["⚠", "needs you", "wait"], stuck: ["◷", "stuck", "stuck"], working: ["●", "working", "work"], done: ["✓", "done", "done"], ready: ["○", "ready", "idle"], starting: ["◌", "starting", "off"], exited: ["–", "exited", "off"] };
  // shells never report a status: they're just "shell"
  const look = (s) => (s.mode === "shell" && ["starting", "ready"].includes(s.status) ? ["○", "shell", "idle"] : LOOK[s.status] || ["?", s.status, "idle"]);
  const URGENCY = ["waiting", "stuck", "working", "done", "ready", "starting", "exited"];
  const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  // display width: wide East Asian characters and emoji take two columns
  const cw = (ch) => { const c = ch.codePointAt(0); return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1; };
  const width = (s) => [...s].reduce((n, ch) => n + cw(ch), 0);
  const cut = (s, n) => { if (n <= 0) return ""; if (width(s) <= n) return s; let o = "", w = 0; for (const ch of s) { if (w + cw(ch) > n - 1) break; o += ch; w += cw(ch); } return o + "…"; };
  const pad = (s, n) => { const c = cut(s, n); return c + " ".repeat(Math.max(0, n - width(c))); };
  // the question of a prompt: its last line that asks something (not a link like "Security guide")
  const question = (c) => { const ls = c.question.split("\n").map(clean).filter(Boolean); return [...ls].reverse().find((l) => l.includes("?")) || ls[0] || "a prompt"; };
  // y = the first "Yes…" option, x = the "No…" option (menus differ: the trust prompt starts with "No, exit")
  const yesOpt = (c) => c.options.find((o) => /^yes\b/i.test(o.label)) || c.options[0];
  const noOpt = (c) => c.options.find((o) => /^no\b/i.test(o.label)) || c.options.at(-1);
  const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const gitText = (g) => (!g ? "" : `${g.branch}${g.files ? ` ${g.files}f +${g.added} -${g.removed}` : " clean"}${g.ahead ? ` ↑${g.ahead}` : ""}`);
  const what = (s) => clean(s.status === "done" ? s.last_report || "finished" : s.doing || s.last_report || (s.mode === "shell" ? "shell" : s.mode === "axa" ? "select it and type to talk" : ""));
  // your own display names for sessions (Ctrl-b r), like herdr's agent labels
  const nameOf = (s) => clean(cfg.labels?.[s.id]) || (s.mode === "axa" ? "AXA commander" : clean(s.name));
  // inside its workspace, a worktree session goes by its own name ("fix-login", not "launches:fix-login")
  const shortName = (s) => clean(cfg.labels?.[s.id]) || (s.worktree ? clean(s.name).split(":").pop() : nameOf(s));
  // "done" stays bright until you've looked at it, then it's just idle (herdr's done vs idle)
  const seen = new Map();
  const unseenDone = (s) => s.status === "done" && (seen.get(s.id) || 0) < (s.last_event_at || 0);
  // helper agents grouped by the work they do: "● builder ×2 · ✓ reviewer"
  function helperGroups(arr) {
    const by = new Map();
    for (const h of arr) { const g = by.get(h.type) || { run: 0, done: 0, desc: "" }; if (h.status === "running") { g.run++; g.desc ||= h.desc; } else g.done++; by.set(h.type, g); }
    return [...by.entries()].map(([type, g]) => (g.run ? [`● ${type}${g.run > 1 ? ` ×${g.run}` : ""}`, "work", g.desc] : [`✓ ${type}${g.done > 1 ? ` ×${g.done}` : ""}`, "done", ""]));
  }

  // ---------- state ----------
  let list = [], err = "", prev = null, overlay = null, prefix = false, quitting = false, zoom = false;
  let mapMode = false, mapSel = 0, mapNodes = [], mapWant = null, chainsList = []; // the map view, its selected node (session or helper), the links between sessions
  const briefSince = cfg.lastSeenAt || 0; // when you last had mission control open (for "since you left")
  let W = out.columns || 120, H = out.rows || 36;
  const views = []; // live panes: { id, proc, term, cursorOn, cols, rows, dead, lastRows }
  let focus = 0; // which pane gets your typing
  const byUrgency = (a, b) => URGENCY.indexOf(a.status) - URGENCY.indexOf(b.status) || (b.last_event_at || b.created) - (a.last_event_at || a.created);
  // AXA first, then sessions by urgency; sessions are numbered 1-9 in this order (AXA is 0)
  // Workspaces, like herdr's: one per project (a worktree session belongs to its repo). A workspace's
  // state rolls up from its sessions: needs you > working > done (not yet seen) > idle.
  const wsKey = (s) => s.worktree?.repo || s.cwd;
  const rollup = (arr) => (arr.some((s) => s.status === "waiting" || s.status === "stuck") ? ["⚠", "needs you", "wait", 0] : arr.some((s) => s.status === "working") ? ["●", "working", "work", 1] : arr.some(unseenDone) ? ["✓", "done", "done", 2] : ["○", "idle", "off", 3]);
  function workspaces() {
    const by = new Map();
    for (const s of list) if (s.mode !== "axa") { const k = wsKey(s); by.set(k, [...(by.get(k) || []), s]); }
    return [...by.entries()].map(([key, ss]) => ({ key, name: basename(key), sessions: ss.sort(byUrgency), state: rollup(ss) }))
      .sort((a, b) => a.state[3] - b.state[3] || Math.max(...b.sessions.map((s) => s.last_event_at || s.created)) - Math.max(...a.sessions.map((s) => s.last_event_at || s.created)));
  }
  // sessions in display order (by workspace, then urgency): their numbers 1-9 follow it
  const sessions = () => workspaces().flatMap((w) => w.sessions);
  const ordered = () => [...list.filter((x) => x.mode === "axa"), ...sessions()];
  const selId = () => views[focus]?.id || null;
  const sel = () => list.find((s) => s.id === selId());
  const onScreen = (id) => views.some((v) => v?.id === id);
  // A session not on screen that's waiting on a prompt
  const alertFor = () => list.find((s) => !onScreen(s.id) && s.status === "waiting" && s.choices) || null;

  // Where everything goes. Panes: one, or two side by side (stacked when the window is narrow).
  function layout() {
    W = out.columns || 120; H = out.rows || 36;
    const side = zoom || W < 70 ? 0 : Math.max(22, Math.min(48, cfg.sidebarWidth, Math.floor(W * 0.4)));
    const sideX = cfg.sidebar === "right" ? W - side : 0; // 0-based column of the sidebar
    const mainX = side && cfg.sidebar !== "right" ? side + 1 : 0, mainW = W - (side ? side + 1 : 0);
    const alert = alertFor(), alertRows = alert ? 2 : 0;
    const feedRows = cfg.feed && H >= 24 ? FEED_ROWS : 0;
    const mainH = H - 1 - alertRows - feedRows; // rows above the alert bar, the activity strip and the status line
    // the tab row (sessions of the focused workspace) sits above the panes
    const tabRow = mapMode ? 0 : 1, ph = mainH - tabRow;
    const panes = [];
    if (views.length < 2) panes.push({ x: mainX, y: tabRow, w: mainW, h: ph });
    else if (mainW >= 100) { const a = Math.floor((mainW - 1) / 2); panes.push({ x: mainX, y: tabRow, w: a, h: ph }, { x: mainX + a + 1, y: tabRow, w: mainW - a - 1, h: ph }); }
    else { const a = Math.floor(ph / 2); panes.push({ x: mainX, y: tabRow, w: mainW, h: a }, { x: mainX, y: tabRow + a, w: mainW, h: ph - a }); }
    // each pane: a header row, then the session's rows
    // a header row per pane only when there are two; one pane is described by the tab row
    for (const p of panes) { p.hdr = panes.length > 1 ? 1 : 0; p.cols = Math.max(10, p.w); p.rows = Math.max(3, p.h - p.hdr); }
    return { side, sideX, mainX, mainW, mainH, panes, alert, alertRows, feedRows };
  }

  // ---------- live panes: a tmux client in a PTY, drawn through a headless terminal ----------
  function closeView(v) {
    if (!v) return;
    try { if (v.proc?._pty) spawnSync("tmux", ["-L", SOCK, "detach-client", "-t", v.proc._pty], { stdio: "ignore", env }); } catch {}
    try { v.proc?.kill(); } catch {}
    try { v.term?.dispose(); } catch {}
    v.closed = true;
  }
  const fitWindow = (v) => spawnSync("tmux", ["-L", SOCK, "resize-window", "-t", `=axa-${v.id}:`, "-x", String(v.cols), "-y", String(v.rows)], { stdio: "ignore", env });
  function makeView(s, pane) {
    if (!s || !s.alive) return { id: s?.id, dead: "Session ended.", lastRows: [] };
    if (spawnSync("tmux", ["-L", SOCK, "has-session", "-t", `=axa-${s.id}`], { stdio: "ignore", env }).status !== 0) return { id: s.id, dead: "This session isn't in tmux; open it in the web console (Ctrl-b o).", lastRows: [] };
    const term = new Headless({ cols: pane.cols, rows: pane.rows, scrollback: 0, allowProposedApi: true });
    const proc = pty.spawn("tmux", ["-L", SOCK, "attach-session", "-t", `=axa-${s.id}`], { name: "xterm-256color", cols: pane.cols, rows: pane.rows, cwd: homedir(), env });
    const v = { id: s.id, proc, term, cursorOn: true, cols: pane.cols, rows: pane.rows, lastRows: [] };
    fitWindow(v);
    proc.onData((d) => {
      if (v.closed) return;
      // cursor visibility isn't in the public API: follow the last show/hide in the stream
      const i = Math.max(d.lastIndexOf("\x1b[?25h"), d.lastIndexOf("\x1b[?25l"));
      if (i >= 0) v.cursorOn = d[i + 5] === "h";
      term.write(d, schedule);
    });
    proc.onExit(() => { if (!v.closed) { v.dead = "Detached or ended. Ctrl-b j/k picks another session."; schedule(); } });
    return v;
  }
  // Show session s in pane `slot` (default: the focused one). If it's already on screen, focus it.
  function show(s, slot = focus) {
    if (!s) return;
    const at = views.findIndex((v) => v?.id === s.id);
    if (at >= 0) { focus = at; return schedule(); }
    closeView(views[slot]);
    views[slot] = null;
    const L = layout();
    views[slot] = makeView(s, L.panes[slot] || L.panes[0]);
    focus = slot;
    schedule();
  }
  function resizeViews() {
    const L = layout();
    views.forEach((v, i) => {
      const p = L.panes[i];
      if (!v?.term || !p || (v.cols === p.cols && v.rows === p.rows)) return;
      v.cols = p.cols; v.rows = p.rows; v.lastRows = [];
      try { v.proc.resize(p.cols, p.rows); v.term.resize(p.cols, p.rows); fitWindow(v); } catch {}
    });
  }

  // ---------- drawing ----------
  let timer = null, lastTitle = "", fullRedraw = true;
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; draw(); }, 16); };
  function cellSgr(c) {
    const a = [];
    if (c.isBold()) a.push(1); if (c.isDim()) a.push(2); if (c.isItalic()) a.push(3); if (c.isUnderline()) a.push(4);
    if (c.isInverse()) a.push(7); if (c.isInvisible()) a.push(8); if (c.isStrikethrough()) a.push(9);
    if (noColor) return a.join(";");
    if (c.isFgRGB()) { const v = c.getFgColor(); a.push(`38;2;${v >> 16};${(v >> 8) & 255};${v & 255}`); }
    else if (c.isFgPalette()) { const p = c.getFgColor(); a.push(p < 8 ? 30 + p : p < 16 ? 82 + p : `38;5;${p}`); }
    if (c.isBgRGB()) { const v = c.getBgColor(); a.push(`48;2;${v >> 16};${(v >> 8) & 255};${v & 255}`); }
    else if (c.isBgPalette()) { const p = c.getBgColor(); a.push(p < 8 ? 40 + p : p < 16 ? 92 + p : `48;5;${p}`); }
    return a.join(";");
  }
  function viewRows(v, p, pane) {
    const rows = [];
    // the text being selected (copy-on-select) shows inverted
    const [sa, sb] = selection && selection.pane === pane ? selRange() : [null, null];
    const inSel = (x, y) => sa && (y > sa.y || (y === sa.y && x >= sa.x)) && (y < sb.y || (y === sb.y && x <= sb.x));
    if (!v || v.dead || !v.term) {
      const msg = v?.dead || "Pick a session: Ctrl-b j/k, or Ctrl-b s to browse with previews";
      for (let y = 0; y < p.rows; y++) rows.push(y === Math.floor(p.rows / 2) ? pad(" ".repeat(Math.max(0, Math.floor((p.cols - width(msg)) / 2))) + sgr("dim", cut(msg, p.cols)), p.cols + 20) : " ".repeat(p.cols));
      return rows;
    }
    const b = v.term.buffer.active, cell = b.getNullCell();
    for (let y = 0; y < p.rows; y++) {
      const line = b.getLine(b.baseY + y);
      let s = "", cur = "", n = 0;
      for (let x = 0; x < p.cols && line; x++) {
        line.getCell(x, cell);
        const w = cell.getWidth();
        if (w === 0) continue;
        const base = cellSgr(cell), a = inSel(x, y) ? (base ? `${base};7` : "7") : base;
        if (a !== cur) { s += `${ESC}[0${a ? ";" + a : ""}m`; cur = a; }
        // a wide character that doesn't fit in the last column would spill over the pane's border
        if (x + w > p.cols) { s += " "; n += 1; break; }
        s += cell.getChars() || " "; n += w;
      }
      rows.push(s + `${ESC}[0m` + " ".repeat(Math.max(0, p.cols - n)));
    }
    return rows;
  }
  // The tab row: the focused session's workspace and its sessions as tabs (click one, or Ctrl-b n/p)
  let tabHits = []; // [{ x0, x1, id }] in screen columns (1-based)
  function workspaceOf(id) { return workspaces().find((w) => w.sessions.some((s) => s.id === id)); }
  function tabStrip(L) {
    // a project with several sessions shows them as tabs; one session (or AXA) is just its name
    const cur = sel(), ws = cur && cur.mode !== "axa" ? workspaceOf(cur.id) : null, tabs = ws && ws.sessions.length > 1 ? ws.sessions : [];
    const label = ws ? ` ▣ ${ws.name}${tabs.length || shortName(cur) === ws.name ? "" : ` · ${shortName(cur)}`} ` : cur ? " ◆ AXA commander " : " ◆ AXA ";
    let o = sgr("title", label), n = width(label);
    tabHits = [];
    for (const s of tabs) {
      const [g, , role] = look(s), t = ` ${g} ${shortName(s)}${unseenDone(s) ? " •" : ""} `;
      if (n + width(t) + 1 > L.mainW) break;
      const x0 = L.mainX + n + 2;
      o += sgr("rule", "│") + (s.id === selId() ? sgr("sel", t) : sgr(role, t));
      n += width(t) + 1;
      tabHits.push({ x0, x1: x0 + width(t) - 1, id: s.id });
    }
    o += sgr("rule", "│"); n += 1;
    const s = sel();
    if (L.panes.length === 1 && s) {
      const [, word, role] = look(s);
      const bits = [gitText(s.git), s.usage?.tokens ? `${fmtTok(s.usage.tokens)} tok${s.usage.budget ? ` of ${fmtTok(s.usage.budget)}` : ""}` : "", s.worktree ? "worktree" : ""].filter(Boolean);
      const right = cut(`${word}${bits.length ? " · " + bits.join(" · ") : ""} `, Math.max(0, L.mainW - n - 2));
      return o + " ".repeat(Math.max(1, L.mainW - n - width(right))) + sgr(role === "off" ? "dim" : role, word) + sgr("dim", right.slice(word.length));
    }
    return o + " ".repeat(Math.max(0, L.mainW - n));
  }
  function paneHeader(v, p, isFocus) {
    const s = list.find((x) => x.id === v?.id);
    if (!s) return sgr("dim", pad(" (empty pane)", p.cols));
    const [g, word, role] = look(s);
    const bits = [gitText(s.git), s.usage?.tokens ? `${fmtTok(s.usage.tokens)} tok${s.usage.budget ? ` of ${fmtTok(s.usage.budget)}` : ""}` : "", s.worktree ? `worktree ${s.worktree.branch}` : ""].filter(Boolean).join(" · ");
    const mark = views.length > 1 ? (isFocus ? "▶" : " ") : "";
    const head = cut(`${mark} ${g} ${nameOf(s)}`, p.cols), rest = ` · ${word}${bits ? " · " + bits : ""}`;
    const room = Math.max(0, p.cols - width(head));
    return sgr(isFocus || views.length < 2 ? role : "dim", head) + sgr("dim", pad(cut(rest, room), room));
  }
  // which session each sidebar row belongs to (for clicks), rebuilt on every draw
  let sideHits = [];
  // Sidebar as a diagram (the default): AXA at the root, sessions branching off it with a dot running
  // along each working one, their helper agents and their links underneath
  function treeRows(L, rows, hits) {
    const w = L.side, frame = Math.floor(Date.now() / 250), ss = sessions(), axa = list.find((s) => s.mode === "axa");
    const line = (segs, id, isSel, sp = "") => {
      const spW = sp ? SPARK_BUCKETS + 1 : 0;
      // the selected session: a bar at the left edge, its text kept in its own colors
      const marked = isSel && segs[0]?.[0]?.startsWith(" ") ? [["▌", "accent"], [segs[0][0].slice(1), segs[0][1]], ...segs.slice(1)] : segs;
      const body = renderSegs(marked, w - spW);
      rows.push(body + (sp ? " " + sgr("work", sp) : ""));
      hits[rows.length - 1] = id;
    };
    const recent = (id) => (helpers.get(id) || []).filter((h) => h.status === "running" || Date.now() - h.ts < 15 * 60_000);
    const wss = workspaces(), nums = new Map(ss.map((s, i) => [s.id, i < 9 ? String(i + 1) : " "]));
    if (axa) {
      const [g, word, role] = look(axa), isSel = axa.id === selId(), down = wss.length ? "│" : " ";
      line([[" ◆ ", "title"], ["AXA", "title"], [`  0 ${g} ${word}`, role]], axa.id, isSel, spark(axa.id));
      line([[` ${down}  `, "rule"], [axa.status === "done" ? "ready for your next message" : what(axa), "dim"]], axa.id, isSel);
      // AXA's own helper agents, grouped by the work they do (like the web map's orbit)
      const hg = helperGroups(recent(axa.id));
      if (hg.length) line([[` ${down}  └ `, "rule"], ...hg.flatMap(([t, r], k) => [[k ? " · " : "", "dim"], [t, r]]), [hg.length === 1 && hg[0][2] ? `: ${hg[0][2]}` : "", "dim"]], `agents:${axa.id}`, false);
    } else line([[" ◆ AXA", "title"], ["  not running · Ctrl-b o", "dim"]], null, false);
    wss.forEach((ws, wi) => {
      const lastWs = wi === wss.length - 1, wstem = lastWs ? " " : "│", [wg, wword, wrole] = ws.state;
      line([[" │", "rule"]], null, false);
      if (ws.sessions.length === 1) {
        // one session: the project row is the session
        const s = ws.sessions[0], [g0, word, role0] = look(s), isSel = s.id === selId(), fresh = unseenDone(s), role = s.status === "done" && !fresh ? "off" : role0;
        const p = frame % 3, branch = s.status === "working" ? [0, 1, 2].map((k) => (k === p ? "●" : "─")).join("") : "──";
        line([[` ${lastWs ? "└" : "├"}`, "rule"], [branch, s.status === "working" ? "work" : s.status === "waiting" ? "wait" : "rule"], [` ${nums.get(s.id)} ${g0} `, role], [shortName(s), s.status === "waiting" ? "wait" : "title"], [fresh ? " •" : "", "done"]], s.id, isSel, spark(s.id));
        const pre = ` ${wstem}     `;
        const subText = s.status === "waiting" && s.choices ? question(s.choices) : s.mode === "shell" && word === "shell" ? what(s) : `${word} · ${what(s)}`;
        line([[pre, "rule"], [subText, s.status === "waiting" ? "waitSoft" : "dim"]], s.id, isSel);
        const meta = [gitText(s.git), s.usage?.tokens ? `${fmtTok(s.usage.tokens)} tok${s.usage.over_budget ? "!" : ""}` : ""].filter(Boolean).join(" · ");
        if (meta) line([[pre, "rule"], [meta, "dim"]], s.id, isSel);
        const hg = helperGroups(recent(s.id));
        if (hg.length) line([[`${pre}└ `, "rule"], ...hg.flatMap(([t, r], k) => [[k ? " · " : "", "dim"], [t, r]])], `agents:${s.id}`, false);
        return;
      }
      // the workspace (project): its state rolls up from its sessions
      line([[` ${lastWs ? "└" : "├"}─ `, "rule"], ["▣ ", "accent"], [ws.name, "title"], [`  ${wg} ${wword}`, wrole], [` · ${ws.sessions.length} sessions`, "dim"]], ws.sessions[0].id, false);
      ws.sessions.forEach((s, i) => {
        const last = i === ws.sessions.length - 1, stem = last ? " " : "│", [g0, word, role0] = look(s), isSel = s.id === selId();
        // done but already seen: shown as idle (dim); not yet seen: bright, with a dot
        const fresh = unseenDone(s), role = s.status === "done" && !fresh ? "off" : role0, g = g0;
        const p = frame % 3, branch = s.status === "working" ? [0, 1, 2].map((k) => (k === p ? "●" : "─")).join("") : "───";
        line([[` ${wstem}  ${last ? "└" : "├"}`, "rule"], [branch, s.status === "working" ? "work" : s.status === "waiting" ? "wait" : "rule"], [` ${nums.get(s.id)} ${g} `, role], [shortName(s), role], [fresh ? " •" : "", "done"]], s.id, isSel, spark(s.id));
        const pre = ` ${wstem}  ${stem}    `;
        const sub = s.status === "waiting" && s.choices ? question(s.choices) : s.mode === "shell" && word === "shell" ? what(s) : `${word} · ${what(s)}`;
        line([[pre, "rule"], [sub, s.status === "waiting" ? "waitSoft" : "dim"]], s.id, isSel);
        const meta = [gitText(s.git), s.usage?.tokens ? `${fmtTok(s.usage.tokens)} tok${s.usage.over_budget ? "!" : ""}` : "", s.worktree ? "worktree" : ""].filter(Boolean).join(" · ");
        if (meta) line([[pre, "rule"], [meta, "dim"]], s.id, isSel);
        const hg = helperGroups(recent(s.id));
        if (hg.length) line([[` ${wstem}  ${stem}    └ `, "rule"], ...hg.flatMap(([t, r], k) => [[k ? " · " : "", "dim"], [t, r]]), [hg.length === 1 && hg[0][2] ? `: ${hg[0][2]}` : "", "dim"]], `agents:${s.id}`, false);
        for (const c of chainsList.filter((c) => c.from === s.id && !c.failed && (!c.fired || Date.now() - c.fired < 15 * 60_000))) {
          const to = list.find((x) => x.id === c.to);
          line([[` ${wstem}  ${stem}    ──▶ `, c.fired ? "dim" : "accent"], [to ? nameOf(to) : c.to_name || "?", c.fired ? "dim" : "accent"], [c.fired ? " ✓ sent" : " when done", "dim"]], s.id, false);
        }
      });
    });
  }
  function sideRows(L) {
    const rows = [], o = ordered(), w = L.side, hits = [];
    sideHits = hits;
    const n = (st) => list.filter((s) => s.mode !== "axa" && s.status === st).length;
    rows.push(sgr("title", pad(" AXA mission control", w)));
    rows.push(sgr("rule", "─".repeat(w)));
    if (cfg.sidebarStyle !== "list") treeRows(L, rows, hits);
    const nums = new Map(sessions().map((s, i) => [s.id, i < 9 ? String(i + 1) : " "]));
    for (const s of cfg.sidebarStyle === "list" ? o : []) {
      const [g, word, role] = look(s);
      const isSel = s.id === selId(), shown = onScreen(s.id), num = s.mode === "axa" ? "0" : nums.get(s.id);
      const head = `${shown && !isSel ? "▸" : " "}${num} ${g} ${cut(nameOf(s), w - 7)}`;
      const sub = `     ${cut(s.status === "waiting" && s.choices ? question(s.choices) : (s.mode === "axa" && ["ready", "starting"].includes(s.status)) || (s.mode === "shell" && word === "shell") ? what(s) : `${word} · ${what(s)}`, w - 6)}`;
      // the activity sparkline sits at the right end of the session's name row
      const sp = spark(s.id), spW = sp ? SPARK_BUCKETS + 1 : 0;
      const metaText = s.mode === "axa" ? null : `     ${cut([gitText(s.git), s.usage?.tokens ? `${fmtTok(s.usage.tokens)} tok${s.usage.over_budget ? "!" : ""}` : ""].filter(Boolean).join(" · "), w - 6)}`;
      const lines = [[head, role, true], [sub, "dim", false], ...(metaText !== null ? [[metaText, "dim", false]] : [])];
      for (const [t, r, withSpark] of lines) {
        const body = withSpark && sp ? pad(t, w - spW) : pad(t, w);
        rows.push(isSel ? sgr("sel", body + (withSpark && sp ? " " + sp : "")) : sgr(r, body) + (withSpark && sp ? " " + sgr(role === "off" ? "dim" : "work", sp) : ""));
        hits[rows.length - 1] = s.id;
      }
    }
    if (!list.some((s) => s.mode !== "axa")) rows.push(sgr("dim", pad("   no sessions yet: Ctrl-b c", w)));
    while (rows.length < H - 1) rows.push(" ".repeat(w));
    rows.length = H - 1;
    return rows;
  }
  function alertRows(L) {
    const a = L.alert, q = question(a.choices), yes = yesOpt(a.choices), no = noOpt(a.choices), k = cfg.prefix.replace("C-", "Ctrl-");
    return [
      sgr("wait", pad(` ⚠ ${nameOf(a)} needs you: ${q}`, L.mainW)),
      sgr("waitSoft", pad(`   ${k} y  ${yes.label}    ${k} x  ${no.label}    ${k} !  go there`, L.mainW)),
    ];
  }
  function statusRow() {
    const k = cfg.prefix.replace("C-", "Ctrl-");
    if (notice && Date.now() < notice.until) { const t = ` ✓ ${notice.text} `; return sgr("tag", t) + sgr("dim", pad(notice.hint || " Shift+drag uses your terminal's own selection", Math.max(0, W - width(t)))); }
    if (updated) return sgr("tag", " ↻ AXA was updated ") + sgr("waitSoft", pad(` press ${keyName()} q, then run axa again to get the new version (your sessions keep running)`, Math.max(0, W - 19)));
    const tag = prefix ? " PREFIX " : "";
    const keys = prefix
      ? " : palette · m map · b brief · h history · l link · i image · s browse · / search · j/k move · 0-9 pick · % split · Tab pane · z zoom · f feed · y/x answer · ! go · c new · w worktree · g goal · d diff · v verify · , settings · q quit · ? help"
      : ` ${k} : palette · ${k} s browse · ${k} ? help · ${k} q leave`;
    const clock = new Date().toLocaleTimeString([], { hour12: false });
    // left: does anything need you; then the keys; the clock at the right end
    const cnt = (st) => list.filter((s) => s.mode !== "axa" && s.status === st).length, needs = cnt("waiting") + cnt("stuck"), busy = cnt("working");
    const state = ` ${needs ? `⚠ ${needs} need${needs > 1 ? "" : "s"} you` : "✓ nothing needs you"}${busy ? ` · ${busy} working` : ""} `;
    const room = Math.max(0, W - 11 - tag.length - width(state) - 1);
    return sgr(needs ? "wait" : "done", state) + sgr("rule", "│") + (tag ? sgr("tag", tag) : "") + sgr("dim", pad(keys, room)) + sgr("dim", pad(clock, 9) + " ");
  }
  function draw() {
    if (quitting) return;
    resizeViews();
    const L = layout();
    let o = `${ESC}[?25l`;
    if (fullRedraw) { o += `${ESC}[0m${ESC}[2J`; views.forEach((v) => v && (v.lastRows = [])); fullRedraw = false; }
    // sidebar and its border
    if (L.side) {
      const side = sideRows(L), bx = cfg.sidebar === "right" ? L.sideX : L.side + 1;
      for (let y = 0; y < H - 1; y++) o += `${ESC}[${y + 1};${L.sideX + 1}H${side[y] || " ".repeat(L.side)}${ESC}[${y + 1};${cfg.sidebar === "right" ? L.sideX : L.side + 1}H${sgr("rule", "│")}`;
      void bx;
    }
    if (mapMode) {
      // the map replaces the panes (sessions keep running and are still live underneath)
      const rows = mapRows(L);
      for (let y = 0; y < L.mainH; y++) o += `${ESC}[${y + 1};${L.mainX + 1}H${rows[y]}`;
    } else {
      // what's on screen counts as seen (a "done" you've looked at turns idle)
      for (const v of views) if (v?.id) seen.set(v.id, Date.now());
      o += `${ESC}[1;${L.mainX + 1}H${tabStrip(L)}`;
      L.panes.forEach((p, i) => {
        const v = views[i];
        if (p.hdr) o += `${ESC}[${p.y + 1};${p.x + 1}H${paneHeader(v, p, i === focus)}`;
        const rows = viewRows(v, p, i);
        for (let y = 0; y < p.rows; y++) {
          if (v && v.lastRows[y] === rows[y]) continue;
          o += `${ESC}[${p.y + y + 1 + p.hdr};${p.x + 1}H${rows[y]}`;
          if (v) v.lastRows[y] = rows[y];
        }
      });
      // the line between two panes
      if (L.panes.length === 2) {
        const [a, b] = L.panes;
        if (b.x > a.x) for (let y = a.y; y < L.mainH; y++) o += `${ESC}[${y + 1};${b.x}H${sgr("rule", "│")}`;
      }
    }
    // panels float over the live sessions (which keep running and drawing underneath)
    if (overlay) o += floatingPanel(L);
    // the copied / pasted popup, bottom center of the main area (like herdr's clipboard toast)
    if (notice && Date.now() < notice.until && !overlay) {
      const t = ` ✓ ${notice.text} `, x = L.mainX + Math.max(0, Math.floor((L.mainW - width(t)) / 2));
      o += `${ESC}[${Math.max(1, L.mainH - 1)};${x + 1}H${sgr("tag", t)}`;
    }
    if (L.alert) alertRows(L).forEach((r, i) => (o += `${ESC}[${L.mainH + 1 + i};${L.mainX + 1}H${r}`));
    if (L.feedRows) feedStripRows(L).forEach((r, i) => (o += `${ESC}[${L.mainH + L.alertRows + 1 + i};${L.mainX + 1}H${r}`));
    o += `${ESC}[${H};1H${statusRow()}`;
    // the focused session's own cursor, when it shows one
    const v = views[focus], p = L.panes[focus];
    if (!overlay && !mapMode && v?.term && !v.dead && v.cursorOn && p) {
      const b = v.term.buffer.active;
      o += `${ESC}[${p.y + b.cursorY + 1 + p.hdr};${p.x + b.cursorX + 1}H${ESC}[?25h`;
    } else if (overlay?.cursor) o += `${ESC}[${overlay.cursor[0]};${overlay.cursor[1]}H${ESC}[?25h`;
    // the window title says whether anything needs you
    const title = list.some((s) => s.status === "waiting" || s.status === "stuck") ? "⚠ AXA" : "AXA";
    if (title !== lastTitle) { o += `${ESC}]0;${title}\x07`; lastTitle = title; }
    out.write(o);
  }

  // A bordered panel centered over the main area ("large" panels, like browse, take nearly all of it)
  function floatingPanel(L) {
    const big = overlay.size === "large";
    // small panels fit their content (title, lines, input, hint, borders)
    const fit = (overlay.lines?.length || 0) + (overlay.input !== undefined ? 1 : 0) + 4;
    const w = Math.max(30, Math.min(L.mainW - (big ? 0 : 4), big ? 400 : 108)), h = Math.max(8, Math.min(L.mainH - (big ? 1 : 2), big ? 400 : Math.min(32, fit + 1)));
    const x = L.mainX + Math.floor((L.mainW - w) / 2), y = Math.floor((L.mainH - h) / 2);
    const rows = overlayRows({ x: x + 1, y: y + 1, cols: w - 2, rows: h - 3 });
    let o = `${ESC}[${y + 1};${x + 1}H${sgr("accent", "╭" + "─".repeat(w - 2) + "╮")}`;
    for (let i = 0; i < h - 2; i++) o += `${ESC}[${y + 2 + i};${x + 1}H${sgr("accent", "│")}${rows[i] ?? " ".repeat(w - 2)}${sgr("accent", "│")}`;
    return o + `${ESC}[${y + h};${x + 1}H${sgr("accent", "╰" + "─".repeat(w - 2) + "╯")}`;
  }

  // ---------- overlays ----------
  // { title, lines: [string | {text, role}], scroll, hint, onKey(k) -> handled?, input?, prompt?, onSubmit?, render?(p), size? }
  function overlayRows(p) {
    const ov = overlay, rows = [];
    if (ov.render) ov.render(p);
    rows.push(sgr("title", pad(` ${ov.title}`, p.cols)));
    const body = p.rows - (ov.input !== undefined ? 2 : 1);
    const lines = ov.lines || [];
    if (ov.follow !== undefined) ov.scroll = Math.max(0, Math.min(Math.max(0, ov.follow - Math.floor(body / 2)), lines.length - body));
    ov.scroll = Math.max(0, Math.min(ov.scroll || 0, Math.max(0, lines.length - body)));
    for (let i = 0; i < body; i++) {
      const raw = lines[ov.scroll + i];
      if (raw === undefined) { rows.push(" ".repeat(p.cols)); continue; }
      const t = typeof raw === "string" ? { text: raw } : raw;
      rows.push(t.raw ? t.raw : t.role ? sgr(t.role, pad(t.text.replace(/\t/g, "    "), p.cols)) : pad(t.text.replace(/\t/g, "    "), p.cols));
    }
    if (ov.input !== undefined) {
      const pr = ` ${ov.prompt || "›"} `;
      rows.push(pad(pr + ov.input, p.cols));
      ov.cursor = [p.y + rows.length, p.x + width(pr) + width(ov.input) + 1];
    } else ov.cursor = null;
    rows.push(sgr("dim", pad(` ${ov.hint || (lines.length > body ? "j/k ↑/↓ space scroll · q close" : "q close")}`, p.cols)));
    return rows;
  }
  // closing a panel repaints the sessions it covered
  const closeOverlay = () => { overlay?.onClose?.(); overlay = null; fullRedraw = true; schedule(); };
  function overlayKey(k) {
    const ov = overlay;
    if (ov.onKey && ov.onKey(k)) return schedule();
    if (ov.input !== undefined) {
      if (k === "\r") { const v = ov.input.trim(); closeOverlay(); if (v || ov.allowEmpty) ov.onSubmit(v); return; }
      if (k === ESC || k === "\x03") return closeOverlay();
      if (k === "\x7f" || k === "\b") ov.input = [...ov.input].slice(0, -1).join("");
      else if (!k.startsWith(ESC)) ov.input += k.replace(/[\x00-\x1f]/g, "");
      ov.onInput?.();
      return schedule();
    }
    const page = Math.max(1, layout().mainH - 3);
    if (k === "q" || k === ESC || k === "\x03") return closeOverlay();
    if (k === "j" || k === "\x1b[B") ov.scroll = (ov.scroll || 0) + 1;
    else if (k === "k" || k === "\x1b[A") ov.scroll = (ov.scroll || 0) - 1;
    else if (k === " " || k === "\x1b[6~") ov.scroll = (ov.scroll || 0) + page;
    else if (k === "b" || k === "\x1b[5~") ov.scroll = (ov.scroll || 0) - page;
    else if (k === "g") ov.scroll = 0;
    else if (k === "G") ov.scroll = 1e9;
    schedule();
  }
  const ask = (prompt, onSubmit, { allowEmpty = false } = {}) => { overlay = { title: prompt, lines: [], input: "", prompt: "›", onSubmit, allowEmpty, hint: "Enter submit · Esc cancel" }; schedule(); };
  const flash = (title, lines) => { overlay = { title, lines: [].concat(lines) }; schedule(); };

  const keyName = () => cfg.prefix.replace("C-", "Ctrl-");
  const help = () => [
    `Everything you type goes to the session in focus. AXA actions: press ${keyName()}, then:`,
    "",
    "  :          palette: search every action and session        ?   this help",
    "  s          browse sessions with a live preview (peek)      ,   settings: theme, prefix key, sidebar, bell",
    "  j / k      next / previous session      0  AXA commander   1 … 9  a session by number",
    "  n / p      next / previous tab (session) in this workspace      r  rename the session (your label)",
    "  %          split: a second session side by side (again to close it)    Tab  switch pane",
    "  z          zoom: hide the sidebar       f  show / hide the activity strip",
    "  /          search every session's screen and recent history",
    "  m          map: AXA at the center, sessions, their helper agents and links: ↑/↓ moves through sessions",
    "             and helpers, Enter opens a session or a helper's details, Space/→ shows details",
    "  a          agents and work of this session: its helpers (live tool calls, instruction, report), its calls",
    "  b          since you left: what happened while mission control was closed",
    "  h          run history: every instruction, its steps, approvals, checks and result",
    "  l          link: when this session finishes, send an instruction to another",
    "  i          paste an image from your clipboard into the session (saved as a PNG, its path typed in); Ctrl+V does this too",
    "  y / x      answer the prompt in the yellow bar: its Yes… / No… option (the bar names them)",
    "  !          jump to whatever needs you",
    "  c          new session in a project     w  new session in its own git worktree",
    "  g          give the session a goal      d  its changes (diff)     v  run the project's checks",
    "  o          open the web console         X  close the session",
    `  ${keyName()}     send a literal ${keyName()}            q  leave (sessions keep running)`,
    "",
    "Mouse: drag across text to copy it (double-click: a word); click a session or pane to focus it; scroll goes to the session.",
    "Hold Shift while dragging to use your terminal's own selection instead.",
    `Settings live in ${cfgPath}.`,
  ];

  // ---------- actions ----------
  function move(d) { const o = ordered(); if (!o.length) return; const i = Math.max(0, o.findIndex((s) => s.id === selId())); show(o[(i + d + o.length) % o.length]); }
  async function poll() {
    try { list = await api("/api/terms"); err = ""; } catch (e) { err = e.message; }
    try { chainsList = await api("/api/chains"); } catch {}
    const now = new Map(list.map((s) => [s.id, s.status]));
    if (cfg.bell && prev && list.some((s) => ["waiting", "stuck"].includes(s.status) && prev.get(s.id) !== s.status)) out.write("\x07");
    prev = now;
    views.forEach((v) => { const s = v && list.find((x) => x.id === v.id); if (v && !v.dead && (!s || !s.alive)) v.dead = "Session ended."; });
    schedule();
  }
  // ---------- the event stream: activity sparklines and the activity strip ----------
  const feed = []; // described events, newest last
  const activity = new Map(); // terminal id -> event times (last 30 minutes)
  const PLUMBING = /^(ToolSearch|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskOutput|EnterPlanMode|ExitPlanMode)$/;
  const clip = (s, n) => cut(clean(s), n);
  function humanAction(tool, summary, skill) {
    if (skill) return `using the ${skill} skill`;
    if (!tool || PLUMBING.test(tool)) return null;
    const s = clip(summary, 90);
    const m = /^mcp__(.+?)__(.+)$/.exec(tool);
    if (m) return `${m[2].replace(/_/g, " ")} (${m[1].replace(/^plugin_/, "").replace(/_/g, " ")})`;
    return { Bash: s ? `ran: ${s}` : "ran a command", Read: `read ${s || "a file"}`, Edit: `edited ${s || "a file"}`, Write: `wrote ${s || "a file"}`, Grep: `searched for ${s}`, Glob: `looked for ${s}`, WebSearch: `searched the web: ${s}`, WebFetch: `read a web page: ${s}`, Agent: `started a helper: ${s}`, Task: `started a helper: ${s}`, Skill: `using the ${s} skill` }[tool] || (s ? `${tool}: ${s}` : tool);
  }
  function describe(e) {
    switch (e.event) {
      case "UserPromptSubmit": return /^\s*(\[AXA supervisor|<task-notification>)/.test(e.prompt || "") ? null : { text: `got an instruction: ${clip(e.prompt, 80)}`, role: "accent" };
      case "PreToolUse": { const a = e.agent_id ? null : humanAction(e.tool, e.summary, e.skill); return a ? { text: a, role: "" } : null; }
      case "PostToolUseFailure": return { text: `${e.tool || "a step"} failed: ${clip(e.error, 80)}`, role: "del" };
      case "AxaDecision": return e.decision === "allow" ? { text: `AXA approved: ${clip(e.reason, 80)}`, role: "dim" } : e.decision === "deny" ? { text: `AXA declined: ${clip(e.reason, 80)}`, role: "stuck" } : { text: `needs your approval: ${clip(e.reason, 80)}`, role: "wait" };
      case "PolicyDecision": return e.decision === "deny" ? { text: `policy refused: ${clip(e.reason, 80)}`, role: "stuck" } : null;
      case "Notification": return /permission/i.test(e.notification_type || "") ? { text: "waiting for your approval", role: "wait" } : null;
      case "Stop": return { text: `finished${e.message ? `: ${clip(e.message, 80)}` : ""}`, role: "done" };
      case "VerifyGate": return { text: "verify gate: sent back to check its work", role: "waitSoft" };
      case "UserAnswer": return { text: `you answered: ${clip(e.answer, 60)}`, role: "accent" };
      case "SupervisorWake": return { text: `AXA woke up: ${clip((e.items || []).join("; "), 90)}`, role: "accent" };
      case "ChainFired": return { text: `link: ${clip(e.from, 20)} finished → sent: ${clip(e.text, 70)}`, role: "accent" };
    }
    return null;
  }
  // helper agents per session (for the map): spawned → running → done
  // Each helper: its instruction, its tool calls as they happen (count, recent targets, last time), failures
  // and its report, like the web console's agent panel. Sessions' own tool calls are tallied too.
  const helpers = new Map(), spawnQueue = new Map(), sessCalls = new Map(); // terminal -> helpers / Map(tool -> tally)
  const toolLabel = (e) => (e.skill ? `skill ${e.skill}` : /^mcp__/.test(e.tool || "") ? String(e.tool).split("__").pop().replace(/_/g, " ") : e.tool);
  function tally(m, tool, summary, at) {
    const c = m.get(tool) || { count: 0, recent: [], at: 0 };
    c.count++; c.at = at;
    if (summary) { c.recent.unshift(clip(summary, 60)); c.recent.length = Math.min(c.recent.length, 5); }
    m.set(tool, c);
  }
  function trackHelpers(e) {
    const t = e.terminal, at = e.ts || Date.now();
    const spawn = e.tool === "Agent" || e.tool === "Task";
    if (e.event === "PreToolUse" && !e.agent_id && spawn) { const q = spawnQueue.get(t) || []; q.push({ desc: e.summary, type: e.subagent_type, prompt: e.prompt }); spawnQueue.set(t, q.slice(-10)); }
    else if (e.event === "PreToolUse" && !e.agent_id && e.tool && !PLUMBING.test(e.tool)) { const m = sessCalls.get(t) || new Map(); tally(m, toolLabel(e), e.summary, at); sessCalls.set(t, m); }
    else if (e.event === "PreToolUse" && e.agent_id && e.tool && !PLUMBING.test(e.tool)) { const h = (helpers.get(t) || []).find((x) => x.id === e.agent_id); if (h) tally(h.calls, toolLabel(e), e.summary, at); }
    else if (e.event === "PostToolUseFailure" && e.agent_id) { const h = (helpers.get(t) || []).find((x) => x.id === e.agent_id); if (h) h.failures++; }
    else if (e.event === "SubagentStart") {
      const sp = (spawnQueue.get(t) || []).shift(), arr = helpers.get(t) || [];
      arr.push({ id: e.agent_id, type: String(e.agent_type || sp?.type || "helper").split(":").pop(), desc: clean(sp?.desc || ""), prompt: sp?.prompt || "", status: "running", start: at, ts: at, calls: new Map(), failures: 0 });
      helpers.set(t, arr.slice(-8));
    } else if (e.event === "SubagentStop") { const h = (helpers.get(t) || []).find((x) => x.id === e.agent_id); if (h) { h.status = "done"; h.ts = h.end = at; h.report = e.message || ""; } }
  }
  function ingest(e) {
    if (!e?.terminal) return;
    trackHelpers(e);
    const t = activity.get(e.terminal) || [];
    t.push(e.ts || Date.now()); activity.set(e.terminal, t);
    const d = describe(e);
    if (d) { feed.push({ ts: e.ts || Date.now(), terminal: e.terminal, commander: e.role === "commander", ...d }); if (feed.length > 300) feed.splice(0, feed.length - 300); }
  }
  // the console's live event stream (Server-Sent Events); reconnects on its own
  async function streamEvents() {
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/events`, { headers: { host: `localhost:${port}`, cookie: `axa_token=${readToken()}` } });
        const reader = res.body.getReader(), dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const kind = /^event: (\w+)/m.exec(block)?.[1], data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
            if (!data) continue;
            try { const v = JSON.parse(data); kind === "history" ? v.forEach(ingest) : ingest(v); } catch {}
          }
          schedule();
        }
      } catch {}
      if (quitting) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  // "  ▂▅█ ▃": events per 3 minutes over the last 30
  function spark(id) {
    const now = Date.now(), span = SPARK_MIN * 60_000, b = Array(SPARK_BUCKETS).fill(0);
    const ts = (activity.get(id) || []).filter((t) => now - t < span * SPARK_BUCKETS);
    activity.set(id, ts);
    for (const t of ts) b[SPARK_BUCKETS - 1 - Math.floor((now - t) / span)]++;
    const max = Math.max(...b);
    return max ? b.map((n) => (n ? SPARK[Math.min(7, Math.ceil((n / max) * 7))] : " ")).join("") : "";
  }
  function feedStripRows(L) {
    const rows = [sgr("rule", "─ activity " + "─".repeat(Math.max(0, L.mainW - 11)))];
    const name = (f) => { const s = list.find((x) => x.id === f.terminal); return f.commander || s?.mode === "axa" ? "AXA" : s ? clean(s.name) : f.terminal.slice(0, 8); };
    const last = feed.slice(-(L.feedRows - 1));
    for (let i = 0; i < L.feedRows - 1; i++) {
      const f = last[i - (L.feedRows - 1 - last.length)];
      if (!f) { rows.push(" ".repeat(L.mainW)); continue; }
      const time = new Date(f.ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
      const head = ` ${time} ${pad(name(f), 14)} `;
      rows.push(sgr("dim", head) + sgr(f.role || "idle", pad(f.text, Math.max(0, L.mainW - width(head)))));
    }
    return rows;
  }

  // ---------- search every session's screen and recent history ----------
  async function searchAll() {
    const ov = { title: "Search every session · type to filter · ↑/↓ choose · Enter go there · Esc close", input: "", prompt: "/", sel: 0, lines: [], size: "large", hint: "searches each session's screen and recent history" };
    const texts = [];
    let hits = [], loading = true;
    ov.render = (p) => {
      const q = ov.input.trim().toLowerCase();
      hits = q ? texts.filter((x) => x.t.toLowerCase().includes(q)).slice(-500) : [];
      ov.sel = Math.min(ov.sel, Math.max(0, hits.length - 1));
      if (loading) { ov.lines = [{ text: "  reading sessions…", role: "dim" }]; return; }
      if (!q) { ov.lines = [{ text: `  ${texts.length} lines across ${new Set(texts.map((x) => x.s.id)).size} sessions: type to search`, role: "dim" }]; return; }
      if (!hits.length) { ov.lines = [{ text: "  no match", role: "dim" }]; return; }
      ov.lines = hits.map((h, i) => {
        const left = pad(`${i === ov.sel ? "›" : " "} ${nameOf(h.s)}`, 18), rest = cut(h.t, Math.max(0, p.cols - 21));
        const at = rest.toLowerCase().indexOf(q), mark = at >= 0 ? rest.slice(0, at) + sgr("wait", rest.slice(at, at + q.length)) + rest.slice(at + q.length) : rest;
        const line = (i === ov.sel ? sgr("sel", left) : sgr("accent", left)) + sgr("rule", " │ ") + mark;
        return { raw: line + " ".repeat(Math.max(0, p.cols - 21 - width(rest))) };
      });
      ov.follow = ov.sel;
    };
    ov.onInput = () => { ov.sel = 0; };
    ov.onKey = (k) => {
      if (k === "\x1b[B" || k === "\x0e") { ov.sel = Math.min(hits.length - 1, ov.sel + 1); return true; }
      if (k === "\x1b[A" || k === "\x10") { ov.sel = Math.max(0, ov.sel - 1); return true; }
      if (k === "\r") { const h = hits[ov.sel]; closeOverlay(); if (h) show(h.s); return true; }
      return false;
    };
    overlay = ov; schedule();
    await Promise.all(ordered().map(async (s) => {
      try { const r = await api(`/api/terms/${s.id}/screen?lines=400`); for (const l of String(r.screen || "").split("\n")) { const t = clean(l); if (t) texts.push({ s, t }); } } catch {}
    }));
    loading = false; schedule();
  }

  // ---------- map: AXA at the center, sessions, their helpers and the links between them ----------
  const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`; };
  const renderSegs = (segs, w) => { let o = "", n = 0; for (const [t, r] of segs) { if (!t) continue; if (n >= w) break; const c = cut(t, w - n); o += r ? sgr(r, c) : c; n += width(c); } return o + " ".repeat(Math.max(0, w - n)); };
  function mapRows(L) {
    const W2 = L.mainW, H2 = L.mainH, frame = Math.floor(Date.now() / 250);
    const ss = sessions(), axa = list.find((s) => s.mode === "axa");
    const TX = 24; // the trunk's column
    const entries = []; // { kind, s, i, h, c }
    ss.forEach((s, i) => {
      entries.push({ kind: "session", s, i });
      const hs = (helpers.get(s.id) || []).filter((h) => h.status === "running" || Date.now() - h.ts < 30 * 60_000).slice(-6);
      for (const h of hs) entries.push({ kind: "helper", s, h });
      for (const c of chainsList.filter((c) => c.from === s.id && (!c.fired || Date.now() - c.fired < 30 * 60_000))) entries.push({ kind: "link", s, c });
      if (i < ss.length - 1) entries.push({ kind: "gap" });
    });
    const rows = Array.from({ length: H2 }, () => [["", ""]]);
    if (!ss.length) {
      rows[Math.floor(H2 / 2)] = [["   ◆ AXA", "title"], ["   no sessions yet: Ctrl-b c starts one, or ask the commander", "dim"]];
      return rows.map((r) => renderSegs(r, W2));
    }
    // sessions and helper agents are the nodes you move between (↑/↓); keep the selected one in view
    mapNodes = entries.filter((e) => e.kind === "session" || e.kind === "helper");
    if (mapWant) { const i = mapNodes.findIndex((n) => n.kind === "session" && n.s.id === mapWant); if (i >= 0) mapSel = i; mapWant = null; }
    mapSel = Math.max(0, Math.min(mapSel, mapNodes.length - 1));
    const selected = mapNodes[mapSel], selAt = entries.indexOf(selected);
    const off = entries.length <= H2 ? -Math.floor((H2 - entries.length) / 2) : Math.max(0, Math.min(selAt - Math.floor(H2 / 2), entries.length - H2));
    const sessRows = entries.map((e, k) => (e.kind === "session" ? k : -1)).filter((k) => k >= 0);
    const first = sessRows[0], last = sessRows.at(-1), mid = Math.round((first + last) / 2);
    for (let y = 0; y < H2; y++) {
      const k = y + off, e = entries[k];
      // AXA's node, left of the trunk, level with the middle of the sessions
      let left = " ".repeat(TX - 1);
      const [ag, aword, arole] = axa ? look(axa) : ["◆", "not running", "off"];
      const node = k === mid - 1 ? [[" ◆ AXA", "title"]] : k === mid ? [[` ${ag} ${aword}`, arole]] : k === mid + 1 ? [[` ${cut(axa ? what(axa) : "Ctrl-b 0", TX - 3)}`, "dim"]] : null;
      const segs = node ? [...node] : [[left, ""]];
      const used = node ? width(node.map(([t]) => t).join("")) : TX - 1;
      if (k === mid) segs.push(["─".repeat(Math.max(0, TX - 1 - used)), "rule"]); else segs.push([" ".repeat(Math.max(0, TX - 1 - used)), ""]);
      // the trunk
      const inSpan = k >= first && k <= last, isSess = e?.kind === "session";
      let tc = " ";
      if (inSpan) {
        if (first === last) tc = k === mid ? "─" : " ";
        else if (isSess) tc = k === first ? (k === mid ? "┬" : "┌") : k === last ? (k === mid ? "┴" : "└") : k === mid ? "┼" : "├";
        else tc = k === mid ? "┤" : "│";
      }
      segs.push([tc, "rule"]);
      if (!e || e.kind === "gap") { rows[y] = segs; continue; }
      const s = e.s, [g, word, role] = look(s);
      if (e.kind === "session") {
        // the branch: data flowing out to a working session
        let branch = "──────";
        if (s.status === "working") { const p = frame % 6; branch = "─".repeat(p) + "●" + "─".repeat(5 - p); }
        segs.push([branch, s.status === "working" ? "work" : s.status === "waiting" ? "wait" : "rule"]);
        const isSel = e === selected;
        segs.push([` ${g} `, role], [nameOf(s), isSel ? "sel" : role], ["  ", ""]);
        if (s.status === "waiting" && s.choices) segs.push([`${question(s.choices)}  `, "wait"], [`[y] ${yesOpt(s.choices).label}  [x] ${noOpt(s.choices).label}`, "waitSoft"]);
        else segs.push([`${word} · ${what(s)}`, "dim"]);
      } else if (e.kind === "helper") {
        const h = e.h, isSel = e === selected;
        segs.push(["         └─ ", "rule"], [h.status === "running" ? "● " : "✓ ", h.status === "running" ? "work" : "done"], [h.type, isSel ? "sel" : h.status === "running" ? "work" : "dim"], [h.desc ? `: ${cut(h.desc, 40)}` : "", "dim"]);
        // its tool calls as leaves: the one it just used lights up
        segs.push(...toolLeaves(h.calls));
      } else if (e.kind === "link") {
        const c = e.c, to = list.find((x) => x.id === c.to);
        segs.push(["         ──▶ ", c.fired ? "dim" : "accent"], [to ? nameOf(to) : c.to_name || "?", c.fired ? "dim" : "accent"], [c.fired ? `  ✓ sent ${fmtDur(Date.now() - c.fired)} ago` : c.failed ? `  ✗ ${c.failed}` : "  when this finishes: ", c.failed ? "stuck" : "dim"], [c.fired || c.failed ? "" : c.text, "idle"]);
      }
      rows[y] = segs;
    }
    return rows.map((r) => renderSegs(r, W2));
  }
  // "⟶ Read ×4 · Edit ×2 · Bash ×1" (most used first; the one used in the last moment is bright)
  function toolLeaves(calls) {
    if (!calls?.size) return [];
    const now = Date.now(), top = [...calls.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 4);
    return [["  ⟶ ", "rule"], ...top.flatMap(([t, c], i) => [[i ? " · " : "", "dim"], [`${t} ×${c.count}`, now - c.at < 1500 ? "title" : "dim"]])];
  }
  // a tool tally as panel rows: "● Read ×4   a.js · b.js · c.js"
  function callLines(calls, w) {
    const now = Date.now();
    return [...calls.entries()].sort((a, b) => b[1].count - a[1].count).map(([tool, c]) => {
      const hot = now - c.at < 1500;
      return { raw: renderSegs([[`  ${hot ? "●" : "·"} `, hot ? "work" : "dim"], [`${tool} ×${c.count}`, hot ? "title" : "idle"], [c.recent.length ? `   ${c.recent.slice(0, 3).join(" · ")}` : "", "dim"]], w) };
    });
  }
  const textLines = (t, empty) => (t ? String(t).split("\n").map((l) => ({ text: `  ${l}` })) : [{ text: `  ${empty}`, role: "dim" }]);
  // A helper agent, live: its task, the instruction it got, its tool calls as they happen, its report
  function helperDetail(h, s) {
    const ov = { title: "", size: "large", lines: [], hint: "updates live · space/b scroll · Esc close" };
    ov.render = (p) => {
      const n = [...h.calls.values()].reduce((a, c) => a + c.count, 0);
      ov.title = `${h.status === "running" ? "●" : "✓"} ${h.type} · ${h.status === "running" ? "working" : "done"} · ${fmtDur((h.end || Date.now()) - h.start)}${s ? ` · helping ${nameOf(s)}` : ""}`;
      ov.lines = [
        ...(h.desc ? [{ text: `Task: ${h.desc}`, role: "title" }] : []),
        { text: "" }, { text: "The instruction it was given", role: "accent" }, ...textLines(h.prompt, "(not recorded; prompts are left out when AXA_LOG_PROMPTS=0)"),
        { text: "" }, { text: `Tool calls, live · ${n} so far${h.failures ? ` · ${h.failures} failed` : ""}`, role: "accent" }, ...(h.calls.size ? callLines(h.calls, p.cols) : [{ text: "  none yet", role: "dim" }]),
        { text: "" }, { text: "Its report", role: "accent" }, ...textLines(h.report, h.status === "running" ? "(still working)" : "(no report)"),
      ];
    };
    overlay = ov; schedule();
  }
  // A session's agents and work, live: what it's doing, its helpers (pick one), its own tool calls, links, report
  function sessionDetail(s) {
    if (!s) return;
    const ov = { title: "", size: "large", sel: 0, lines: [], hint: "j/k pick a helper · Enter its details · space/b scroll · Esc close" };
    let hs = [];
    ov.render = (p) => {
      const cur = list.find((x) => x.id === s.id) || s, [g, word] = look(cur);
      hs = (helpers.get(s.id) || []).slice().reverse();
      ov.sel = Math.max(0, Math.min(ov.sel, hs.length - 1));
      ov.title = `${g} ${nameOf(cur)} · ${word} · agents and work`;
      const meta = [gitText(cur.git), cur.usage?.tokens ? `${fmtTok(cur.usage.tokens)} tokens` : "", cur.worktree ? `worktree ${cur.worktree.branch}` : ""].filter(Boolean).join(" · ");
      const links = chainsList.filter((c) => c.from === s.id || c.to === s.id);
      const calls = sessCalls.get(s.id) || new Map();
      ov.lines = [
        { text: `Now: ${what(cur)}`, role: "title" }, ...(meta ? [{ text: meta, role: "dim" }] : []),
        { text: "" }, { text: `Helper agents (${hs.length})`, role: "accent" },
        ...(hs.length ? hs.map((h, i) => ({ raw: renderSegs([[i === ov.sel ? " › " : "   ", "accent"], [h.status === "running" ? "● " : "✓ ", h.status === "running" ? "work" : "done"], [h.type, i === ov.sel ? "sel" : "title"], [h.desc ? `: ${h.desc}` : "", "idle"], [`   ${[...h.calls.values()].reduce((a, c) => a + c.count, 0)} calls · ${fmtDur((h.end || Date.now()) - h.start)}`, "dim"], ...toolLeaves(h.calls)], p.cols) })) : [{ text: "   none yet", role: "dim" }]),
        { text: "" }, { text: "Its own tool calls, live", role: "accent" }, ...(calls.size ? callLines(calls, p.cols) : [{ text: "  none yet", role: "dim" }]),
        ...(links.length ? [{ text: "" }, { text: "Links", role: "accent" }, ...links.map((c) => ({ text: `  ${c.from === s.id ? `→ ${c.to_name}` : `← ${c.from_name}`}: ${c.text}${c.fired ? "  (sent)" : ""}`, role: "dim" }))] : []),
        ...(cur.last_report ? [{ text: "" }, { text: "Last report", role: "accent" }, ...textLines(cur.last_report)] : []),
      ];
    };
    ov.onKey = (k) => {
      if (k === "j" || k === "\x1b[B") { ov.sel++; return true; }
      if (k === "k" || k === "\x1b[A") { ov.sel = Math.max(0, ov.sel - 1); return true; }
      if (k === "\r" && hs[ov.sel]) {
        const back = ov; helperDetail(hs[ov.sel], s);
        overlay.onKey = (k2) => { if (k2 === ESC || k2 === "q") { overlay = back; fullRedraw = true; return true; } return false; };
        return true;
      }
      return false;
    };
    overlay = ov; schedule();
  }
  function mapKey(k) {
    const node = mapNodes[mapSel], s = node?.s;
    if (k === "j" || k === "\x1b[B") mapSel = Math.min(mapNodes.length - 1, mapSel + 1);
    else if (k === "k" || k === "\x1b[A") mapSel = Math.max(0, mapSel - 1);
    else if (/^[1-9]$/.test(k)) { const i = mapNodes.findIndex((n) => n.kind === "session" && n.i === Number(k) - 1); if (i >= 0) mapSel = i; }
    // Enter: open a session / a helper's details; Space or →: details of either
    else if (k === "\r" && node?.kind === "helper") helperDetail(node.h, s);
    else if (k === "\r" && s) { mapMode = false; fullRedraw = true; show(s); }
    else if ((k === " " || k === "\x1b[C") && node) node.kind === "helper" ? helperDetail(node.h, s) : sessionDetail(s);
    else if ((k === "y" || k === "x") && s?.status === "waiting" && s.choices) answerSession(s, k === "y" ? yesOpt(s.choices) : noOpt(s.choices));
    else if (k === "d" && s) showDiff(s);
    else if (k === "g" && s) giveGoal(s);
    else if (k === "l" && s) linkFrom(s);
    else if (k === "v" && s) runVerify(s);
    else if (k === ESC || k === "m" || k === "q") { mapMode = false; fullRedraw = true; }
    schedule();
  }
  async function answerSession(s, o) {
    try { await api(`/api/terms/${s.id}/answer`, { method: "POST", body: { n: o.n, label: o.label }, headers: { "x-axa-client": "tui" } }); await poll(); }
    catch (e) { flash("Couldn't answer", [e.message]); }
  }

  // ---------- links: when one session finishes, the next one gets an instruction ----------
  function linkFrom(s = sel()) {
    if (!s) return;
    const others = ordered().filter((x) => x.id !== s.id && x.alive);
    if (!others.length) return flash("Nothing to link to", ["Open another session first (Ctrl-b c)."]);
    const ov = { title: `Link: when ${nameOf(s)} finishes, send the next instruction to…`, sel: 0, lines: [], hint: "j/k choose · Enter next · Esc cancel" };
    const render = () => { ov.lines = others.map((o, i) => { const [g] = look(o); return { text: `${i === ov.sel ? "›" : " "} ${g} ${nameOf(o)}`, role: i === ov.sel ? "sel" : "" }; }); ov.follow = ov.sel; };
    ov.onKey = (k) => {
      if (k === "j" || k === "\x1b[B") ov.sel = Math.min(others.length - 1, ov.sel + 1);
      else if (k === "k" || k === "\x1b[A") ov.sel = Math.max(0, ov.sel - 1);
      else if (k === "\r") {
        const to = others[ov.sel];
        closeOverlay();
        ask(`When ${nameOf(s)} finishes, tell ${nameOf(to)}:`, async (text) => {
          try { await api("/api/chains", { method: "POST", body: { from: s.id, to: to.id, text } }); chainsList = await api("/api/chains"); flash("Linked", [`When ${nameOf(s)} finishes (and its checks settle), AXA sends ${nameOf(to)}:`, "", `  ${text}`, "", "It shows on the map (Ctrl-b m). Remove it from the palette (Ctrl-b :, \"remove link\")."]); }
          catch (e) { flash("Couldn't link them", [e.message]); }
        });
        return true;
      } else if (k === "q" || k === ESC) { closeOverlay(); return true; }
      render(); return true;
    };
    render(); overlay = ov; schedule();
  }

  // ---------- since you left: what happened between runs ----------
  const runGlyph = (r) => (r.status === "done" ? ["✓", "done"] : r.status === "running" ? ["●", "work"] : r.status === "replaced" ? ["↺", "dim"] : ["–", "off"]);
  const runPrompt = (r) => (/^\s*\[AXA supervisor/.test(r.prompt || "") ? "(supervisor update)" : /^\s*\[AXA link/.test(r.prompt || "") ? `(link) ${clean(r.prompt).replace(/^\[AXA link: [^\]]*\]\s*/, "")}` : clean(r.prompt));
  async function briefing(auto = false) {
    const since = briefSince;
    let runs = [];
    try { runs = await api(`/api/runs?since=${since}&limit=300`); } catch {}
    const waiting = list.filter((s) => s.mode !== "axa" && (s.status === "waiting" || s.status === "stuck"));
    if (auto && (!since || (!runs.length && !waiting.length))) return;
    const lines = [];
    for (const s of waiting) lines.push({ text: `⚠ ${nameOf(s)}  ${s.status === "stuck" ? "looks stuck" : `waiting: ${s.choices ? question(s.choices) : clean(s.doing)}`}`, role: "wait" });
    const groups = new Map();
    for (const r of runs.slice().reverse()) { const g = groups.get(r.terminal) || []; g.push(r); groups.set(r.terminal, g); }
    for (const rs of groups.values()) {
      const lastRun = rs.at(-1), [g, role] = runGlyph(lastRun), done = rs.filter((r) => r.status === "done").length;
      const sum = (k) => rs.reduce((n, r) => n + (r[k] || 0), 0);
      const bits = [done ? `${done} run${done > 1 ? "s" : ""} finished` : "", lastRun.status === "running" ? "working now" : "", sum("gate") ? `verify gate ${sum("gate")}×` : "", sum("approvals") ? `${sum("approvals")} approved by AXA` : "", sum("escalated") ? `${sum("escalated")} asked you` : "", sum("failures") ? `${sum("failures")} failed steps` : ""].filter(Boolean).join(" · ");
      lines.push({ text: `${g} ${lastRun.name.padEnd(16)} ${bits}`, role });
      const rep = [...rs].reverse().find((r) => r.report);
      if (rep) lines.push({ text: `    └ ${clean(rep.report)}`, role: "dim" });
    }
    if (!lines.length) lines.push({ text: "Nothing happened since then.", role: "dim" });
    const at = since ? new Date(since).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" }) : "";
    overlay = { title: since ? `Since you left · ${at} (${fmtDur(Date.now() - since)} ago)` : "Briefing", lines, hint: `Esc close · ${keyName()} h full history · ${keyName()} ! what needs you · ${keyName()} m map` };
    schedule();
  }

  // ---------- run history: every instruction, its steps and result ----------
  async function history() {
    let runs = [];
    try { runs = await api("/api/runs?limit=300"); } catch (e) { return flash("Couldn't read the history", [e.message]); }
    if (!runs.length) return flash("No runs yet", ["Runs appear here once sessions get instructions."]);
    const ov = { title: "Run history · newest first · Enter details · Esc close", sel: 0, lines: [], size: "large", hint: "j/k choose · Enter details · Esc close" };
    const render = () => {
      ov.lines = runs.map((r, i) => {
        const [g, role] = runGlyph(r), when = new Date(r.start).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
        const text = `${i === ov.sel ? "›" : " "} ${when.padEnd(14)} ${cut(r.name, 14).padEnd(14)} ${g} ${fmtDur((r.end || Date.now()) - r.start).padStart(5)}  ${runPrompt(r)}`;
        return { text, role: i === ov.sel ? "sel" : r.status === "running" ? "work" : "" };
      });
      ov.follow = ov.sel;
    };
    ov.onKey = (k) => {
      if (k === "j" || k === "\x1b[B") ov.sel = Math.min(runs.length - 1, ov.sel + 1);
      else if (k === "k" || k === "\x1b[A") ov.sel = Math.max(0, ov.sel - 1);
      else if (k === "\r") {
        const r = runs[ov.sel], back = ov;
        overlay = { title: `${r.name} · ${new Date(r.start).toLocaleString([], { hour12: false })} · ${r.status}`, hint: "Esc back to the list", size: "large", lines: [
          { text: "Instruction", role: "title" }, ...String(r.prompt || "").split("\n").map((l) => ({ text: `  ${l}` })), { text: "" },
          { text: `Took ${fmtDur((r.end || Date.now()) - r.start)} · ${r.steps} steps${r.helpers ? ` · ${r.helpers} helper agents` : ""}`, role: "dim" },
          { text: `AXA approved ${r.approvals} · declined ${r.declined} · asked you ${r.escalated} · policy refused ${r.refused} · verify gate ${r.gate}× · failed steps ${r.failures}`, role: "dim" },
          ...(r.answers?.length ? [{ text: `You answered: ${r.answers.join(" · ")}`, role: "accent" }] : []),
          { text: "" }, { text: "Result", role: "title" }, ...String(r.report || (r.status === "running" ? "(still working)" : "(no report)")).split("\n").map((l) => ({ text: `  ${l}` })),
        ] };
        overlay.onKey = (k2) => { if (k2 === ESC || k2 === "q") { overlay = back; fullRedraw = true; return true; } return false; };
        return true;
      } else if (k === "q" || k === ESC) { closeOverlay(); return true; }
      render(); return true;
    };
    render(); overlay = ov; schedule();
  }

  async function answerAlert(which) {
    const a = alertFor() || (sel()?.status === "waiting" && sel()?.choices ? sel() : null);
    if (!a) return flash("Nothing to answer", ["No session is waiting on a prompt right now."]);
    const o = which === "yes" ? yesOpt(a.choices) : noOpt(a.choices);
    try { await api(`/api/terms/${a.id}/answer`, { method: "POST", body: { n: o.n, label: o.label }, headers: { "x-axa-client": "tui" } }); await poll(); }
    catch (e) { flash("Couldn't answer", [e.message]); }
  }
  async function showDiff(s = sel()) {
    if (!s) return;
    try {
      const d = await api(`/api/terms/${s.id}/diff`);
      const lines = (d.diff || "").split("\n").map((l) => ({ text: l, role: l.startsWith("diff --git") ? "title" : l.startsWith("@@") ? "hunk" : l.startsWith("+++") || l.startsWith("---") ? "dim" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "" }));
      if (d.untracked_total) lines.push({ text: "" }, { text: `New files (${d.untracked_total})`, role: "title" }, ...d.untracked.map((f) => ({ text: `+ ${f}`, role: "add" })));
      overlay = { title: `${nameOf(s)} · changes · ${gitText(d.git) || ""}`, lines: d.error ? [d.error] : lines.length ? lines : ["No uncommitted changes."] };
      schedule();
    } catch (e) { flash("Couldn't read the changes", [e.message]); }
  }
  function runVerify(s = sel()) {
    if (!s) return;
    const ov = { title: `${nameOf(s)} · verify (running…)`, lines: [] };
    overlay = ov; schedule();
    const child = spawn(process.execPath, [join(root, "skills", "verify", "verify.mjs"), s.cwd], { cwd: s.cwd, env: { ...process.env, CI: "1" } });
    const dec = new StringDecoder("utf8");
    let part = "";
    const add = (c) => { const t = part + dec.write(c); const ls = t.split("\n"); part = ls.pop(); for (const l of ls) ov.lines.push({ text: l, role: /\| FAIL \|/.test(l) ? "del" : /\| PASS \|/.test(l) ? "add" : /failed \(/.test(l) ? "stuck" : "" }); ov.scroll = 1e9; schedule(); };
    child.stdout.on("data", add); child.stderr.on("data", add);
    child.on("close", (code) => { if (part) ov.lines.push({ text: part }); ov.title = `${nameOf(s)} · verify · ${code === 0 ? "all checks pass" : "checks failed"}`; schedule(); });
    ov.onClose = () => { try { child.kill(); } catch {} };
  }
  async function newSession(worktree) {
    let projects = [];
    try { projects = await api("/api/projects"); } catch (e) { return flash("Couldn't list projects", [e.message]); }
    const ov = { title: worktree ? "New session in its own worktree: pick the project" : "New session: pick a project", sel: 0, lines: [], hint: `j/k move · Enter ${cfg.newSession === "shell" ? "shell" : "Claude"} session · ${cfg.newSession === "shell" ? "a Claude" : "s shell"} · Esc cancel` };
    const render = () => { ov.lines = projects.map((p, i) => ({ text: `${i === ov.sel ? "›" : " "} ${p.name.padEnd(22)} ${p.path.replace(homedir(), "~")}`, role: i === ov.sel ? "sel" : "" })); ov.follow = ov.sel; };
    ov.onKey = (k) => {
      if (k === "j" || k === "\x1b[B") ov.sel = Math.min(projects.length - 1, ov.sel + 1);
      else if (k === "k" || k === "\x1b[A") ov.sel = Math.max(0, ov.sel - 1);
      else if (k === "\r" || k === "s" || k === "a") {
        const p = projects[ov.sel], mode = k === "s" ? "shell" : k === "a" ? "claude" : cfg.newSession === "shell" ? "shell" : "claude";
        const go = async (wt) => { try { const t = await api("/api/terms", { method: "POST", body: { cwd: p.path, mode, worktree: wt || undefined } }); await poll(); show(list.find((x) => x.id === t.id)); } catch (e) { flash("Couldn't start it", [e.message]); } };
        closeOverlay();
        if (worktree) ask("Worktree name (e.g. fix-login; empty for a dated one)", (name) => go(name || true), { allowEmpty: true }); else go();
      } else if (k === "q" || k === ESC) closeOverlay();
      render(); return true;
    };
    render(); overlay = ov; schedule();
  }
  function giveGoal(s = sel()) {
    if (!s || s.mode === "shell") return flash("Pick a Claude session", ["Goals go to Claude sessions (not shells)."]);
    ask(`Goal for ${nameOf(s)}: what does done look like?`, async (goal) => {
      try { await api(`/api/terms/${s.id}/input`, { method: "POST", body: { text: `/goal ${goal.replace(/\s*\n\s*/g, " ")}` } }); }
      catch (e) { flash("Couldn't send the goal", [e.message]); }
    });
  }
  function closeSession(s = sel()) {
    if (!s) return;
    ask(`Close ${nameOf(s)}? This ends what's running in it. Type yes to confirm`, async (v) => {
      if (v.toLowerCase() !== "yes") return;
      const i = views.findIndex((x) => x?.id === s.id);
      if (i >= 0) { closeView(views[i]); views.splice(i, 1); focus = 0; }
      try { await api(`/api/terms/${s.id}`, { method: "DELETE" }); await poll(); if (!views.length) move(0); } catch (e) { flash("Couldn't close it", [e.message]); }
    });
  }
  function toggleSplit() {
    if (views.length > 1) { closeView(views[1]); views.length = 1; focus = 0; fullRedraw = true; return schedule(); }
    const next = ordered().find((s) => !onScreen(s.id) && s.alive);
    if (!next) return flash("Nothing to split with", ["Open another session first (Ctrl-b c)."]);
    views.push(null);
    fullRedraw = true;
    resizeViews(); // the first pane narrows to make room
    show(next, 1);
  }

  // ---------- browse: every session with a live preview of its screen (peek) ----------
  function browse() {
    const o = ordered();
    if (!o.length) return flash("No sessions", ["Start one with Ctrl-b c."]);
    const ov = { title: "Sessions · ↑/↓ preview · Enter show here · % show in a split · d diff · g goal · Esc close", sel: Math.max(0, o.findIndex((s) => s.id === selId())), lines: [], hint: "the preview is read-only and live", size: "large" };
    let screen = [], timerId = null, last = null;
    const fetchScreen = async () => {
      const s = o[ov.sel]; if (!s) return;
      try { const r = await api(`/api/terms/${s.id}/screen?lines=200`); screen = String(r.screen || "").split("\n"); } catch (e) { screen = [`(couldn't read it: ${e.message})`]; }
      schedule();
    };
    ov.render = (p) => {
      const lw = Math.min(30, Math.floor(p.cols * 0.35)), rw = p.cols - lw - 1, body = p.rows - 1;
      if (last !== ov.sel) { last = ov.sel; screen = ["(loading…)"]; fetchScreen(); }
      const shown = screen.slice(-body);
      ov.lines = [];
      for (let i = 0; i < body; i++) {
        const s = o[i];
        let left = " ".repeat(lw);
        if (s) { const [g, , role] = look(s); const t = pad(` ${g} ${nameOf(s)}`, lw); left = i === ov.sel ? sgr("sel", t) : sgr(role, t); }
        ov.lines.push({ raw: left + sgr("rule", "│") + pad(clean(shown[i] ?? ""), rw) });
      }
    };
    ov.onKey = (k) => {
      if (k === "j" || k === "\x1b[B") ov.sel = Math.min(o.length - 1, ov.sel + 1);
      else if (k === "k" || k === "\x1b[A") ov.sel = Math.max(0, ov.sel - 1);
      else if (/^[0-9]$/.test(k)) ov.sel = Math.min(o.length - 1, Number(k) - (o[0]?.mode === "axa" ? 0 : 1));
      else if (k === "\r") { closeOverlay(); show(o[ov.sel]); }
      else if (k === "%") { closeOverlay(); if (views.length < 2) { views.push(null); fullRedraw = true; resizeViews(); } show(o[ov.sel], 1); }
      else if (k === "d") { const s = o[ov.sel]; closeOverlay(); showDiff(s); }
      else if (k === "g") { const s = o[ov.sel]; closeOverlay(); giveGoal(s); }
      else if (k === "q" || k === ESC) closeOverlay();
      return true;
    };
    ov.onClose = () => clearInterval(timerId);
    timerId = setInterval(fetchScreen, 1000);
    overlay = ov; schedule();
  }

  // ---------- palette: search every action and session ----------
  function palette() {
    const acts = [];
    const add = (label, run, hint = "") => acts.push({ label, run, hint });
    add("Browse sessions with previews", browse, "s");
    add("New session", () => newSession(false), "c");
    add("New session in its own worktree", () => newSession(true), "w");
    add("Split: second session side by side", toggleSplit, "%");
    add(zoom ? "Show the sidebar" : "Zoom: hide the sidebar", () => { zoom = !zoom; fullRedraw = true; schedule(); }, "z");
    add("Jump to whatever needs you", () => action("!"), "!");
    add("Search every session", searchAll, "/");
    add(mapMode ? "Back to the sessions" : "Map: AXA, sessions, helpers and links", () => action("m"), "m");
    add("Since you left: briefing", () => briefing(false), "b");
    add("Run history", history, "h");
    add("Link: when this session finishes, instruct another", () => linkFrom(), "l");
    add("Paste an image from the clipboard into this session", pasteImage, "i");
    add("Rename this session (your own label)", () => action("r"), "r");
    add("Agents and work of this session", () => sessionDetail(sel()), "a");
    for (const c of chainsList.filter((c) => !c.fired && !c.failed)) add(`Remove link: ${c.from_name} → ${c.to_name}`, async () => { try { await api(`/api/chains/${c.id}`, { method: "DELETE" }); chainsList = await api("/api/chains"); } catch (e) { flash("Couldn't remove it", [e.message]); } });
    add(cfg.feed ? "Hide the activity strip" : "Show the activity strip", () => action("f"), "f");
    add("Settings: theme, prefix key, sidebar, bell", settings, ",");
    add("Open the web console", () => action("o"), "o");
    add("Help: all keys", () => action("?"), "?");
    for (const t of Object.keys(THEMES)) add(`Theme: ${t}`, () => { cfg.theme = t; saveCfg(); fullRedraw = true; schedule(); });
    for (const s of ordered()) {
      const n = nameOf(s);
      add(`Go to ${n}`, () => show(s));
      if (s.mode !== "axa") { add(`Changes in ${n}`, () => showDiff(s)); add(`Verify ${n}`, () => runVerify(s)); add(`Close ${n}`, () => closeSession(s)); }
      if (s.mode !== "shell") add(`Goal for ${n}`, () => giveGoal(s));
      if (s.status === "waiting" && s.choices) for (const o of s.choices.options) add(`Answer ${n}: ${o.label}`, async () => { try { await api(`/api/terms/${s.id}/answer`, { method: "POST", body: { n: o.n, label: o.label }, headers: { "x-axa-client": "tui" } }); await poll(); } catch (e) { flash("Couldn't answer", [e.message]); } });
    }
    // fuzzy: every typed character in order; earlier and tighter matches first
    const score = (label, q) => { if (!q) return 0; const l = label.toLowerCase(); let i = 0, s = 0, last = -1; for (const ch of q.toLowerCase()) { const j = l.indexOf(ch, i); if (j < 0) return -1; s += j - last - 1; last = j; i = j + 1; } return s + l.indexOf(q[0]?.toLowerCase()) * 0.1; };
    const ov = { title: "Palette: type to search, Enter to run", input: "", prompt: ":", sel: 0, lines: [], hint: "↑/↓ choose · Enter run · Esc close" };
    let hits = acts;
    const render = () => {
      hits = acts.map((a) => ({ a, s: score(a.label, ov.input.trim()) })).filter((x) => x.s >= 0).sort((x, y) => x.s - y.s).map((x) => x.a);
      ov.sel = Math.min(ov.sel, Math.max(0, hits.length - 1));
      ov.lines = hits.map((a, i) => ({ text: `${i === ov.sel ? "›" : " "} ${a.label}${a.hint ? `   ${keyName()} ${a.hint}` : ""}`, role: i === ov.sel ? "sel" : "" }));
      if (!hits.length) ov.lines = [{ text: "  no match", role: "dim" }];
      ov.follow = ov.sel;
    };
    ov.onInput = () => { ov.sel = 0; render(); };
    ov.onKey = (k) => {
      if (k === "\x1b[B" || k === "\x0e") { ov.sel = Math.min(hits.length - 1, ov.sel + 1); render(); return true; }
      if (k === "\x1b[A" || k === "\x10") { ov.sel = Math.max(0, ov.sel - 1); render(); return true; }
      if (k === "\r") { const a = hits[ov.sel]; overlay = null; fullRedraw = true; if (a) a.run(); schedule(); return true; }
      return false;
    };
    render(); overlay = ov; schedule();
  }

  // ---------- settings (saved to ui.json, applied live) ----------
  function settings() {
    const items = [
      { key: "theme", label: "Theme", values: Object.keys(THEMES), about: "terminal = your terminal's own colors" },
      { key: "prefix", label: "Prefix key", values: Object.keys(PREFIXES), about: "the key before every AXA action" },
      { key: "sidebarStyle", label: "Sidebar style", values: ["tree", "list"], about: "tree: the live diagram (AXA, sessions, helpers, links); list: compact" },
      { key: "sidebar", label: "Sidebar side", values: ["left", "right"] },
      { key: "sidebarWidth", label: "Sidebar width", values: [24, 26, 28, 30, 34, 38, 42, 48] },
      { key: "bell", label: "Bell when something needs you", values: [true, false] },
      { key: "newSession", label: "New sessions start as", values: ["claude", "shell"] },
      { key: "feed", label: "Activity strip", values: [true, false], about: "the latest events across sessions, under the panes" },
      { key: "copyOnSelect", label: "Copy on select", values: [true, false], about: "drag across text to copy it (off: drags go to the session)" },
    ];
    const ov = { title: "Settings · ↑/↓ choose · ←/→ or Enter change · saved as you go · Esc close", sel: 0, lines: [] };
    const fmt = (v) => (v === true ? "on" : v === false ? "off" : String(v));
    const render = () => {
      ov.lines = items.map((it, i) => ({ text: `${i === ov.sel ? "›" : " "} ${it.label.padEnd(32)} ‹ ${fmt(cfg[it.key]).padEnd(9)} ›   ${it.about || ""}`, role: i === ov.sel ? "sel" : "" }));
      ov.lines.push({ text: "" }, { text: `  ${noColor ? "NO_COLOR is set: colors are off whatever the theme." : `Saved to ${cfgPath}`}`, role: "dim" });
      if (noColor) ov.lines.push({ text: "" });
      ov.lines.push({ text: "" }, ...["  Status preview:", ...Object.keys(LOOK).map((st) => ` ${LOOK[st][0]} ${LOOK[st][1]}`)].map((t, i) => (i === 0 ? { text: t, role: "dim" } : { text: t, role: LOOK[Object.keys(LOOK)[i - 1]][2] })));
    };
    ov.onKey = (k) => {
      const it = items[ov.sel];
      if (k === "j" || k === "\x1b[B") ov.sel = Math.min(items.length - 1, ov.sel + 1);
      else if (k === "k" || k === "\x1b[A") ov.sel = Math.max(0, ov.sel - 1);
      else if (k === "\x1b[C" || k === "l" || k === "\r" || k === " " || k === "\x1b[D" || k === "h") {
        const d = k === "\x1b[D" || k === "h" ? -1 : 1, i = it.values.indexOf(cfg[it.key]);
        cfg[it.key] = it.values[(i + d + it.values.length) % it.values.length];
        saveCfg(); fullRedraw = true;
      } else if (k === "q" || k === ESC) { closeOverlay(); return true; }
      render(); return true;
    };
    render(); overlay = ov; schedule();
  }

  function action(k) {
    const o = ordered();
    if (k === "?") return flash("AXA · keys", help());
    if (k === ":") return palette();
    if (k === "s") return browse();
    if (k === ",") return settings();
    if (k === "q") return quit();
    if (k === "j" || k === "\x1b[B") return move(1);
    if (k === "k" || k === "\x1b[A") return move(-1);
    // n / p: the next / previous tab (session) in this workspace
    if (k === "n" || k === "p") { const ws = sel() && workspaceOf(selId()); if (!ws) return move(k === "n" ? 1 : -1); const i = ws.sessions.findIndex((s) => s.id === selId()); return show(ws.sessions[(i + (k === "n" ? 1 : -1) + ws.sessions.length) % ws.sessions.length]); }
    if (k === "r") { const s = sel(); if (!s) return; return ask(`Name for ${nameOf(s)} (empty: back to its own name)`, (v) => { cfg.labels = { ...(cfg.labels || {}) }; if (v) cfg.labels[s.id] = v.slice(0, 40); else delete cfg.labels[s.id]; saveCfg(); schedule(); }, { allowEmpty: true }); }
    if (/^[0-9]$/.test(k)) return show(k === "0" ? o.find((s) => s.mode === "axa") : sessions()[Number(k) - 1]);
    if (k === "!") { const t = o.find((s) => s.status === "waiting") || o.find((s) => s.status === "stuck"); return t ? show(t) : flash("All clear", ["Nothing needs you right now."]); }
    if (k === "%") return toggleSplit();
    if (k === "\t" || k === "\x1b[Z") { if (views.length > 1) { focus = (focus + 1) % views.length; schedule(); } return; }
    if (k === "z") { zoom = !zoom; fullRedraw = true; return schedule(); }
    if (k === "/") return searchAll();
    if (k === "m") { mapMode = !mapMode; if (mapMode) mapWant = selId(); fullRedraw = true; return schedule(); }
    if (k === "a") return sessionDetail(sel());
    if (k === "b") return briefing(false);
    if (k === "h") return history();
    if (k === "l") return linkFrom();
    if (k === "i") return pasteImage();
    if (k === "f") { cfg.feed = !cfg.feed; saveCfg(); fullRedraw = true; return schedule(); }
    if (k === "y") return answerAlert("yes");
    if (k === "x") return answerAlert("no");
    if (k === "c") return newSession(false);
    if (k === "w") return newSession(true);
    if (k === "g") return giveGoal();
    if (k === "d") return showDiff();
    if (k === "v") return runVerify();
    if (k === "o") return openUrl(`http://localhost:${port}/?t=${readToken()}`);
    if (k === "X") return closeSession();
    if (k === String.fromCharCode(PREFIX())) { const v = views[focus]; if (v?.proc && !v.dead) v.proc.write(k); }
  }

  // ---------- input: prefix keys, mouse, everything else to the focused session ----------
  // one keypress at a time for AXA's own screens: escape sequences (arrows, PgUp…) or single characters
  const keysOf = (d) => d.match(/\x1b\[[0-9;?]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu) || [];
  // ---------- copy-on-select: drag across a session's text and it's copied when you let go ----------
  // selection: { pane, a: {x, y}, b: {x, y}, active } in the pane's cells
  let selection = null, lastClick = { at: 0, x: -1, y: -1 }, notice = null, selClear = null;
  const selRange = () => { const { a, b } = selection; return a.y < b.y || (a.y === b.y && a.x <= b.x) ? [a, b] : [b, a]; };
  function selText() {
    const v = views[selection.pane]; if (!v?.term) return "";
    const [a, b] = selRange(), buf = v.term.buffer.active, lines = [];
    for (let y = a.y; y <= b.y; y++) lines.push((buf.getLine(buf.baseY + y)?.translateToString(true, y === a.y ? a.x : 0, y === b.y ? b.x + 1 : undefined) || "").replace(/\s+$/, ""));
    return lines.join("\n");
  }
  // the terminal's own clipboard (OSC 52: Windows Terminal, iTerm2, kitty, WezTerm…), plus the system's
  // copy tool where there is one (clip.exe on WSL, pbcopy, wl-copy, xclip), for terminals that ignore OSC 52
  const clipTool = process.env.AXA_NO_CLIP_TOOL ? null : [["clip.exe", []], ["pbcopy", []], ["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]]
    .find(([c]) => spawnSync("which", [c], { stdio: "ignore" }).status === 0) || null;
  function copyText(t) {
    out.write(`${ESC}]52;c;${Buffer.from(t, "utf8").toString("base64")}\x07`);
    // clip.exe reads the console's code page: give it plain text only (OSC 52 covers the rest)
    if (clipTool && !(clipTool[0] === "clip.exe" && /[^\x00-\x7f]/.test(t))) {
      try { const c = spawn(clipTool[0], clipTool[1], { stdio: ["pipe", "ignore", "ignore"] }); c.on("error", () => {}); c.stdin.end(clipTool[0] === "clip.exe" ? t.replace(/\n/g, "\r\n") : t); } catch {}
    }
    const n = t.split("\n").length;
    notice = { text: `copied ${n > 1 ? `${n} lines` : `${[...t].length} characters`}`, until: Date.now() + 2500 };
    clearTimeout(selClear); selClear = setTimeout(() => { selection = null; schedule(); }, 1200);
    schedule();
  }
  // double-click: the word under the pointer
  function selectWord(pane, x, y) {
    const v = views[pane]; if (!v?.term) return;
    const buf = v.term.buffer.active, line = buf.getLine(buf.baseY + y)?.translateToString(false) || "";
    const isWord = (ch) => ch && /[^\s"'`()[\]{}<>│|,;]/.test(ch);
    if (!isWord(line[x])) return;
    let a = x, b = x;
    while (a > 0 && isWord(line[a - 1])) a--;
    while (b < line.length - 1 && isWord(line[b + 1])) b++;
    selection = { pane, a: { x: a, y }, b: { x: b, y }, active: false };
    copyText(line.slice(a, b + 1));
  }

  // ---------- paste an image from your clipboard into the focused session ----------
  // Ctrl-b i (or Ctrl+V, below) grabs the clipboard image itself, saves it as a PNG in the
  // session's project (.claude/axa-pastes, kept out of git status) and types its path into the session.
  function grabClipboardImage(file) {
    return new Promise((done) => {
      if (process.env.AXA_PASTE_IMAGE_FROM) { try { copyFileSync(process.env.AXA_PASTE_IMAGE_FROM, file); return done(true); } catch { return done(false); } } // for tests
      const has = (c) => spawnSync("which", [c], { stdio: "ignore" }).status === 0;
      let cmd, args, viaStdout = false;
      if (has("powershell.exe") && has("wslpath")) { // WSL: the Windows clipboard
        const win = spawnSync("wslpath", ["-w", file], { encoding: "utf8" }).stdout.trim().replace(/'/g, "''");
        cmd = "powershell.exe"; args = ["-NoProfile", "-STA", "-Command", `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $i = [System.Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${win}', [System.Drawing.Imaging.ImageFormat]::Png); 'ok' }`];
      } else if (process.platform === "darwin") { cmd = "osascript"; args = ["-e", `set f to open for access POSIX file "${file.replace(/"/g, "")}" with write permission`, "-e", "write (the clipboard as «class PNGf») to f", "-e", "close access f"]; }
      else if (has("wl-paste")) { cmd = "wl-paste"; args = ["--type", "image/png"]; viaStdout = true; }
      else if (has("xclip")) { cmd = "xclip"; args = ["-selection", "clipboard", "-t", "image/png", "-o"]; viaStdout = true; }
      else return done(null);
      const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }), chunks = [];
      c.stdout.on("data", (d) => chunks.push(d));
      const timer = setTimeout(() => { try { c.kill(); } catch {} done(false); }, 15000);
      c.on("error", () => { clearTimeout(timer); done(null); });
      c.on("close", (code) => {
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
    const v = views[focus], s = sel();
    if (!v?.proc || v.dead || !s) return flash("Pick a session first", ["The image is pasted into the session you're looking at."]);
    const { top, base, dir, file: target } = grabbed || pasteTarget(s);
    let file = target;
    if (!grabbed) {
      try { mkdirSync(dir, { recursive: true }); } catch (e) { return flash("Couldn't save the image", [e.message]); }
      notice = { text: "reading the clipboard…", until: Date.now() + 15000, hint: " " }; schedule();
      const ok = await grabClipboardImage(file);
      if (!ok) { notice = null; return flash("No image on the clipboard", [ok === null ? "No clipboard tool was found on this machine." : `Copy an image first (on Windows: Win+Shift+S for a screenshot), then press Ctrl+V or ${keyName()} i.`]); }
    }
    // keep pasted images out of the project's git status (local only, nothing committed)
    if (top.status === 0) try {
      const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: base, encoding: "utf8" }).stdout.trim(), ex = join(common, "info", "exclude");
      const cur = existsSync(ex) ? readFileSync(ex, "utf8") : "";
      if (!cur.split("\n").includes("/.claude/axa-pastes/")) writeFileSync(ex, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "/.claude/axa-pastes/\n");
    } catch {}
    v.proc.write(`${file} `); // Claude Code reads image files by path
    notice = { text: "image pasted", until: Date.now() + 3000, hint: ` ${file.replace(homedir(), "~")}` }; schedule();
  }

  // ---------- Ctrl+V: paste an image if the clipboard has one, else its text ----------
  // Needs the terminal to pass Ctrl+V through (Windows Terminal binds it to its own text paste unless
  // unbound; its Ctrl+Shift+V still pastes text the usual way). One clipboard read decides: an image is
  // saved and its path typed in (like Ctrl-b i); text goes in as a bracketed paste. Typing during the
  // read is held back and sent after it, so nothing lands out of order.
  function readClipboard(file) {
    return new Promise((done) => {
      const has = (c) => spawnSync("which", [c], { stdio: "ignore" }).status === 0;
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
      const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }), chunks = [];
      c.stdout.on("data", (d) => chunks.push(d));
      const timer = setTimeout(() => { try { c.kill(); } catch {} done(null); }, 15000);
      c.on("error", () => { clearTimeout(timer); done(null); });
      c.on("close", () => {
        clearTimeout(timer);
        const outp = Buffer.concat(chunks).toString("utf8");
        if (outp.startsWith("IMG")) return done({ image: true });
        if (outp.startsWith("TXT")) return done({ text: outp.slice(3).replace(/\r\n/g, "\n") });
        done(null);
      });
    });
  }
  let pasting = null; // the Ctrl+V in progress; input typed meanwhile waits for it
  const held = [];
  function ctrlV() {
    const v = views[focus], s = sel();
    if (!v?.proc || v.dead || !s) return;
    const t = pasteTarget(s);
    try { mkdirSync(t.dir, { recursive: true }); } catch {}
    notice = { text: "reading the clipboard…", until: Date.now() + 15000, hint: " " }; schedule();
    pasting = readClipboard(t.file).then(async (r) => {
      notice = null;
      if (r?.image) await pasteImage(t);
      else if (r?.text) { if (!v.dead) v.proc.write(`${ESC}[200~${r.text.replace(/\x1b\[20[01]~/g, "")}${ESC}[201~`); }
      else flash("Nothing to paste", ["The clipboard is empty, or no clipboard tool was found."]);
      schedule();
    }).finally(() => {
      pasting = null;
      const rest = held.splice(0).join("");
      if (rest && !v.dead) send(v, rest);
    });
  }
  // Text for the focused session; Ctrl+V (0x16) is handled above instead of being passed on
  function send(v, chunk) {
    if (pasting) return held.push(chunk);
    const k = chunk.indexOf("\x16");
    if (k < 0) return v.proc.write(chunk);
    if (k) v.proc.write(chunk.slice(0, k));
    ctrlV();
    if (chunk.length > k + 1) held.push(chunk.slice(k + 1));
  }

  // ---------- an open window notices when AXA itself was updated ----------
  let updated = false;
  const selfFile = fileURLToPath(import.meta.url), selfMtime = (() => { try { return statSync(selfFile).mtimeMs; } catch { return 0; } })();
  setInterval(() => { try { if (!updated && statSync(selfFile).mtimeMs !== selfMtime) { updated = true; schedule(); } } catch {} }, 15000);

  const decoder = new StringDecoder("utf8");
  const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  function onMouse(b, x, y, up) {
    const L = layout();
    if (overlay) return;
    if (L.side && x > L.sideX && x <= L.sideX + L.side) {
      if (up || b !== 0) return;
      const hit = sideHits[y - 1] || "";
      // a helper-agents row opens the agents panel; any other row opens that session
      if (hit.startsWith("agents:")) return sessionDetail(list.find((x) => x.id === hit.slice(7)));
      const s = hit && list.find((x) => x.id === hit);
      if (s) show(s);
      return;
    }
    // a tab in the tab row
    if (y === 1 && !mapMode) { if (!up && b === 0) { const t = tabHits.find((h) => x >= h.x0 && x <= h.x1); if (t) show(list.find((s) => s.id === t.id)); } return; }
    if (L.alert && y > L.mainH && y <= L.mainH + 2) { if (!up && b === 0 && x > L.mainX + Math.floor(L.mainW * 0.6)) show(L.alert); return; }
    // a drag that started in a pane keeps selecting even if the pointer strays outside it
    const i = selection?.active ? selection.pane : L.panes.findIndex((p) => x > p.x && x <= p.x + p.cols && y > p.y && y <= p.y + p.h);
    if (i < 0 || mapMode) return;
    const v = views[i], p = L.panes[i];
    const left = (b & 3) === 0 && !(b & 64), motion = (b & 32) !== 0;
    if (cfg.copyOnSelect && left && v?.term && !v.dead) {
      const cx = Math.max(0, Math.min(p.cols - 1, x - p.x - 1)), cy = Math.max(0, Math.min(p.rows - 1, y - p.y - 1 - p.hdr));
      if (!up && !motion) { // press
        if (i !== focus) focus = i;
        const dbl = Date.now() - lastClick.at < 400 && lastClick.x === cx && lastClick.y === cy;
        lastClick = { at: Date.now(), x: cx, y: cy };
        if (dbl) return selectWord(i, cx, cy);
        selection = { pane: i, a: { x: cx, y: cy }, b: { x: cx, y: cy }, active: true };
      } else if (motion && selection?.active) selection.b = { x: cx, y: cy };
      else if (up && selection?.active) {
        selection.active = false;
        const same = selection.a.x === selection.b.x && selection.a.y === selection.b.y;
        if (same) selection = null; else { const t = selText(); if (t.trim()) copyText(t); else selection = null; }
      }
      return schedule();
    }
    if (i !== focus && !up && b === 0) { focus = i; schedule(); }
    // inside the session: forward when its program asked for the mouse (tmux does: scroll, click)
    if (v?.term && !v.dead && y >= p.y + 1 + p.hdr && v.term.modes.mouseTrackingMode !== "none") v.proc.write(`\x1b[<${b};${x - p.x};${y - p.y - p.hdr}${up ? "m" : "M"}`);
  }
  process.stdin.on("data", (buf) => {
    let d = decoder.write(buf);
    d = d.replace(MOUSE, (_, b, x, y, m) => { onMouse(Number(b), Number(x), Number(y), m === "m"); return ""; });
    if (!d) return;
    if (overlay) return keysOf(d).forEach((k) => overlay && overlayKey(k));
    const P = String.fromCharCode(PREFIX());
    while (d) {
      if (prefix) {
        prefix = false;
        const k = d.startsWith(ESC + "[") ? (d.match(/^\x1b\[[0-9;]*[A-Za-z~]/) || [d])[0] : [...d][0];
        d = d.slice(k.length);
        action(k); schedule();
        if (overlay) { keysOf(d).forEach((k) => overlay && overlayKey(k)); return; }
        continue;
      }
      const i = d.indexOf(P);
      const chunk = i < 0 ? d : d.slice(0, i);
      const v = views[focus];
      if (chunk && selection && !selection.active) { selection = null; schedule(); } // typing clears a finished selection
      if (chunk && mapMode) keysOf(chunk).forEach(mapKey); // on the map, keys move around it
      else if (chunk && v?.proc && !v.dead) send(v, chunk);
      if (i < 0) break;
      prefix = true; d = d.slice(i + 1); schedule();
    }
  });

  // ---------- start: AXA is always there ----------
  // mouse: clicks and wheel (1000), drags (1002, for copy-on-select), in SGR form (1006)
  const enter = () => { out.write(`${ESC}[?1049h${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h${ESC}[2J`); process.stdin.setRawMode(true); process.stdin.resume(); };
  const leave = () => { out.write(`${ESC}[?1002l${ESC}[?1000l${ESC}[?1006l${ESC}[0m${ESC}[?25h${ESC}[?1049l`); try { process.stdin.setRawMode(false); } catch {} };
  function quit() { quitting = true; cfg.lastSeenAt = Date.now(); saveCfg(); views.forEach(closeView); leave(); console.log("AXA keeps running: `axa` reopens this, `axa console` opens the web console."); process.exit(0); }
  process.on("SIGTERM", quit); process.on("SIGHUP", quit);
  process.on("uncaughtException", (e) => { quitting = true; try { views.forEach(closeView); } catch {} leave(); console.error(e); process.exit(1); });
  out.on("resize", () => { fullRedraw = true; resizeViews(); schedule(); });

  await poll();
  if (err) throw new Error(`The console isn't answering: ${err}`);
  // the commander: reuse the console's, or start one (in this folder when it's inside your home)
  let cmd = list.find((s) => s.mode === "axa" && s.alive), cmdError = null;
  if (!cmd) {
    const rel = relative(homedir(), process.cwd());
    const cwd = rel && !rel.startsWith("..") && !isAbsolute(rel) ? process.cwd() : homedir();
    try { const t = await api("/api/terms", { method: "POST", body: { mode: "axa", cwd } }); await poll(); cmd = list.find((s) => s.id === t.id); }
    catch (e) { cmdError = e.message; }
  }
  enter();
  views.push(null);
  show(list.find((s) => s.status === "waiting" && s.mode !== "axa") || cmd || ordered()[0], 0);
  if (cmdError) flash("Couldn't start the AXA commander", [cmdError, "", "Sessions still work; start it later from the web console (Ctrl-b o)."]);
  setInterval(poll, 1000);
  streamEvents();
  // the map's and the diagram sidebar's flowing links (only while something is working)
  setInterval(() => { if ((mapMode || cfg.sidebarStyle !== "list") && list.some((s) => s.status === "working")) schedule(); }, 250);
  // "since you left" counts from when mission control was last open
  setInterval(() => { cfg.lastSeenAt = Date.now(); saveCfg(); }, 60_000);
  if (!cmdError) setTimeout(() => { if (!overlay) briefing(true); }, 1500);
  setInterval(schedule, 1000); // the clock
}
