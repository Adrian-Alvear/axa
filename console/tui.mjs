// AXA mission control in the terminal: `axa` opens it.
// A sidebar with AXA (the commander) and every session, sorted by what needs you, next to the live,
// fully interactive view of one session (or two side by side), rendered here through a headless
// terminal. tmux-style: everything you type goes to the session in focus; the prefix key (Ctrl-b by
// default) then a key is an AXA action: Ctrl-b : opens a palette of every action, Ctrl-b ? lists keys.
// Settings (theme, prefix, sidebar, bell) live in $AXA_HOME/ui.json and Ctrl-b , edits them live.
// Same backend as the web console, so the browser, phone and this window always agree.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";

const require = createRequire(import.meta.url);
const out = process.stdout;
const ESC = "\x1b";

// ---------- themes: roles -> SGR codes ----------
// "terminal" uses the 16 basic colors, so your terminal's own theme applies (the default)
const THEMES = {
  terminal: { title: "1;36", accent: "36", wait: "1;33", waitSoft: "33", stuck: "31", work: "36", done: "32", idle: "0", off: "2", dim: "2", sel: "7", rule: "2", tag: "1;7", add: "32", del: "31", hunk: "36" },
  hud: { title: "1;38;2;79;216;255", accent: "38;2;79;216;255", wait: "1;38;2;255;181;71", waitSoft: "38;2;255;181;71", stuck: "38;2;255;138;92", work: "38;2;79;216;255", done: "38;2;94;242;194", idle: "38;2;143;179;196", off: "38;2;108;138;153", dim: "38;2;108;138;153", sel: "48;2;14;48;66;38;2;233;251;255", rule: "38;2;34;78;98", tag: "1;48;2;79;216;255;38;2;3;16;24", add: "38;2;94;242;194", del: "38;2;255;84;104", hunk: "38;2;79;216;255" },
  light: { title: "1;38;5;25", accent: "38;5;25", wait: "1;38;5;130", waitSoft: "38;5;130", stuck: "38;5;160", work: "38;5;25", done: "38;5;28", idle: "0", off: "38;5;245", dim: "38;5;242", sel: "48;5;153;38;5;16", rule: "38;5;250", tag: "1;7", add: "38;5;28", del: "38;5;160", hunk: "38;5;25" },
  contrast: { title: "1;97", accent: "1;96", wait: "1;93", waitSoft: "93", stuck: "1;91", work: "1;96", done: "1;92", idle: "97", off: "37", dim: "37", sel: "1;7", rule: "97", tag: "1;7", add: "1;92", del: "1;91", hunk: "1;96" },
  mono: { title: "1", accent: "1", wait: "1;4", waitSoft: "1", stuck: "1", work: "0", done: "0", idle: "0", off: "2", dim: "2", sel: "7", rule: "2", tag: "7", add: "1", del: "2", hunk: "1" },
};
const PREFIXES = { "C-b": 0x02, "C-a": 0x01, "C-g": 0x07, "C-\\": 0x1c };
const DEFAULTS = { theme: "terminal", prefix: "C-b", sidebar: "left", sidebarWidth: 30, bell: true, newSession: "claude" };

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
  const nameOf = (s) => (s.mode === "axa" ? "AXA commander" : clean(s.name));

  // ---------- state ----------
  let list = [], err = "", prev = null, overlay = null, prefix = false, quitting = false, zoom = false;
  let W = out.columns || 120, H = out.rows || 36;
  const views = []; // live panes: { id, proc, term, cursorOn, cols, rows, dead, lastRows }
  let focus = 0; // which pane gets your typing
  const byUrgency = (a, b) => URGENCY.indexOf(a.status) - URGENCY.indexOf(b.status) || (b.last_event_at || b.created) - (a.last_event_at || a.created);
  // AXA first, then sessions by urgency; sessions are numbered 1-9 in this order (AXA is 0)
  const sessions = () => list.filter((x) => x.mode !== "axa").sort(byUrgency);
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
    const mainH = H - 1 - alertRows; // rows above the alert bar and status line
    const panes = [];
    if (views.length < 2) panes.push({ x: mainX, y: 0, w: mainW, h: mainH });
    else if (mainW >= 100) { const a = Math.floor((mainW - 1) / 2); panes.push({ x: mainX, y: 0, w: a, h: mainH }, { x: mainX + a + 1, y: 0, w: mainW - a - 1, h: mainH }); }
    else { const a = Math.floor(mainH / 2); panes.push({ x: mainX, y: 0, w: mainW, h: a }, { x: mainX, y: a, w: mainW, h: mainH - a }); }
    // each pane: a header row, then the session's rows
    for (const p of panes) { p.cols = Math.max(10, p.w); p.rows = Math.max(3, p.h - 1); }
    return { side, sideX, mainX, mainW, mainH, panes, alert, alertRows };
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
  function viewRows(v, p) {
    const rows = [];
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
        const a = cellSgr(cell);
        if (a !== cur) { s += `${ESC}[0${a ? ";" + a : ""}m`; cur = a; }
        // a wide character that doesn't fit in the last column would spill over the pane's border
        if (x + w > p.cols) { s += " "; n += 1; break; }
        s += cell.getChars() || " "; n += w;
      }
      rows.push(s + `${ESC}[0m` + " ".repeat(Math.max(0, p.cols - n)));
    }
    return rows;
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
  function sideRows(L) {
    const rows = [], o = ordered(), w = L.side;
    const n = (st) => list.filter((s) => s.mode !== "axa" && s.status === st).length;
    rows.push(sgr("title", pad(" AXA mission control", w)));
    rows.push(sgr("rule", "─".repeat(w)));
    const nums = new Map(sessions().map((s, i) => [s.id, i < 9 ? String(i + 1) : " "]));
    for (const s of o) {
      const [g, word, role] = look(s);
      const isSel = s.id === selId(), shown = onScreen(s.id), num = s.mode === "axa" ? "0" : nums.get(s.id);
      const head = `${shown && !isSel ? "▸" : " "}${num} ${g} ${cut(nameOf(s), w - 7)}`;
      const sub = `     ${cut(s.status === "waiting" && s.choices ? question(s.choices) : (s.mode === "axa" && ["ready", "starting"].includes(s.status)) || (s.mode === "shell" && word === "shell") ? what(s) : `${word} · ${what(s)}`, w - 6)}`;
      const meta = s.mode === "axa" ? null : `     ${cut([gitText(s.git), s.usage?.tokens ? `${fmtTok(s.usage.tokens)} tok${s.usage.over_budget ? "!" : ""}` : ""].filter(Boolean).join(" · "), w - 6)}`;
      for (const [t, r] of [[head, role], [sub, "dim"], ...(meta !== null ? [[meta, "dim"]] : [])]) rows.push(isSel ? sgr("sel", pad(t, w)) : sgr(r, pad(t, w)));
    }
    if (!list.some((s) => s.mode !== "axa")) rows.push(sgr("dim", pad("   no sessions yet: Ctrl-b c", w)));
    while (rows.length < H - 3) rows.push(" ".repeat(w));
    rows.length = H - 3;
    const needs = n("waiting") + n("stuck");
    rows.push(sgr("rule", "─".repeat(w)));
    const needText = needs ? `⚠ ${needs} need${needs > 1 ? "" : "s"} you` : "nothing needs you", rest = n("working") ? ` · ${n("working")} working` : "";
    rows.push(" " + sgr(needs ? "wait" : "dim", needText) + sgr("dim", pad(rest, Math.max(0, w - 1 - width(needText)))));
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
    const tag = prefix ? " PREFIX " : "";
    const keys = prefix
      ? " : palette · s browse · j/k move · 0-9 pick · % split · Tab pane · z zoom · y/x answer · ! go · c new · w worktree · g goal · d diff · v verify · , settings · q quit · ? help"
      : ` ${k} : palette · ${k} s browse · ${k} ? help · ${k} q leave (sessions keep running)`;
    const clock = new Date().toLocaleTimeString([], { hour12: false });
    const room = Math.max(0, W - 10 - tag.length);
    return (tag ? sgr("tag", tag) : "") + sgr("dim", pad(keys, room)) + sgr("dim", pad(clock, 10));
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
    if (overlay) {
      // overlays take the whole main area
      const p = { x: L.mainX, y: 0, cols: L.mainW, rows: L.mainH - 1 };
      const rows = overlayRows(p);
      for (let y = 0; y < L.mainH; y++) o += `${ESC}[${y + 1};${L.mainX + 1}H${rows[y] ?? " ".repeat(L.mainW)}`;
      views.forEach((v) => v && (v.lastRows = []));
    } else {
      L.panes.forEach((p, i) => {
        const v = views[i];
        o += `${ESC}[${p.y + 1};${p.x + 1}H${paneHeader(v, p, i === focus)}`;
        const rows = viewRows(v, p);
        for (let y = 0; y < p.rows; y++) {
          if (v && v.lastRows[y] === rows[y]) continue;
          o += `${ESC}[${p.y + y + 2};${p.x + 1}H${rows[y]}`;
          if (v) v.lastRows[y] = rows[y];
        }
      });
      // the line between two panes
      if (L.panes.length === 2) {
        const [a, b] = L.panes;
        if (b.x > a.x) for (let y = 0; y < L.mainH; y++) o += `${ESC}[${y + 1};${b.x}H${sgr("rule", "│")}`;
      }
    }
    if (L.alert) alertRows(L).forEach((r, i) => (o += `${ESC}[${L.mainH + 1 + i};${L.mainX + 1}H${r}`));
    o += `${ESC}[${H};1H${statusRow()}`;
    // the focused session's own cursor, when it shows one
    const v = views[focus], p = L.panes[focus];
    if (!overlay && v?.term && !v.dead && v.cursorOn && p) {
      const b = v.term.buffer.active;
      o += `${ESC}[${p.y + b.cursorY + 2};${p.x + b.cursorX + 1}H${ESC}[?25h`;
    } else if (overlay?.cursor) o += `${ESC}[${overlay.cursor[0]};${overlay.cursor[1]}H${ESC}[?25h`;
    // the window title says whether anything needs you
    const title = list.some((s) => s.status === "waiting" || s.status === "stuck") ? "⚠ AXA" : "AXA";
    if (title !== lastTitle) { o += `${ESC}]0;${title}\x07`; lastTitle = title; }
    out.write(o);
  }

  // ---------- overlays ----------
  // { title, lines: [string | {text, role}], scroll, hint, onKey(k) -> handled?, input?, prompt?, onSubmit?, render?(p) }
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
      ov.cursor = [rows.length, p.x + width(pr) + width(ov.input) + 1];
    } else ov.cursor = null;
    rows.push(sgr("dim", pad(` ${ov.hint || (lines.length > body ? "j/k ↑/↓ space scroll · q close" : "q close")}`, p.cols)));
    return rows;
  }
  const closeOverlay = () => { overlay?.onClose?.(); overlay = null; schedule(); };
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
    "  %          split: a second session side by side (again to close it)    Tab  switch pane",
    "  z          zoom: hide the sidebar",
    "  y / x      answer the prompt in the yellow bar: its Yes… / No… option (the bar names them)",
    "  !          jump to whatever needs you",
    "  c          new session in a project     w  new session in its own git worktree",
    "  g          give the session a goal      d  its changes (diff)     v  run the project's checks",
    "  o          open the web console         X  close the session",
    `  ${keyName()}     send a literal ${keyName()}            q  leave (sessions keep running)`,
    "",
    "Mouse: click a session or a pane to focus it; scrolling inside a session goes to it.",
    "Hold Shift while dragging to select text with your terminal.",
    `Settings live in ${cfgPath}.`,
  ];

  // ---------- actions ----------
  function move(d) { const o = ordered(); if (!o.length) return; const i = Math.max(0, o.findIndex((s) => s.id === selId())); show(o[(i + d + o.length) % o.length]); }
  async function poll() {
    try { list = await api("/api/terms"); err = ""; } catch (e) { err = e.message; }
    const now = new Map(list.map((s) => [s.id, s.status]));
    if (cfg.bell && prev && list.some((s) => ["waiting", "stuck"].includes(s.status) && prev.get(s.id) !== s.status)) out.write("\x07");
    prev = now;
    views.forEach((v) => { const s = v && list.find((x) => x.id === v.id); if (v && !v.dead && (!s || !s.alive)) v.dead = "Session ended."; });
    schedule();
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
    const ov = { title: "Sessions · ↑/↓ preview · Enter show here · % show in a split · d diff · g goal · Esc close", sel: Math.max(0, o.findIndex((s) => s.id === selId())), lines: [], hint: "the preview is read-only and live" };
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
      if (k === "\r") { const a = hits[ov.sel]; overlay = null; if (a) a.run(); schedule(); return true; }
      return false;
    };
    render(); overlay = ov; schedule();
  }

  // ---------- settings (saved to ui.json, applied live) ----------
  function settings() {
    const items = [
      { key: "theme", label: "Theme", values: Object.keys(THEMES), about: "terminal = your terminal's own colors" },
      { key: "prefix", label: "Prefix key", values: Object.keys(PREFIXES), about: "the key before every AXA action" },
      { key: "sidebar", label: "Sidebar side", values: ["left", "right"] },
      { key: "sidebarWidth", label: "Sidebar width", values: [24, 26, 28, 30, 34, 38, 42, 48] },
      { key: "bell", label: "Bell when something needs you", values: [true, false] },
      { key: "newSession", label: "New sessions start as", values: ["claude", "shell"] },
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
    if (k === "j" || k === "\x1b[B" || k === "n") return move(1);
    if (k === "k" || k === "\x1b[A" || k === "p") return move(-1);
    if (/^[0-9]$/.test(k)) return show(k === "0" ? o.find((s) => s.mode === "axa") : sessions()[Number(k) - 1]);
    if (k === "!") { const t = o.find((s) => s.status === "waiting") || o.find((s) => s.status === "stuck"); return t ? show(t) : flash("All clear", ["Nothing needs you right now."]); }
    if (k === "%") return toggleSplit();
    if (k === "\t" || k === "\x1b[Z") { if (views.length > 1) { focus = (focus + 1) % views.length; schedule(); } return; }
    if (k === "z") { zoom = !zoom; fullRedraw = true; return schedule(); }
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
  const decoder = new StringDecoder("utf8");
  const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  function onMouse(b, x, y, up) {
    const L = layout();
    if (overlay) return;
    if (L.side && x > L.sideX && x <= L.sideX + L.side) {
      if (up || b !== 0) return;
      let row = 3; // title, rule, then 2-3 rows per entry
      for (const s of ordered()) { const h = s.mode === "axa" ? 2 : 3; if (y >= row && y < row + h) return show(s); row += h; }
      return;
    }
    if (L.alert && y > L.mainH && y <= L.mainH + 2) { if (!up && b === 0 && x > L.mainX + Math.floor(L.mainW * 0.6)) show(L.alert); return; }
    const i = L.panes.findIndex((p) => x > p.x && x <= p.x + p.cols && y > p.y && y <= p.y + p.h);
    if (i < 0) return;
    if (i !== focus && !up && b === 0) { focus = i; schedule(); }
    const v = views[i], p = L.panes[i];
    // inside the session: forward when its program asked for the mouse (tmux does: scroll, click)
    if (v?.term && !v.dead && y >= p.y + 2 && v.term.modes.mouseTrackingMode !== "none") v.proc.write(`\x1b[<${b};${x - p.x};${y - p.y - 1}${up ? "m" : "M"}`);
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
      if (chunk && v?.proc && !v.dead) v.proc.write(chunk);
      if (i < 0) break;
      prefix = true; d = d.slice(i + 1); schedule();
    }
  });

  // ---------- start: AXA is always there ----------
  const enter = () => { out.write(`${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h${ESC}[2J`); process.stdin.setRawMode(true); process.stdin.resume(); };
  const leave = () => { out.write(`${ESC}[?1000l${ESC}[?1006l${ESC}[0m${ESC}[?25h${ESC}[?1049l`); try { process.stdin.setRawMode(false); } catch {} };
  function quit() { quitting = true; views.forEach(closeView); leave(); console.log("AXA keeps running: `axa` reopens this, `axa console` opens the web console."); process.exit(0); }
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
  setInterval(schedule, 1000); // the clock
}
