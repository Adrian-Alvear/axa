// Panels that float over the live sessions: the panel frame and its keys, prompts (ask), messages
// (flash), help, search, browse with previews, links, the "since you left" briefing, run history,
// diffs, verify runs, new sessions, goals, answering prompts and closing sessions.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ESC, look, needsYou, STATUS, clean, cut, pad, width, question, yesOpt, noOpt, gitText, fmtDur } from "./theme.mjs";

export function overlays(c) {
  const { cfg, views: V } = c;

  // A bordered panel centered over the main area ("large" panels, like browse, take nearly all of it)
  function floatingPanel(L) {
    const { sgr } = c, ov = c.overlay, big = ov.size === "large";
    // small panels fit their content (title, lines, input, hint, borders)
    const fit = (ov.lines?.length || 0) + (ov.input !== undefined ? 1 : 0) + 4;
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
    const { sgr } = c, ov = c.overlay, rows = [];
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
  const closeOverlay = () => { c.overlay?.onClose?.(); c.overlay = null; c.fullRedraw = true; c.schedule(); };
  function overlayKey(k) {
    const ov = c.overlay;
    if (ov.onKey && ov.onKey(k)) return c.schedule();
    if (ov.input !== undefined) {
      if (k === "\r") { const v = ov.input.trim(); closeOverlay(); if (v || ov.allowEmpty) ov.onSubmit(v); return; }
      if (k === ESC || k === "\x03") return closeOverlay();
      if (k === "\x7f" || k === "\b") ov.input = [...ov.input].slice(0, -1).join("");
      else if (!k.startsWith(ESC)) ov.input += k.replace(/[\x00-\x1f]/g, "");
      ov.onInput?.();
      return c.schedule();
    }
    const page = Math.max(1, c.layout().mainH - 3);
    if (k === "q" || k === ESC || k === "\x03") return closeOverlay();
    if (k === "j" || k === "\x1b[B") ov.scroll = (ov.scroll || 0) + 1;
    else if (k === "k" || k === "\x1b[A") ov.scroll = (ov.scroll || 0) - 1;
    else if (k === " " || k === "\x1b[6~") ov.scroll = (ov.scroll || 0) + page;
    else if (k === "b" || k === "\x1b[5~") ov.scroll = (ov.scroll || 0) - page;
    else if (k === "g") ov.scroll = 0;
    else if (k === "G") ov.scroll = 1e9;
    c.schedule();
  }
  const ask = (prompt, onSubmit, { allowEmpty = false } = {}) => { c.overlay = { title: prompt, lines: [], input: "", prompt: "›", onSubmit, allowEmpty, hint: "Enter submit · Esc cancel" }; c.schedule(); };
  const flash = (title, lines) => { c.overlay = { title, lines: [].concat(lines) }; c.schedule(); };

  const help = () => {
    const keyName = c.keyName();
    return [
      `Everything you type goes to the session in focus. AXA actions: press ${keyName}, then:`,
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
      `  ${keyName}     send a literal ${keyName}            q  leave (sessions keep running)`,
      "",
      "Mouse: drag across text to copy it (double-click: a word); click a session or pane to focus it; scroll goes to the session.",
      "Hold Shift while dragging to use your terminal's own selection instead.",
      `Settings live in ${c.cfgPath}.`,
    ];
  };

  // ---------- search every session's screen and recent history ----------
  async function searchAll() {
    const ov = { title: "Search every session · type to filter · ↑/↓ choose · Enter go there · Esc close", input: "", prompt: "/", sel: 0, lines: [], size: "large", hint: "searches each session's screen and recent history" };
    const texts = [];
    let hits = [], loading = true;
    ov.render = (p) => {
      const { sgr } = c;
      const q = ov.input.trim().toLowerCase();
      hits = q ? texts.filter((x) => x.t.toLowerCase().includes(q)).slice(-500) : [];
      ov.sel = Math.min(ov.sel, Math.max(0, hits.length - 1));
      if (loading) { ov.lines = [{ text: "  reading sessions…", role: "dim" }]; return; }
      if (!q) { ov.lines = [{ text: `  ${texts.length} lines across ${new Set(texts.map((x) => x.s.id)).size} sessions: type to search`, role: "dim" }]; return; }
      if (!hits.length) { ov.lines = [{ text: "  no match", role: "dim" }]; return; }
      ov.lines = hits.map((h, i) => {
        const left = pad(`${i === ov.sel ? "›" : " "} ${c.nameOf(h.s)}`, 18), rest = cut(h.t, Math.max(0, p.cols - 21));
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
      if (k === "\r") { const h = hits[ov.sel]; closeOverlay(); if (h) c.show(h.s); return true; }
      return false;
    };
    c.overlay = ov; c.schedule();
    await Promise.all(c.ordered().map(async (s) => {
      try { const r = await c.api(`/api/terms/${s.id}/screen?lines=400`); for (const l of String(r.screen || "").split("\n")) { const t = clean(l); if (t) texts.push({ s, t }); } } catch {}
    }));
    loading = false; c.schedule();
  }

  async function answerSession(s, o) {
    try { await c.api(`/api/terms/${s.id}/answer`, { method: "POST", body: { n: o.n, label: o.label, question: s.choices?.question }, headers: { "x-axa-client": "tui" } }); await c.poll(); }
    catch (e) { flash("Couldn't answer", [e.message]); }
  }
  async function answerAlert(which) {
    const sel = c.sel(), a = c.alertFor() || (sel?.status === "waiting" && sel?.choices ? sel : null);
    if (!a) return flash("Nothing to answer", ["No session is waiting on a prompt right now."]);
    return answerSession(a, which === "yes" ? yesOpt(a.choices) : noOpt(a.choices));
  }

  // ---------- links: when one session finishes, the next one gets an instruction ----------
  function linkFrom(s = c.sel()) {
    if (!s) return;
    const { nameOf } = c;
    const others = c.ordered().filter((x) => x.id !== s.id && x.alive);
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
          try { await c.api("/api/chains", { method: "POST", body: { from: s.id, to: to.id, text } }); c.chainsList = await c.api("/api/chains"); flash("Linked", [`When ${nameOf(s)} finishes (and its checks settle), AXA sends ${nameOf(to)}:`, "", `  ${text}`, "", "It shows on the map (Ctrl-b m). Remove it from the palette (Ctrl-b :, \"remove link\")."]); }
          catch (e) { flash("Couldn't link them", [e.message]); }
        });
        return true;
      } else if (k === "q" || k === ESC) { closeOverlay(); return true; }
      render(); return true;
    };
    render(); c.overlay = ov; c.schedule();
  }

  // ---------- since you left: what happened between runs ----------
  const runGlyph = (r) => (r.status === "done" ? ["✓", "done"] : r.status === "running" ? ["●", "work"] : r.status === "replaced" ? ["↺", "dim"] : ["–", "off"]);
  const runPrompt = (r) => (/^\s*\[AXA supervisor/.test(r.prompt || "") ? "(supervisor update)" : /^\s*\[AXA link/.test(r.prompt || "") ? `(link) ${clean(r.prompt).replace(/^\[AXA link: [^\]]*\]\s*/, "")}` : clean(r.prompt));
  async function briefing(auto = false) {
    const since = c.briefSince, keyName = c.keyName();
    let runs = [];
    try { runs = await c.api(`/api/runs?since=${since}&limit=300`); } catch {}
    const waiting = c.list.filter((s) => s.mode !== "axa" && needsYou(s));
    if (auto && (!since || (!runs.length && !waiting.length))) return;
    const lines = [];
    for (const s of waiting) lines.push({ text: `${look(s)[0]} ${c.nameOf(s)}  ${s.status === "waiting" ? `${STATUS.waiting.word}: ${s.choices ? question(s.choices) : clean(s.doing)}` : `${look(s)[1]}: ${clean(s.doing || s.last_report)}`}`, role: look(s)[2] });
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
    c.overlay = { title: since ? `Since you left · ${at} (${fmtDur(Date.now() - since)} ago)` : "Briefing", lines, hint: `Esc close · ${keyName} h full history · ${keyName} ! what needs you · ${keyName} m map` };
    c.schedule();
  }

  // ---------- run history: every instruction, its steps and result ----------
  async function history() {
    let runs = [];
    try { runs = await c.api("/api/runs?limit=300"); } catch (e) { return flash("Couldn't read the history", [e.message]); }
    if (!runs.length) return flash("No runs yet", ["Runs appear here once sessions get instructions."]);
    const ov = { title: "Run history · newest first · Enter details · Esc close", sel: 0, lines: [], size: "large", hint: "j/k choose · Enter details · Esc close" };
    const render = () => {
      ov.lines = runs.map((r, i) => {
        const [g] = runGlyph(r), when = new Date(r.start).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
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
        c.overlay = { title: `${r.name} · ${new Date(r.start).toLocaleString([], { hour12: false })} · ${r.status}`, hint: "Esc back to the list", size: "large", lines: [
          { text: "Instruction", role: "title" }, ...String(r.prompt || "").split("\n").map((l) => ({ text: `  ${l}` })), { text: "" },
          { text: `Took ${fmtDur((r.end || Date.now()) - r.start)} · ${r.steps} steps${r.helpers ? ` · ${r.helpers} helper agents` : ""}`, role: "dim" },
          { text: `AXA approved ${r.approvals} · declined ${r.declined} · asked you ${r.escalated} · policy refused ${r.refused} · verify gate ${r.gate}× · failed steps ${r.failures}`, role: "dim" },
          ...(r.answers?.length ? [{ text: `You answered: ${r.answers.join(" · ")}`, role: "accent" }] : []),
          { text: "" }, { text: "Result", role: "title" }, ...String(r.report || (r.status === "running" ? "(still working)" : "(no report)")).split("\n").map((l) => ({ text: `  ${l}` })),
        ] };
        c.overlay.onKey = (k2) => { if (k2 === ESC || k2 === "q") { c.overlay = back; c.fullRedraw = true; return true; } return false; };
        return true;
      } else if (k === "q" || k === ESC) { closeOverlay(); return true; }
      render(); return true;
    };
    render(); c.overlay = ov; c.schedule();
  }

  async function showDiff(s = c.sel()) {
    if (!s) return;
    try {
      const d = await c.api(`/api/terms/${s.id}/diff`);
      const lines = (d.diff || "").split("\n").map((l) => ({ text: l, role: l.startsWith("diff --git") ? "title" : l.startsWith("@@") ? "hunk" : l.startsWith("+++") || l.startsWith("---") ? "dim" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "" }));
      if (d.untracked_total) lines.push({ text: "" }, { text: `New files (${d.untracked_total})`, role: "title" }, ...d.untracked.map((f) => ({ text: `+ ${f}`, role: "add" })));
      c.overlay = { title: `${c.nameOf(s)} · changes · ${gitText(d.git) || ""}`, lines: d.error ? [d.error] : lines.length ? lines : ["No uncommitted changes."] };
      c.schedule();
    } catch (e) { flash("Couldn't read the changes", [e.message]); }
  }
  function runVerify(s = c.sel()) {
    if (!s) return;
    const ov = { title: `${c.nameOf(s)} · verify (running…)`, lines: [] };
    c.overlay = ov; c.schedule();
    const child = spawn(process.execPath, [join(c.root, "skills", "verify", "verify.mjs"), s.cwd], { cwd: s.cwd, env: { ...process.env, CI: "1" } });
    const dec = new StringDecoder("utf8");
    let part = "";
    const add = (chunk) => { const t = part + dec.write(chunk); const ls = t.split("\n"); part = ls.pop(); for (const l of ls) ov.lines.push({ text: l, role: /\| FAIL \|/.test(l) ? "del" : /\| PASS \|/.test(l) ? "add" : /failed \(/.test(l) ? "stuck" : "" }); ov.scroll = 1e9; c.schedule(); };
    child.stdout.on("data", add); child.stderr.on("data", add);
    child.on("close", (code) => { if (part) ov.lines.push({ text: part }); ov.title = `${c.nameOf(s)} · verify · ${code === 0 ? "all checks pass" : "checks failed"}`; c.schedule(); });
    ov.onClose = () => { try { child.kill(); } catch {} };
  }
  async function newSession(worktree) {
    let projects = [];
    try { projects = await c.api("/api/projects"); } catch (e) { return flash("Couldn't list projects", [e.message]); }
    const ov = { title: worktree ? "New session in its own worktree: pick the project" : "New session: pick a project", sel: 0, lines: [], hint: `j/k move · Enter ${cfg.newSession === "shell" ? "shell" : "Claude"} session · ${cfg.newSession === "shell" ? "a Claude" : "s shell"} · Esc cancel` };
    const render = () => { ov.lines = projects.map((p, i) => ({ text: `${i === ov.sel ? "›" : " "} ${p.name.padEnd(22)} ${p.path.replace(homedir(), "~")}`, role: i === ov.sel ? "sel" : "" })); ov.follow = ov.sel; };
    ov.onKey = (k) => {
      if (k === "j" || k === "\x1b[B") ov.sel = Math.min(projects.length - 1, ov.sel + 1);
      else if (k === "k" || k === "\x1b[A") ov.sel = Math.max(0, ov.sel - 1);
      else if (k === "\r" || k === "s" || k === "a") {
        const p = projects[ov.sel], mode = k === "s" ? "shell" : k === "a" ? "claude" : cfg.newSession === "shell" ? "shell" : "claude";
        const go = async (wt) => { try { const t = await c.api("/api/terms", { method: "POST", body: { cwd: p.path, mode, worktree: wt || undefined } }); await c.poll(); c.show(c.list.find((x) => x.id === t.id)); } catch (e) { flash("Couldn't start it", [e.message]); } };
        closeOverlay();
        if (worktree) ask("Worktree name (e.g. fix-login; empty for a dated one)", (name) => go(name || true), { allowEmpty: true }); else go();
      } else if (k === "q" || k === ESC) closeOverlay();
      render(); return true;
    };
    render(); c.overlay = ov; c.schedule();
  }
  function giveGoal(s = c.sel()) {
    if (!s || s.mode === "shell") return flash("Pick a Claude session", ["Goals go to Claude sessions (not shells)."]);
    ask(`Goal for ${c.nameOf(s)}: what does done look like?`, async (goal) => {
      try { await c.api(`/api/terms/${s.id}/input`, { method: "POST", body: { text: `/goal ${goal.replace(/\s*\n\s*/g, " ")}` } }); }
      catch (e) { flash("Couldn't send the goal", [e.message]); }
    });
  }
  function closeSession(s = c.sel()) {
    if (!s) return;
    ask(`Close ${c.nameOf(s)}? This ends what's running in it. Type yes to confirm`, async (v) => {
      if (v.toLowerCase() !== "yes") return;
      const i = V.findIndex((x) => x?.id === s.id);
      if (i >= 0) { c.closeView(V[i]); V.splice(i, 1); c.focus = 0; }
      try { await c.api(`/api/terms/${s.id}`, { method: "DELETE" }); await c.poll(); if (!V.length) c.move(0); } catch (e) { flash("Couldn't close it", [e.message]); }
    });
  }

  // ---------- browse: every session with a live preview of its screen (peek) ----------
  function browse() {
    const o = c.ordered();
    if (!o.length) return flash("No sessions", ["Start one with Ctrl-b c."]);
    const ov = { title: "Sessions · ↑/↓ preview · Enter show here · % show in a split · d diff · g goal · Esc close", sel: Math.max(0, o.findIndex((s) => s.id === c.selId())), lines: [], hint: "the preview is read-only and live", size: "large" };
    let screen = [], timerId = null, last = null;
    const fetchScreen = async () => {
      const s = o[ov.sel]; if (!s) return;
      try { const r = await c.api(`/api/terms/${s.id}/screen?lines=200`); screen = String(r.screen || "").split("\n"); } catch (e) { screen = [`(couldn't read it: ${e.message})`]; }
      c.schedule();
    };
    ov.render = (p) => {
      const { sgr } = c;
      const lw = Math.min(30, Math.floor(p.cols * 0.35)), rw = p.cols - lw - 1, body = p.rows - 1;
      if (last !== ov.sel) { last = ov.sel; screen = ["(loading…)"]; fetchScreen(); }
      const shown = screen.slice(-body);
      ov.lines = [];
      for (let i = 0; i < body; i++) {
        const s = o[i];
        let left = " ".repeat(lw);
        if (s) { const [g, , role] = look(s); const t = pad(` ${g} ${c.nameOf(s)}`, lw); left = i === ov.sel ? sgr("sel", t) : sgr(role, t); }
        ov.lines.push({ raw: left + sgr("rule", "│") + pad(clean(shown[i] ?? ""), rw) });
      }
    };
    ov.onKey = (k) => {
      if (k === "j" || k === "\x1b[B") ov.sel = Math.min(o.length - 1, ov.sel + 1);
      else if (k === "k" || k === "\x1b[A") ov.sel = Math.max(0, ov.sel - 1);
      else if (/^[0-9]$/.test(k)) ov.sel = Math.min(o.length - 1, Number(k) - (o[0]?.mode === "axa" ? 0 : 1));
      else if (k === "\r") { closeOverlay(); c.show(o[ov.sel]); }
      else if (k === "%") { closeOverlay(); if (V.length < 2) { V.push(null); c.fullRedraw = true; c.resizeViews(); } c.show(o[ov.sel], 1); }
      else if (k === "d") { const s = o[ov.sel]; closeOverlay(); showDiff(s); }
      else if (k === "g") { const s = o[ov.sel]; closeOverlay(); giveGoal(s); }
      else if (k === "q" || k === ESC) closeOverlay();
      return true;
    };
    ov.onClose = () => clearInterval(timerId);
    timerId = setInterval(fetchScreen, 1000);
    c.overlay = ov; c.schedule();
  }

  return { floatingPanel, closeOverlay, overlayKey, ask, flash, help, searchAll, answerSession, answerAlert, linkFrom, briefing, history, showDiff, runVerify, newSession, giveGoal, closeSession, browse };
}
