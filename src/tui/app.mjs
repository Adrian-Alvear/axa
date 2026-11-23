// `axa`: the AXA hub in your terminal.
//
// It opens on the hub, a home screen above Claude: your running sessions (the AXA commander first), your
// past chats, the agents you have, and your projects. Nothing starts until you pick something. Opening a
// session shows it live, full screen, under a one-line AXA header; Ctrl-b h (the prefix key, then h)
// brings you back to the hub, and the session keeps running.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { files, inHome, openUrl, pluginRoot, port, tilde, webUrl } from "../paths.mjs";
import { api } from "../daemon.mjs";
import { SOCKET, TMUX_CONF, tmuxEnv } from "../core/tmux-client.mjs";
import { ESC, I, THEME_NAMES, nerdFontInstalled, URGENCY, ago, chipOf, clean, cut, fmtTok, gitText, line, look, pad, paint, reviewBadge, selLine, setIcons, setMotion, setTheme, spinner, truecolor, width } from "./draw.mjs";
import { sliceAnsi } from "./ansi.mjs";
import { LiveView } from "./live.mjs";
import { agentDetail, agentName, axaStatusLine, controlRows, msgText, selectedText } from "./control.mjs";
import { copyToClipboard, pasteFile, readClipboard } from "./clipboard.mjs";
import { hintKey, hitAt, makeArm, overlayHit, segSpans } from "./mouse.mjs";

const out = process.stdout;
const PREFIXES = { "C-b": 0x02, "C-a": 0x01, "C-g": 0x07, "C-\\": 0x1c };
const DEFAULTS = { theme: "axa", prefix: "C-b", bell: true, motion: "full", voice: "off", voiceName: "", voiceRate: 0, voiceMoreHint: true };
const KOKORO_KIND = { af: "American, female", am: "American, male", bf: "British, female", bm: "British, male" };
const SPEEDS = { "-2": "slowest", "-1": "slow", 0: "normal", 1: "fast", 2: "fastest" };
const MOTIONS = ["full", "reduced", "off"];
// notifications (notify.mjs): ui.json "notify": { voice, desktop }
const NOTIFY_LEVELS = ["needs-you", "all", "off"];
const NOTIFY_HINT = { "needs-you": "what needs you (and finished work, spoken)", all: "everything", off: "off" };
const PANELS = ["control", "sessions", "chats", "agents", "projects"];
const TITLES = { control: "Control", sessions: "Sessions", chats: "Chats", agents: "Agents", projects: "Projects" };

