// `axa`: the AXA hub in your terminal.
//
// It opens on the hub, a home screen above Claude: your running sessions (the AXA commander first), your
// past chats, the agents you have, and your projects. Nothing starts until you pick something. Opening a
// session shows it live, full screen, under a one-line AXA header; Ctrl-b h (the prefix key, then h)
// brings you back to the hub, and the session keeps running.
import { spawn } from "node:child_process";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { files, inHome, openUrl, pluginRoot, port, tilde, webUrl } from "../paths.mjs";
import { api } from "../daemon.mjs";
import { SOCKET, TMUX_CONF, tmuxEnv } from "../core/tmux-client.mjs";
import { ESC, URGENCY, ago, clean, cut, fmtTok, gitText, line, look, pad, paint, selLine, setTheme, width } from "./draw.mjs";
import { sliceAnsi } from "./ansi.mjs";
import { LiveView } from "./live.mjs";
import { pasteFile, readClipboard } from "./clipboard.mjs";

const out = process.stdout;
const PREFIXES = { "C-b": 0x02, "C-a": 0x01, "C-g": 0x07, "C-\\": 0x1c };
const DEFAULTS = { theme: "terminal", prefix: "C-b", bell: true };
const PANELS = ["sessions", "chats", "agents", "projects"];
const TITLES = { sessions: "Sessions", chats: "Chats", agents: "Agents", projects: "Projects" };

