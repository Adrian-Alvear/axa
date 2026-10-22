// Every AXA action: the prefix keys (action), the palette that searches them all (Ctrl-b :), and the
// settings panel (Ctrl-b ,) that edits ui.json live.
import { ESC, pad, THEME_NAMES, PREFIXES, STATUS, URGENCY, themeLabel, DEPTH_TEXT } from "./theme.mjs";

export function palette(c) {
  const { cfg, views: V } = c;

  // ---------- palette: search every action and session ----------
  function openPalette() {
    const { keyName, nameOf, flash } = c;
    const acts = [];
    const add = (label, run, hint = "") => acts.push({ label, run, hint });
    add("Browse sessions with previews", c.browse, "s");
    add("New session", () => c.newSession(false), "c");
    add("New session in its own worktree", () => c.newSession(true), "w");
    add("Split: second session side by side", c.toggleSplit, "%");
    add(c.zoom ? "Show the sidebar" : "Zoom: hide the sidebar", () => { c.zoom = !c.zoom; c.fullRedraw = true; c.schedule(); }, "z");
    add("Jump to whatever needs you", () => action("!"), "!");
    add("Search every session", c.searchAll, "/");
    add(c.mapMode ? "Back to the sessions" : "Map: AXA, sessions, helpers and links", () => action("m"), "m");
    add("Since you left: briefing", () => c.briefing(false), "b");
    add("Run history", c.history, "h");
    add("Link: when this session finishes, instruct another", () => c.linkFrom(), "l");
    add("Paste an image from the clipboard into this session", () => c.pasteImage(), "i");
    add("Rename this session (your own label)", () => action("r"), "r");
    add("Agents and work of this session", () => c.sessionDetail(c.sel()), "a");
    for (const ch of c.chainsList.filter((ch) => !ch.fired && !ch.failed)) add(`Remove link: ${ch.from_name} → ${ch.to_name}`, async () => { try { await c.api(`/api/chains/${ch.id}`, { method: "DELETE" }); c.chainsList = await c.api("/api/chains"); } catch (e) { flash("Couldn't remove it", [e.message]); } });
    add(`Settings: theme (${themeLabel(cfg.theme)}), prefix key, sidebar, bell`, settings, ",");
    add("Open the web console", () => action("o"), "o");
    add("Help: all keys", () => action("?"), "?");
    for (const t of THEME_NAMES) add(`Theme: ${themeLabel(t)} (${t})`, () => { cfg.theme = t; c.saveCfg(); c.fullRedraw = true; c.schedule(); });
    add(cfg.themeSync ? "Stop syncing the theme with the web console" : "Sync the theme with the web console", () => { cfg.themeSync = !cfg.themeSync; c.saveCfg(); c.fullRedraw = true; c.schedule(); });
    for (const s of c.ordered()) {
      const n = nameOf(s);
      add(`Go to ${n}`, () => c.show(s));
      if (s.mode !== "axa") { add(`Changes in ${n}`, () => c.showDiff(s)); add(`Verify ${n}`, () => c.runVerify(s)); add(`Close ${n}`, () => c.closeSession(s)); }
      if (s.mode !== "shell") add(`Goal for ${n}`, () => c.giveGoal(s));
      if (s.status === "waiting" && s.choices) for (const o of s.choices.options) add(`Answer ${n}: ${o.label}`, () => c.answerSession(s, o));
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
      if (k === "\r") { const a = hits[ov.sel]; c.overlay = null; c.fullRedraw = true; if (a) a.run(); c.schedule(); return true; }
      return false;
    };
    render(); c.overlay = ov; c.schedule();
  }

  // ---------- settings (saved to ui.json, applied live) ----------
  function settings() {
    const items = [
      { key: "theme", label: "Theme", values: THEME_NAMES, about: "terminal = your terminal's own colors" },
      { key: "themeSync", label: "Theme sync (web console)", values: [false, true], about: "on: a theme picked in either one changes both" },
      { key: "prefix", label: "Prefix key", values: Object.keys(PREFIXES), about: "the key before every AXA action" },
      { key: "sidebarStyle", label: "Sidebar style", values: ["tree", "list"], about: "tree: the live diagram (AXA, sessions, helpers, links); list: compact" },
      { key: "sidebar", label: "Sidebar side", values: ["left", "right"] },
      { key: "sidebarWidth", label: "Sidebar width", values: [24, 26, 28, 30, 34, 38, 42, 48] },
      { key: "bell", label: "Bell when something needs you", values: [true, false] },
      { key: "newSession", label: "New sessions start as", values: ["claude", "shell"] },
      { key: "copyOnSelect", label: "Copy on select", values: [true, false], about: "drag across text to copy it (off: drags go to the session)" },
    ];
    const ov = { title: "Settings · ↑/↓ choose · ←/→ or Enter change · saved as you go · Esc close", sel: 0, lines: [] };
    const fmt = (v) => (v === true ? "on" : v === false ? "off" : String(v));
    const render = () => {
      // a narrow panel shortens the labels so the values always show
      const lw = Math.max(12, Math.min(32, (ov.cols || 76) - 17));
      ov.lines = items.map((it, i) => ({ text: `${i === ov.sel ? "›" : " "} ${pad(it.label, lw)} ‹ ${fmt(cfg[it.key]).padEnd(9)} ›   ${it.about || ""}`, role: i === ov.sel ? "sel" : "" }));
      ov.lines.push({ text: "" }, { text: `  Theme: ${themeLabel(cfg.theme)} · ${DEPTH_TEXT[c.depth]}${cfg.themeSync ? " · synced with the web console" : ""}`, role: "accent" });
      ov.lines.push({ text: `  ${c.noColor ? "NO_COLOR is set: colors are off whatever the theme." : `Saved to ${c.cfgPath}`}`, role: "dim" });
      // every status as the app shows it (glyph, word and color), wrapped to the panel
      const cols = ov.cols || 76, rows = [[]];
      let used = 2;
      for (const st of URGENCY) { const t = `${STATUS[st].glyph} ${STATUS[st].word}`; const gap = rows.at(-1).length ? 3 : 0; if (used + gap + t.length > cols && gap) { rows.push([]); used = 2; } else if (gap) { rows.at(-1).push(["   ", ""]); used += gap; } rows.at(-1).push([t, STATUS[st].tui]); used += t.length; }
      ov.lines.push({ text: "" }, { text: "  Status preview:", role: "dim" }, ...rows.map((segs) => ({ raw: c.renderSegs([["  ", ""], ...segs], cols) })));
    };
    ov.onKey = (k) => {
      const it = items[ov.sel];
      if (k === "j" || k === "\x1b[B") ov.sel = Math.min(items.length - 1, ov.sel + 1);
      else if (k === "k" || k === "\x1b[A") ov.sel = Math.max(0, ov.sel - 1);
      else if (k === "\x1b[C" || k === "l" || k === "\r" || k === " " || k === "\x1b[D" || k === "h") {
        const d = k === "\x1b[D" || k === "h" ? -1 : 1, i = it.values.indexOf(cfg[it.key]);
        cfg[it.key] = it.values[(i + d + it.values.length) % it.values.length];
        c.saveCfg(); c.fullRedraw = true;
      } else if (k === "q" || k === ESC) { c.closeOverlay(); return true; }
      render(); return true;
    };
    ov.render = (p) => { if (ov.cols !== p.cols) { ov.cols = p.cols; render(); } };
    render(); c.overlay = ov; c.schedule();
  }

  // ---------- the prefix keys: Ctrl-b then k ----------
  function action(k) {
    const o = c.ordered(), { sel, selId, show, move, flash } = c;
    if (k === "?") return flash("AXA · keys", c.help());
    if (k === ":") return openPalette();
    if (k === "s") return c.browse();
    if (k === ",") return settings();
    if (k === "q") return c.quit();
    if (k === "j" || k === "\x1b[B") return move(1);
    if (k === "k" || k === "\x1b[A") return move(-1);
    // n / p: the next / previous tab (session) in this workspace
    if (k === "n" || k === "p") { const ws = sel() && c.workspaceOf(selId()); if (!ws) return move(k === "n" ? 1 : -1); const i = ws.sessions.findIndex((s) => s.id === selId()); return show(ws.sessions[(i + (k === "n" ? 1 : -1) + ws.sessions.length) % ws.sessions.length]); }
    if (k === "r") { const s = sel(); if (!s) return; return c.ask(`Name for ${c.nameOf(s)} (empty: back to its own name)`, (v) => { cfg.labels = { ...(cfg.labels || {}) }; if (v) cfg.labels[s.id] = v.slice(0, 40); else delete cfg.labels[s.id]; c.saveCfg(); c.schedule(); }, { allowEmpty: true }); }
    if (/^[0-9]$/.test(k)) return show(k === "0" ? o.find((s) => s.mode === "axa") : c.sessions()[Number(k) - 1]);
    if (k === "!") { const t = o.find((s) => s.status === "waiting") || o.find((s) => s.status === "stuck"); return t ? show(t) : flash("All clear", ["Nothing needs you right now."]); }
    if (k === "%") return c.toggleSplit();
    if (k === "\t" || k === "\x1b[Z") { if (V.length > 1) { c.focus = (c.focus + 1) % V.length; c.schedule(); } return; }
    if (k === "z") { c.zoom = !c.zoom; c.fullRedraw = true; return c.schedule(); }
    if (k === "/") return c.searchAll();
    if (k === "m") { c.mapMode = !c.mapMode; if (c.mapMode) c.mapWant = selId(); c.fullRedraw = true; return c.schedule(); }
    if (k === "a") return c.sessionDetail(sel());
    if (k === "b") return c.briefing(false);
    if (k === "h") return c.history();
    if (k === "l") return c.linkFrom();
    if (k === "i") return c.pasteImage();
    if (k === "y") return c.answerAlert("yes");
    if (k === "x") return c.answerAlert("no");
    if (k === "c") return c.newSession(false);
    if (k === "w") return c.newSession(true);
    if (k === "g") return c.giveGoal();
    if (k === "d") return c.showDiff();
    if (k === "v") return c.runVerify();
    if (k === "o") return c.openUrl(`http://localhost:${c.port}/?t=${c.readToken()}`);
    if (k === "X") return c.closeSession();
    if (k === String.fromCharCode(c.PREFIX())) { const v = V[c.focus]; if (v?.proc && !v.dead) v.proc.write(k); }
  }

  return { palette: openPalette, settings, action };
}
