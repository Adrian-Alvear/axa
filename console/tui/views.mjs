// The screen: where everything goes (layout), the live session panes (a tmux client in a PTY, drawn
// through a headless terminal), the tab row, the pane headers, the alert bar, the status line, and the
// frame itself (only rows that changed are rewritten). Also copy-on-select inside a pane.
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { ESC, look, cut, pad, width, question, yesOpt, noOpt, fmtTok, gitText } from "./theme.mjs";
import { wakeLimitText } from "./events.mjs";

export function views(c) {
  const { cfg, out, env, SOCK, seen } = c, V = c.views;
  const selId = () => V[c.focus]?.id || null;
  const sel = () => c.list.find((s) => s.id === selId());
  const onScreen = (id) => V.some((v) => v?.id === id);
  // A session not on screen that's waiting on a prompt
  const alertFor = () => c.list.find((s) => !onScreen(s.id) && s.status === "waiting" && s.choices) || null;

  // Where everything goes. Panes: one, or two side by side (stacked when the window is narrow).
  function layout() {
    c.W = out.columns || 120; c.H = out.rows || 36;
    const W = c.W;
    const side = c.zoom || W < 70 ? 0 : Math.max(22, Math.min(48, cfg.sidebarWidth, Math.floor(W * 0.4)));
    const sideX = cfg.sidebar === "right" ? W - side : 0; // 0-based column of the sidebar
    const mainX = side && cfg.sidebar !== "right" ? side + 1 : 0, mainW = W - (side ? side + 1 : 0);
    const alert = alertFor(), alertRows = alert ? 2 : 0;
    const feedRows = 0; // the activity strip is gone: the briefing (b) and history (h) cover it
    const mainH = c.H - 1 - alertRows - feedRows; // rows above the alert bar, the activity strip and the status line
    // the tab row (sessions of the focused workspace) sits above the panes
    const tabRow = c.mapMode ? 0 : 1, ph = mainH - tabRow;
    const panes = [];
    if (V.length < 2) panes.push({ x: mainX, y: tabRow, w: mainW, h: ph });
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
    const term = new c.Headless({ cols: pane.cols, rows: pane.rows, scrollback: 0, allowProposedApi: true });
    const proc = c.pty.spawn("tmux", ["-L", SOCK, "attach-session", "-t", `=axa-${s.id}`], { name: "xterm-256color", cols: pane.cols, rows: pane.rows, cwd: homedir(), env });
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
  function show(s, slot = c.focus) {
    if (!s) return;
    const at = V.findIndex((v) => v?.id === s.id);
    if (at >= 0) { c.focus = at; return schedule(); }
    closeView(V[slot]);
    V[slot] = null;
    const L = layout();
    V[slot] = makeView(s, L.panes[slot] || L.panes[0]);
    c.focus = slot;
    schedule();
  }
  function resizeViews() {
    const L = layout();
    V.forEach((v, i) => {
      const p = L.panes[i];
      if (!v?.term || !p || (v.cols === p.cols && v.rows === p.rows)) return;
      v.cols = p.cols; v.rows = p.rows; v.lastRows = [];
      try { v.proc.resize(p.cols, p.rows); v.term.resize(p.cols, p.rows); fitWindow(v); } catch {}
    });
  }
  function move(d) { const o = c.ordered(); if (!o.length) return; const i = Math.max(0, o.findIndex((s) => s.id === selId())); show(o[(i + d + o.length) % o.length]); }
  function toggleSplit() {
    if (V.length > 1) { closeView(V[1]); V.length = 1; c.focus = 0; c.fullRedraw = true; return schedule(); }
    const next = c.ordered().find((s) => !onScreen(s.id) && s.alive);
    if (!next) return c.flash("Nothing to split with", ["Open another session first (Ctrl-b c)."]);
    V.push(null);
    c.fullRedraw = true;
    resizeViews(); // the first pane narrows to make room
    show(next, 1);
  }

  // ---------- drawing ----------
  const schedule = () => { if (!c.timer) c.timer = setTimeout(() => { c.timer = null; draw(); }, 16); };
  function cellSgr(cell) {
    const a = [];
    if (cell.isBold()) a.push(1); if (cell.isDim()) a.push(2); if (cell.isItalic()) a.push(3); if (cell.isUnderline()) a.push(4);
    if (cell.isInverse()) a.push(7); if (cell.isInvisible()) a.push(8); if (cell.isStrikethrough()) a.push(9);
    if (c.noColor) return a.join(";");
    if (cell.isFgRGB()) { const v = cell.getFgColor(); a.push(`38;2;${v >> 16};${(v >> 8) & 255};${v & 255}`); }
    else if (cell.isFgPalette()) { const p = cell.getFgColor(); a.push(p < 8 ? 30 + p : p < 16 ? 82 + p : `38;5;${p}`); }
    if (cell.isBgRGB()) { const v = cell.getBgColor(); a.push(`48;2;${v >> 16};${(v >> 8) & 255};${v & 255}`); }
    else if (cell.isBgPalette()) { const p = cell.getBgColor(); a.push(p < 8 ? 40 + p : p < 16 ? 92 + p : `48;5;${p}`); }
    return a.join(";");
  }
  function viewRows(v, p, pane) {
    const { sgr } = c, rows = [];
    // the text being selected (copy-on-select) shows inverted
    const [sa, sb] = c.selection && c.selection.pane === pane ? selRange() : [null, null];
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
  function tabStrip(L) {
    const { sgr, shortName, unseenDone } = c;
    // a project with several sessions shows them as tabs; one session (or AXA) is just its name
    const cur = sel(), ws = cur && cur.mode !== "axa" ? c.workspaceOf(cur.id) : null, tabs = ws && ws.sessions.length > 1 ? ws.sessions : [];
    const label = ws ? ` ▣ ${ws.name}${tabs.length || shortName(cur) === ws.name ? "" : ` · ${shortName(cur)}`} ` : cur ? " ◆ AXA commander " : " ◆ AXA ";
    let o = sgr("title", label), n = width(label);
    c.tabHits = [];
    for (const s of tabs) {
      const [g, , role] = look(s), t = ` ${g} ${shortName(s)}${unseenDone(s) ? " •" : ""} `;
      if (n + width(t) + 1 > L.mainW) break;
      const x0 = L.mainX + n + 2;
      o += sgr("rule", "│") + (s.id === selId() ? sgr("sel", t) : sgr(role, t));
      n += width(t) + 1;
      c.tabHits.push({ x0, x1: x0 + width(t) - 1, id: s.id });
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
    const { sgr } = c;
    const s = c.list.find((x) => x.id === v?.id);
    if (!s) return sgr("dim", pad(" (empty pane)", p.cols));
    const [g, word, role] = look(s);
    const bits = [gitText(s.git), s.usage?.tokens ? `${fmtTok(s.usage.tokens)} tok${s.usage.budget ? ` of ${fmtTok(s.usage.budget)}` : ""}` : "", s.worktree ? `worktree ${s.worktree.branch}` : ""].filter(Boolean).join(" · ");
    const mark = V.length > 1 ? (isFocus ? "▶" : " ") : "";
    const head = cut(`${mark} ${g} ${c.nameOf(s)}`, p.cols), rest = ` · ${word}${bits ? " · " + bits : ""}`;
    const room = Math.max(0, p.cols - width(head));
    return sgr(isFocus || V.length < 2 ? role : "dim", head) + sgr("dim", pad(cut(rest, room), room));
  }
  function alertRows(L) {
    const { sgr } = c;
    const a = L.alert, q = question(a.choices), yes = yesOpt(a.choices), no = noOpt(a.choices), k = c.keyName();
    return [
      sgr("wait", pad(` ⚠ ${c.nameOf(a)} needs you: ${q}`, L.mainW)),
      sgr("waitSoft", pad(`   ${k} y  ${yes.label}    ${k} x  ${no.label}    ${k} !  go there`, L.mainW)),
    ];
  }
  function statusRow() {
    const { sgr, notice } = c, W = c.W, k = c.keyName();
    if (notice && Date.now() < notice.until) { const t = ` ✓ ${notice.text} `; return sgr("tag", t) + sgr("dim", pad(notice.hint || " Shift+drag uses your terminal's own selection", Math.max(0, W - width(t)))); }
    if (c.updated) return sgr("tag", " ↻ AXA was updated ") + sgr("waitSoft", pad(` press ${k} q, then run axa again to get the new version (your sessions keep running)`, Math.max(0, W - 19)));
    const tag = c.prefix ? " PREFIX " : "";
    // the supervisor's hourly wake limit: updates are held back until it lifts
    const limit = c.prefix ? null : wakeLimitText(c.ev);
    const keys = c.prefix
      ? " : palette · m map · b brief · h history · l link · i image · s browse · / search · j/k move · 0-9 pick · % split · Tab pane · z zoom · y/x answer · ! go · c new · w worktree · g goal · d diff · v verify · , settings · q quit · ? help"
      : limit ? ` ⏸ ${limit}` : ` ${k} : palette · ${k} s browse · ${k} ? help · ${k} q leave`;
    const clock = new Date().toLocaleTimeString([], { hour12: false });
    // left: does anything need you; then the keys; the clock at the right end
    const cnt = (st) => c.list.filter((s) => s.mode !== "axa" && s.status === st).length, needs = cnt("waiting") + cnt("stuck"), busy = cnt("working");
    const state = ` ${needs ? `⚠ ${needs} need${needs > 1 ? "" : "s"} you` : "✓ nothing needs you"}${busy ? ` · ${busy} working` : ""} `;
    const room = Math.max(0, W - 11 - tag.length - width(state) - 1);
    return sgr(needs ? "wait" : "done", state) + sgr("rule", "│") + (tag ? sgr("tag", tag) : "") + sgr(limit ? "wait" : "dim", pad(keys, room)) + sgr("dim", pad(clock, 9) + " ");
  }
  function draw() {
    if (c.quitting) return;
    const { sgr } = c;
    resizeViews();
    const L = layout(), H = c.H;
    let o = `${ESC}[?25l`;
    if (c.fullRedraw) { o += `${ESC}[0m${ESC}[2J`; V.forEach((v) => v && (v.lastRows = [])); c.fullRedraw = false; }
    // sidebar and its border
    if (L.side) {
      const side = c.sideRows(L);
      for (let y = 0; y < H - 1; y++) o += `${ESC}[${y + 1};${L.sideX + 1}H${side[y] || " ".repeat(L.side)}${ESC}[${y + 1};${cfg.sidebar === "right" ? L.sideX : L.side + 1}H${sgr("rule", "│")}`;
    }
    if (c.mapMode) {
      // the map replaces the panes (sessions keep running and are still live underneath)
      const rows = c.mapRows(L);
      for (let y = 0; y < L.mainH; y++) o += `${ESC}[${y + 1};${L.mainX + 1}H${rows[y]}`;
    } else {
      // what's on screen counts as seen (a "done" you've looked at turns idle)
      for (const v of V) if (v?.id) seen.set(v.id, Date.now());
      o += `${ESC}[1;${L.mainX + 1}H${tabStrip(L)}`;
      L.panes.forEach((p, i) => {
        const v = V[i];
        if (p.hdr) o += `${ESC}[${p.y + 1};${p.x + 1}H${paneHeader(v, p, i === c.focus)}`;
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
    if (c.overlay) o += c.floatingPanel(L);
    // the copied / pasted popup, bottom center of the main area (like herdr's clipboard toast)
    const notice = c.notice, toast = !!(notice && Date.now() < notice.until && !c.overlay);
    if (toast !== c.toastShown || toast) {
      // repaint what the toast covered, now or when it ends
      V.forEach((v) => v && (v.lastRows = []));
      if (toast) { clearTimeout(c.toastTimer); c.toastTimer = setTimeout(schedule, Math.max(20, notice.until - Date.now() + 20)); }
      if (!toast) schedule(); // it just ended: repaint the rows it covered on the next frame
      c.toastShown = toast;
    }
    if (toast) {
      const t = ` ✓ ${notice.text} `, x = L.mainX + Math.max(0, Math.floor((L.mainW - width(t)) / 2));
      o += `${ESC}[${Math.max(1, L.mainH - 1)};${x + 1}H${sgr("tag", t)}`;
    }
    if (L.alert) alertRows(L).forEach((r, i) => (o += `${ESC}[${L.mainH + 1 + i};${L.mainX + 1}H${r}`));
    o += `${ESC}[${H};1H${statusRow()}`;
    // the focused session's own cursor, when it shows one
    const v = V[c.focus], p = L.panes[c.focus];
    if (!c.overlay && !c.mapMode && v?.term && !v.dead && v.cursorOn && p) {
      const b = v.term.buffer.active;
      o += `${ESC}[${p.y + b.cursorY + 1 + p.hdr};${p.x + b.cursorX + 1}H${ESC}[?25h`;
    } else if (c.overlay?.cursor) o += `${ESC}[${c.overlay.cursor[0]};${c.overlay.cursor[1]}H${ESC}[?25h`;
    // the window title says whether anything needs you
    const title = c.list.some((s) => s.status === "waiting" || s.status === "stuck") ? "⚠ AXA" : "AXA";
    if (title !== c.lastTitle) { o += `${ESC}]0;${title}\x07`; c.lastTitle = title; }
    out.write(o);
  }

  // ---------- copy-on-select: drag across a session's text and it's copied when you let go ----------
  // c.selection: { pane, a: {x, y}, b: {x, y}, active } in the pane's cells
  const selRange = () => { const { a, b } = c.selection; return a.y < b.y || (a.y === b.y && a.x <= b.x) ? [a, b] : [b, a]; };
  function selText() {
    const v = V[c.selection.pane]; if (!v?.term) return "";
    const [a, b] = selRange(), buf = v.term.buffer.active, lines = [];
    for (let y = a.y; y <= b.y; y++) lines.push((buf.getLine(buf.baseY + y)?.translateToString(true, y === a.y ? a.x : 0, y === b.y ? b.x + 1 : undefined) || "").replace(/\s+$/, ""));
    return lines.join("\n");
  }
  // the terminal's own clipboard (OSC 52: Windows Terminal, iTerm2, kitty, WezTerm…), plus the system's
  // copy tool where there is one (clip.exe on WSL, pbcopy, wl-copy, xclip), for terminals that ignore OSC 52
  const clipTool = process.env.AXA_NO_CLIP_TOOL ? null : [["clip.exe", []], ["pbcopy", []], ["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]]
    .find(([cmd]) => spawnSync("which", [cmd], { stdio: "ignore" }).status === 0) || null;
  function copyText(t) {
    out.write(`${ESC}]52;c;${Buffer.from(t, "utf8").toString("base64")}\x07`);
    // clip.exe reads the console's code page: give it plain text only (OSC 52 covers the rest)
    if (clipTool && !(clipTool[0] === "clip.exe" && /[^\x00-\x7f]/.test(t))) {
      try { const p = spawn(clipTool[0], clipTool[1], { stdio: ["pipe", "ignore", "ignore"] }); p.on("error", () => {}); p.stdin.end(clipTool[0] === "clip.exe" ? t.replace(/\n/g, "\r\n") : t); } catch {}
    }
    const n = t.split("\n").length;
    c.notice = { text: `copied ${n > 1 ? `${n} lines` : `${[...t].length} characters`}`, until: Date.now() + 2500 };
    clearTimeout(c.selClear); c.selClear = setTimeout(() => { c.selection = null; schedule(); }, 1200);
    schedule();
  }
  // double-click: the word under the pointer
  function selectWord(pane, x, y) {
    const v = V[pane]; if (!v?.term) return;
    const buf = v.term.buffer.active, line = buf.getLine(buf.baseY + y)?.translateToString(false) || "";
    const isWord = (ch) => ch && /[^\s"'`()[\]{}<>│|,;]/.test(ch);
    if (!isWord(line[x])) return;
    let a = x, b = x;
    while (a > 0 && isWord(line[a - 1])) a--;
    while (b < line.length - 1 && isWord(line[b + 1])) b++;
    c.selection = { pane, a: { x: a, y }, b: { x: b, y }, active: false };
    copyText(line.slice(a, b + 1));
  }

  return { selId, sel, onScreen, alertFor, layout, closeView, show, resizeViews, move, toggleSplit, schedule, draw, selText, copyText, selectWord };
}