export async function runTui() {
  // ---------- settings: ~/.axa/ui.json ----------
  let cfg = { ...DEFAULTS };
  try { cfg = { ...DEFAULTS, ...JSON.parse(readFileSync(files.ui, "utf8")) }; } catch {}
  const saveCfg = () => { try { writeFileSync(files.ui, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 }); chmodSync(files.ui, 0o600); } catch {} };
  setTheme(cfg.theme);
  const noColor = !!process.env.NO_COLOR || process.env.TERM === "dumb";
  const prefixByte = () => String.fromCharCode(PREFIXES[cfg.prefix] ?? 0x02);
  const keyName = () => cfg.prefix.replace("C-", "Ctrl-");

  // ---------- state ----------
  let W = out.columns || 120, H = out.rows || 36;
  let data = { sessions: [], chats: [], projects: [], agents: [], links: [] };
  let err = "", screen = "hub", live = null, overlay = null, prefix = false, toast = null, quitting = false;
  let focus = 0; // which hub panel
  const sel = { sessions: 0, chats: 0, agents: 0, projects: 0 }, scroll = { sessions: 0, chats: 0, agents: 0, projects: 0 };
  const filter = { sessions: "", chats: "", agents: "", projects: "" };
  let filtering = false; // typing into the focused panel's filter
  let pendingSend = null; // { id, text }: typed into a session as soon as it's ready (e.g. a commander just started)
  let prevStatus = null;

  const call = (path, opts = {}) => api(path, { ...opts, headers: { "x-axa-client": "tui", ...(opts.headers || {}) } });
  const flash = (text, ms = 3500) => { toast = { text, until: Date.now() + ms }; schedule(); setTimeout(schedule, ms + 50); };

  // ---------- data ----------
  const byUrgency = (a, b) => URGENCY.indexOf(a.status) - URGENCY.indexOf(b.status) || (b.last_event_at || b.created) - (a.last_event_at || a.created);
  const commander = () => data.sessions.find((s) => s.mode === "axa" && s.alive) || null;
  // the sessions panel order (also Ctrl-b n/p order): the commander first, then by what needs you
  const orderedSessions = () => [...data.sessions.filter((s) => s.mode === "axa"), ...data.sessions.filter((s) => s.mode !== "axa").sort(byUrgency)];
  const nameOf = (s) => (s.mode === "axa" ? "AXA commander" : clean(s.name));
  const where = (cwd) => (cwd === homedir() ? "~" : tilde(cwd));
  // sessions waiting on a prompt, other than the one you're looking at
  const waitingOthers = () => data.sessions.filter((s) => s.status === "waiting" && s.choices && !(screen === "live" && s.id === live?.id));
  const question = (c) => { const ls = c.question.split("\n").map(clean).filter(Boolean); return [...ls].reverse().find((l) => l.includes("?")) || ls.at(-1) || "a prompt"; };
  const yesOpt = (c) => c.options.find((o) => /^yes\b/i.test(o.label)) || c.options[0];
  const noOpt = (c) => c.options.find((o) => /^no\b/i.test(o.label)) || c.options.at(-1);

  async function pollSessions() {
    try { data.sessions = await call("/api/terms"); err = ""; } catch (e) { err = e.message; }
    afterPoll();
  }
  async function pollHub() {
    try { data = await call("/api/hub?chats=200"); err = ""; } catch (e) { err = e.message; }
    afterPoll();
  }
  function afterPoll() {
    const now = new Map(data.sessions.map((s) => [s.id, s.status]));
    if (cfg.bell && prevStatus && data.sessions.some((s) => ["waiting", "stuck"].includes(s.status) && prevStatus.get(s.id) !== s.status)) out.write("\x07");
    prevStatus = now;
    if (live && !live.dead && !data.sessions.some((s) => s.id === live.id && s.alive)) live.dead = "This session has ended.";
    if (pendingSend) {
      const s = data.sessions.find((x) => x.id === pendingSend.id);
      if (!s?.alive) pendingSend = null;
      else if (["ready", "done"].includes(s.status) && !s.awaiting_permission) {
        const p = pendingSend; pendingSend = null;
        call(`/api/terms/${p.id}/input`, { method: "POST", body: { text: p.text } }).then(() => flash(`sent to ${nameOf(s)}`), (e) => flash(`couldn't send: ${e.message}`));
      }
    }
    schedule();
  }

  // ---------- hub panels: items and how each one draws ----------
  const match = (text, q) => !q || text.toLowerCase().includes(q.toLowerCase());
  const runningOf = (agent) => data.sessions.flatMap((s) => s.helpers || []).filter((h) => h.status === "running" && (h.type === agent.name || h.type.split(":").pop() === agent.name.split(":").pop())).length;
  function items(panel) {
    const q = filter[panel];
    if (panel === "sessions") {
      const cmd = commander();
      const list = orderedSessions().filter((s) => s.alive || s.mode !== "axa");
      const rows = [...(cmd ? [] : [{ kind: "commander-off" }]), ...list.map((s) => ({ kind: "session", s }))];
      return rows.filter((r) => r.kind !== "session" || match(`${nameOf(r.s)} ${r.s.cwd} ${r.s.doing || ""}`, q));
    }
    if (panel === "chats") return data.chats.filter((c) => match(`${c.title} ${c.project} ${c.cwd}`, q)).map((c) => ({ kind: "chat", c }));
    if (panel === "agents") return data.agents.filter((a) => match(`${a.name} ${a.source} ${a.description}`, q)).map((a) => ({ kind: "agent", a }));
    return [...data.projects.filter((p) => match(`${p.name} ${p.path}`, q)).map((p) => ({ kind: "project", p })), ...(q ? [] : [{ kind: "home" }])];
  }
  // Each item: an array of [segments, rightSegments] lines
  function itemLines(it, w) {
    if (it.kind === "commander-off") return [[[["◇ ", "dim"], ["AXA commander", "head"]], [["not running", "dim"]]], [[["  Enter starts it: it runs your sessions for you", "dim"]], []]];
    if (it.kind === "session") {
      const s = it.s, [g, word, role] = look(s), cmd = s.mode === "axa";
      const ctx = cmd ? "" : `  ${where(s.worktree?.repo || s.cwd)}${s.worktree ? ` (${s.worktree.branch})` : ""}`;
      const first = [[[`${cmd ? "◆" : g} `, cmd ? "title" : role], [nameOf(s), cmd ? "title" : s.status === "waiting" ? "wait" : "head"], [ctx, "dim"]], [[`${g} ${word}`, role]]];
      const said = s.status === "waiting" && s.choices ? question(s.choices) : clean(s.status === "done" ? s.last_report || "finished" : s.doing || (cmd ? "ready: open it and tell it what you want" : s.mode === "shell" ? "shell" : s.last_report || ""));
      const helpers = (s.helpers || []).filter((h) => h.status === "running");
      const meta = [gitText(s.git), s.usage?.tokens ? `${fmtTok(s.usage.tokens)} tok${s.usage.over_budget ? " over budget" : ""}` : "", helpers.length ? `● ${helpers.length} agent${helpers.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
      return [first, [[["  " + said, s.status === "waiting" ? "waitSoft" : "dim"]], meta && width(said) + width(meta) + 6 < w ? [[meta + " ", "dim"]] : []]];
    }
    if (it.kind === "chat") {
      const c = it.c;
      return [[[[c.open_in ? "● " : "  ", "work"], [clean(c.title), "head"]], [[`${c.project === "adrianwsl" || c.cwd === homedir() ? "~" : c.project} · ${ago(c.updated)} `, "dim"]]]];
    }
    if (it.kind === "agent") {
      const a = it.a, n = runningOf(a);
      return [[[[n ? "● " : "  ", "work"], [a.name, "head"], [`  ${clean(a.description)}`, "dim"]], [[`${n ? `${n} running · ` : ""}${a.source} `, n ? "work" : "dim"]]]];
    }
    if (it.kind === "project") {
      const p = it.p;
      return [[[["▣ ", "accent"], [p.name, "head"], [`  ${gitText(p.git)}`, "dim"]], [[p.sessions ? `${p.sessions} open ` : "", "work"]]]];
    }
    return [[[["~ ", "accent"], ["Home folder", "head"], ["  a session in ~", "dim"]], []]];
  }

  // ---------- drawing ----------
  let timer = null, prevRows = [], hits = [];
  const schedule = () => { if (!timer && !quitting) timer = setTimeout(() => { timer = null; draw(); }, 16); };
  // a framed panel: rows exactly w wide; registers click targets
  function panelBox(panel, x, y, w, h) {
    const on = PANELS[focus] === panel && screen === "hub" && !overlay;
    const list = items(panel), fr = on ? "frameOn" : "frame";
    const count = list.filter((i) => i.kind !== "commander-off" && i.kind !== "home").length;
    const ftxt = filter[panel] || (on && filtering) ? `  /${filter[panel]}${on && filtering ? "▏" : ""}` : "";
    const label = ` ${PANELS.indexOf(panel) + 1} ${TITLES[panel]} ${count ? `(${count})` : ""}${ftxt} `;
    const rows = [paint(fr, "╭─") + paint(on ? "title" : "head", cut(label, w - 4)) + paint(fr, "─".repeat(Math.max(0, w - 3 - width(cut(label, w - 4)))) + "╮")];
    const iw = w - 2, ih = h - 2;
    sel[panel] = Math.max(0, Math.min(sel[panel], list.length - 1));
    // scroll so the selected item is fully visible
    const heights = list.map((it) => itemLines(it, iw - 1).length);
    const top = (i) => heights.slice(0, i).reduce((a, b) => a + b, 0);
    if (top(sel[panel]) < scroll[panel]) scroll[panel] = top(sel[panel]);
    if (top(sel[panel]) + (heights[sel[panel]] || 1) > scroll[panel] + ih) scroll[panel] = top(sel[panel]) + (heights[sel[panel]] || 1) - ih;
    scroll[panel] = Math.max(0, Math.min(scroll[panel], Math.max(0, top(list.length) - ih)));
    const body = [];
    list.forEach((it, i) => {
      const isSel = i === sel[panel];
      for (const [segs, right] of itemLines(it, iw - 1)) {
        const txt = isSel ? selLine([[" ", ""], ...segs], iw, right, on ? "sel" : "selDim") : line([[" ", ""], ...segs], iw, right);
        body.push({ txt, i });
      }
    });
    const shown = body.slice(scroll[panel], scroll[panel] + ih);
    if (!list.length) shown.push({ txt: line([[" " + (filter[panel] ? "nothing matches" : { sessions: "nothing running: n starts a session, a the commander", chats: "no chats yet", agents: "no agents found", projects: "no projects found: add them in ~/.axa/roster.md" }[panel]), "dim"]], iw) });
    for (let r = 0; r < ih; r++) {
      const b = shown[r];
      rows.push(paint(fr, "│") + (b ? b.txt : " ".repeat(iw)) + paint(fr, "│"));
      hits.push({ x0: x, x1: x + w - 1, y: y + 1 + r, panel, i: b?.i });
    }
    const more = top(list.length) > scroll[panel] + ih ? ` ↓ ${list.length - 1 - sel[panel]} more ` : "";
    rows.push(paint(fr, "╰" + "─".repeat(Math.max(0, w - 3 - width(more)))) + paint("dim", more) + paint(fr, "─╯"));
    hits.push({ x0: x, x1: x + w - 1, y, panel }, { x0: x, x1: x + w - 1, y: y + h - 1, panel });
    return rows;
  }
  function titleBar() {
    const n = (st) => data.sessions.filter((s) => s.status === st).length, needs = n("waiting") + n("stuck");
    const state = needs ? [`⚠ ${needs} need${needs > 1 ? "" : "s"} you`, "wait"] : ["✓ nothing needs you", "done"];
    const clock = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const right = [state, [n("working") ? ` · ${n("working")} working` : "", "work"], [`  ${clock} `, "dim"]];
    if (screen === "hub") return line([[" ◆ AXA", "title"], ["  hub", "head"], [err ? `   ${err}` : "", "stuck"]], W, right);
    // live: where you are and how to get back
    const s = data.sessions.find((x) => x.id === live?.id) || { name: "?", status: "exited", mode: "claude" };
    const [g, word, role] = look(s);
    const bits = [gitText(s.git), s.usage?.tokens ? `${fmtTok(s.usage.tokens)} tok` : ""].filter(Boolean).join(" · ");
    return line([[" ◆ AXA", "title"], [" ‹ hub ", "key"], ["│ ", "frame"], [`${g} `, role], [nameOf(s), "head"], [` · ${word}`, role], [bits ? ` · ${bits}` : "", "dim"]], W, [[prefix ? " waiting for a key… " : `${keyName()} h hub · n/p switch · ? keys `, prefix ? "bar" : "dim"]]);
  }
  function alertBar(a) {
    const yes = yesOpt(a.choices), no = noOpt(a.choices), k = screen === "live" ? `${keyName()} ` : "";
    return line([[" ⚠ ", "wait"], [nameOf(a), "wait"], [` needs you: ${question(a.choices)}`, "waitSoft"]], W, [[`${k}y `, "key"], [cut(yes.label, 18), "waitSoft"], [`  ${k}x `, "key"], [cut(no.label, 18), "waitSoft"], [`  ${k}! `, "key"], ["go there ", "waitSoft"]]);
  }
  function footer() {
    if (toast && Date.now() < toast.until) return paint("bar", pad(` ${toast.text}`, W));
    if (screen === "live") return null;
    const per = { sessions: "⏎ open · d diff · g goal · r rename · X close", chats: "⏎ resume", agents: "⏎ details · u use it", projects: "⏎ open · n new · w worktree · s shell" }[PANELS[focus]];
    return line([[" Tab", "key"], [" panels  ", "dim"], [per, "dim"], ["  │  ", "frame"], ["n", "key"], [" new  ", "dim"], ["a", "key"], [" AXA  ", "dim"], ["/", "key"], [" filter  ", "dim"], ["?", "key"], [" help  ", "dim"], ["q", "key"], [" quit", "dim"]], W);
  }
  function hubBody(y0, h) {
    hits = [];
    const rows = Array(h).fill(" ".repeat(W));
    if (W >= 96 && h >= 12) {
      const lw = Math.floor(W * 0.46), rw = W - lw;
      const sh = Math.max(6, Math.round(h * 0.58)), ch = Math.max(6, Math.round(h * 0.62));
      const L = [...panelBox("sessions", 1, y0, lw, sh), ...panelBox("projects", 1, y0 + sh, lw, h - sh)];
      const R = [...panelBox("chats", lw + 1, y0, rw, ch), ...panelBox("agents", lw + 1, y0 + ch, rw, h - ch)];
      for (let i = 0; i < h; i++) rows[i] = (L[i] || " ".repeat(lw)) + (R[i] || " ".repeat(rw));
    } else {
      // narrow: stacked, the focused panel gets the most room
      const minH = 4, rest = h - minH * 3, order = PANELS;
      let y = 0;
      for (const p of order) {
        const ph = p === PANELS[focus] ? Math.max(minH, rest) : minH;
        for (const r of panelBox(p, 1, y0 + y, W, ph)) rows[y++] = r;
      }
    }
    return rows;
  }
  function frame() {
    const rows = [titleBar()];
    const alert = waitingOthers()[0];
    if (alert) rows.push(alertBar(alert));
    const foot = footer();
    const bodyH = H - rows.length - (foot === null ? 0 : 1);
    if (screen === "live" && live) {
      const top = rows.length;
      live.resize(W, bodyH);
      live.top = top;
      if (live.dead) for (let i = 0; i < bodyH; i++) rows.push(i === Math.floor(bodyH / 2) ? line([[" ".repeat(Math.max(0, Math.floor((W - 50) / 2))) + live.dead + `  ${keyName()} h goes back to the hub`, "dim"]], W) : " ".repeat(W));
      else rows.push(...live.rowsAnsi().slice(0, bodyH));
    } else rows.push(...hubBody(rows.length + 1, bodyH));
    if (foot !== null) rows.push(foot);
    while (rows.length < H) rows.push(" ".repeat(W));
    rows.length = H;
    if (overlay) drawOverlay(rows);
    return rows;
  }
  function draw() {
    if (quitting) return;
    W = out.columns || 120; H = out.rows || 36;
    const rows = frame();
    let o = `${ESC}[?25l`;
    rows.forEach((r, y) => { if (prevRows[y] !== r) o += `${ESC}[${y + 1};1H${r}${ESC}[0m`; });
    prevRows = rows;
    // the cursor: in a text box, or where the live session has it
    if (overlay?.cursorAt) o += `${ESC}[${overlay.cursorAt.y + 1};${overlay.cursorAt.x + 1}H${ESC}[?25h`;
    else if (screen === "live" && live && !live.dead && !overlay) { const c = live.cursor(); if (c) o += `${ESC}[${c.y + 1 + live.top};${c.x + 1}H${ESC}[?25h`; }
    out.write(o);
  }

  // ---------- dialogs: floating over whatever is underneath ----------
  // overlay: { title, lines: [{text, role}] | render(w), input?, sel?, onKey(k), hint, size }
  function drawOverlay(rows) {
    const ov = overlay;
    const w = Math.min(W - 4, ov.size === "small" ? 72 : 110);
    // plain lines wrap at word boundaries (diffs and check output don't: ov.wrap === false)
    const wrapLine = (l) => {
      if (ov.wrap === false || l.raw || width(l.text) <= w - 3) return [l];
      const outL = []; let cur = "";
      for (const word of l.text.split(/(\s+)/)) {
        if (width(cur + word) > w - 3 && cur.trim()) { outL.push({ ...l, text: cur.trimEnd() }); cur = word.trimStart() ? "  " + word.trimStart() : ""; }
        else cur += word;
      }
      if (cur.trim()) outL.push({ ...l, text: cur });
      return outL;
    };
    const content = ov.render ? ov.render(w - 4) : ov.lines.map((l) => (typeof l === "string" ? { text: l } : l)).flatMap(wrapLine);
    const maxH = H - 4, ih = Math.max(1, Math.min(content.length + (ov.input !== undefined ? 2 : 0), maxH - 3));
    const h = ih + 3, x = Math.floor((W - w) / 2), y = Math.max(1, Math.floor((H - h) / 2));
    const listH = ih - (ov.input !== undefined ? 2 : 0);
    ov.scroll = Math.max(0, Math.min(ov.scroll || 0, content.length - listH));
    if (ov.follow !== undefined) { if (ov.follow < ov.scroll) ov.scroll = ov.follow; if (ov.follow >= ov.scroll + listH) ov.scroll = ov.follow - listH + 1; }
    const box = [paint("frameOn", "╭─") + paint("title", cut(` ${ov.title} `, w - 4)) + paint("frameOn", "─".repeat(Math.max(0, w - 3 - width(cut(` ${ov.title} `, w - 4)))) + "╮")];
    const wrap = (s) => paint("frameOn", "│") + s + paint("frameOn", "│");
    for (const l of content.slice(ov.scroll, ov.scroll + listH)) box.push(wrap(l.raw ?? (l.role === "sel" ? paint("sel", pad(` ${l.text}`, w - 2)) : " " + paint(l.role || "", pad(l.text, w - 3)))));
    while (box.length < listH + 1) box.push(wrap(" ".repeat(w - 2)));
    ov.cursorAt = null;
    if (ov.input !== undefined) {
      box.push(wrap(" ".repeat(w - 2)));
      const shownIn = cut(ov.input.slice(-(w - 8)), w - 7);
      box.push(wrap(paint("key", " ❯ ") + pad(shownIn, w - 5)));
      ov.cursorAt = { x: x + 4 + width(shownIn), y: y + box.length - 1 };
    }
    const more = content.length > ov.scroll + listH ? ` ↓ ${content.length - ov.scroll - listH} more ` : "";
    box.push(paint("frameOn", "╰─") + paint("dim", cut(` ${ov.hint || "Esc closes"} `, w - 4 - width(more))) + paint("frameOn", "─".repeat(Math.max(0, w - 3 - width(cut(` ${ov.hint || "Esc closes"} `, w - 4 - width(more))) - width(more)))) + paint("dim", more) + paint("frameOn", "╯"));
    box.forEach((b, i) => { const r = y + i; if (r < H) rows[r] = sliceAnsi(rows[r], 0, x) + b + sliceAnsi(rows[r], x + w, W); });
  }
  const closeOverlay = () => { try { overlay?.onClose?.(); } catch {} overlay = null; prevRows = []; schedule(); };
  const viewer = (title, lines, extra = {}) => { overlay = { title, lines, hint: "↑/↓ PgUp/PgDn scroll · Esc closes", ...extra }; schedule(); };
  // a one-line text box
  function ask(title, onSubmit, { value = "", hint = "Enter confirms · Esc cancels", lines = [], allowEmpty = false } = {}) {
    overlay = { title, lines, input: value, size: "small", hint, onKey: (k) => {
      if (k === "\r") { const v = overlay.input.trim(); if (!v && !allowEmpty) return true; closeOverlay(); onSubmit(v); return true; }
      if (k === "\x7f" || k === "\b") { overlay.input = [...overlay.input].slice(0, -1).join(""); return true; }
      if (k === "\x15") { overlay.input = ""; return true; }
      if (k.length && !k.startsWith(ESC) && k >= " ") { overlay.input += k; return true; }
      return false;
    } };
    schedule();
  }
  // a list to pick from: options [{ label, hint, value }]; extra keys: { key: (option) => void }
  function pick(title, options, onPick, { hint, keys = {}, selected = 0 } = {}) {
    const ov = { title, sel: selected, size: "small", hint: hint || "↑/↓ choose · Enter pick · Esc cancel" };
    ov.render = (w) => options.map((o, i) => ({ raw: i === ov.sel ? paint("sel", pad(` ${o.label}${o.hint ? "  " + o.hint : ""}`, w + 2)) : " " + line([[o.label, "head"], [o.hint ? "  " + o.hint : "", "dim"]], w + 1) }));
    ov.onKey = (k) => {
      if (k === "\x1b[A" || k === "k") ov.sel = Math.max(0, ov.sel - 1);
      else if (k === "\x1b[B" || k === "j") ov.sel = Math.min(options.length - 1, ov.sel + 1);
      else if (k === "\r") { const o = options[ov.sel]; closeOverlay(); onPick(o); }
      else if (keys[k]) { const o = options[ov.sel]; closeOverlay(); keys[k](o); }
      else return false;
      ov.follow = ov.sel;
      return true;
    };
    overlay = ov; schedule();
  }
  function overlayKey(k) {
    const ov = overlay;
    if (ov.onKey?.(k)) return schedule();
    const page = Math.max(1, H - 8);
    if (k === ESC || k === "q" || (k === "\r" && ov.input === undefined && !ov.onKey)) return closeOverlay();
    if (k === "\x1b[A" || k === "k") ov.scroll = (ov.scroll || 0) - 1;
    else if (k === "\x1b[B" || k === "j") ov.scroll = (ov.scroll || 0) + 1;
    else if (k === "\x1b[5~") ov.scroll = (ov.scroll || 0) - page;
    else if (k === "\x1b[6~" || k === " ") ov.scroll = (ov.scroll || 0) + page;
    else if (k === "g" && ov.input === undefined) ov.scroll = 0;
    else if (k === "G" && ov.input === undefined) ov.scroll = 1e9;
    ov.follow = undefined;
    schedule();
  }

  // ---------- actions ----------
  function openLive(s) {
    if (!s) return;
    if (live && live.id === s.id && !live.dead) { screen = "live"; prevRows = []; return schedule(); }
    live?.close();
    const top = 1 + (waitingOthers().filter((x) => x.id !== s.id).length ? 1 : 0);
    live = new LiveView({ socket: SOCKET, conf: TMUX_CONF, env: tmuxEnv(), session: s, cols: W, rows: Math.max(5, H - top), onUpdate: schedule, noColor });
    screen = "live"; prevRows = []; schedule();
  }
  function toHub() { screen = "hub"; prevRows = []; pollHub(); schedule(); }
  async function start(body, label) {
    try {
      flash(`starting ${label}…`, 2000);
      const s = await call("/api/terms", { method: "POST", body: { cols: W, rows: H - 1, ...body } });
      await pollSessions();
      openLive(data.sessions.find((x) => x.id === s.id) || s);
      return s;
    } catch (e) { flash(`couldn't start it: ${e.message}`, 6000); return null; }
  }
  // the commander: open it, or start it (in your home folder)
  async function openCommander() {
    const c = commander();
    if (c) return openLive(c);
    const cwd = inHome(process.cwd()) ? process.cwd() : homedir();
    return start({ mode: "axa", cwd }, "the AXA commander");
  }
  function newSession(project, { mode = "claude", worktree = false } = {}) {
    const go = (p) => {
      if (!p) return;
      if (worktree) return ask(`New worktree session in ${p.name}: a short name for its branch (e.g. fix-login)`, (name) => start({ cwd: p.path, mode, worktree: name || true }, `${p.name}:${name || "worktree"}`), { allowEmpty: true, hint: "Enter confirms (empty: a dated name) · Esc cancels" });
      start({ cwd: p.path, mode }, p.name);
    };
    if (project) return go(project);
    const options = [...data.projects.map((p) => ({ label: p.name, hint: where(p.path), value: p })), { label: "Home folder", hint: "~", value: { name: "home", path: homedir() } }, { label: "Another folder…", hint: "type a path", value: null }];
    pick(worktree ? "New session in its own worktree: which project?" : `New ${mode === "shell" ? "shell" : "Claude session"}: where?`, options, (o) => {
      if (o.value) return go(o.value);
      ask("Folder for the new session (inside your home folder)", (path) => go({ name: path.split("/").filter(Boolean).pop() || "~", path: path.replace(/^~(?=$|\/)/, homedir()) }), { value: "~/" });
    }, { hint: "↑/↓ choose · Enter Claude · s shell · w worktree · Esc cancel", keys: { s: (o) => o.value && newSession(o.value, { mode: "shell" }), w: (o) => o.value && newSession(o.value, { worktree: true }) } });
  }
  async function resumeChat(c) {
    if (c.open_in) { const s = data.sessions.find((x) => x.id === c.open_in); if (s) return openLive(s); }
    return start({ resume: c.id }, `"${cut(clean(c.title), 30)}"`);
  }
  async function showDiff(s) {
    try {
      const d = await call(`/api/terms/${s.id}/diff`);
      const lines = (d.diff || "").split("\n").map((l) => ({ text: l, role: l.startsWith("diff --git") ? "head" : l.startsWith("@@") ? "hunk" : /^(\+\+\+|---)/.test(l) ? "dim" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "" }));
      if (d.untracked_total) lines.push({ text: "" }, { text: `New files (${d.untracked_total})`, role: "head" }, ...d.untracked.map((f) => ({ text: `+ ${f}`, role: "add" })));
      const empty = !d.diff?.trim() && !d.untracked_total;
      viewer(`${nameOf(s)} · changes · ${gitText(d.git) || "no git"}`, d.error ? [{ text: d.error, role: "stuck" }] : empty ? [{ text: "No uncommitted changes.", role: "dim" }] : lines, { wrap: false });
    } catch (e) { flash(`couldn't read the changes: ${e.message}`); }
  }
  function giveGoal(s) {
    if (s.mode === "shell") return flash("goals go to Claude sessions, not shells");
    ask(`Goal for ${nameOf(s)}: what does done look like?`, (goal) => call(`/api/terms/${s.id}/input`, { method: "POST", body: { text: `/goal ${goal}` } }).then(() => flash(`goal sent to ${nameOf(s)}`), (e) => flash(`couldn't send: ${e.message}`)), { lines: [{ text: "It keeps working on its own until this is true (Claude Code's /goal).", role: "dim" }] });
  }
  function rename(s) {
    if (s.mode === "axa") return flash("the commander keeps its name");
    ask(`Rename ${nameOf(s)}`, (name) => call(`/api/terms/${s.id}/rename`, { method: "POST", body: { name } }).then(pollSessions), { value: clean(s.name) });
  }
  function closeSession(s) {
    const wt = s.worktree ? ` Its worktree folder stays (branch ${s.worktree.branch}).` : "";
    pick(`Close ${nameOf(s)}? This ends what's running in it.${wt}`, [{ label: "Keep it running", value: false }, { label: "Close it", value: true }], async (o) => {
      if (!o.value) return;
      try { await call(`/api/terms/${s.id}`, { method: "DELETE" }); if (live?.id === s.id) { live.close(); live = null; screen = "hub"; } await pollHub(); flash(`closed ${nameOf(s)}`); }
      catch (e) { flash(`couldn't close it: ${e.message}`); }
    });
  }
  async function answerAlert(which, s = waitingOthers()[0]) {
    if (!s) return flash("nothing is waiting on you");
    const o = which === "yes" ? yesOpt(s.choices) : noOpt(s.choices);
    try { await call(`/api/terms/${s.id}/answer`, { method: "POST", body: { n: o.n, label: o.label } }); flash(`${nameOf(s)}: answered "${o.label}"`); await pollSessions(); }
    catch (e) { flash(`couldn't answer: ${e.message}`); }
  }
  function runVerify(s) {
    const ov = { title: `${nameOf(s)} · checks (running…)`, lines: [], wrap: false, hint: "Esc closes (stops the checks)" };
    viewer(ov.title, [], ov); overlay = ov;
    const child = spawn(process.execPath, [join(pluginRoot, "skills", "verify", "verify.mjs"), s.cwd], { cwd: s.cwd, env: { ...process.env, CI: "1" } });
    const dec = new StringDecoder("utf8");
    let part = "";
    const add = (c) => { const t = part + dec.write(c), ls = t.split("\n"); part = ls.pop(); for (const l of ls) ov.lines.push({ text: l, role: /\| FAIL \|/.test(l) ? "del" : /\| PASS \|/.test(l) ? "add" : "" }); ov.scroll = 1e9; schedule(); };
    child.stdout.on("data", add); child.stderr.on("data", add);
    child.on("close", (code) => { if (part) ov.lines.push({ text: part }); ov.title = `${nameOf(s)} · checks · ${code === 0 ? "all pass" : "something failed"}`; schedule(); });
    ov.onClose = () => { try { child.kill(); } catch {} };
  }
  function agentDetails(a) {
    const n = runningOf(a);
    const busy = data.sessions.flatMap((s) => (s.helpers || []).filter((h) => h.status === "running" && (h.type === a.name || h.type.split(":").pop() === a.name.split(":").pop())).map((h) => ({ s, h })));
    const lines = [
      { text: clean(a.description) || "(no description)" },
      { text: "" },
      { text: `source   ${a.source}${a.file ? `  (${a.file})` : ""}`, role: "dim" },
      { text: `model    ${a.model}`, role: "dim" },
      { text: `tools    ${a.tools}`, role: "dim" },
      { text: "" },
      ...(n ? [{ text: `Running now (${n})`, role: "head" }, ...busy.map(({ s, h }) => ({ text: `● in ${nameOf(s)}: ${clean(h.desc || h.doing || "")}`, role: "work" })), { text: "" }] : []),
      { text: "u: give it a task (the AXA commander runs it with this agent)", role: "accent" },
    ];
    viewer(a.name, lines, { size: "small", hint: "u use it · Esc closes", onKey: (k) => { if (k === "u") { closeOverlay(); useAgent(a); return true; } return false; } });
  }
  function useAgent(a) {
    ask(`Task for ${a.name}`, async (task) => {
      const text = `Use the ${a.name} agent (subagent_type "${a.name}") for this task: ${task}`;
      const c = commander();
      if (c && ["ready", "done"].includes(c.status)) { await call(`/api/terms/${c.id}/input`, { method: "POST", body: { text } }).catch((e) => flash(`couldn't send: ${e.message}`)); return openLive(c); }
      const s = c || (await openCommander());
      if (s) { pendingSend = { id: s.id, text }; flash("the commander gets the task as soon as it's ready", 5000); openLive(data.sessions.find((x) => x.id === s.id) || s); }
    }, { lines: [{ text: clean(a.description), role: "dim" }] });
  }
  function settings() {
    const opts = () => [
      { label: "Theme", hint: cfg.theme, value: "theme" },
      { label: "Prefix key", hint: keyName(), value: "prefix" },
      { label: "Bell when a session needs you", hint: cfg.bell ? "on" : "off", value: "bell" },
    ];
    const cycle = (arr, v) => arr[(arr.indexOf(v) + 1) % arr.length];
    const again = (selected) => pick("Settings (Enter changes)", opts(), (o) => {
      if (o.value === "theme") { cfg.theme = cycle(["terminal", "hud", "mono"], cfg.theme); setTheme(cfg.theme); }
      if (o.value === "prefix") cfg.prefix = cycle(Object.keys(PREFIXES), cfg.prefix);
      if (o.value === "bell") cfg.bell = !cfg.bell;
      saveCfg(); prevRows = [];
      again(opts().findIndex((x) => x.value === o.value));
    }, { selected, hint: `Enter changes · Esc done · saved in ${tilde(files.ui)}` });
    again(0);
  }
  function help() {
    const k = keyName();
    viewer("AXA keys", [
      { text: "The hub", role: "head" },
      { text: "  Tab / Shift-Tab or 1-4   move between Sessions, Chats, Agents, Projects" },
      { text: "  ↑/↓ or j/k, PgUp/PgDn    move in a panel        Enter   open the selected thing" },
      { text: "  a   the AXA commander (opens it, or starts it)   n   new session (pick a folder)" },
      { text: "  /   filter the panel     y / x   answer the prompt in the yellow bar   !  go to it" },
      { text: "  o   web console          ,  settings             q   quit (sessions keep running)" },
      { text: "" },
      { text: "Sessions panel", role: "head" },
      { text: "  Enter open live · d changes (diff) · g give a goal · v run checks · r rename · X close" },
      { text: "Chats panel", role: "head" },
      { text: "  Enter resume the chat in a live session (● = already open: it jumps there)" },
      { text: "Agents panel", role: "head" },
      { text: "  Enter details · u give it a task (the commander runs it with that agent)" },
      { text: "Projects panel", role: "head" },
      { text: "  Enter open its session (or start one) · n new · w new in its own worktree · s shell" },
      { text: "" },
      { text: `Inside a session (everything you type goes to it; ${k} then a key is for AXA)`, role: "head" },
      { text: `  ${k} h   back to the hub (the session keeps running)` },
      { text: `  ${k} n / p   next / previous session      ${k} a   the commander` },
      { text: `  ${k} y / x   answer the prompt in the yellow bar      ${k} !   go to it` },
      { text: `  ${k} d   changes · g goal · v checks · i paste an image · r rename · X close · q quit` },
      { text: `  ${k} ${k}   sends a literal ${k} to the session` },
      { text: "  Ctrl+V   pastes an image from your clipboard if there is one (else its text)" },
      { text: "  Mouse: scroll goes to the session; drag selects and copies (Shift+drag: your terminal's own)" },
      { text: "" },
      { text: `Settings: ${tilde(files.ui)}   ·   web console: axa web   ·   port ${port}`, role: "dim" },
    ]);
  }
  async function pasteImage() {
    const s = data.sessions.find((x) => x.id === live?.id);
    if (!s || !live || live.dead) return;
    let target;
    try { target = pasteFile(s.cwd); } catch (e) { return flash(`couldn't save the image: ${e.message}`); }
    flash("reading the clipboard…", 15000);
    const r = await readClipboard(target.file);
    if (r?.image) {
      if (target.repo) { const { excludeLocally } = await import("../core/git.mjs"); excludeLocally(target.repo, "/.claude/axa-pastes/"); }
      live.write(`${target.file} `); // Claude Code reads image files by path
      flash(`image pasted: ${tilde(target.file)}`);
    } else if (r?.text) { live.write(`${ESC}[200~${r.text.replace(/\x1b\[20[01]~/g, "")}${ESC}[201~`); toast = null; schedule(); }
    else flash("nothing to paste: copy an image first (on Windows: Win+Shift+S)");
  }

  // ---------- keys ----------
  const current = () => items(PANELS[focus])[sel[PANELS[focus]]];
  const selectedSession = () => { const it = current(); return it?.kind === "session" ? it.s : null; };
  function hubKey(k) {
    const panel = PANELS[focus], list = items(panel);
    if (filtering) {
      if (k === "\r" || k === "\x1b[B") { filtering = false; return; }
      if (k === ESC) { filtering = false; filter[panel] = ""; return; }
      if (k === "\x7f" || k === "\b") { filter[panel] = [...filter[panel]].slice(0, -1).join(""); sel[panel] = 0; return; }
      if (!k.startsWith(ESC) && k >= " ") { filter[panel] += k; sel[panel] = 0; }
      return;
    }
    const it = list[sel[panel]];
    const move = (d) => { sel[panel] = Math.max(0, Math.min(list.length - 1, sel[panel] + d)); };
    switch (k) {
      case "\t": focus = (focus + 1) % PANELS.length; return;
      case "\x1b[Z": focus = (focus + PANELS.length - 1) % PANELS.length; return;
      case "1": case "2": case "3": case "4": focus = Number(k) - 1; return;
      case "\x1b[A": case "k": return move(-1);
      case "\x1b[B": case "j": return move(1);
      case "\x1b[5~": return move(-10);
      case "\x1b[6~": return move(10);
      case "\x1b[H": case "\x1b[1~": case "g": sel[panel] = 0; return;
      case "\x1b[F": case "\x1b[4~": case "G": sel[panel] = list.length - 1; return;
      case "\x1b[C": case "l": focus = (focus + 1) % PANELS.length; return;
      case "\x1b[D": case "h": focus = (focus + PANELS.length - 1) % PANELS.length; return;
      case "/": filtering = true; return;
      case ESC: if (filter[panel]) filter[panel] = ""; return;
      case "q": case "\x03": return quit();
      case "?": return help();
      case ",": return settings();
      case "o": openUrl(webUrl()); return flash("opened the web console in your browser");
      case "a": return openCommander();
      case "n": return panel === "projects" && it?.kind === "project" ? newSession(it.p) : newSession();
      case "y": return answerAlert("yes");
      case "x": return answerAlert("no");
      case "!": { const w = waitingOthers()[0]; return w ? openLive(w) : flash("nothing is waiting on you"); }
      case "R": return pollHub().then(() => flash("refreshed"));
      case "\r": case " ":
        if (!it) return;
        if (it.kind === "commander-off") return openCommander();
        if (it.kind === "session") return openLive(it.s);
        if (it.kind === "chat") return resumeChat(it.c);
        if (it.kind === "agent") return agentDetails(it.a);
        if (it.kind === "project") { const open = data.sessions.find((s) => s.alive && s.mode !== "axa" && (s.worktree?.repo || s.cwd) === it.p.path); return open ? openLive(open) : newSession(it.p); }
        if (it.kind === "home") return newSession({ name: "home", path: homedir() });
        return;
    }
    const s = selectedSession();
    if (panel === "sessions" && s) {
      if (k === "d") return showDiff(s);
      if (k === "g") return giveGoal(s);
      if (k === "v") return runVerify(s);
      if (k === "r") return rename(s);
      if (k === "X") return closeSession(s);
    }
    if (panel === "agents" && it?.kind === "agent" && k === "u") return useAgent(it.a);
    if (panel === "projects" && it?.kind === "project") {
      if (k === "w") return newSession(it.p, { worktree: true });
      if (k === "s") return newSession(it.p, { mode: "shell" });
    }
  }
  // Ctrl-b then a key, inside a live session
  function liveAction(k) {
    const s = data.sessions.find((x) => x.id === live?.id);
    const order = orderedSessions().filter((x) => x.alive);
    const step = (d) => { if (!order.length) return; const i = order.findIndex((x) => x.id === live?.id); openLive(order[(i + d + order.length) % order.length]); };
    if (k === prefixByte()) return live?.write(k);
    switch (k) {
      case "h": case ESC: case " ": case "\x1b[D": return toHub();
      case "n": case "\x1b[C": return step(1);
      case "p": return step(-1);
      case "a": return openCommander();
      case "y": return answerAlert("yes");
      case "x": return answerAlert("no");
      case "!": { const w = waitingOthers()[0]; return w ? openLive(w) : flash("nothing is waiting on you"); }
      case "q": return quit();
      case "?": return help();
      case "o": openUrl(webUrl()); return flash("opened the web console in your browser");
      case "i": return pasteImage();
      case ",": return settings();
    }
    if (/^[1-9]$/.test(k)) return order[Number(k) - 1] && openLive(order[Number(k) - 1]);
    if (!s) return;
    if (k === "d") return showDiff(s);
    if (k === "g") return giveGoal(s);
    if (k === "v") return runVerify(s);
    if (k === "r") return rename(s);
    if (k === "X") return closeSession(s);
    flash(`${keyName()} ${k === "\r" ? "Enter" : k}: not an AXA key (${keyName()} ? lists them)`);
  }
  function keysOf(d) {
    const keys = [];
    for (let i = 0; i < d.length;) {
      if (d[i] === ESC) {
        // ESC [ ... and ESC O x are keys (arrows...); ESC then anything else is Esc, then that key
        const m = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O[A-Za-z])?/.exec(d.slice(i));
        keys.push(m[0]); i += m[0].length;
      } else { const ch = String.fromCodePoint(d.codePointAt(i)); keys.push(ch); i += ch.length; }
    }
    return keys;
  }
  let lastClick = { at: 0, panel: null, i: -1 }, lastTyping = 0;
  function onMouse(b, x, y, up) {
    if (overlay) {
      if (b === 64) overlay.scroll = (overlay.scroll || 0) - 3; else if (b === 65) overlay.scroll = (overlay.scroll || 0) + 3;
      return schedule();
    }
    if (screen === "live") {
      if (y === 1) { if (!up && b === 0 && x <= 14) toHub(); return; }
      if (live && y > live.top && !live.dead) live.mouse(b, x, y - live.top, up);
      return;
    }
    const hit = hits.find((h) => y === h.y && x >= h.x0 && x <= h.x1);
    if (!hit) return;
    const p = PANELS.indexOf(hit.panel);
    if (b === 64 || b === 65) { focus = p; sel[hit.panel] = Math.max(0, sel[hit.panel] + (b === 64 ? -1 : 1)); return schedule(); }
    if (b !== 0 || up) return;
    focus = p;
    if (hit.i !== undefined) {
      const again = Date.now() - lastClick.at < 450 && lastClick.panel === hit.panel && lastClick.i === hit.i;
      sel[hit.panel] = hit.i;
      lastClick = { at: Date.now(), panel: hit.panel, i: hit.i };
      if (again) hubKey("\r");
    }
    schedule();
  }
  // Ctrl+V inside a session: an image on the clipboard is pasted as a file; text as a normal paste
  let pasting = null;
  const held = [];
  function sendLive(chunk) {
    if (!live || live.dead) return;
    if (pasting) return held.push(chunk);
    const k = chunk.indexOf("\x16");
    if (k < 0) {
      live.write(chunk);
      // tell the daemon you're typing here (the supervisor won't type into the commander meanwhile)
      if (Date.now() - lastTyping > 5000) { lastTyping = Date.now(); call(`/api/terms/${live.id}/typing`, { method: "POST", body: {} }).catch(() => {}); }
      return;
    }
    if (k) live.write(chunk.slice(0, k));
    if (chunk.length > k + 1) held.push(chunk.slice(k + 1));
    pasting = pasteImage().finally(() => { pasting = null; const rest = held.splice(0).join(""); if (rest) sendLive(rest); });
  }
  const decoder = new StringDecoder("utf8");
  const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  process.stdin.on("data", (buf) => {
    let d = decoder.write(buf);
    d = d.replace(MOUSE, (_, b, x, y, m) => { onMouse(Number(b), Number(x), Number(y), m === "m"); return ""; });
    if (!d) return;
    // each key goes where the UI is at that moment: a dialog, the hub, or the live session
    const P = prefixByte();
    while (d) {
      if (overlay || screen === "hub") {
        const [k] = keysOf(d);
        d = d.slice(k.length);
        if (overlay) overlayKey(k); else hubKey(k);
        continue;
      }
      if (prefix) {
        prefix = false;
        const [k] = keysOf(d);
        d = d.slice(k.length);
        liveAction(k);
        continue;
      }
      // live: everything goes to the session, up to the prefix key
      const i = d.indexOf(P);
      if (i < 0) { sendLive(d); break; }
      if (i) sendLive(d.slice(0, i));
      prefix = true; d = d.slice(i + 1);
    }
    schedule();
  });

  // ---------- an open window notices when AXA itself was updated ----------
  const self = fileURLToPath(import.meta.url), selfAt = (() => { try { return statSync(self).mtimeMs; } catch { return 0; } })();
  setInterval(() => { try { if (statSync(self).mtimeMs !== selfAt && !toast) flash(`AXA was updated: quit (q) and run axa again for the new version`, 10000); } catch {} }, 30000);

  // ---------- start and stop ----------
  // mouse: clicks and wheel (1000), drags (1002), SGR form (1006)
  const enter = () => { out.write(`${ESC}[?1049h${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h${ESC}[?25l${ESC}[2J`); process.stdin.setRawMode(true); process.stdin.resume(); };
  const leave = () => { out.write(`${ESC}[?1002l${ESC}[?1000l${ESC}[?1006l${ESC}[0m${ESC}[?25h${ESC}[?1049l`); try { process.stdin.setRawMode(false); } catch {} };
  function quit() {
    quitting = true;
    live?.close();
    leave();
    const n = data.sessions.filter((s) => s.alive).length;
    console.log(n ? `AXA: ${n} session${n > 1 ? "s keep" : " keeps"} running. \`axa\` brings you back.` : "AXA: bye. `axa` brings you back.");
    process.exit(0);
  }
  process.on("SIGTERM", quit); process.on("SIGHUP", quit);
  process.on("uncaughtException", (e) => { quitting = true; try { live?.close(); } catch {} leave(); console.error(e); process.exit(1); });
  out.on("resize", () => { prevRows = []; out.write(`${ESC}[2J`); schedule(); });

  await pollHub();
  if (err) throw new Error(`The AXA daemon isn't answering: ${err}`);
  if (!data.tmux) throw new Error("AXA needs tmux to run sessions: install it (sudo apt install tmux, or brew install tmux) and run axa again.");
  // start where you're needed: the panel with something waiting, else sessions if any, else chats
  if (!data.sessions.length && data.chats.length) focus = 1;
  enter();
  draw();
  setInterval(pollSessions, 1000);
  setInterval(() => { if (screen === "hub" && !overlay) pollHub(); }, 5000);
  setInterval(schedule, 15000); // the clock
}
