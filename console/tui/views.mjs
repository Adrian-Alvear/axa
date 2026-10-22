// The screen: where everything goes (layout), the live session panes (a tmux client in a PTY, drawn
// through a headless terminal), the tab row, the pane borders, the alert bar, the status bar, the
// which-key popup, and the frame itself. A frame is rows of parts ({x, w, s}); floating panels are
// spliced over them, and only the parts that changed since the last frame are written (output.mjs),
// inside a synchronized-output block when the terminal supports one. A pane's rows are rebuilt only
// when its session printed something (or the selection, size or theme changed). Also copy-on-select.
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { ESC, look, needsYou, STATUS, SPINNER, statusLabel, cut, pad, width, question, yesOpt, noOpt, fmtTok, gitText, costText, themeLabel } from "./theme.mjs";
import { wakeLimitText } from "./events.mjs";
import { createScreen, splice, frame } from "./output.mjs";

// the app draws only the live screen of a session (tmux keeps its history), so its headless terminals
// keep no scrollback of their own: memory stays flat however much a session prints (the console's
// server-side terminals cap theirs at 2000 lines)
export const HEADLESS_SCROLLBACK = 0;
// a pane hidden behind the map this long gives back its terminal (it's re-attached when you return)
export const PARK_AFTER_MS = 20_000;
const HEAVY = { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" }, ROUND = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

// The which-key popup: the keys after the prefix, grouped by what they do
export const WHICH_KEY = [
  ["Sessions", [["j/k", "next / prev"], ["0-9", "pick by number"], ["n/p", "next / prev tab"], ["s", "browse"], ["c", "new session"], ["w", "new in worktree"], ["r", "rename"], ["X", "close session"]]],
  ["Panes", [["%", "split"], ["Tab", "switch pane"], ["z", "zoom"], ["!", "what needs you"]]],
  ["Views", [[":", "palette"], ["m", "map"], ["b", "briefing"], ["h", "history"], ["/", "search"], ["a", "agents"]]],
  ["Act", [["y/x", "answer yes / no"], ["g", "goal"], ["d", "diff"], ["v", "verify"], ["l", "link"], ["i", "paste image"]]],
  ["App", [[",", "settings"], ["o", "web console"], ["?", "all keys"], ["q", "leave"]]],
];

export function views(c) {
  const { cfg, out, env, SOCK, seen } = c, V = c.views;
  const screen = createScreen();
  const selId = () => V[c.focus]?.id || null;
  const sel = () => c.list.find((s) => s.id === selId());
  const onScreen = (id) => V.some((v) => v?.id === id);
  // A session not on screen that's waiting on a prompt
  const alertFor = () => c.list.find((s) => !onScreen(s.id) && s.status === "waiting" && s.choices) || null;
  // a working session's glyph is the braille spinner (one frame per shared tick); others their status glyph
  const glyph = (s) => (s?.status === "working" ? SPINNER[(c.tickN || 0) % SPINNER.length] : look(s)[0]);

  // Where everything goes. Panes: one, or two side by side (stacked when the window is narrow), each
  // of two in its own border (the focused one heavy and in the accent color).
  function layout() {
    c.W = out.columns || 120; c.H = out.rows || 36;
    const W = c.W;
    const side = c.zoom || W < 70 ? 0 : Math.max(22, Math.min(48, cfg.sidebarWidth, Math.floor(W * 0.4)));
    const sideX = cfg.sidebar === "right" ? W - side : 0; // 0-based column of the sidebar
    const mainX = side && cfg.sidebar !== "right" ? side + 1 : 0, mainW = W - (side ? side + 1 : 0);
    const alert = alertFor(), alertRows = alert ? 2 : 0;
    const feedRows = 0;
    const mainH = c.H - 1 - alertRows; // rows above the alert bar and the status line
    const tabRow = c.mapMode ? 0 : 1, ph = mainH - tabRow;
    const panes = [];
    if (V.length < 2) panes.push({ x: mainX, y: tabRow, w: mainW, h: ph });
    else if (mainW >= 100) { const a = Math.floor(mainW / 2); panes.push({ x: mainX, y: tabRow, w: a, h: ph }, { x: mainX + a, y: tabRow, w: mainW - a, h: ph }); }
    else { const a = Math.floor(ph / 2); panes.push({ x: mainX, y: tabRow, w: mainW, h: a }, { x: mainX, y: tabRow + a, w: mainW, h: ph - a }); }
    // a bordered pane: the session's cells start one column right (ix) and one row down (hdr)
    const boxed = panes.length > 1;
    for (const p of panes) { p.box = boxed; p.hdr = p.ix = boxed ? 1 : 0; p.cols = Math.max(10, p.w - 2 * p.ix); p.rows = Math.max(3, p.h - 2 * p.hdr); }
    return { side, sideX, mainX, mainW, mainH, panes, alert, alertRows, feedRows };
  }

  // ---------- live panes: a tmux client in a PTY, drawn through a headless terminal ----------
  function closeView(v) {
    if (!v) return;
    try { if (v.proc?._pty) spawnSync("tmux", ["-L", SOCK, "detach-client", "-t", v.proc._pty], { stdio: "ignore", env }); } catch {}
    try { v.proc?.kill(); } catch {}
    try { v.term?.dispose(); } catch {}
    v.term = null; v.proc = null; v.cache = null;
    v.closed = true;
  }
  const fitWindow = (v) => spawnSync("tmux", ["-L", SOCK, "resize-window", "-t", `=axa-${v.id}:`, "-x", String(v.cols), "-y", String(v.rows)], { stdio: "ignore", env });
  function makeView(s, pane) {
    if (!s || !s.alive) return { id: s?.id, dead: "Session ended." };
    if (spawnSync("tmux", ["-L", SOCK, "has-session", "-t", `=axa-${s.id}`], { stdio: "ignore", env }).status !== 0) return { id: s.id, dead: "This session isn't in tmux; open it in the web console (Ctrl-b o)." };
    const term = new c.Headless({ cols: pane.cols, rows: pane.rows, scrollback: HEADLESS_SCROLLBACK, allowProposedApi: true });
    const proc = c.pty.spawn("tmux", ["-L", SOCK, "attach-session", "-t", `=axa-${s.id}`], { name: "xterm-256color", cols: pane.cols, rows: pane.rows, cwd: homedir(), env });
    const v = { id: s.id, proc, term, cursorOn: true, cols: pane.cols, rows: pane.rows, dirty: true, cache: null };
    fitWindow(v);
    const parsed = () => { if (!v.closed) { v.dirty = true; schedule(); } };
    proc.onData((d) => {
      if (v.closed) return;
      // cursor visibility isn't in the public API: follow the last show/hide in the stream
      const i = Math.max(d.lastIndexOf("\x1b[?25h"), d.lastIndexOf("\x1b[?25l"));
      if (i >= 0) v.cursorOn = d[i + 5] === "h";
      term.write(d, parsed); // redrawn once the headless terminal has taken it in
    });
    proc.onExit(() => { if (!v.closed) { v.dead = "Detached or ended. Ctrl-b j/k picks another session."; schedule(); } });
    return v;
  }
  // Show session s in pane `slot` (default: the focused one). If it's already on screen, focus it.
  function show(s, slot = c.focus) {
    if (!s) return;
    const at = V.findIndex((v) => v?.id === s.id);
    if (at >= 0 && !V[at].parked) { c.focus = at; return schedule(); }
    if (at >= 0) slot = at;
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
      v.cols = p.cols; v.rows = p.rows; v.dirty = true;
      try { v.proc.resize(p.cols, p.rows); v.term.resize(p.cols, p.rows); fitWindow(v); } catch {}
    });
  }
  function move(d) { const o = c.ordered(); if (!o.length) return; const i = Math.max(0, o.findIndex((s) => s.id === selId())); show(o[(i + d + o.length) % o.length]); }
  function toggleSplit() {
    if (V.length > 1) { closeView(V[1]); V.length = 1; c.focus = 0; return schedule(); }
    const next = c.ordered().find((s) => !onScreen(s.id) && s.alive);
    if (!next) return c.flash("Nothing to split with", ["Open another session first (Ctrl-b c)."]);
    V.push(null);
    resizeViews(); // the first pane narrows to make room
    show(next, 1);
  }
  // The map hides the panes: after a while their terminals are given back, and re-attached on return
  function setMap(on) {
    c.mapMode = on; c.mapSince = Date.now();
    if (on) c.mapWant = selId(); else unpark();
    schedule();
  }
  function park() {
    if (!c.mapMode) return;
    V.forEach((v, i) => { if (v?.term) { closeView(v); V[i] = { id: v.id, parked: true }; } });
  }
  function unpark() {
    V.forEach((v, i) => { if (v?.parked) { const s = c.list.find((x) => x.id === v.id); V[i] = null; V[i] = makeView(s, layout().panes[i] || layout().panes[0]); } });
  }

  // ---------- drawing ----------
  // c.frames (index.mjs) coalesces requests into at most one frame per 1/60 s
  const schedule = () => (c.frames ? c.frames.schedule() : draw());
  function cellSgr(cell, ansi) {
    const a = [];
    if (cell.isBold()) a.push(1); if (cell.isDim()) a.push(2); if (cell.isItalic()) a.push(3); if (cell.isUnderline()) a.push(4);
    if (cell.isInverse()) a.push(7); if (cell.isInvisible()) a.push(8); if (cell.isStrikethrough()) a.push(9);
    if (c.noColor) return a.join(";");
    if (cell.isFgRGB()) { const v = cell.getFgColor(); a.push(`38;2;${v >> 16};${(v >> 8) & 255};${v & 255}`); }
    else if (cell.isFgPalette()) { const p = cell.getFgColor(); a.push(ansi && p < 16 ? ansi[p][0] : p < 8 ? 30 + p : p < 16 ? 82 + p : `38;5;${p}`); }
    if (cell.isBgRGB()) { const v = cell.getBgColor(); a.push(`48;2;${v >> 16};${(v >> 8) & 255};${v & 255}`); }
    else if (cell.isBgPalette()) { const p = cell.getBgColor(); a.push(ansi && p < 16 ? ansi[p][1] : p < 8 ? 40 + p : p < 16 ? 92 + p : `48;5;${p}`); }
    return a.join(";");
  }
  // a pane's rows (exactly p.cols wide each), rebuilt only when something in them changed
  function viewRows(v, p, pane) {
    const { sgr } = c;
    if (!v || v.dead || !v.term) {
      const msg = v?.dead || (v?.parked ? "" : "Pick a session: Ctrl-b j/k, or Ctrl-b s to browse with previews");
      return Array.from({ length: p.rows }, (_, y) => (y === Math.floor(p.rows / 2) && msg ? pad(" ".repeat(Math.max(0, Math.floor((p.cols - width(msg)) / 2))) + cut(msg, p.cols), p.cols).replace(msg, sgr("dim", msg)) : " ".repeat(p.cols)));
    }
    const selSig = c.selection && c.selection.pane === pane ? JSON.stringify([c.selection.a, c.selection.b]) : "";
    const key = `${c.reset()}|${p.cols}x${p.rows}|${selSig}`;
    if (!v.dirty && v.cache?.key === key) return v.cache.rows;
    const rows = [], base = c.base(), ansi = c.ansiMap();
    // the text being selected (copy-on-select) shows inverted
    const [sa, sb] = selSig ? selRange() : [null, null];
    const inSel = (x, y) => sa && (y > sa.y || (y === sa.y && x >= sa.x)) && (y < sb.y || (y === sb.y && x <= sb.x));
    const b = v.term.buffer.active, cell = b.getNullCell();
    for (let y = 0; y < p.rows; y++) {
      const line = b.getLine(b.baseY + y);
      let s = "", cur = null, n = 0;
      for (let x = 0; x < p.cols && line; x++) {
        line.getCell(x, cell);
        const w = cell.getWidth();
        if (w === 0) continue;
        const attrs = cellSgr(cell, ansi), a = inSel(x, y) ? (attrs ? `${attrs};7` : "7") : attrs;
        if (a !== cur) { s += `${ESC}[0${base ? ";" + base : ""}${a ? ";" + a : ""}m`; cur = a; }
        // a wide character that doesn't fit in the last column would spill over the pane's border
        if (x + w > p.cols) { s += " "; n += 1; break; }
        s += cell.getChars() || " "; n += w;
      }
      rows.push(s + c.reset() + " ".repeat(Math.max(0, p.cols - n)));
    }
    v.dirty = false; v.cache = { key, rows };
    return rows;
  }
  // The tab row: the focused session's workspace and its sessions as tabs (click one, or Ctrl-b n/p)
  function tabStrip(L) {
    const { sgr, shortName, unseenDone, icon } = c;
    const cur = sel(), ws = cur && cur.mode !== "axa" ? c.workspaceOf(cur.id) : null, tabs = ws && ws.sessions.length > 1 ? ws.sessions : [];
    const label = ws ? ` ${icon("ws")} ${ws.name}${tabs.length || shortName(cur) === ws.name ? "" : ` · ${shortName(cur)}`} ` : cur ? ` ${icon("axa")} AXA commander ` : ` ${icon("axa")} AXA `;
    const lab = cut(label, L.mainW);
    let o = sgr("title", lab), n = width(lab);
    c.tabHits = [];
    for (const s of tabs) {
      const [, , role] = look(s), t = ` ${glyph(s)} ${shortName(s)}${unseenDone(s) ? " •" : ""} `;
      if (n + width(t) + 1 > L.mainW) break;
      const x0 = L.mainX + n + 2;
      o += sgr("rule", "│") + (s.id === selId() ? sgr("sel", t) : sgr(role, t));
      n += width(t) + 1;
      c.tabHits.push({ x0, x1: x0 + width(t) - 1, id: s.id });
    }
    if (n < L.mainW) { o += sgr("rule", "│"); n += 1; }
    const s = sel();
    if (L.panes.length === 1 && s) {
      const [, word, role] = look(s);
      const bits = [gitText(s.git), costText(s.cost), s.usage?.tokens ? `${fmtTok(s.usage.tokens)} tok${s.usage.budget ? ` of ${fmtTok(s.usage.budget)}` : ""}` : "", s.worktree ? "worktree" : ""].filter(Boolean);
      const right = cut(`${word}${bits.length ? " · " + bits.join(" · ") : ""} `, Math.max(0, L.mainW - n - 2));
      if (!right) return o + " ".repeat(Math.max(0, L.mainW - n));
      const head = right.startsWith(word) ? word : "";
      return o + " ".repeat(Math.max(1, L.mainW - n - width(right))) + (head ? sgr(role === "off" ? "dim" : role, head) : "") + sgr("dim", right.slice(head.length));
    }
    return o + " ".repeat(Math.max(0, L.mainW - n));
  }
  // A bordered pane's top edge, with its title: "┏━ ▶ ⠹ name · working · main 2f +3 -1 ━━━┓"
  function boxTop(v, p, isFocus) {
    const { sgr } = c, B = isFocus ? HEAVY : ROUND, frameRole = isFocus ? "focus" : "rule";
    const s = c.list.find((x) => x.id === v?.id);
    const inner = p.w - 4; // corners and one rule each side
    let title = "", role = "dim";
    if (s) {
      const [, word, r] = look(s);
      const bits = [gitText(s.git), costText(s.cost), s.worktree ? `worktree ${s.worktree.branch}` : ""].filter(Boolean).join(" · ");
      title = cut(` ${isFocus ? "▶" : " "} ${glyph(s)} ${c.nameOf(s)} · ${word}${bits ? " · " + bits : ""} `, Math.max(0, inner));
      role = isFocus ? r : "dim";
    } else title = cut(" (empty pane) ", Math.max(0, inner));
    const fill = Math.max(0, inner - width(title));
    return sgr(frameRole, B.tl + B.h) + sgr(role, title) + sgr(frameRole, B.h.repeat(fill) + B.h + B.tr);
  }
  function alertRows(L) {
    const { sgr } = c;
    const a = L.alert, q = question(a.choices), yes = yesOpt(a.choices), no = noOpt(a.choices), k = c.keyName();
    return [
      sgr("wait", pad(` ${statusLabel("waiting")} · ${c.nameOf(a)}: ${q}`, L.mainW)),
      sgr("waitSoft", pad(`   ${k} y  ${yes.label}    ${k} x  ${no.label}    ${k} !  go there`, L.mainW)),
    ];
  }

  // ---------- the status bar ----------
  // mode chip · what needs you · this view's keys · the focused session's branch · theme · clock
  const mode = () => (c.prefix ? "PREFIX" : c.overlay?.kind === "palette" ? "PALETTE" : c.mapMode ? "MAP" : c.zoom ? "ZOOM" : "NORMAL");
  function legend(m, L) {
    const k = c.keyName();
    if (m === "PREFIX") return "press a key · ? all keys · Esc cancel";
    if (m === "PALETTE") return "type to filter · ↑/↓ choose · Enter run · Esc close";
    if (c.overlay) return "Esc close";
    if (m === "MAP") return "↑/↓ move · Enter open · Space details · y/x answer · d diff · m back";
    // (most useful first: a narrow window cuts from the right)
    const bits = [`${k} ? keys`, `${k} : palette`];
    if (L?.alert) bits.push(`${k} y/x answer`);
    if (V.length > 1) bits.push(`${k} Tab pane`);
    bits.push(m === "ZOOM" ? `${k} z sidebar` : `${k} s browse`, `${k} m map`);
    return bits.join(" · ");
  }
  const clock = () => new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
  function statusRow(L) {
    const { sgr, notice, icon } = c, W = c.W, k = c.keyName();
    if (notice && Date.now() < notice.until) { const t = ` ✓ ${notice.text} `; return sgr("tag", t) + sgr("dim", pad(notice.hint || " Shift+drag uses your terminal's own selection", Math.max(0, W - width(t)))); }
    if (c.updated) { const t = " ↻ AXA was updated "; return sgr("tag", t) + sgr("waitSoft", pad(` press ${k} q, then run axa again to get the new version (your sessions keep running)`, Math.max(0, W - width(t)))); }
    const m = mode(), chip = ` ${m} `;
    const others = c.list.filter((s) => s.mode !== "axa"), needs = others.filter(needsYou).length, busy = others.filter((s) => s.status === "working").length;
    const state = needs ? ` ${STATUS.waiting.glyph} ${needs} need${needs > 1 ? "" : "s"} you ` : ` ${STATUS.done.glyph} all clear `;
    const work = busy ? `${SPINNER[(c.tickN || 0) % SPINNER.length]} ${busy} working ` : "";
    // right side, dropped when the window is too narrow (theme first, then branch) so the keys keep
    // room: branch, theme, clock
    const s = sel(), branch = s?.git?.branch ? ` ${icon("branch")} ${cut(s.git.branch, 24)} ` : "";
    const right = [[branch, "accent"], [` ${themeLabel(cfg.theme)} `, "dim"], [` ${clock()} `, "dim"]];
    const fixed = width(chip) + width(state) + width(work) + 1;
    for (const drop of [1, 0]) if (fixed + right.reduce((n, [t]) => n + width(t), 0) + 34 > W) right[drop][0] = "";
    const rw = right.reduce((n, [t]) => n + width(t), 0);
    const limit = m === "NORMAL" ? wakeLimitText(c.ev) : null;
    const room = Math.max(0, W - fixed - rw);
    const keys = pad(` ${limit ? `⏸ ${limit}` : legend(m, L)}`, room);
    return sgr(m === "NORMAL" ? "sel" : "tag", chip) + sgr(needs ? "wait" : "done", state) + (work ? sgr("work", work) : "") + sgr("rule", "│") + sgr(limit ? "wait" : "dim", keys) + right.map(([t, r]) => (t ? sgr(r, t) : "")).join("");
  }

  // ---------- the which-key popup: ~400 ms after the prefix, the keys that can follow it ----------
  function whichKeyBox(L) {
    const { sgr } = c;
    // groups kept whole in columns, as few columns (and as wide) as the space allows
    const groups = WHICH_KEY.map(([g, ks]) => [{ head: g }, ...ks.map(([key, what]) => ({ key, what }))]);
    const pack = (n, h) => { const cols = [[]]; for (const g of groups) { if (cols.at(-1).length && cols.at(-1).length + g.length > h) cols.push([]); cols.at(-1).push(...g); } return cols.length <= n ? cols : null; };
    const maxW = Math.min(c.W - 2, 4 * 22 + 2), maxH = Math.max(6, L.mainH - 3);
    let cols = null, colW = 21;
    // the shortest popup that fits, with as few columns as that height allows
    for (let h = Math.max(...groups.map((g) => g.length)); h <= maxH && !cols; h++) for (let n = 1; n <= 4 && !cols; n++) {
      const cw = Math.min(21, Math.floor((maxW - 3) / n) - 1);
      if (cw < 14) break;
      cols = pack(n, h); colW = cw;
    }
    // too small for whole groups: flow the keys down the columns that fit
    if (!cols) {
      const all = groups.flat(), n = Math.max(1, Math.floor((maxW - 2) / 15)), h = Math.ceil(all.length / n);
      colW = Math.max(8, Math.floor((maxW - 2) / n) - 1);
      cols = Array.from({ length: n }, (_, i) => all.slice(i * h, (i + 1) * h));
    }
    const h = Math.max(...cols.map((col) => col.length)), w = cols.length * (colW + 1) + 3;
    const body = Array.from({ length: h }, (_, r) => cols.map((col) => {
      const e = col[r];
      return " " + (!e ? " ".repeat(colW) : e.head ? sgr("title", pad(` ${e.head}`, colW)) : sgr("accent", pad(` ${e.key}`, 5)) + pad(` ${e.what}`, colW - 5));
    }).join("") + " ");
    const title = cut(` ${c.keyName()} … `, w - 4), hint = " Esc cancel · ? all keys · : palette";
    const rows = [
      sgr("accent", "╭─") + sgr("title", title) + sgr("accent", "─".repeat(Math.max(0, w - 3 - width(title))) + "╮"),
      ...body.map((r) => sgr("accent", "│") + r + sgr("accent", "│")),
      sgr("accent", "│") + sgr("dim", pad(hint, w - 2)) + sgr("accent", "│"),
      sgr("accent", "╰" + "─".repeat(w - 2) + "╯"),
    ];
    // over the main area when it fits there, else centered on the window
    const y = Math.max(0, L.mainH - rows.length), x = w <= L.mainW ? L.mainX + Math.floor((L.mainW - w) / 2) : Math.max(0, Math.floor((c.W - w) / 2));
    return { x, y, w, rows };
  }

  // ---------- the frame ----------
  function draw() {
    if (c.quitting) return;
    const { sgr } = c;
    resizeViews();
    const L = layout(), H = c.H, W = c.W;
    let pre = "";
    if (c.clearScreen) { pre = `${c.reset()}${ESC}[2J`; c.clearScreen = false; c.fullRedraw = true; }
    if (c.fullRedraw) { screen.reset(); c.fullRedraw = false; }
    const rows = Array.from({ length: H }, () => []);
    const put = (y, x, w, s) => { if (y >= 0 && y < H && w > 0) rows[y].push({ x, w, s }); };
    // sidebar and its border
    if (L.side) {
      const side = c.sideRows(L), ruleX = cfg.sidebar === "right" ? L.sideX - 1 : L.side;
      for (let y = 0; y < H - 1; y++) { put(y, L.sideX, L.side, side[y] || " ".repeat(L.side)); put(y, ruleX, 1, sgr("rule", "│")); }
    }
    if (c.mapMode) {
      // the map replaces the panes (sessions keep running underneath)
      const mr = c.mapRows(L);
      for (let y = 0; y < L.mainH; y++) put(y, L.mainX, L.mainW, mr[y] ?? " ".repeat(L.mainW));
    } else {
      // what's on screen counts as seen (a "done" you've looked at turns idle)
      for (const v of V) if (v?.id) seen.set(v.id, Date.now());
      put(0, L.mainX, L.mainW, tabStrip(L));
      L.panes.forEach((p, i) => {
        const v = V[i], pr = viewRows(v, p, i), isFocus = i === c.focus;
        if (!p.box) { for (let y = 0; y < p.rows && y < p.h; y++) put(p.y + y, p.x, p.cols, pr[y]); return; }
        const B = isFocus ? HEAVY : ROUND, fr = isFocus ? "focus" : "rule", side = sgr(fr, B.v);
        put(p.y, p.x, p.w, boxTop(v, p, isFocus));
        for (let y = 0; y < p.rows; y++) { put(p.y + 1 + y, p.x, 1, side); put(p.y + 1 + y, p.x + 1, p.cols, pr[y]); put(p.y + 1 + y, p.x + 1 + p.cols, 1, side); }
        put(p.y + p.h - 1, p.x, p.w, sgr(fr, B.bl + B.h.repeat(Math.max(0, p.w - 2)) + B.br));
      });
    }
    if (L.alert) alertRows(L).forEach((r, i) => put(L.mainH + i, L.mainX, L.mainW, r));
    put(H - 1, 0, W, statusRow(L));
    const over = (box) => box.rows.forEach((s, i) => { const y = box.y + i; if (y >= 0 && y < H) rows[y] = splice(rows[y], box.x, box.w, s); });
    // panels float over the live sessions (which keep running and drawing underneath)
    if (c.overlay) over(c.floatingPanel(L));
    else if (c.whichKey && c.prefix) over(whichKeyBox(L));
    // the copied / pasted popup, bottom center of the main area
    const notice = c.notice, toast = !!(notice && Date.now() < notice.until && !c.overlay);
    if (toast) {
      clearTimeout(c.toastTimer); c.toastTimer = setTimeout(schedule, Math.max(20, notice.until - Date.now() + 20));
      const t = ` ✓ ${notice.text} `, tw = Math.min(width(t), L.mainW), x = L.mainX + Math.max(0, Math.floor((L.mainW - tw) / 2));
      over({ x, y: Math.max(0, L.mainH - 2), w: tw, rows: [sgr("tag", cut(t, tw))] });
    }
    let o = screen.diff(rows, c.base());
    // the focused session's own cursor, when it shows one
    const v = V[c.focus], p = L.panes[c.focus];
    let cursor = "hidden";
    if (!c.overlay && !c.mapMode && !(c.whichKey && c.prefix) && v?.term && !v.dead && v.cursorOn && p) {
      const b = v.term.buffer.active;
      cursor = `${p.y + b.cursorY + 1 + p.hdr};${p.x + p.ix + b.cursorX + 1}`;
    } else if (c.overlay?.cursor) cursor = `${c.overlay.cursor[0]};${c.overlay.cursor[1]}`;
    // nothing changed and the cursor stays put: nothing is written at all
    if (o || pre || cursor !== c.lastCursor) {
      o = `${ESC}[?25l${pre}${o}${ESC}[0m${cursor === "hidden" ? "" : `${ESC}[${cursor}H${ESC}[?25h`}`;
      c.lastCursor = cursor;
    }
    // the window title says whether anything needs you
    const title = c.list.some(needsYou) ? `${STATUS.waiting.glyph} AXA` : "AXA";
    if (title !== c.lastTitle) { o += `${ESC}]0;${title}\x07`; c.lastTitle = title; }
    if (o) { c.bytesOut = (c.bytesOut || 0) + o.length; out.write(frame(o, c.sync)); }
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

  return { selId, sel, onScreen, alertFor, glyph, layout, closeView, show, resizeViews, move, toggleSplit, setMap, park, unpark, schedule, draw, selText, copyText, selectWord, mode };
}