export async function runTui() {
  // ---------- settings: ~/.axa/ui.json ----------
  let cfg = { ...DEFAULTS };
  try { cfg = { ...DEFAULTS, ...JSON.parse(readFileSync(files.ui, "utf8")) }; } catch {}
  const saveCfg = () => { try { writeFileSync(files.ui, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 }); chmodSync(files.ui, 0o600); } catch {} };
  // settings from v1 (theme "terminal"/"hud") move to the v2 look once; after that your choice sticks
  if (cfg.version !== 2 || !cfg.icons) { cfg = { ...cfg, theme: "axa", icons: nerdFontInstalled() ? "nerd" : "plain", version: 2 }; saveCfg(); }
  setTheme(cfg.theme === "axa" && !truecolor() && !process.env.AXA_TRUECOLOR ? "terminal" : cfg.theme);
  setIcons(cfg.icons);
  // motion: your setting; AXA_REDUCED_MOTION=1 turns "full" down to "reduced"
  const envReduced = /^(1|true|yes)$/i.test(process.env.AXA_REDUCED_MOTION || "");
  const motionNow = () => { const m = MOTIONS.includes(cfg.motion) ? cfg.motion : "full"; return m === "full" && envReduced ? "reduced" : m; };
  setMotion(motionNow());
  // voice: the daemon reads the commander's replies aloud; AXA_VOICE=1/0 forces it on/off
  const voiceEnv = process.env.AXA_VOICE === "1" ? "on" : process.env.AXA_VOICE === "0" ? "off" : null;
  const voiceOn = () => (voiceEnv || cfg.voice) === "on";
  const noColor = !!process.env.NO_COLOR || process.env.TERM === "dumb";
  const prefixByte = () => String.fromCharCode(PREFIXES[cfg.prefix] ?? 0x02);
  const keyName = () => cfg.prefix.replace("C-", "Ctrl-");

  // ---------- state ----------
  let W = out.columns || 120, H = out.rows || 36;
  let data = { sessions: [], chats: [], projects: [], agents: [], links: [] };
  let err = "", screen = "hub", live = null, overlay = null, prefix = false, toast = null, quitting = false;
  let focus = 0; // which hub panel
  const sel = { control: 0, sessions: 0, chats: 0, agents: 0, projects: 0 }, scroll = { control: 0, sessions: 0, chats: 0, agents: 0, projects: 0 };
  const filter = { control: "", sessions: "", chats: "", agents: "", projects: "" };
  let act = null, ctlSel = null, focusInput = false, cmdInput = ""; // Control: activity, selected session, the commander box
  let cmdMsgs = [], cmdChat = null, cmdScroll = 0; // the commander's conversation, and how far you've scrolled it back
  // a drag over the commander's text: { startRow, startCol, endRow, endCol, scroll, dragged, done } (screen rows/cols)
  let cmdSel = null;
  let ctl = { mapHits: [], chatHits: [] }, zone = "map", chatSel = 0, ctlAgent = null; // Control's focus: the map (sessions) or the recent chats
  let filtering = false; // typing into the focused panel's filter
  let pendingSend = null; // { id, text }: typed into a session as soon as it's ready (e.g. a commander just started)
  let prevStatus = null;
  let notes = []; // notifications from the daemon (oldest first); cfg.notifySeen: the newest you've seen
  // the mouse: approve takes two clicks (the first arms it for 4 s); what the title, alert bar and footer
  // drew where (hit boxes, rebuilt every frame); the list area the wheel scrolls
  const approveArm = makeArm(4000);
  let titleHits = [], alertHits = [], footHits = [], alertY = 0, footY = 0, listArea = null;

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
  const waitingOthers = () => data.sessions.filter((s) => ["waiting", "needs_trust"].includes(s.status) && s.choices && !(screen === "live" && s.id === live?.id));
  const question = (c) => { const ls = c.question.split("\n").map(clean).filter(Boolean); return [...ls].reverse().find((l) => l.includes("?")) || ls.at(-1) || "a prompt"; };
  const yesOpt = (c) => c.options.find((o) => /^yes\b/i.test(o.label)) || c.options[0];
  const noOpt = (c) => c.options.find((o) => /^no\b/i.test(o.label)) || c.options.at(-1);
  // what a click on Approve would approve: this session and this very prompt
  const armKey = (s) => `${s.id}\n${s.choices?.question}\n${yesOpt(s.choices)?.n}`;

  async function pollSessions() {
    try { data.sessions = await call("/api/terms"); err = ""; } catch (e) { err = e.message; }
    afterPoll();
  }
  async function pollNotes() {
    try { notes = (await call("/api/notifications?limit=200")).items || []; schedule(); } catch {}
  }
  const unread = () => notes.filter((n) => n.at > (cfg.notifySeen || 0)).length;
  async function pollHub() {
    try { data = await call("/api/hub?chats=200"); err = ""; } catch (e) { err = e.message; }
    afterPoll();
  }
  function afterPoll() {
    const now = new Map(data.sessions.map((s) => [s.id, s.status]));
    if (cfg.bell && prevStatus && data.sessions.some((s) => ["waiting", "needs_trust", "stuck"].includes(s.status) && prevStatus.get(s.id) !== s.status)) out.write("\x07");
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

  // ---------- the hub: tabs, a list on the left, a live preview of the selection on the right ----------
  const match = (text, q) => !q || text.toLowerCase().includes(q.toLowerCase());
  const sameAgent = (type, name) => type === name || type.split(":").pop() === name.split(":").pop();
  const busyOf = (a) => data.sessions.flatMap((s) => (s.helpers || []).filter((h) => h.status === "running" && sameAgent(h.type, a.name)).map((h) => ({ s, h })));
  const chatWhere = (c) => (c.cwd === homedir() ? "~" : c.project);
  function items(panel) {
    const q = filter[panel];
    if (panel === "sessions") {
      const list = orderedSessions().filter((s) => s.alive || s.mode !== "axa").filter((s) => match(`${nameOf(s)} ${s.cwd} ${s.doing || ""}`, q));
      return [...(commander() || q ? [] : [{ kind: "commander-off" }]), ...list.map((s) => ({ kind: "session", s }))];
    }
    if (panel === "chats") return data.chats.filter((c) => match(`${c.title} ${c.project} ${c.cwd}`, q)).map((c) => ({ kind: "chat", c }));
    if (panel === "agents") return data.agents.filter((a) => match(`${a.name} ${a.source} ${a.description}`, q)).map((a) => ({ kind: "agent", a }));
    return [...data.projects.filter((p) => match(`${p.name} ${p.path}`, q)).map((p) => ({ kind: "project", p })), ...(q ? [] : [{ kind: "home" }])];
  }
  const counts = () => ({ control: data.sessions.filter((s) => ["waiting", "needs_trust", "stuck"].includes(s.status)).length || "", sessions: data.sessions.filter((s) => s.alive).length, chats: data.chats.length, agents: data.agents.length, projects: data.projects.length });

  // a list entry: two lines, [left segments, right segments] each
  function entry(it) {
    if (it.kind === "commander-off") return [[[[`${I.axa} `, "dim"], ["AXA commander", "dim"]], [[" OFF ", "chipOff"]]], [[["  Enter starts it", "dim"]], []]];
    if (it.kind === "session") {
      const s = it.s, [g, , role] = look(s), cmd = s.mode === "axa";
      const icon = cmd ? I.axa : s.status === "working" || s.status === "starting" ? g : s.mode === "shell" ? I.shell : I.session;
      const sub = cmd ? "the commander" : `${where(s.worktree?.repo || s.cwd)}${s.git ? `  ${I.branch} ${s.git.branch}${s.git.files ? ` +${s.git.added} -${s.git.removed}` : ""}` : ""}`;
      const rb = reviewBadge(s), rbRole = { approve: "done", warn: "waitSoft", block: "stuck" }[s.review?.verdict] || "dim";
      return [[[[`${icon} `, cmd ? "title" : role], [nameOf(s), cmd ? "title" : "head"]], [chipOf(s)]], [[["  " + sub, "dim"]], [[rb ? `${rb}  ` : "", rbRole], [s.usage?.tokens ? `${fmtTok(s.usage.tokens)}` : "", "dim"]]]];
    }
    if (it.kind === "chat") {
      const c = it.c;
      return [[[[`${c.open_in ? I.open : I.chat} `, c.open_in ? "work" : "dim"], [clean(c.title), "head"]], []], [[[`  ${chatWhere(c)}${c.branch && c.branch !== "HEAD" ? `  ${I.branch} ${c.branch}` : ""}`, "dim"]], [[ago(c.updated), "dim"]]]];
    }
    if (it.kind === "agent") {
      const a = it.a, n = busyOf(a).length;
      return [[[[`${n ? spinner() : I.agent} `, n ? "work" : a.source === "axa" ? "accent" : "violet"], [a.name, "head"]], [[n ? ` ${n} RUNNING ` : "", "chipWork"]]], [[["  " + clean(a.description), "dim"]], []]];
    }
    if (it.kind === "project") {
      const p = it.p;
      return [[[[`${I.project} `, "accent"], [p.name, "head"]], [[p.sessions ? ` ${p.sessions} OPEN ` : "", "chipIdle"]]], [[[`  ${where(p.path)}  ${gitText(p.git)}`, "dim"]], []]];
    }
    return [[[[`${I.home} `, "accent"], ["Home folder", "head"]], []], [[["  a session in ~", "dim"]], []]];
  }
  function listRows(panel, x, y0, w, h) {
    const list = items(panel), rows = [];
    sel[panel] = Math.max(0, Math.min(sel[panel], list.length - 1));
    const per = 3, fit = Math.max(1, Math.floor((h + 1) / per)); // two lines and a gap per entry
    if (sel[panel] < scroll[panel]) scroll[panel] = sel[panel];
    if (sel[panel] >= scroll[panel] + fit) scroll[panel] = sel[panel] - fit + 1;
    scroll[panel] = Math.max(0, Math.min(scroll[panel], Math.max(0, list.length - fit)));
    for (let i = scroll[panel]; i < list.length && rows.length + 2 <= h; i++) {
      const isSel = i === sel[panel], on = isSel ? (screen === "hub" && !overlay ? "sel" : "selDim") : null;
      for (const [segs, right] of entry(list[i])) {
        rows.push(paint(isSel ? "frameOn" : "", isSel ? "▌" : " ") + line(segs, w - 1, right, on));
        hits.push({ x0: x, x1: x + w - 1, y: y0 + rows.length - 1, panel, i });
      }
      if (rows.length < h) rows.push(" ".repeat(w));
    }
    if (!list.length) {
      const msg = filter[panel] ? "nothing matches" : { sessions: "nothing running yet", chats: "no chats yet", agents: "no agents found", projects: "no projects found" }[panel];
      rows.push(line([[`  ${msg}`, "dim"]], w));
      if (!filter[panel] && panel === "sessions") rows.push(line([["  N starts a session · a the commander", "dim"]], w));
    }
    const more = list.length - scroll[panel] - fit;
    while (rows.length < h) rows.push(" ".repeat(w));
    if (more > 0) rows[h - 1] = line([[`  ↓ ${more} more`, "dim"]], w);
    if (scroll[panel] > 0) rows[0] = line([[`  ↑ ${scroll[panel]} more`, "dim"]], w);
    return rows;
  }

  // ---------- preview ----------
  const wrapText = (text, w, indent = "") => {
    const outL = [];
    for (const para of String(text ?? "").replace(/\r/g, "").split("\n")) {
      let cur = indent;
      for (const word of para.split(/(\s+)/)) {
        if (!word) continue;
        if (width(cur + word) > w && cur.trim()) { outL.push(cur.trimEnd()); cur = indent + word.trimStart(); }
        else cur += word;
      }
      outL.push(cur.trimEnd());
    }
    return outL;
  };
  // the session's screen, with its colors, straight from tmux (refreshed while it's selected)
  const shots = new Map(); // id -> { at, lines }
  function screenOf(id) {
    const c = shots.get(id);
    if (c && Date.now() - c.at < 400) return c.lines;
    const r = spawnSync("tmux", ["-L", SOCKET, "capture-pane", "-p", "-e", "-t", `=axa-${id}:`], { encoding: "utf8", env: tmuxEnv(), timeout: 2000 });
    const lines = r.status === 0 ? r.stdout.replace(/\n+$/, "").split("\n") : c?.lines || [];
    shots.set(id, { at: Date.now(), lines });
    return lines;
  }
  // The commander's status, read off the bottom of its screen the way Claude Code draws it:
  //   ✽ Whirring… (5s · ↓ 343 tokens)      <- activity, above the input box
  //   ──────── / ❯ input / ────────
  //   ⏵⏵ auto mode on · esc to interrupt   <- the status line(s), below it
  // Returns { mode, activity, lines } with the lines in their own colors (plain under NO_COLOR).
  let statusCache = { at: 0, id: null, st: { mode: "", activity: "", lines: [] } };
  const plain = (s) => s.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "");
  function commanderStatus() {
    const c = commander();
    if (!c) return { mode: "", activity: "", lines: [] };
    if (statusCache.id === c.id && Date.now() - statusCache.at < 1000) return statusCache.st;
    const r = spawnSync("tmux", ["-L", SOCKET, "capture-pane", "-p", "-e", "-t", `=axa-${c.id}:`], { encoding: "utf8", env: tmuxEnv(), timeout: 2000 });
    if (r.status !== 0) return statusCache.st;
    const raw = r.stdout.replace(/\n+$/, "").split("\n").slice(-40), txt = raw.map(plain);
    const rules = txt.map((t, i) => (/^\s*─{12,}\s*$/.test(t) ? i : -1)).filter((i) => i >= 0);
    const st = { mode: "", activity: "", lines: [] };
    if (rules.length >= 2) {
      const [top, bottom] = rules.slice(-2);
      st.lines = raw.slice(bottom + 1).filter((_, i) => txt[bottom + 1 + i].trim()).slice(0, 3).map((l) => (noColor ? plain(l) : l));
      for (let i = top - 1; i >= Math.max(0, top - 3); i--) if (txt[i].trim()) { if (/…|\(\d+[smh]\b|tokens/.test(txt[i])) st.activity = noColor ? plain(raw[i]) : raw[i]; break; }
    }
    const foot = st.lines.map(plain).join("\n");
    const m = /⏵⏵\s*(accept edits|auto mode|bypass permissions)\s+on/i.exec(foot) || /⏸\s*(plan mode)\s+on/i.exec(foot);
    st.mode = m ? m[1].toLowerCase().replace("bypass permissions", "bypass perms") : rules.length >= 2 ? "default mode" : "";
    statusCache = { at: Date.now(), id: c.id, st };
    return st;
  }
  const chatCache = new Map(); // id -> { updated, msgs, loading }
  function messagesOf(c) {
    const m = chatCache.get(c.id);
    if (m && m.updated === c.updated) return m.msgs;
    if (!m?.loading) {
      chatCache.set(c.id, { ...m, loading: true });
      call(`/api/chats/${c.id}/messages?limit=16`).then((msgs) => { chatCache.set(c.id, { updated: c.updated, msgs }); schedule(); }, () => chatCache.set(c.id, { updated: c.updated, msgs: [] }));
    }
    return m?.msgs || null;
  }
  function previewRows(it, w, h) {
    const P = []; // [segs, right, role-on]
    const head = (icon, iconRole, title, chip) => { P.push([[], [], "pvHead"]); P.push([[[`  ${icon}  `, iconRole], [title, "pvHead"]], chip ? [chip, ["  ", ""]] : [], "pvHead"]); };
    const meta = (text) => { P.push([[[`  ${text}`, "barDim"]], [], "pvHead"]); P.push([[], [], "pvHead"]); };
    const gap = () => P.push([[], [], "pv"]);
    const label = (text) => P.push([[[`  ${text.toUpperCase()}`, "accent"]], [], "pv"]);
    const para = (text, role = "text", indent = "  ") => { for (const l of wrapText(text, w - 3, indent)) P.push([[[l, role]], [], "pv"]); };
    const rule = (text = "") => P.push([[[`  ${text ? text.toUpperCase() + " " : ""}`, "dim"], ["─".repeat(w), "frame"]], [], "pv"]);
    let tail = null; // rows (already rendered) that fill the rest from the bottom up
    if (!it) { head(I.search, "dim", "Nothing selected"); }
    else if (it.kind === "commander-off" || (it.kind === "session" && it.s.mode === "axa" && !it.s.alive)) {
      head(I.axa, "title", "AXA commander", [" OFF ", "chipOff"]);
      gap();
      para("One Claude session that runs the others. Tell it what you want across projects (\"keep going on v7 in launches, and have feed fix its phone layout\"): it opens a session per project, hands each its work, checks the results and reports back.");
      gap(); para("Routine approvals are handled for you; only one-way doors (shipping, deploying, spending) wait for you here.", "dim");
      gap(); P.push([[["  ", ""], [" Enter ", "keycap"], [" start it", "dim"]], [], "pv"]);
    } else if (it.kind === "session") {
      const s = it.s;
      head(s.mode === "axa" ? I.axa : s.mode === "shell" ? I.shell : I.session, s.mode === "axa" ? "title" : look(s)[2], nameOf(s), chipOf(s));
      meta([where(s.cwd), gitText(s.git), s.usage?.tokens ? `${I.tokens} ${fmtTok(s.usage.tokens)} tokens${s.usage.budget ? ` of ${fmtTok(s.usage.budget)}` : ""}` : "", s.worktree ? `${I.worktree} worktree` : ""].filter(Boolean).join("   "));
      gap();
      if (["waiting", "needs_trust"].includes(s.status) && s.choices) {
        para(question(s.choices), "wait");
        P.push([[["  ", ""], [" y ", "keycap"], [` ${cut(yesOpt(s.choices).label, 30)}   `, "waitSoft"], [" x ", "keycap"], [` ${cut(noOpt(s.choices).label, 30)}`, "waitSoft"]], [], "pv"]);
        gap();
      } else if (s.status === "done" && s.last_report) { label("Last report"); for (const l of wrapText(clean(s.last_report), w - 2, " ").slice(0, 4)) P.push([[[l, "text"]], [], "pv"]); gap(); }
      else if (s.doing) { P.push([[[` ${look(s)[0]} `, look(s)[2]], [clean(s.doing), "text"]], [], "pv"]); gap(); }
      const hs = (s.helpers || []).filter((x) => x.status === "running" || Date.now() - x.at < 10 * 60_000);
      if (hs.length) {
        label("Agents");
        for (const x of hs.slice(-4)) P.push([[[` ${x.status === "running" ? spinner() : I.done} `, x.status === "running" ? "work" : "done"], [x.type, "head"], [`  ${clean(x.doing || x.desc || "")}`, "dim"]], [[x.calls ? `${x.calls} steps` : "", "dim"]], "pv"]);
        gap();
      }
      rule("screen");
      tail = s.alive ? screenOf(s.id) : [paint("dim", " this session has ended")];
    } else if (it.kind === "chat") {
      const c = it.c;
      head(I.chat, "accent", clean(c.title), c.open_in ? [" OPEN ", "chipWork"] : null);
      meta([chatWhere(c) === "~" ? "~" : where(c.cwd), c.branch && c.branch !== "HEAD" ? `${I.branch} ${c.branch}` : "", `updated ${ago(c.updated)}${ago(c.updated) === "now" ? "" : " ago"}`].filter(Boolean).join("   "));
      gap();
      const msgs = messagesOf(c);
      if (!msgs) para("loading…", "dim");
      else if (!msgs.length) para("no messages to show", "dim");
      else {
        // newest at the bottom, like the chat itself
        const body = [];
        for (const m of msgs) {
          if (m.role === "system") { for (const l of wrapText(clean(`⚙ supervisor · ${m.text}`), w - 3, "  ").slice(0, 3)) body.push(line([[l, "dim"]], w, [], "pv")); body.push(line([], w, [], "pv")); continue; }
          body.push(line([[` ${m.role === "you" ? I.you : I.claude} `, m.role], [m.role === "you" ? "You" : "Claude", m.role]], w, [], "pv"));
          const plain = m.text.replace(/```[\s\S]*?```/g, "[code]").replace(/\*\*|__|`/g, "").replace(/^#+\s*/gm, "").replace(/\n{2,}/g, "\n");
          for (const l of wrapText(clean(plain), w - 4, "   ").slice(0, m.role === "you" ? 6 : 8)) body.push(line([[l, m.role === "you" ? "text" : "dim"]], w, [], "pv"));
          body.push(line([], w, [], "pv"));
        }
        tail = body;
      }
    } else if (it.kind === "agent") {
      const a = it.a, busy = busyOf(a);
      head(I.agent, a.source === "axa" ? "accent" : "violet", a.name, busy.length ? [` ${busy.length} RUNNING `, "chipWork"] : [` ${a.source.toUpperCase()} `, "chipIdle"]);
      meta([`model ${a.model}`, `tools ${a.tools}`, a.file || ""].filter(Boolean).join("   "));
      gap(); para(clean(a.description) || "(no description)");
      if (busy.length) { gap(); label("Running now"); for (const { s, h: x } of busy) P.push([[[` ${spinner()} `, "work"], [nameOf(s), "head"], [`  ${clean(x.doing || x.desc || "")}`, "dim"]], [], "pv"]); }
      gap(); P.push([[["  ", ""], [" Enter ", "keycap"], [" give it a task (the commander runs it with this agent)", "dim"]], [], "pv"]);
      if (a.prompt) { gap(); rule("instructions"); para(a.prompt, "dim"); }
    } else if (it.kind === "project" || it.kind === "home") {
      const p = it.kind === "home" ? { name: "Home folder", path: homedir(), git: null } : it.p;
      head(it.kind === "home" ? I.home : I.project, "accent", p.name, p.sessions ? [` ${p.sessions} OPEN `, "chipIdle"] : null);
      meta([where(p.path), gitText(p.git)].filter(Boolean).join("   "));
      gap();
      const inP = (cwd) => cwd === p.path || (it.kind !== "home" && cwd.startsWith(p.path + "/"));
      const ss = data.sessions.filter((s) => s.alive && s.mode !== "axa" && inP(s.worktree?.repo || s.cwd));
      label("Sessions");
      if (!ss.length) para("none open", "dim", "   ");
      for (const s of ss) P.push([[[`  ${look(s)[0]} `, look(s)[2]], [nameOf(s), "head"], [`  ${clean(s.doing || "")}`, "dim"]], [chipOf(s)], "pv"]);
      gap();
      const cs = data.chats.filter((c) => inP(c.cwd)).slice(0, 6);
      label("Recent chats");
      if (!cs.length) para("none yet", "dim", "   ");
      for (const c of cs) P.push([[[`  ${I.chat} `, "dim"], [clean(c.title), "text"]], [[ago(c.updated), "dim"]], "pv"]);
      const ag = data.agents.filter((a) => a.project === p.name);
      if (ag.length) { gap(); label("Agents"); for (const a of ag) P.push([[[`  ${I.agent} `, "violet"], [a.name, "head"], [`  ${clean(a.description)}`, "dim"]], [], "pv"]); }
      gap(); P.push([[["  ", ""], [" Enter ", "keycap"], [" open  ", "dim"], [" N ", "keycap"], [" new  ", "dim"], [" w ", "keycap"], [" worktree  ", "dim"], [" s ", "keycap"], [" shell", "dim"]], [], "pv"]);
    }
    const rows = P.map(([segs, right, on]) => line(segs, w, right, on));
    if (tail) {
      const room = Math.max(0, h - rows.length);
      // a session's screen is cut to the preview's width (keeping its colors); other tails are rendered
      const t = tail.slice(-room).map((l) => (it.kind === "session" ? sliceAnsi(" " + l, 0, w) : l));
      rows.push(...t);
    }
    rows.length = Math.min(rows.length, h);
    while (rows.length < h) rows.push(line([], w, [], "pv"));
    return rows;
  }

  // ---------- the frame ----------
  let timer = null, prevRows = [], hits = [], tabHits = [];
  const schedule = () => { if (!timer && !quitting) timer = setTimeout(() => { timer = null; draw(); }, 16); };
  function titleBar() {
    const n = (st) => data.sessions.filter((s) => s.status === st).length, needs = n("waiting") + n("needs_trust") + n("stuck"), work = n("working");
    const clock = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const un = unread();
    const right = [[` ${I.bell} ${un || ""} `, un ? "chipWait" : "barDim"], [" ", "bar"], [needs ? ` ${I.wait} ${needs} NEED${needs > 1 ? "" : "S"} YOU ` : "", "chipWait"], [needs && work ? " " : "", "bar"], [work ? ` ${spinner()} ${work} WORKING ` : "", "chipWork"], [!needs && !work ? `${I.done} all quiet` : "", "barDim"], [`   ${clock}`, "barDim"]];
    titleHits = [];
    if (screen === "hub") {
      const left = [[` ${I.axa} AXA`, "barTitle"], [err ? `   ${err}` : "", "stuck"]], spans = segSpans(left, W, right).right;
      const bell = spans.find((s) => s.i === 0), chip = needs && spans.find((s) => s.i === 2);
      if (bell) titleHits.push({ y: 1, x0: bell.x0, x1: bell.x1, k: "bell" });
      if (chip) titleHits.push({ y: 1, x0: chip.x0, x1: chip.x1, k: "needs" });
      return line(left, W, right, "bar");
    }
    const s = data.sessions.find((x) => x.id === live?.id) || { name: "?", status: "exited", mode: "claude" };
    const bits = [gitText(s.git), s.usage?.tokens ? `${I.tokens} ${fmtTok(s.usage.tokens)}` : ""].filter(Boolean).join("  ");
    return line([[` ${I.axa} AXA `, "barTitle"], [" ‹ hub ", "keycap"], ["  ", "bar"], [nameOf(s), "head"], ["  ", "bar"], chipOf(s), [bits ? `  ${bits}` : "", "barDim"]], W, prefix ? [[" waiting for a key… ", "chipWait"]] : toast && Date.now() < toast.until ? [[` ${toast.text} `, "chipIdle"]] : [[` ${keyName()} h `, "keycap"], [" hub  ", "barDim"], [` ${keyName()} n `, "keycap"], [" next  ", "barDim"], [` ${keyName()} ? `, "keycap"], [" keys", "barDim"]], "bar");
  }
  function tabBar() {
    const c = counts();
    let o = "", used = 0;
    tabHits = [];
    for (const [i, p] of PANELS.entries()) {
      const icon = { control: I.axa, sessions: I.session, chats: I.chat, agents: I.agent, projects: I.project }[p];
      const t = ` ${i + 1} ${icon} ${TITLES[p]} ${c[p]} `;
      tabHits.push({ x0: used + 1, x1: used + width(t), i });
      o += paint(i === focus ? "tabOn" : "tabOff", t) + paint("bar", " ");
      used += width(t) + 1;
    }
    const f = filter[PANELS[focus]], ftxt = filtering || f ? ` ${I.search} ${f}${filtering ? "▏" : ""} ` : "";
    return o + line([[ftxt, filtering ? "chipWork" : "chipIdle"]], Math.max(0, W - used), [], "bar");
  }
  function alertBar(a) {
    const yes = yesOpt(a.choices), no = noOpt(a.choices), k = screen === "live" ? `${keyName()} ` : "", armed = approveArm.armed(armKey(a));
    const left = [[` ${I.wait} NEEDS YOU `, "chipWait"], [`  ${nameOf(a)}`, "wait"], [`  ${question(a.choices)}`, "waitSoft"]];
    const right = [[` ${k}y `, "keycap"], [armed ? " click again to approve  " : ` ${cut(yes.label, 20)}  `, armed ? "chipWait" : "waitSoft"], [` ${k}x `, "keycap"], [` ${cut(no.label, 20)}  `, "waitSoft"], [` ${k}! `, "keycap"], [" go there", "waitSoft"]];
    // every part is clickable: y (twice) approves, x declines, the rest goes there (y is filled in by frame())
    const sp = segSpans(left, W, right);
    alertHits = [...sp.left.map((s) => ({ ...s, k: "go" })), ...sp.right.map((s) => ({ ...s, k: s.i < 2 ? "yes" : s.i < 4 ? "no" : "go" }))];
    return line(left, W, right);
  }
  function footer() {
    footHits = [];
    if (screen === "live") return null; // a session keeps every row; notices show in its header
    if (toast && Date.now() < toast.until) return line([[` ${toast.text}`, "text"]], W, [], "bar");
    const per = { control: focusInput ? [["⏎", "send to the commander"], ["Esc", "stop typing"]] : zone === "chats" ? [["⏎", "resume chat"], ["↑↓", "pick"], ["←", "back to the map"], [":", "talk to AXA"]] : [["⏎", "open"], ["↑↓", "pick session"], ["→", "chats"], [":", "talk to AXA"], ["PgUp", "AXA's messages"], ["y/x", "answer"], ["d", "changes"], ...(W >= 170 ? [["drag", "copy"]] : [])], sessions: [["⏎", "open"], ["d", "changes"], ["g", "goal"], ["v", "checks"], ["r", "rename"], ["X", "close"]], chats: [["⏎", "resume"], ["/", "search"]], agents: [["⏎", "give a task"], ["/", "search"]], projects: [["⏎", "open"], ["N", "new"], ["w", "worktree"], ["s", "shell"]] }[PANELS[focus]];
    const all = [["Tab", "switch"], ["a", "AXA"], ["n", "notifications"], ["N", "new"], ["?", "help"], ["q", "quit"]];
    const segs = per.flatMap(([k, t]) => [[` ${k} `, "keycap"], [` ${t}  `, "barDim"]]);
    const right = all.flatMap(([k, t], j) => [[` ${k} `, "keycap"], [j === all.length - 1 ? ` ${t}` : ` ${t}  `, "barDim"]]);
    // every hint is a button for its key (y/x: the y half approves, the x half declines)
    const sp = segSpans(segs, W, right);
    for (const [spans, src] of [[sp.left, per], [sp.right, all]]) for (const s of spans) {
      const k = src[s.i >> 1][0];
      if (k === "y/x" && s.i % 2 === 0) footHits.push({ x0: s.x0, x1: s.x0 + 1, k: "y" }, { x0: s.x0 + 2, x1: s.x1, k: "x" });
      else footHits.push({ x0: s.x0, x1: s.x1, k });
    }
    return line(segs, W, right, "bar");
  }
  // Control: sessions in table order (the commander first), and the one selected
  const ctlOrder = () => orderedSessions().filter((s) => s.alive);
  const ctlSelected = () => { const o = ctlOrder(); return o.find((s) => s.id === ctlSel) || o.find((s) => s.mode !== "axa") || o[0] || null; };
  function hubBody(y0, h) {
    hits = []; listArea = null;
    const panel = PANELS[focus];
    if (panel === "control") {
      if (W < 100 || h < 20) return [...listRows("sessions", 1, y0, W, h - 1), line([[" widen the window (100×26 or more) for the full control view", "dim"]], W)];
      const w = waitingOthers();
      ctl = { motion: motionNow(), sessions: data.sessions, act, selId: ctlSelected()?.id, focusInput, input: cmdInput, nameOf, question, yesOpt, noOpt, waiting: w[0], waitingCount: w.length, armed: !!w[0] && approveArm.armed(armKey(w[0])), apHits: [], order: ctlOrder(), chats: data.chats, zone, chatSel, agentSel: ctlAgent, cmdStatus: commanderStatus(), mapHits: [], chatHits: [], y0, L: Math.round(W * 0.62), cmdMsgs: withNotices(cmdMsgs), cmdScroll, cmdSel: cmdSel?.dragged && cmdSel.scroll === cmdScroll ? cmdSel : null };
      const rowsOut = controlRows(ctl, W, h - 1);
      cmdScroll = ctl.cmdScroll;
      if (cmdSel && cmdSel.scroll !== cmdScroll) cmdSel = null; // the conversation scrolled: the selection goes
      // one full-width status bar under it: mode · model · context · tokens · agents · sessions
      const c = commander();
      rowsOut.push(c ? axaStatusLine(c, data.sessions, W, 1, { mode: ctl.cmdStatus.mode, on: "bar", voice: voiceOn() })[0] : line([[" AXA is offline · press a to start it", "barDim"]], W, [], "bar"));
      return rowsOut;
    }
    if (W < 90) { listArea = { x0: 1, x1: W, y0, y1: y0 + h - 1, panel }; return listRows(panel, 1, y0, W, h); }
    const lw = Math.max(32, Math.min(56, Math.round(W * 0.36))), pw = W - lw - 1;
    listArea = { x0: 1, x1: lw, y0, y1: y0 + h - 1, panel };
    const L = listRows(panel, 1, y0, lw, h);
    const R = previewRows(items(panel)[sel[panel]], pw, h);
    return L.map((l, i) => l + paint("frame", "│") + R[i]);
  }
  function frame() {
    const rows = [titleBar()];
    if (screen === "hub") rows.push(tabBar());
    const alert = waitingOthers()[0];
    alertY = 0; alertHits = [];
    if (alert) { rows.push(alertBar(alert)); alertY = rows.length; for (const h of alertHits) h.y = alertY; }
    const foot = footer();
    const bodyH = H - rows.length - (foot === null ? 0 : 1);
    if (screen === "live" && live) {
      const top = rows.length;
      live.resize(W, bodyH);
      live.top = top;
      if (live.dead) for (let i = 0; i < bodyH; i++) rows.push(i === Math.floor(bodyH / 2) ? line([[" ".repeat(Math.max(0, Math.floor((W - 50) / 2))) + live.dead + `  ${keyName()} h goes back to the hub`, "dim"]], W) : " ".repeat(W));
      else rows.push(...live.rowsAnsi().slice(0, bodyH));
    } else rows.push(...hubBody(rows.length + 1, bodyH));
    footY = 0;
    if (foot !== null) { rows.push(foot); footY = rows.length; for (const h of footHits) h.y = footY; }
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
    // the top edge ends in a ✕ that closes it (a click outside does too)
    const tt = cut(` ${ov.title} `, w - 7);
    const box = [paint("frameOn", "╭─") + paint("title", tt) + paint("frameOn", "─".repeat(Math.max(0, w - 6 - width(tt)))) + paint("dim", " ✕ ") + paint("frameOn", "╮")];
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
    // where it is, for the mouse (see overlayHit in mouse.mjs)
    ov.geo = { x, y, w, h: box.length, listTop: y + 1, listH, scroll: ov.scroll, n: content.length, more: more ? [x + w - width(more), x + w - 1] : null };
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
    ov.render = (w) => options.map((o, i) => ({ raw: i === ov.sel ? paint("sel", pad(` ${o.label}${o.hint ? "  " + o.hint : ""}`, w + 2)) : " " + line([[o.label, o.dim ? "dim" : "head"], [o.hint ? "  " + o.hint : "", "dim"]], w + 1) }));
    ov.onKey = (k) => {
      if (k === "\x1b[A" || k === "k") ov.sel = Math.max(0, ov.sel - 1);
      else if (k === "\x1b[B" || k === "j") ov.sel = Math.min(options.length - 1, ov.sel + 1);
      else if (k === "\r") { const o = options[ov.sel]; closeOverlay(); onPick(o); }
      else if (keys[k]) { const o = options[ov.sel]; closeOverlay(); keys[k](o); }
      else return false;
      ov.follow = ov.sel;
      return true;
    };
    // a click selects an option; a click on the selected one (so a double-click too) picks it
    ov.pickAt = (i) => { if (i < 0 || i >= options.length) return; if (i === ov.sel) return ov.onKey("\r"); ov.sel = ov.follow = i; };
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

  // ---------- notifications ----------
  // newest first; Enter (or a click on the selected one) goes to its session; c clears the list
  function openNotifications() {
    const list = [...notes].reverse();
    cfg.notifySeen = Math.max(cfg.notifySeen || 0, ...notes.map((n) => n.at)); saveCfg();
    const when = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const options = list.length ? list.map((n) => ({ label: `${n.needsUser ? I.wait : "·"} ${when(n.at)}  ${clean(n.title)}`, hint: clean(n.body).slice(0, 90), value: n })) : [{ label: "No notifications yet.", hint: "", value: null, dim: true }];
    pick(`Notifications${list.length ? ` · ${list.length}` : ""}`, options, (o) => {
      const s = o.value?.session && data.sessions.find((x) => x.id === o.value.session && x.alive);
      if (s) return openLive(s);
      if (o.value) flash(o.value.session ? "that session has closed" : clean(o.value.title));
    }, { hint: "↑/↓ choose · Enter go to its session · c clear all · Esc close", keys: { c: () => call("/api/notifications/clear", { method: "POST" }).then(() => { notes = []; flash("notifications cleared"); }, (e) => flash(`couldn't clear: ${e.message}`)) } });
    overlay.size = "wide";
  }
  // the commander's conversation with each notification since its first message as a "⚙ notice" line
  function withNotices(msgs) {
    const from = msgs.find((m) => m.at)?.at;
    if (!from || !notes.length) return msgs;
    const ns = notes.filter((n) => n.at >= from).map((n) => ({ role: "system", notice: true, text: `${clean(n.title)}${n.body ? ` · ${clean(n.body)}` : ""}`, at: n.at }));
    return [...msgs, ...ns].map((m, i) => [m, i]).sort((a, b) => (a[0].at ?? 0) - (b[0].at ?? 0) || a[1] - b[1]).map(([m]) => m);
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
  // One of the commander's agents, in a popup that follows it live (sessions refresh every second)
  function openAgent(sid, aid) {
    const find = () => data.sessions.find((s) => s.id === sid)?.helpers?.find((h) => h.id === aid);
    let last = find();
    if (!last) return flash("that agent has gone");
    ctlAgent = aid;
    overlay = {
      title: `Agent · ${agentName(last)}`,
      render: (w) => { last = find() || last; return agentDetail(last, w); },
      hint: "↑/↓ scroll · a opens AXA · Esc closes",
      onClose: () => { ctlAgent = null; },
      onKey: (k) => { if (k !== "a") return false; closeOverlay(); openCommander(); return true; },
    };
    schedule();
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
  function useAgent(a) {
    ask(`Task for ${a.name}`, async (task) => {
      const text = `Use the ${a.name} agent (subagent_type "${a.name}") for this task: ${task}`;
      const c = commander();
      if (c && ["ready", "done"].includes(c.status)) { await call(`/api/terms/${c.id}/input`, { method: "POST", body: { text } }).catch((e) => flash(`couldn't send: ${e.message}`)); return openLive(c); }
      const s = c || (await openCommander());
      if (s) { pendingSend = { id: s.id, text }; flash("the commander gets the task as soon as it's ready", 5000); openLive(data.sessions.find((x) => x.id === s.id) || s); }
    }, { lines: [{ text: clean(a.description), role: "dim" }] });
  }
  const stopVoice = () => call("/api/voice/stop", { method: "POST" }).catch(() => {});
  let voiceInfo = null; // the daemon's /api/voice answer (engine, Kokoro installed, voices), refreshed by the pickers
  function toggleVoice() {
    stopVoice();
    if (voiceEnv) return flash(`voice is forced ${voiceEnv} by AXA_VOICE`);
    cfg.voice = voiceOn() ? "off" : "on"; saveCfg();
    flash(cfg.voice === "on" ? "voice on: AXA reads its replies aloud (Esc stops it)" : "voice off");
  }
  async function pickVoice(back) {
    let v;
    try { v = await call("/api/voice"); } catch (e) { flash(`couldn't ask the daemon: ${e.message}`); return back(); }
    voiceInfo = v;
    if (!v.backend) { flash(`no voice here: ${v.why}`, 6000); return back(); }
    const kokoro = v.engine === "kokoro";
    const opts = [{ label: "Default", hint: kokoro ? `Kokoro's ${v.kokoro?.defaultVoice || "af_heart"}` : "the system's voice", value: "" },
      ...v.voices.map((n) => ({ label: n, hint: kokoro ? KOKORO_KIND[n.slice(0, 2)] : "", value: n }))];
    pick(`Voice (${v.backend})`, opts, (o) => { cfg.voiceName = o.value; saveCfg(); back(); }, { selected: Math.max(0, opts.findIndex((o) => o.value === cfg.voiceName)) });
  }
  // Kokoro (the neural voice, once `axa voice install kokoro` has run) or the computer's own voices
  async function pickEngine(back) {
    let v;
    try { v = await call("/api/voice"); } catch (e) { flash(`couldn't ask the daemon: ${e.message}`); return back(); }
    voiceInfo = v;
    const ok = !!v.kokoro?.installed, now = v.engine || "system";
    const opts = [
      { label: "Kokoro", hint: ok ? `neural, offline${now === "kokoro" ? " · in use" : ""}` : "not installed: run axa voice install kokoro", value: "kokoro", dim: !ok },
      { label: "System", hint: `your computer's own voices${v.system ? ` (${v.system})` : ""}${now === "system" ? " · in use" : ""}`, value: "system" },
    ];
    pick("Voice engine", opts, (o) => {
      if (o.value === "kokoro" && !ok) { flash("Kokoro isn't installed: run  axa voice install kokoro  in a terminal", 7000); return back(); }
      if (o.value !== now) { cfg.voiceEngine = o.value; cfg.voiceName = ""; stopVoice(); saveCfg(); voiceInfo = { ...v, engine: o.value }; }
      back();
    }, { selected: now === "kokoro" ? 0 : 1 });
  }
  function settings(start = 0) {
    const opts = () => [
      { label: "Theme", hint: cfg.theme, value: "theme" },
      { label: "Prefix key", hint: keyName(), value: "prefix" },
      { label: "Icons", hint: cfg.icons === "nerd" ? "Nerd Font" : "plain Unicode", value: "icons" },
      { label: "Bell when a session needs you", hint: cfg.bell ? "on" : "off", value: "bell" },
      { label: "Motion (map animation)", hint: motionNow() + (envReduced && cfg.motion === "full" ? " (AXA_REDUCED_MOTION)" : ""), value: "motion" },
      { label: "Voice (reads AXA's replies aloud)", hint: (voiceOn() ? "on" : "off") + (voiceEnv ? " (AXA_VOICE)" : ""), value: "voice" },
      { label: "Voice engine", hint: voiceInfo ? (voiceInfo.engine === "kokoro" ? "Kokoro" : "System") + (voiceInfo.kokoro?.installed ? "" : " (Kokoro: not installed)") : cfg.voiceEngine === "kokoro" ? "Kokoro" : cfg.voiceEngine === "system" ? "System" : "automatic", value: "voiceEngine" },
      { label: "Voice name", hint: cfg.voiceName || (voiceInfo?.engine === "kokoro" ? "af_heart" : "default"), value: "voiceName" },
      { label: "Voice speed", hint: SPEEDS[cfg.voiceRate] || "normal", value: "voiceRate" },
      { label: "Say when there's more on screen", hint: cfg.voiceMoreHint === false ? "off" : "on", value: "voiceMoreHint" },
      { label: "Test the voice", hint: "says \"AXA voice check.\"", value: "voiceTest" },
      { label: "Speak notifications", hint: NOTIFY_HINT[cfg.notify?.voice || "needs-you"], value: "notifyVoice" },
      { label: "Desktop notifications", hint: NOTIFY_HINT[cfg.notify?.desktop || "needs-you"], value: "notifyDesktop" },
    ];
    const cycle = (arr, v) => arr[(arr.indexOf(v) + 1) % arr.length];
    const again = (selected) => pick("Settings (Enter changes)", opts(), (o) => {
      if (o.value === "theme") { cfg.theme = cycle(THEME_NAMES, cfg.theme); setTheme(cfg.theme); }
      if (o.value === "icons") { cfg.icons = cfg.icons === "nerd" ? "plain" : "nerd"; setIcons(cfg.icons); }
      if (o.value === "prefix") cfg.prefix = cycle(Object.keys(PREFIXES), cfg.prefix);
      if (o.value === "bell") cfg.bell = !cfg.bell;
      if (o.value === "motion") { cfg.motion = cycle(MOTIONS, MOTIONS.includes(cfg.motion) ? cfg.motion : "full"); setMotion(motionNow()); }
      if (o.value === "voice") { if (voiceEnv) flash(`voice is forced ${voiceEnv} by AXA_VOICE`); else { cfg.voice = voiceOn() ? "off" : "on"; if (cfg.voice === "off") stopVoice(); } }
      if (o.value === "notifyVoice") cfg.notify = { ...cfg.notify, voice: cycle(NOTIFY_LEVELS, cfg.notify?.voice || "needs-you") };
      if (o.value === "notifyDesktop") cfg.notify = { ...cfg.notify, desktop: cycle(NOTIFY_LEVELS, cfg.notify?.desktop || "needs-you") };
      if (o.value === "voiceMoreHint") cfg.voiceMoreHint = cfg.voiceMoreHint === false;
      if (o.value === "voiceRate") cfg.voiceRate = cfg.voiceRate >= 2 ? -2 : (Math.round(Number(cfg.voiceRate)) || 0) + 1;
      if (o.value === "voiceTest") call("/api/voice/test", { method: "POST" }).then(() => flash("speaking…"), (e) => flash(`no voice: ${e.message}`));
      saveCfg(); prevRows = [];
      if (o.value === "voiceName") return pickVoice(() => again(opts().findIndex((x) => x.value === "voiceName")));
      if (o.value === "voiceEngine") return pickEngine(() => again(opts().findIndex((x) => x.value === "voiceEngine")));
      again(opts().findIndex((x) => x.value === o.value));
    }, { selected, hint: `Enter changes · Esc done · saved in ${tilde(files.ui)}` });
    // the engine row needs the daemon's view (is Kokoro installed?); don't hold the overlay up for long
    Promise.race([call("/api/voice").then((v) => { voiceInfo = v; }, () => {}), new Promise((r) => setTimeout(r, 1500))]).then(() => again(start));
  }
  function help() {
    const k = keyName();
    viewer("AXA keys", [
      { text: "The hub", role: "head" },
      { text: "  Tab / Shift-Tab or 1-5   move between Control, Sessions, Chats, Agents, Projects" },
      { text: "  Control: ↑/↓ pick a session (or click it on the map or table) · : talk to the commander" },
      { text: "  ↑/↓ or j/k, PgUp/PgDn    move in a panel        Enter   open the selected thing" },
      { text: "  a   the AXA commander (opens it, or starts it)   N   new session (pick a folder)" },
      { text: "  n   notifications (newest first: Enter goes to the session, c clears; the bell counts the unread)" },
      { text: "  /   filter the panel     y / x   answer the prompt in the yellow bar   !  go to it" },
      { text: "  o   web console          ,  settings             q   quit (sessions keep running)" },
      { text: "  Control: m   voice on/off (AXA reads its replies aloud) · Esc stops it speaking" },
      { text: "" },
      { text: "Mouse", role: "head" },
      { text: "  Control: click the commander's box (or its conversation) to talk to AXA · ⏎ send sends" },
      { text: "           click anywhere else, or Esc, to stop typing" },
      { text: "  Drag over the commander's text to copy it · double-click a message to copy all of it" },
      { text: "  Click a tab, a session, a chat, any key hint in the footer, or the NEEDS YOU chip (jumps there)" },
      { text: "  Approve takes two clicks (the button reads \"click again to approve\"); Decline takes one" },
      { text: "  Popups: click an item to select it, click it again (or double-click) to choose; ✕ or a click outside closes" },
      { text: "  Shift+drag uses your terminal's own selection instead" },
      { text: "" },
      { text: "Sessions panel", role: "head" },
      { text: "  Enter open live · d changes (diff) · g give a goal · v run checks · r rename · X close" },
      { text: "Chats panel", role: "head" },
      { text: "  Enter resume the chat in a live session (● = already open: it jumps there)" },
      { text: "Agents", role: "head" },
      { text: "  Enter give it a task (the commander runs it with that agent); the preview shows its instructions" },
      { text: "Projects panel", role: "head" },
      { text: "  Enter open its session (or start one) · N new · w new in its own worktree · s shell" },
      { text: "" },
      { text: `Inside a session (everything you type goes to it; ${k} then a key is for AXA)`, role: "head" },
      { text: `  ${k} h   back to the hub (the session keeps running)` },
      { text: `  ${k} n / p   next / previous session      ${k} a   the commander` },
      { text: `  ${k} y / x   answer the prompt in the yellow bar      ${k} !   go to it` },
      { text: `  ${k} d   changes · g goal · v checks · i paste an image · r rename · X close · q quit` },
      { text: `  ${k} ${k}   sends a literal ${k} to the session` },
      { text: "  Ctrl+V or Alt+V   pastes an image from your clipboard if there is one (else its text)" },
      { text: "  On Control: press : then Alt+V (or Ctrl+V) to attach a clipboard image for the commander" },
      { text: "  Mouse: scroll goes to the session; drag selects and copies (Shift+drag: your terminal's own)" },
      { text: "" },
      { text: "Voice", role: "head" },
      { text: "  AXA speaks the commander's finished replies (the short version) with your computer's own voices." },
      { text: "  m on Control or , settings turns it on; pick the voice and speed there; AXA_VOICE=1/0 forces it." },
      { text: "  A better, offline neural voice: axa voice install kokoro (then Voice engine in , settings switches)." },
      { text: "  To talk back, turn on Claude Code's hold-to-talk dictation (/config, \"voiceEnabled\") in the commander." },
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
  // Control: a clipboard image (saved in the pastes folder) or its text goes into the commander box
  async function pasteForCommander() {
    if (screen !== "hub" || overlay || PANELS[focus] !== "control") return flash("press : on Control to talk to AXA, then Alt+V");
    let file;
    try { mkdirSync(files.pastes, { recursive: true, mode: 0o700 }); file = join(files.pastes, `paste-${new Date().toISOString().replace(/[:.]/g, "-")}.png`); }
    catch (e) { return flash(`couldn't save the image: ${e.message}`); }
    flash("reading the clipboard…", 15000);
    const r = await readClipboard(file);
    if (r?.image) { cmdInput += `${file} `; focusInput = true; flash(`image attached: ${tilde(file)}`); }
    else if (r?.text) { cmdInput += r.text.replace(/\r?\n|\r/g, " "); focusInput = true; toast = null; }
    else flash("nothing to paste: copy an image first (on Windows: Win+Shift+S)");
    schedule();
  }
  // a bracketed paste in the hub or a dialog: the text goes into the open box and never sends
  function hubPaste(text) {
    if (!text.trim()) return pasteForCommander(); // an image-only clipboard pastes nothing
    const t = text.replace(/\r?\n|\r/g, " ");
    if (overlay && typeof overlay.input === "string") { overlay.input += t; return; }
    if (!overlay && screen === "hub" && PANELS[focus] === "control") { focusInput = true; cmdInput += t; return; }
    flash("press : on Control to talk to AXA, then paste");
  }

  // ---------- keys ----------
  const current = () => items(PANELS[focus])[sel[PANELS[focus]]];
  const selectedSession = () => { const it = current(); return it?.kind === "session" ? it.s : null; };
  async function sendToCommander(text) {
    const c = commander();
    if (c && ["ready", "done"].includes(c.status) && !c.awaiting_permission) {
      try { await call(`/api/terms/${c.id}/input`, { method: "POST", body: { text } }); flash("sent to the commander"); } catch (e) { flash(`couldn't send: ${e.message}`); }
      return;
    }
    if (c) { pendingSend = { id: c.id, text }; return flash("the commander is busy: it gets this as soon as it's free", 5000); }
    const cwd = inHome(process.cwd()) ? process.cwd() : homedir();
    try { const s = await call("/api/terms", { method: "POST", body: { mode: "axa", cwd, cols: W, rows: H - 1 } }); pendingSend = { id: s.id, text }; flash("starting the commander; it gets your message when it's ready", 6000); await pollSessions(); }
    catch (e) { flash(`couldn't start the commander: ${e.message}`); }
  }
  function controlKey(k) {
    if (focusInput) {
      if (k === "\x1b[5~") { cmdScroll += 8; return true; }
      if (k === "\x1b[6~") { cmdScroll = Math.max(0, cmdScroll - 8); return true; }
      if (k === "\r") { const t = cmdInput.trim(); if (t) { sendToCommander(t); cmdInput = ""; } focusInput = false; return true; }
      if (k === ESC) { focusInput = false; return true; }
      if (k === "\x7f" || k === "\b") { cmdInput = [...cmdInput].slice(0, -1).join(""); return true; }
      if (k === "\x15") { cmdInput = ""; return true; }
      if (!k.startsWith(ESC) && k >= " ") { cmdInput += k; return true; }
      return true;
    }
    const o = ctlOrder(), cur = ctlSelected(), i = Math.max(0, o.findIndex((s) => s.id === cur?.id));
    const go = (d) => { if (o.length) ctlSel = o[Math.max(0, Math.min(o.length - 1, i + d))].id; };
    const nChats = Math.min(data.chats.length, 9);
    if (k === "\x1b[5~") { cmdScroll += 8; return true; }
    if (k === "\x1b[6~") { cmdScroll = Math.max(0, cmdScroll - 8); return true; }
    if (k === "\x1b[F" || k === "\x1b[4~") { cmdScroll = 0; return true; }
    switch (k) {
      case ":": case "i": case "c": focusInput = true; return true;
      case "\x1b[C": case "l": zone = "chats"; return true;
      case "\x1b[D": case "h": zone = "map"; return true;
      case "\x1b[A": case "k": if (zone === "chats") chatSel = Math.max(0, chatSel - 1); else go(-1); return true;
      case "\x1b[B": case "j": if (zone === "chats") chatSel = Math.min(Math.max(0, nChats - 1), chatSel + 1); else go(1); return true;
      case "\r": case " ":
        if (zone === "chats") { const c = data.chats[chatSel]; if (c) resumeChat(c); return true; }
        if (cur) openLive(cur); else openCommander();
        return true;
    }
    if (k === ESC) stopVoice(); // Esc hushes AXA's voice
    if (zone === "chats" && k === ESC) { zone = "map"; return true; }
    if (k === "m") { toggleVoice(); return true; }
    if (cur && { d: 1, g: 1, v: 1, r: 1, X: 1 }[k]) { ({ d: showDiff, g: giveGoal, v: runVerify, r: rename, X: closeSession })[k](cur); return true; }
    return false;
  }
  function hubKey(k) {
    const panel = PANELS[focus], list = items(panel);
    if (panel === "control" && controlKey(k)) return;
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
      case "1": case "2": case "3": case "4": case "5": focus = Number(k) - 1; return;
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
      case "n": return openNotifications();
      case "N": return panel === "projects" && it?.kind === "project" ? newSession(it.p) : newSession();
      case "y": return answerAlert("yes");
      case "x": return answerAlert("no");
      case "!": { const w = waitingOthers()[0]; return w ? openLive(w) : flash("nothing is waiting on you"); }
      case "R": return pollHub().then(() => flash("refreshed"));
      case "\r": case " ":
        if (!it) return;
        if (it.kind === "commander-off") return openCommander();
        if (it.kind === "session") return openLive(it.s);
        if (it.kind === "chat") return resumeChat(it.c);
        if (it.kind === "agent") return useAgent(it.a);
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
  // the commander's text: press starts a selection, a drag (32) extends it, release copies it;
  // a double-click on a message copies the whole message. true when the event was ours.
  function cmdMouse(b, x, by, up) {
    const lines = ctl.cmdText || [];
    if (b === 32 && cmdSel && !cmdSel.done) { cmdSel.endRow = by; cmdSel.endCol = x; cmdSel.dragged = true; return true; }
    if (b === 0 && up && cmdSel && !cmdSel.done) {
      const text = cmdSel.dragged ? selectedText(lines, cmdSel) : "";
      if (!text) { if (!cmdSel.dragged) focusInput = true; cmdSel = null; return true; } // a click, not a drag: talk to AXA
      copyToClipboard(text);
      const n = [...text].length;
      flash(`copied ${n} character${n === 1 ? "" : "s"}`);
      const mine = (cmdSel.done = Date.now());
      setTimeout(() => { if (cmdSel?.done === mine) { cmdSel = null; schedule(); } }, 1000); // the highlight lingers a moment
      return true;
    }
    if (b !== 0 || up) return false;
    cmdSel = null;
    const inText = x > (ctl.midL ?? ctl.L) + 1 && by >= ctl.cmdTop && by < ctl.cmdBottom && lines.length && by >= lines[0].row && by <= lines.at(-1).row;
    if (!inText) { if (!inCommander(x, by)) return false; focusInput = true; return true; } // the box, the header, blank rows
    const l = lines.find((t) => t.row === by);
    if (l && l.msg >= 0 && cmdMsgs[l.msg]) {
      const again = Date.now() - lastClick.at < 450 && lastClick.i === `msg:${l.msg}`;
      lastClick = { at: again ? 0 : Date.now(), panel: "control", i: `msg:${l.msg}` };
      if (again) { const t = msgText(cmdMsgs[l.msg].text); if (t) { copyToClipboard(t); flash("copied the message"); } return true; }
    }
    cmdSel = { startRow: by, startCol: x, endRow: by, endCol: x, scroll: cmdScroll, dragged: false, done: 0 };
    return true;
  }
  // the commander panel on Control (x 1-based, by a body row)
  const inCommander = (x, by) => x > (ctl.midL ?? ctl.L) && by >= ctl.cmdTop && by < ctl.cmdBottom;
  const onControl = () => screen === "hub" && !overlay && PANELS[focus] === "control" && ctl.y0;
  // a click on an Approve button (the alert bar's y, the Approvals panel's, the footer's y)
  function onApprove(x, y) {
    if (overlay) return false;
    if (alertY && y === alertY) return hitAt(alertHits, x, y)?.k === "yes";
    if (screen !== "hub") return false;
    if (footY && y === footY) return hitAt(footHits, x, y)?.k === "y";
    return !!onControl() && hitAt(ctl.apHits || [], x, y - ctl.y0)?.which === "yes";
  }
  // answer the prompt shown in the yellow bar by mouse: decline at once; approve on the second click, and
  // only if it's still the same prompt. Same path as the y/x keys (answerAlert).
  function clickAnswer(which) {
    const s = waitingOthers()[0];
    if (!s) { approveArm.disarm(); return flash("nothing is waiting on you"); }
    if (which === "no") { approveArm.disarm(); return answerAlert("no", s); }
    if (approveArm.press(armKey(s)) === "fire") return answerAlert("yes", s);
    setTimeout(schedule, 4050); // the button goes back to normal when it disarms
  }
  // a footer hint: the same as pressing its key
  function footerClick(k) {
    if (k === "y" || k === "x") return clickAnswer(k === "y" ? "yes" : "no");
    if (k === "drag") return flash("drag over the commander's text to copy it");
    const key = hintKey(k);
    if (!key) return;
    if (focusInput && !["⏎", "Esc"].includes(k)) focusInput = false; // help, quit… while typing: stop typing first
    hubKey(key);
  }
  function onMouse(b, x, y, up) {
    const press = b === 0 && !up;
    if (press && !onApprove(x, y)) approveArm.disarm(); // any other click disarms Approve
    if (overlay) {
      const ov = overlay;
      if (b === 64 || b === 65) { ov.scroll = (ov.scroll || 0) + (b === 64 ? -3 : 3); ov.follow = undefined; return schedule(); }
      if (!press || !ov.geo) return;
      const h = overlayHit(ov.geo, x, y);
      if (h.kind === "outside" || h.kind === "close") overlayKey(ESC); // like Esc
      else if (h.kind === "more") { ov.scroll = (ov.scroll || 0) + ov.geo.listH; ov.follow = undefined; }
      else if (h.kind === "item" && ov.pickAt) ov.pickAt(h.i);
      return schedule();
    }
    // the yellow bar (in the hub and above a live session): y approves (two clicks), x declines, the rest goes there
    if (alertY && y === alertY) {
      const h = press && hitAt(alertHits, x, y);
      if (h?.k === "yes" || h?.k === "no") clickAnswer(h.k);
      else if (h?.k === "go") { const w = waitingOthers()[0]; if (w) openLive(w); }
      return schedule();
    }
    if (screen === "live") {
      if (y === 1) { if (!up && b === 0 && x <= 14) toHub(); return; }
      if (live && y > live.top && !live.dead) live.mouse(b, x, y - live.top, up);
      return;
    }
    if (footY && y === footY) { const h = press && hitAt(footHits, x, y); if (h) footerClick(h.k); return schedule(); }
    // a click outside the commander panel stops typing to it
    if (press && focusInput && !(onControl() && inCommander(x, y - ctl.y0))) focusInput = false;
    if (y === 1) {
      const th = press && hitAt(titleHits, x, y);
      if (th?.k === "bell") { openNotifications(); return schedule(); }
      if (th) { const w = data.sessions.filter((s) => ["waiting", "needs_trust", "stuck"].includes(s.status)).sort(byUrgency)[0]; if (w) openLive(w); }
      return schedule();
    }
    if (y === 2) { const t = tabHits.find((h) => x >= h.x0 && x <= h.x1); if (t && press) focus = t.i; return schedule(); }
    if (PANELS[focus] === "control" && ctl.y0) {
      const by = y - ctl.y0; // body row (0-based)
      if ((b === 64 || b === 65) && inCommander(x, by)) { cmdScroll = Math.max(0, cmdScroll + (b === 64 ? 3 : -3)); cmdSel = null; return schedule(); }
      // the wheel over the recent chats picks one
      if ((b === 64 || b === 65) && ctl.tableTop && by >= ctl.tableTop - 1 && x <= Math.round(ctl.L * 0.55)) { zone = "chats"; chatSel = Math.max(0, Math.min(Math.min(data.chats.length, 9) - 1, chatSel + (b === 64 ? -1 : 1))); return schedule(); }
      if (press) {
        const a = hitAt(ctl.apHits || [], x, by);
        if (a) { clickAnswer(a.which); return schedule(); }
        // the send button at the end of the input line
        if (by === ctl.inputRow && ctl.sendHit && x >= ctl.sendHit.x0 && x <= ctl.sendHit.x1) {
          focusInput = true;
          if (cmdInput.trim()) controlKey("\r");
          return schedule();
        }
      }
      if (cmdMouse(b, x, by, up)) return schedule();
      if (b !== 0 || up) return;
      const m = ctl.mapHits.find((h) => by - ctl.mapTop >= h.row0 && by - ctl.mapTop <= h.row1 && x - 2 >= h.col0 && x - 2 <= h.col1);
      const c = x <= Math.round(ctl.L * 0.55) && ctl.chatHits.find((h) => by - ctl.tableTop === h.row);
      if (c) {
        const again = Date.now() - lastClick.at < 450 && lastClick.i === `chat:${c.i}`;
        zone = "chats"; chatSel = c.i; lastClick = { at: Date.now(), panel: "control", i: `chat:${c.i}` };
        if (again && data.chats[c.i]) resumeChat(data.chats[c.i]);
        return schedule();
      }
      if (m?.agent) return openAgent(m.id, m.agent);
      const id = m?.id;
      if (!id) return;
      zone = "map";
      if (id === "commander") return openCommander();
      const again = Date.now() - lastClick.at < 450 && lastClick.i === id;
      ctlSel = id; lastClick = { at: Date.now(), panel: "control", i: id };
      if (again) { const s = data.sessions.find((x) => x.id === id); if (s) openLive(s); }
      return schedule();
    }
    // the wheel anywhere over a list moves its selection
    if ((b === 64 || b === 65) && listArea && y >= listArea.y0 && y <= listArea.y1 && x >= listArea.x0 && x <= listArea.x1) {
      const n = items(listArea.panel).length;
      sel[listArea.panel] = Math.max(0, Math.min(n - 1, sel[listArea.panel] + (b === 64 ? -1 : 1)));
      return schedule();
    }
    const hit = hits.find((h) => y === h.y && x >= h.x0 && x <= h.x1);
    if (!hit) return;
    const p = PANELS.indexOf(hit.panel);
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
  const PS = `${ESC}[200~`, PE = `${ESC}[201~`;
  let pasteBuf = "";
  // inside a session: an empty paste (an image-only clipboard) or Alt+V pastes the clipboard image
  const livePasteImage = () => { if (pasting) return; pasting = pasteImage().finally(() => { pasting = null; const rest = held.splice(0).join(""); if (rest) sendLive(rest); }); };
  process.stdin.on("data", (buf) => {
    let d = pasteBuf + decoder.write(buf);
    pasteBuf = "";
    // a paste split across chunks: hold it until its end marker arrives
    const ps = d.lastIndexOf(PS);
    if (ps >= 0 && d.indexOf(PE, ps) < 0) { pasteBuf = d.slice(ps); d = d.slice(0, ps); if (!d) return; }
    if (screen === "live" && !overlay) {
      // tmux forwards real pastes; only the empty one and Alt+V are ours
      if (d.includes(PS + PE) || d === "\x1bv") { d = d.split(PS + PE).join(""); if (d === "\x1bv") d = ""; livePasteImage(); }
    } else {
      d = d.replace(/\x1b\[200~([\s\S]*?)\x1b\[201~/g, (_, t) => { hubPaste(t); return ""; });
      if (d === "\x1bv" || (d === "\x16" && screen === "hub" && !overlay && PANELS[focus] === "control")) { d = ""; pasteForCommander(); }
    }
    d = d.replace(MOUSE, (_, b, x, y, m) => { onMouse(Number(b), Number(x), Number(y), m === "m"); return ""; });
    if (!d) return;
    cmdSel = null; // a key clears the commander selection
    approveArm.disarm(); // and an armed Approve
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
  const enter = () => { out.write(`${ESC}[?1049h${ESC}[?2004h${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h${ESC}[?25l${ESC}[2J`); process.stdin.setRawMode(true); process.stdin.resume(); };
  const leave = () => { out.write(`${ESC}[?2004l${ESC}[?1002l${ESC}[?1000l${ESC}[?1006l${ESC}[0m${ESC}[?25h${ESC}[?1049l`); try { process.stdin.setRawMode(false); } catch {} };
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
  pollNotes();
  setInterval(pollNotes, 3000);
  // the commander's conversation: refreshed while Control is open, and right after it finishes a turn
  let cmdLast = "";
  const pollCommander = async () => {
    const c = commander();
    if (!c?.chat) { if (!c) cmdMsgs = []; return; }
    const key = `${c.chat}:${c.status}:${c.last_event_at}`;
    if (key === cmdLast && cmdChat === c.chat) return;
    try {
      const m = await call(`/api/chats/${c.chat}/messages?limit=40`);
      const grew = m.length !== cmdMsgs.length || m.at(-1)?.text !== cmdMsgs.at(-1)?.text;
      cmdMsgs = m; cmdChat = c.chat; cmdLast = key;
      if (grew) { cmdScroll = 0; cmdSel = null; } // a new message: back to the newest
      schedule();
    } catch {}
  };
  setInterval(() => { if (screen === "hub" && PANELS[focus] === "control") pollCommander(); }, 1500);
  const pollActivity = () => call("/api/activity?minutes=60&limit=80").then((a) => { act = a; schedule(); }, () => {});
  pollActivity();
  setInterval(() => { if (screen === "hub" && PANELS[focus] === "control") pollActivity(); }, 2000);
  // the map moves (pulses along links, agents circling)
  // Control's redraw: fast while something on the map moves (ctl.anim, set by the last draw), slow when
  // it's idle (breathing and the sweep), slower still with reduced motion; unchanged rows aren't rewritten
  const ctlTick = () => {
    const on = screen === "hub" && !overlay && PANELS[focus] === "control", m = motionNow();
    if (on) schedule();
    setTimeout(ctlTick, !on ? 400 : m !== "full" ? 1000 : ctl.anim ? 80 : 400);
  };
  ctlTick();
  setInterval(() => { if (screen === "hub" && !overlay) pollHub(); }, 5000);
  setInterval(schedule, 15000); // the clock
  // spinners turn while something works
  setInterval(() => { if (data.sessions.some((s) => s.status === "working" || s.status === "starting") || data.sessions.some((s) => (s.helpers || []).some((h) => h.status === "running"))) schedule(); }, 120);
  // a selected session's preview follows its screen
  setInterval(() => { if (screen === "hub" && !overlay && PANELS[focus] === "sessions") schedule(); }, 500);
}
