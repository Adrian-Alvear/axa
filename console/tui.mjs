// AXA mission control in the terminal: `axa` opens it.
// A sidebar with AXA (the commander) and every session, sorted by what needs you, next to the live,
// fully interactive view of the selected session (rendered here through a headless terminal), with
// one-key answers for prompts, diffs, checks, goals and new sessions. tmux-style: everything you type
// goes to the session; Ctrl-b then a key is an AXA action (Ctrl-b ? lists them).
// Same backend as the web console, so the browser, phone and this window always agree.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";

const require = createRequire(import.meta.url);
const PREFIX = 0x02; // Ctrl-b
const out = process.stdout;
const ESC = "\x1b";

export async function runTui({ port, readToken, openUrl, root }) {
  const pty = require("node-pty");
  const { Terminal: Headless } = require("@xterm/headless");
  const SOCK = `axa-${port}`;
  const env = { ...process.env, TERM: "xterm-256color" };
  for (const k of ["TMUX", "TMUX_PANE"]) delete env[k];

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

  // ---------- look: glyph + word + color (16 basic colors, so your theme applies) ----------
  const color = !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const sgr = (code, s) => (color ? `${ESC}[${code}m${s}${ESC}[0m` : s);
  // shells never report a status: they're just "shell"
  const look = (s) => (s.mode === "shell" && ["starting", "ready"].includes(s.status) ? ["○", "shell", "0"] : LOOK[s.status] || ["?", s.status, "0"]);
  const LOOK = { waiting: ["⚠", "needs you", "1;33"], stuck: ["◷", "stuck", "31"], working: ["●", "working", "36"], done: ["✓", "done", "32"], ready: ["○", "ready", "0"], starting: ["◌", "starting", "2"], exited: ["–", "exited", "2"] };
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

  // ---------- state ----------
  let list = [], selId = null, err = "", prev = null, overlay = null, prefix = false, quitting = false;
  let W = out.columns || 120, H = out.rows || 36;
  const layout = () => {
    W = out.columns || 120; H = out.rows || 36;
    const side = W < 70 ? 0 : Math.max(24, Math.min(34, Math.floor(W * 0.27)));
    const alert = alertFor();
    const alertRows = alert ? 2 : 0;
    return { side, left: side ? side + 1 : 0, top: 1, cols: Math.max(10, W - (side ? side + 1 : 0)), rows: Math.max(4, H - 2 - alertRows), alertRows, alert };
  };
  const byUrgency = (a, b) => URGENCY.indexOf(a.status) - URGENCY.indexOf(b.status) || (b.last_event_at || b.created) - (a.last_event_at || a.created);
  // AXA first, then sessions by urgency; sessions are numbered 1-9 in this order (AXA is 0)
  const sessions = () => list.filter((x) => x.mode !== "axa").sort(byUrgency);
  const ordered = () => [...list.filter((x) => x.mode === "axa"), ...sessions()];
  const sel = () => list.find((s) => s.id === selId);
  // A session other than the one you're looking at that's waiting on a prompt
  function alertFor() { return list.find((s) => s.id !== selId && s.status === "waiting" && s.choices) || null; }

  // ---------- the live view: a tmux client in a PTY, drawn through a headless terminal ----------
  let view = null; // { id, proc, term, cursorOn, cols, rows, dead }
  function closeView() {
    if (!view) return;
    const v = view; view = null;
    try { if (v.proc._pty) spawnSync("tmux", ["-L", SOCK, "detach-client", "-t", v.proc._pty], { stdio: "ignore", env }); } catch {}
    try { v.proc.kill(); } catch {}
    try { v.term.dispose(); } catch {}
  }
  function openView(s) {
    closeView();
    lastRows = [];
    if (!s || !s.alive) return;
    const L = layout();
    if (spawnSync("tmux", ["-L", SOCK, "has-session", "-t", `=axa-${s.id}`], { stdio: "ignore", env }).status !== 0) { view = { id: s.id, dead: "This session isn't in tmux, so it can only be viewed in the web console (Ctrl-b o)." }; return; }
    const term = new Headless({ cols: L.cols, rows: L.rows, scrollback: 0, allowProposedApi: true });
    const proc = pty.spawn("tmux", ["-L", SOCK, "attach-session", "-t", `=axa-${s.id}`], { name: "xterm-256color", cols: L.cols, rows: L.rows, cwd: homedir(), env });
    const v = { id: s.id, proc, term, cursorOn: true, cols: L.cols, rows: L.rows };
    view = v;
    fitWindow(v);
    proc.onData((d) => {
      if (view !== v) return;
      // cursor visibility isn't in the public API: follow the last show/hide in the stream
      const i = Math.max(d.lastIndexOf("\x1b[?25h"), d.lastIndexOf("\x1b[?25l"));
      if (i >= 0) v.cursorOn = d[i + 5] === "h";
      term.write(d, schedule);
    });
    proc.onExit(() => { if (view === v) { v.dead = "Detached or ended. Ctrl-b j/k to pick a session."; schedule(); } });
  }
  const fitWindow = (v) => spawnSync("tmux", ["-L", SOCK, "resize-window", "-t", `=axa-${v.id}:`, "-x", String(v.cols), "-y", String(v.rows)], { stdio: "ignore", env });
  function resizeView() {
    const L = layout();
    if (!view?.term || (view.cols === L.cols && view.rows === L.rows)) return;
    view.cols = L.cols; view.rows = L.rows; lastRows = [];
    try { view.proc.resize(L.cols, L.rows); view.term.resize(L.cols, L.rows); fitWindow(view); } catch {}
  }

  // ---------- drawing ----------
  let lastRows = [], timer = null, lastTitle = "";
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; draw(); }, 16); };
  function cellSgr(c) {
    const a = [];
    if (c.isBold()) a.push(1); if (c.isDim()) a.push(2); if (c.isItalic()) a.push(3); if (c.isUnderline()) a.push(4);
    if (c.isInverse()) a.push(7); if (c.isInvisible()) a.push(8); if (c.isStrikethrough()) a.push(9);
    if (c.isFgRGB()) { const v = c.getFgColor(); a.push(`38;2;${v >> 16};${(v >> 8) & 255};${v & 255}`); }
    else if (c.isFgPalette()) { const p = c.getFgColor(); a.push(p < 8 ? 30 + p : p < 16 ? 82 + p : `38;5;${p}`); }
    if (c.isBgRGB()) { const v = c.getBgColor(); a.push(`48;2;${v >> 16};${(v >> 8) & 255};${v & 255}`); }
    else if (c.isBgPalette()) { const p = c.getBgColor(); a.push(p < 8 ? 40 + p : p < 16 ? 92 + p : `48;5;${p}`); }
    return a.join(";");
  }
  function viewRows(L) {
    const rows = [];
    if (!view || view.dead || !view.term) {
      const msg = view?.dead || (selId ? "Session ended." : "Pick a session (Ctrl-b j/k), or start one: Ctrl-b c");
      for (let y = 0; y < L.rows; y++) rows.push(y === Math.floor(L.rows / 2) ? pad(" ".repeat(Math.max(0, Math.floor((L.cols - msg.length) / 2))) + sgr(2, msg), L.cols) : " ".repeat(L.cols));
      return rows;
    }
    const b = view.term.buffer.active, cell = b.getNullCell();
    for (let y = 0; y < L.rows; y++) {
      const line = b.getLine(b.baseY + y);
      let s = "", cur = "", n = 0;
      for (let x = 0; x < L.cols && line; x++) {
        line.getCell(x, cell);
        const w = cell.getWidth();
        if (w === 0) continue;
        const a = color ? cellSgr(cell) : "";
        if (a !== cur) { s += `${ESC}[0${a ? ";" + a : ""}m`; cur = a; }
        s += cell.getChars() || " "; n += w;
      }
      s += `${ESC}[0m` + " ".repeat(Math.max(0, L.cols - n));
      rows.push(s);
    }
    return rows;
  }
  function sideRows(L) {
    const rows = [], o = ordered();
    const n = (st) => list.filter((s) => s.mode !== "axa" && s.status === st).length;
    rows.push(sgr("1;36", pad(" AXA mission control", L.side)));
    rows.push(sgr(2, "─".repeat(L.side)));
    const nums = new Map(sessions().map((s, i) => [s.id, i < 9 ? String(i + 1) : " "]));
    o.forEach((s) => {
      const [g, word, code] = look(s);
      const isSel = s.id === selId, num = s.mode === "axa" ? "0" : nums.get(s.id);
      const name = s.mode === "axa" ? "AXA commander" : clean(s.name);
      const head = ` ${num} ${g} ${cut(name, L.side - 7)}`;
      const sub = `     ${cut(s.status === "waiting" && s.choices ? question(s.choices) : s.mode === "axa" && ["ready", "starting"].includes(s.status) || (s.mode === "shell" && word === "shell") ? what(s) : `${word} · ${what(s)}`, L.side - 6)}`;
      const meta = s.mode === "axa" ? "" : `     ${cut([gitText(s.git), s.usage?.tokens ? `${fmtTok(s.usage.tokens)} tok${s.usage.over_budget ? "!" : ""}` : ""].filter(Boolean).join(" · "), L.side - 6)}`;
      const mark = (t) => (isSel ? sgr(`7`, pad(t, L.side)) : pad(t, L.side));
      rows.push(isSel ? mark(head) : sgr(code === "0" ? "0" : code, pad(head, L.side)));
      rows.push(isSel ? mark(sub) : sgr(2, pad(sub, L.side)));
      if (meta) rows.push(isSel ? mark(meta) : sgr(2, pad(meta, L.side)));
    });
    if (!list.some((s) => s.mode !== "axa")) rows.push(sgr(2, pad("   no sessions yet: Ctrl-b c", L.side)));
    while (rows.length < H - 3) rows.push(" ".repeat(L.side));
    rows.length = H - 3;
    const needs = n("waiting") + n("stuck");
    rows.push(sgr(2, "─".repeat(L.side)));
    const needText = needs ? `⚠ ${needs} need${needs > 1 ? "" : "s"} you` : "nothing needs you", rest = n("working") ? ` · ${n("working")} working` : "";
    rows.push(" " + sgr(needs ? "1;33" : 2, needText) + sgr(2, pad(rest, Math.max(0, L.side - 1 - width(needText)))));
    return rows;
  }
  function headerRow(L) {
    const s = sel();
    if (!s) return pad(sgr(2, " no session selected"), L.cols);
    const [g, word, code] = look(s);
    const name = s.mode === "axa" ? "AXA commander" : clean(s.name);
    const bits = [gitText(s.git), s.usage?.tokens ? `${fmtTok(s.usage.tokens)} tok${s.usage.budget ? ` of ${fmtTok(s.usage.budget)}` : ""}` : "", s.worktree ? `worktree ${s.worktree.branch}` : ""].filter(Boolean).join(" · ");
    const head = cut(` ${g} ${name}`, L.cols), rest = ` · ${word}${bits ? " · " + bits : ""}`;
    return sgr(code === "0" ? "1" : `1;${code.replace(/^1;/, "")}`, head) + sgr(2, pad(cut(rest, L.cols - width(head)), Math.max(0, L.cols - width(head))));
  }
  function alertRows(L) {
    const a = L.alert;
    const q = question(a.choices), yes = yesOpt(a.choices), no = noOpt(a.choices);
    const l1 = ` ⚠ ${clean(a.name)} needs you: ${q}`;
    const l2 = `   Ctrl-b y  ${yes.label}    Ctrl-b x  ${no.label}    Ctrl-b !  go there`;
    return [sgr("1;33", pad(cut(l1, L.cols), L.cols)), sgr(33, pad(cut(l2, L.cols), L.cols))];
  }
  function statusRow() {
    const tag = prefix ? " PREFIX " : "";
    const keys = prefix ? " y yes · x no · ! go · j/k move · 0-9 pick · c new · w worktree · g goal · d diff · v verify · o web · X close · q quit · ? help" : " Ctrl-b ? help · Ctrl-b j/k sessions · Ctrl-b q leave (sessions keep running)";
    const clock = new Date().toLocaleTimeString([], { hour12: false });
    const room = Math.max(0, W - 10 - tag.length);
    return (tag ? sgr("1;7", tag) : "") + sgr(2, pad(cut(keys, room), room)) + sgr(2, pad(clock, 10));
  }
  function draw() {
    if (quitting) return;
    const L = layout();
    resizeView();
    let o = `${ESC}[?25l`;
    const side = L.side ? sideRows(L) : [];
    for (let y = 0; y < H - 1; y++) if (L.side) o += `${ESC}[${y + 1};1H${side[y] || " ".repeat(L.side)}${sgr(2, "│")}`;
    o += `${ESC}[1;${L.left + 1}H${headerRow(L)}`;
    const main = overlay ? overlayRows(L) : viewRows(L);
    for (let y = 0; y < L.rows; y++) {
      const r = main[y] ?? " ".repeat(L.cols);
      if (overlay || lastRows[y] !== r) { o += `${ESC}[${y + 2};${L.left + 1}H${r}`; if (!overlay) lastRows[y] = r; }
    }
    if (overlay) lastRows = [];
    if (L.alert) alertRows(L).forEach((r, i) => (o += `${ESC}[${L.rows + 2 + i};${L.left + 1}H${r}`));
    o += `${ESC}[${H};1H${statusRow()}`;
    // the session's own cursor, when it shows one
    if (!overlay && view?.term && !view.dead && view.cursorOn) {
      const b = view.term.buffer.active;
      o += `${ESC}[${b.cursorY + 2};${L.left + b.cursorX + 1}H${ESC}[?25h`;
    } else if (overlay?.input !== undefined) o += `${ESC}[${overlay.cursorRow ?? H - 1};${overlay.cursorCol ?? 1}H${ESC}[?25h`;
    // the window title says whether anything needs you
    const title = list.some((s) => s.status === "waiting" || s.status === "stuck") ? "⚠ AXA" : "AXA";
    if (title !== lastTitle) { o += `${ESC}]0;${title}\x07`; lastTitle = title; }
    out.write(o);
  }

  // ---------- overlays: help, diff, verify output, pickers, one-line input ----------
  // { title, lines[], scroll, onKey?(key) , input?: string, prompt?, onSubmit? }
  function overlayRows(L) {
    const ov = overlay, rows = [];
    rows.push(sgr("1;36", pad(` ${ov.title}`, L.cols)));
    const body = L.rows - (ov.input !== undefined ? 3 : 2);
    const lines = ov.lines || [];
    ov.scroll = Math.max(0, Math.min(ov.scroll || 0, Math.max(0, lines.length - body)));
    for (let i = 0; i < body; i++) {
      const raw = lines[ov.scroll + i];
      if (raw === undefined) { rows.push(" ".repeat(L.cols)); continue; }
      const t = typeof raw === "string" ? { text: raw } : raw;
      const text = pad(cut(t.text.replace(/\t/g, "    "), L.cols), L.cols);
      rows.push(t.code ? sgr(t.code, text) : text);
    }
    if (ov.input !== undefined) {
      const p = ` ${ov.prompt || "›"} `;
      rows.push(pad(p + ov.input, L.cols));
      ov.cursorRow = L.rows; ov.cursorCol = L.left + width(p) + width(ov.input) + 1;
    }
    rows.push(sgr(2, pad(` ${ov.hint || (lines.length > body ? "j/k ↑/↓ space scroll · q close" : "q close")}`, L.cols)));
    return rows;
  }
  const closeOverlay = () => { overlay = null; lastRows = []; schedule(); };
  function overlayKey(k) {
    const ov = overlay;
    if (ov.input !== undefined) {
      if (k === "\r") { const v = ov.input.trim(); closeOverlay(); if (v || ov.allowEmpty) ov.onSubmit(v); return; }
      if (k === ESC || k === "\x03") return closeOverlay();
      if (k === "\x7f" || k === "\b") ov.input = [...ov.input].slice(0, -1).join("");
      else if (!k.startsWith(ESC)) ov.input += k.replace(/[\x00-\x1f]/g, "");
      return schedule();
    }
    if (ov.onKey && ov.onKey(k) !== false) return schedule();
    const page = Math.max(1, layout().rows - 3);
    if (k === "q" || k === ESC || k === "\x03") return closeOverlay();
    if (k === "j" || k === "\x1b[B") ov.scroll = (ov.scroll || 0) + 1;
    else if (k === "k" || k === "\x1b[A") ov.scroll = (ov.scroll || 0) - 1;
    else if (k === " " || k === "\x1b[6~") ov.scroll = (ov.scroll || 0) + page;
    else if (k === "b" || k === "\x1b[5~") ov.scroll = (ov.scroll || 0) - page;
    else if (k === "g") ov.scroll = 0;
    else if (k === "G") ov.scroll = 1e9;
    schedule();
  }
  const ask = (prompt, onSubmit, { title = prompt, lines = [], allowEmpty = false } = {}) => { overlay = { title, lines, input: "", prompt: "›", onSubmit, allowEmpty, hint: "Enter submit · Esc cancel" }; schedule(); };
  const flash = (title, lines) => { overlay = { title, lines: [].concat(lines) }; schedule(); };

  const HELP = [
    "Everything you type goes to the selected session. AXA actions: press Ctrl-b, then:",
    "",
    "  j / k  or  ↓ / ↑    next / previous session        0        AXA commander",
    "  1 … 9              pick a session by its number    !        jump to whatever needs you",
    "  y / x              answer the prompt in the yellow bar: its Yes… option / its No… option (the bar shows which)",
    "  c                  new session in a project        w        new session in its own git worktree",
    "  g                  give the selected session a goal (Claude Code /goal)",
    "  d                  its changes (diff against the last commit)",
    "  v                  run the project's checks (verify: typecheck, lint, tests, build)",
    "  o                  open the web console            X        close the selected session",
    "  Ctrl-b             send a literal Ctrl-b           q        leave (sessions keep running)",
    "",
    "Mouse: click a session to select it; scroll and click inside the session go to it.",
    "Hold Shift while dragging to select text with your terminal.",
    "Prompts can also be answered right in the session (arrows/numbers + Enter), in the web console, or on your phone.",
  ];

  // ---------- actions ----------
  function select(s) { if (!s) return; selId = s.id; openView(s); schedule(); }
  function move(d) { const o = ordered(); if (!o.length) return; const i = Math.max(0, o.findIndex((s) => s.id === selId)); select(o[(i + d + o.length) % o.length]); }
  async function answerAlert(which) {
    const a = alertFor() || (sel()?.status === "waiting" && sel()?.choices ? sel() : null);
    if (!a) return flash("Nothing to answer", ["No session is waiting on a prompt right now."]);
    const o = which === "yes" ? yesOpt(a.choices) : noOpt(a.choices);
    try { await api(`/api/terms/${a.id}/answer`, { method: "POST", body: { n: o.n, label: o.label }, headers: { "x-axa-client": "tui" } }); await poll(); }
    catch (e) { flash("Couldn't answer", [e.message]); }
  }
  async function showDiff() {
    const s = sel(); if (!s) return;
    try {
      const d = await api(`/api/terms/${s.id}/diff`);
      const lines = (d.diff || "").split("\n").map((l) => ({ text: l, code: l.startsWith("diff --git") ? "1" : l.startsWith("@@") ? "36" : l.startsWith("+++") || l.startsWith("---") ? "2" : l.startsWith("+") ? "32" : l.startsWith("-") ? "31" : "" }));
      if (d.untracked_total) lines.push({ text: "" }, { text: `New files (${d.untracked_total})`, code: "1" }, ...d.untracked.map((f) => ({ text: `+ ${f}`, code: "32" })));
      overlay = { title: `${clean(s.name)} · changes · ${gitText(d.git) || ""}`, lines: d.error ? [d.error] : lines.length ? lines : ["No uncommitted changes."] };
      schedule();
    } catch (e) { flash("Couldn't read the changes", [e.message]); }
  }
  function runVerify() {
    const s = sel(); if (!s) return;
    const ov = { title: `${clean(s.name)} · verify (running…)`, lines: [] };
    overlay = ov; schedule();
    const child = spawn(process.execPath, [join(root, "skills", "verify", "verify.mjs"), s.cwd], { cwd: s.cwd, env: { ...process.env, CI: "1" } });
    const dec = new StringDecoder("utf8");
    let part = "";
    const add = (c) => { const t = part + dec.write(c); const ls = t.split("\n"); part = ls.pop(); for (const l of ls) ov.lines.push({ text: l, code: /\| FAIL \|/.test(l) ? "31" : /\| PASS \|/.test(l) ? "32" : /failed \(/.test(l) ? "1;31" : "" }); ov.scroll = 1e9; schedule(); };
    child.stdout.on("data", add); child.stderr.on("data", add);
    child.on("close", (code) => { if (part) ov.lines.push({ text: part }); ov.title = `${clean(s.name)} · verify · ${code === 0 ? "all checks pass" : "checks failed"}`; schedule(); });
    ov.onKey = (k) => { if (k === "q" || k === ESC) { try { child.kill(); } catch {} return false; } return false; };
  }
  async function newSession(worktree) {
    let projects = [];
    try { projects = await api("/api/projects"); } catch (e) { return flash("Couldn't list projects", [e.message]); }
    const ov = { title: worktree ? "New session in its own worktree: pick the project" : "New session: pick a project", sel: 0, lines: [], hint: "j/k move · Enter Claude session · s shell · Esc cancel" };
    const render = () => { ov.lines = projects.map((p, i) => ({ text: `${i === ov.sel ? "›" : " "} ${p.name.padEnd(22)} ${p.path.replace(homedir(), "~")}`, code: i === ov.sel ? "7" : "" })); };
    ov.onKey = (k) => {
      if (k === "j" || k === "\x1b[B") ov.sel = Math.min(projects.length - 1, ov.sel + 1);
      else if (k === "k" || k === "\x1b[A") ov.sel = Math.max(0, ov.sel - 1);
      else if (k === "\r" || k === "s") {
        const p = projects[ov.sel], mode = k === "s" ? "shell" : "claude";
        const go = async (wt) => { try { const t = await api("/api/terms", { method: "POST", body: { cwd: p.path, mode, worktree: wt || undefined } }); await poll(); select(list.find((x) => x.id === t.id)); } catch (e) { flash("Couldn't start it", [e.message]); } };
        closeOverlay();
        if (worktree) ask("Worktree name (e.g. fix-login)", (name) => go(name || true), { allowEmpty: true }); else go();
        return true;
      } else if (k === "q" || k === ESC) { closeOverlay(); return true; }
      else return true;
      render(); return true;
    };
    render(); overlay = ov; schedule();
  }
  function giveGoal() {
    const s = sel(); if (!s || s.mode === "shell") return flash("Pick a Claude session", ["Goals go to Claude sessions (not shells)."]);
    ask(`Goal for ${clean(s.name)}: what does done look like?`, async (goal) => {
      try { await api(`/api/terms/${s.id}/input`, { method: "POST", body: { text: `/goal ${goal.replace(/\s*\n\s*/g, " ")}` } }); }
      catch (e) { flash("Couldn't send the goal", [e.message]); }
    });
  }
  function closeSel() {
    const s = sel(); if (!s) return;
    ask(`Close ${clean(s.name)}? This ends what's running in it. Type yes to confirm`, async (v) => {
      if (v.toLowerCase() !== "yes") return;
      try { closeView(); await api(`/api/terms/${s.id}`, { method: "DELETE" }); selId = null; await poll(); move(0); } catch (e) { flash("Couldn't close it", [e.message]); }
    });
  }

  function action(k) {
    const o = ordered();
    if (k === "?") return (overlay = { title: "AXA · keys", lines: HELP }), schedule();
    if (k === "q") return quit();
    if (k === "j" || k === "\x1b[B" || k === "n") return move(1);
    if (k === "k" || k === "\x1b[A" || k === "p") return move(-1);
    if (/^[0-9]$/.test(k)) return select(k === "0" ? o.find((s) => s.mode === "axa") : o.filter((s) => s.mode !== "axa")[Number(k) - 1]);
    if (k === "!") { const t = o.find((s) => s.status === "waiting") || o.find((s) => s.status === "stuck"); return t ? select(t) : flash("All clear", ["Nothing needs you right now."]); }
    if (k === "y") return answerAlert("yes");
    if (k === "x") return answerAlert("no");
    if (k === "c") return newSession(false);
    if (k === "w") return newSession(true);
    if (k === "g") return giveGoal();
    if (k === "d") return showDiff();
    if (k === "v") return runVerify();
    if (k === "o") return openUrl(`http://localhost:${port}/?t=${readToken()}`);
    if (k === "X") return closeSel();
    if (k === String.fromCharCode(PREFIX)) return view?.proc && !view.dead && view.proc.write(k);
  }

  // ---------- input: prefix keys, mouse, everything else to the session ----------
  const decoder = new StringDecoder("utf8");
  const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  function onMouse(b, x, y, up) {
    const L = layout();
    if (L.side && x <= L.side) {
      if (up || b !== 0) return;
      // which session row was clicked (rows: title, rule, then 2-3 rows per entry)
      let row = 3;
      for (const s of ordered()) { const h = s.mode === "axa" ? 2 : 3; if (y >= row && y < row + h) return select(s); row += h; }
      return;
    }
    if (L.alert && y > L.rows + 1 && y <= L.rows + 3 && !up && b === 0) { // click in the yellow bar: the "go there" part
      if (x > L.left + Math.floor(L.cols * 0.6)) return select(L.alert);
      return;
    }
    // inside the session: forward when its program asked for the mouse (tmux does: scroll, click)
    if (view?.term && !view.dead && y >= 2 && y < 2 + L.rows && view.term.modes.mouseTrackingMode !== "none") {
      view.proc.write(`\x1b[<${b};${x - L.left};${y - 1}${up ? "m" : "M"}`);
    }
  }
  process.stdin.on("data", (buf) => {
    let d = decoder.write(buf);
    d = d.replace(MOUSE, (_, b, x, y, m) => { onMouse(Number(b), Number(x), Number(y), m === "m"); return ""; });
    if (!d) return;
    if (overlay) return overlayKey(d);
    while (d) {
      if (prefix) {
        prefix = false;
        const k = d.startsWith(ESC + "[") ? (d.match(/^\x1b\[[0-9;]*[A-Za-z~]/) || [d])[0] : [...d][0];
        d = d.slice(k.length);
        action(k); schedule();
        continue;
      }
      const i = d.indexOf(String.fromCharCode(PREFIX));
      const chunk = i < 0 ? d : d.slice(0, i);
      if (chunk && view?.proc && !view.dead) view.proc.write(chunk);
      if (i < 0) break;
      prefix = true; d = d.slice(i + 1); schedule();
    }
  });

  // ---------- data ----------
  async function poll() {
    try { list = await api("/api/terms"); err = ""; }
    catch (e) { err = e.message; }
    // bell when something starts needing you
    const now = new Map(list.map((s) => [s.id, s.status]));
    if (prev && list.some((s) => ["waiting", "stuck"].includes(s.status) && prev.get(s.id) !== s.status)) out.write("\x07");
    prev = now;
    if (selId && !list.some((s) => s.id === selId)) { selId = null; closeView(); }
    if (view && !view.dead && sel() && !sel().alive) view.dead = "Session ended.";
    schedule();
  }

  // ---------- start: AXA is always there ----------
  const enter = () => { out.write(`${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h${ESC}[2J`); process.stdin.setRawMode(true); process.stdin.resume(); };
  const leave = () => { out.write(`${ESC}[?1000l${ESC}[?1006l${ESC}[0m${ESC}[?25h${ESC}[?1049l`); try { process.stdin.setRawMode(false); } catch {} };
  function quit() { quitting = true; closeView(); leave(); console.log("AXA keeps running: `axa` reopens this, `axa console` opens the web console."); process.exit(0); }
  process.on("SIGTERM", quit); process.on("SIGHUP", quit);
  process.on("uncaughtException", (e) => { quitting = true; try { closeView(); } catch {} leave(); console.error(e); process.exit(1); });
  out.on("resize", () => { lastRows = []; resizeView(); schedule(); });

  await poll();
  if (err) throw new Error(`The console isn't answering: ${err}`);
  // the commander: reuse the console's, or start one (in this folder when it's inside your home)
  let cmd = list.find((s) => s.mode === "axa" && s.alive);
  if (!cmd) {
    const rel = relative(homedir(), process.cwd());
    const cwd = rel && !rel.startsWith("..") && !isAbsolute(rel) ? process.cwd() : homedir();
    try { const t = await api("/api/terms", { method: "POST", body: { mode: "axa", cwd } }); await poll(); cmd = list.find((s) => s.id === t.id); } catch {}
  }
  enter();
  select(list.find((s) => s.status === "waiting" && s.mode !== "axa") || cmd || ordered()[0]);
  setInterval(poll, 1000);
  setInterval(schedule, 1000); // the clock
}
