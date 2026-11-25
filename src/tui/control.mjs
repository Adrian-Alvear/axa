// The Control screen: AXA's mission control. Live lanes in the middle (one per session, the commander first:
// see lanes.mjs), metrics and activity on top, what needs your approval and the
// commander on the right, the sessions table and the log underneath.
import { areaChart } from "./canvas.mjs";
import { laneRows, laneSessions, needTally, needText } from "./lanes.mjs";
import { sliceAnsi } from "./ansi.mjs";
import { I, ago, chipOf, clean, cut, fitFirst, fmtTok, line, paint, plural, setMotion, sgrOf, spinner, width } from "./draw.mjs";
import { segSpans } from "./mouse.mjs";

// ---------- pieces ----------
// A framed panel: thin border, a small uppercase title, an optional tag at the right of the top edge
export function panel(title, w, h, body, { tag = "", on = false } = {}) {
  const fr = on ? "frameOn" : "frame";
  const t = ` ${title.toUpperCase()} `, tg = fitTag(tag, w - 4 - width(t));
  const top = paint(fr, "┌─") + paint(on ? "accent" : "dim", cut(t, w - 4)) + paint(fr, "─".repeat(Math.max(0, w - 4 - width(cut(t, w - 4)) - width(tg)))) + paint("dim", tg) + paint(fr, "─┐");
  const rows = [top];
  for (let i = 0; i < h - 2; i++) rows.push(paint(fr, "│") + (body[i] ?? " ".repeat(w - 2)) + paint(fr, "│"));
  rows.push(paint(fr, "└" + "─".repeat(Math.max(0, w - 2)) + "┘"));
  return rows;
}
// A panel's tag in the room its top edge leaves: whole " · " parts from the start, never cut mid-word
export function fitTag(tag, room) {
  const parts = String(tag || "").split(" · ").filter(Boolean);
  while (parts.length && width(` ${parts.join(" · ")} `) > room) parts.pop();
  return parts.length ? ` ${parts.join(" · ")} ` : "";
}
// The commander's hints, longest first: the widest that fits whole is shown
export const INPUT_HINTS = ["Click here or press : to talk to AXA…", "Press : to talk to AXA…", "Press : to talk to AXA", ": talk to AXA", ""];
export const APPROVE_HINTS = ["answer in the yellow bar: y yes · x no · ! go there", "in the yellow bar: y yes · x no · ! go there", "y yes · x no · ! go there", "y yes · x no", ""];
// Columns of panels side by side: each [rows, width]
const beside = (...cols) => cols[0][0].map((_, i) => cols.map(([rows, w]) => rows[i] ?? " ".repeat(w)).join(""));

// A segmented bar: ▮▮▮▮▯▯▯
const segBar = (frac, n, role) => paint(role, "▮".repeat(Math.round(frac * n))) + paint("frame", "▮".repeat(n - Math.round(frac * n)));

const wrap = (text, w) => {
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    let cur = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (width(cur) + width(word) + 1 > w && cur) { out.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) out.push(cur);
  }
  return out;
};

// Inline markdown to plain text: `code` kept without backticks (and left alone inside), links -> their
// text, **bold** / __bold__ and *italic* / _italic_ markers dropped. snake_case, file globs (*.mjs) and
// bullets are not emphasis and stay as they are.
export function mdInline(s) {
  const code = [];
  s = String(s ?? "").replace(/`+([^`]*?)`+/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`).replace(/`/g, "");
  s = s.replace(/\[([^\]]+)\]\([^)\s]*\)/g, "$1").replace(/\*\*/g, "");
  s = s.replace(/(^|[^\w])__(?=\S)(.+?)(?<=\S)__(?![\w])/g, "$1$2");
  s = s.replace(/(^|[\s(\["'])([*_])(?=[^\s*_./\\])([^*_\n]*?[^\s*_])\2(?=$|[\s.,;:!?)\]"'])/g, "$1$3");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => code[i]);
}

// Split a string into pieces of at most w columns (a word longer than its column is cut, not lost)
const hardSplit = (word, w) => {
  const out = [];
  let cur = "", cw = 0;
  for (const ch of word) { const c = width(ch); if (cw + c > w && cur) { out.push(cur); cur = ""; cw = 0; } cur += ch; cw += c; }
  if (cur) out.push(cur);
  return out;
};
// Word-wrap plain text to w columns; the first line starts after `lead`, the rest after `hang`
const wrapWords = (text, w, lead = "", hang = "") => {
  const out = [];
  let cur = lead;
  const fresh = () => cur === lead || cur === hang;
  for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
    if (!word) continue;
    const room = w - width(out.length ? hang : lead);
    for (const piece of width(word) > room && room > 0 ? hardSplit(word, room) : [word]) {
      if (!fresh() && width(cur) + 1 + width(piece) > w) { out.push(cur.trimEnd()); cur = hang; }
      cur += (fresh() ? "" : " ") + piece;
    }
  }
  out.push(cur.trimEnd());
  return out;
};

// ---------- markdown tables ----------
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isTableStart = (lines, i) => lines[i].includes("|") && lines[i + 1] != null && lines[i + 1].includes("|") && TABLE_SEP.test(lines[i + 1]);
const tableCells = (l) => l.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => mdInline(c.replace(/\\\|/g, "|")).replace(/\s+/g, " ").trim());
// A GitHub table as [text, role] lines at most w wide: an aligned grid when the columns fit (shrinking
// the widest first, none under 8), stacked cards (first cell as a title, then "header: value") otherwise
export function tableLines(head, rows, w) {
  const n = head.length, SEP = " │ ";
  rows = rows.map((r) => Array.from({ length: n }, (_, i) => r[i] ?? ""));
  const avail = w - 3 * (n - 1);
  const cols = head.map((h, i) => Math.max(1, width(h), ...rows.map((r) => width(r[i]))));
  const fits = cols.reduce((a, b) => a + b, 0) <= avail;
  if (fits || (n <= 4 && avail >= 8 * n)) {
    if (!fits) {
      // take a column at a time off the widest (never under 8) until the row fits
      let over = cols.reduce((a, b) => a + b, 0) - avail;
      while (over > 0) { const top = Math.max(...cols); const i = cols.indexOf(top); cols[i]--; over--; }
    }
    // a column too narrow for its words (up to 12 wide) would chop them: cards read better
    const longest = (i) => Math.min(12, Math.max(0, ...[head[i], ...rows.map((r) => r[i])].flatMap((c) => c.split(" ").map(width))));
    if (!fits && cols.some((c, i) => c < longest(i))) return tableCards(head, rows, w);
    const cellLines = (r) => r.map((c, i) => wrapWords(c, cols[i]));
    const rowOut = (r) => {
      const cl = cellLines(r), h = Math.max(...cl.map((x) => x.length));
      return Array.from({ length: h }, (_, k) => cl.map((x, i) => (x[k] ?? "") + " ".repeat(cols[i] - width(x[k] ?? ""))).join(SEP).trimEnd());
    };
    const body = rows.map(rowOut), gap = body.some((b) => b.length > 1);
    const out = rowOut(head).map((l) => [l, "head"]);
    out.push([cols.map((c) => "─".repeat(c)).join("─┼─"), "dim"]);
    body.forEach((b, k) => { if (k && gap) out.push(["", null]); for (const l of b) out.push([l, null]); });
    return out;
  }
  return tableCards(head, rows, w);
}
function tableCards(head, rows, w) {
  const n = head.length, out = [];
  rows.forEach((r, k) => {
    if (k) out.push(["", null]);
    for (const l of wrapWords(r[0] || "—", w)) out.push([l, "head"]);
    for (let i = 1; i < n; i++) {
      if (!r[i]) continue;
      const lead = `  ${head[i] || `#${i + 1}`}: `;
      for (const l of wrapWords(r[i], w, lead, "    ")) out.push([l, null]);
    }
  });
  return out;
}

// A chat message as [text, role] lines (role null: the message's own color; "head" for table headers
// and card titles, "dim" for rules): markdown cleaned up, line breaks and bullets kept (wrapped under
// their text), tables drawn as a grid or cards
export function msgLines(text, w) {
  const outL = [];
  const push = (t, role = null) => outL.push([t, role]);
  const blank = () => { if (outL.length && outL.at(-1)[0] !== "") push(""); };
  let inCode = false;
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    if (/^\s*```/.test(raw)) { inCode = !inCode; continue; }
    if (inCode) { push("  " + cut(raw.replace(/\t/g, "  "), w - 2)); continue; }
    if (isTableStart(lines, i)) {
      const head = tableCells(raw), rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) rows.push(tableCells(lines[i]));
      i--;
      blank();
      for (const l of tableLines(head, rows, w)) outL.push(l);
      if (i + 1 < lines.length && lines[i + 1].trim()) push("");
      continue;
    }
    raw = raw.replace(/^#{1,6}\s+/, "");
    if (!raw.trim()) { blank(); continue; }
    const m = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(raw);
    const lead = m ? `${m[1]}${/\d/.test(m[2]) ? m[2] : "•"} ` : "", hang = " ".repeat(width(lead));
    for (const l of wrapWords(mdInline(m ? m[3] : raw), w, lead, hang)) push(l);
  }
  while (outL.length && outL.at(-1)[0] === "") outL.pop();
  return outL;
}
export const wrapMsg = (text, w) => msgLines(text, w).map(([t]) => t);

// A message's whole text for copying: markdown cleaned like wrapMsg, but not wrapped
export const msgText = (text) => wrapMsg(text, Infinity).join("\n");

// ---------- select to copy in the commander ----------
// lines: [{ row, col0, text }] (screen rows/cols, col0 = where the text starts); sel: { startRow, startCol,
// endRow, endCol } in the same coordinates, either direction. selRange(l, sel) is the [from, to) of l's
// characters that are selected (null when none); selectedText(lines, sel) the selected text.
const orderSel = (s) => (s.endRow < s.startRow || (s.endRow === s.startRow && s.endCol < s.startCol) ? { startRow: s.endRow, startCol: s.endCol, endRow: s.startRow, endCol: s.startCol } : s);
const colIdx = (chars, c) => { let w = 0; for (let i = 0; i < chars.length; i++) { w += width(chars[i]); if (c < w) return i; } return chars.length; };
export function selRange(l, sel) {
  if (!sel) return null;
  const s = orderSel(sel), chars = [...l.text];
  if (l.row < s.startRow || l.row > s.endRow) return null;
  const from = l.row === s.startRow ? colIdx(chars, Math.max(0, s.startCol - l.col0)) : 0;
  const to = l.row === s.endRow ? (s.endCol < l.col0 ? 0 : Math.min(chars.length, colIdx(chars, s.endCol - l.col0) + 1)) : chars.length;
  return to > from ? [from, to] : null;
}
export function selectedText(lines, sel) {
  if (!sel) return "";
  const s = orderSel(sel), out = [];
  for (const l of [...lines].sort((a, b) => a.row - b.row)) {
    if (l.row < s.startRow || l.row > s.endRow) continue;
    const r = selRange(l, s);
    out.push(r ? [...l.text].slice(r[0], r[1]).join("").trimEnd() : "");
  }
  while (out.length && !out[0]) out.shift();
  while (out.length && !out.at(-1)) out.pop();
  return out.join("\n");
}

// ---------- what an event says, in plain words ----------
const PLUMBING = /^(ToolSearch|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskOutput|EnterPlanMode|ExitPlanMode)$/;
function said(e) {
  const s = clean(e.summary || "");
  switch (e.event) {
    case "UserPromptSubmit": return /^\s*(\[AXA supervisor|<task-notification>)/.test(e.prompt || "") ? ["woke up to check its sessions", "accent"] : [`got: ${clean(e.prompt)}`, "accent"];
    case "PreToolUse": {
      if (e.skill) return [`using the ${e.skill} skill`, "violet"];
      if (!e.tool || PLUMBING.test(e.tool)) return null;
      if (e.tool === "Agent" || e.tool === "Task") return [`started ${e.subagent_type || "a helper"}: ${s}`, "violet"];
      const m = /^mcp__(.+?)__(.+)$/.exec(e.tool);
      if (m) return [`${m[2].replace(/_/g, " ")} (${m[1].replace(/^plugin_/, "")})`, "text"];
      return [{ Bash: `ran ${s}`, Read: `read ${s}`, Edit: `edited ${s}`, Write: `wrote ${s}`, Grep: `searched ${s}`, Glob: `looked for ${s}`, WebSearch: `searched the web: ${s}`, WebFetch: `read ${s}` }[e.tool] || `${e.tool} ${s}`, e.agent_id ? "dim" : "text"];
    }
    case "PostToolUseFailure": return [`${e.tool || "a step"} failed: ${clean(e.error)}`, "stuck"];
    case "SubagentStop": return [`${String(e.agent_type || "helper").split(":").pop()} finished`, "done"];
    case "AxaDecision": return e.decision === "allow" ? [`approved: ${clean(e.reason)}`, "dim"] : e.decision === "deny" ? [`declined: ${clean(e.reason)}`, "stuck"] : [`needs you: ${clean(e.reason)}`, "wait"];
    case "PolicyDecision": return e.decision === "deny" ? [`policy refused: ${clean(e.reason)}`, "stuck"] : null;
    case "Stop": return [`finished${e.message ? `: ${clean(e.message)}` : ""}`, "done"];
    case "VerifyGate": return ["sent back to check its work", "waitSoft"];
    case "UserAnswer": return [`you answered: ${clean(e.answer)}`, "accent"];
    case "SupervisorWake": return ["woke the commander", "accent"];
    case "ChainFired": return [`link fired → ${clean(e.to)}`, "accent"];
    case "MilestoneReview": return [clean(e.summary || "milestone review"), { approve: "done", warn: "waitSoft", block: "stuck", error: "stuck" }[e.verdict] || "accent"];
    case "Review": return [`review: ${e.verdict} (${e.findings ?? 0} finding${e.findings === 1 ? "" : "s"})${e.raw_verdict && e.raw_verdict !== e.verdict ? `, reviewer said ${e.raw_verdict}` : ""}`, { approve: "done", warn: "waitSoft", block: "stuck" }[e.verdict] || "dim"];
  }
  return null;
}

// consecutive entries with the same key become one, counted (n), keeping the latest
export function collapseRepeats(list, key) {
  const out = [];
  for (const x of list) { const last = out.at(-1); if (last && key(last) === key(x)) out[out.length - 1] = { ...x, n: last.n + 1 }; else out.push({ ...x, n: 1 }); }
  return out;
}
// "claude-opus-5-5-20261001" -> "Opus 5.5"; anything else as it came
export const modelName = (m) => {
  const x = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(String(m || ""));
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] ? `.${x[3]}` : ""}${x[4] ? " 1M" : ""}` : String(m || "");
};
const dur = (ms) => { const m = Math.floor(ms / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };

// the voice states the daemon reports (server.mjs voiceNow), and the status line's slot for them
export const VOICE_STATES = ["speaking", "speaking summary", "writing summary"];
const VOICE_SLOT = Math.max(width("voice on"), ...VOICE_STATES.map((s) => width(`🔊 ${s}`)));
const padTo = (s, n) => s + " ".repeat(Math.max(0, n - width(s)));
// AXA's own status line for the commander: mode · model · context · tokens · uptime · agents · sessions.
// Pieces drop from the right when it's narrow. `on` ("bar") draws it as a status bar.
export function axaStatusLine(cmd, sessions, w, maxRows = 2, { mode = "", on = null, voice = false, notifyMode = "live", usage = null } = {}) {
  const u = cmd.usage || {}, segs = [];
  // voice: true (on) or what it's doing now ("speaking summary"), in a slot as wide as the longest state so
  // nothing after it moves when it changes
  if (voice) segs.push([padTo(voice === true ? "voice on" : `🔊 ${voice}`, VOICE_SLOT), "accent"]);
  // interruptions held back (attention.mjs): shown whenever it isn't live
  // spending: every session's estimated cost, and the account's limits (official) when known
  if (usage && (usage.cost || usage.limits)) segs.push([[usage.cost ? `$${usage.cost < 10 ? usage.cost.toFixed(2) : Math.round(usage.cost)} est` : "", usage.limits || ""].filter(Boolean).join(" · "), "dim"]);
  if (notifyMode === "digest" || notifyMode === "quiet") segs.push([notifyMode === "digest" ? "◷ digest" : "◌ quiet", "waitSoft"]);
  if (mode) segs.push([`${mode.startsWith("plan") ? "⏸" : "⏵⏵"} ${mode}`, mode.startsWith("bypass") ? "stuck" : "accent"]);
  if (u.model) segs.push([`◆ ${modelName(u.model)}`, "accent"]);
  if (u.context) {
    const limit = /\[1m\]/i.test(u.model || "") || u.context > 200_000 ? 1_000_000 : 200_000, pct = Math.min(100, Math.round((u.context / limit) * 100));
    const n = 8, on = Math.round((pct / 100) * n);
    segs.push([`ctx ${"▰".repeat(on)}${"▱".repeat(n - on)} ${pct}% ${fmtTok(u.context)}/${fmtTok(limit)}`, pct >= 85 ? "stuck" : pct >= 65 ? "wait" : "text"]);
  }
  if (u.tokens) segs.push([`${fmtTok(u.tokens)} tok${u.cached ? ` (+${fmtTok(u.cached)} cached)` : ""}${u.budget ? ` of ${fmtTok(u.budget)}` : ""}`, u.over_budget ? "stuck" : "dim"]);
  if (cmd.created) segs.push([`up ${dur(Date.now() - cmd.created)}`, "dim"]);
  const hs = cmd.helpers || [], run = hs.filter((h) => h.status === "running").length;
  if (hs.length) segs.push([run ? `${spinner()} ${run} agent${run > 1 ? "s" : ""} running` : `✓ ${hs.length} agent${hs.length > 1 ? "s" : ""} done`, run ? "violet" : "dim"]);
  const ws = sessions.filter((s) => s.alive && s.mode !== "axa"), tally = needTally(sessions), busy = ws.filter((s) => s.status === "working").length;
  segs.push([[plural(ws.length, "session"), busy ? `${busy} working` : "", needText(tally)].filter(Boolean).join(" · "), tally.total ? "wait" : "dim"]);
  if (cmd.git?.branch) segs.push([`${I.branch} ${cmd.git.branch}`, "dim"]);
  // fit: whole pieces separated by " · ", wrapping onto up to `maxRows` rows
  const rows = [[[" ", ""]]]; let used = 1;
  for (const [t, role] of segs) {
    let cur = rows.at(-1);
    if (used + (cur.length > 1 ? 3 : 0) + width(t) > w - 1) {
      if (rows.length >= maxRows) break;
      rows.push((cur = [[" ", ""]])); used = 1;
    }
    if (cur.length > 1) { cur.push([" · ", "frame"]); used += 3; }
    cur.push([cut(t, w - 2), role]); used += width(cut(t, w - 2));
  }
  return rows.map((r) => line(r, w, [], on));
}

// The commander's agents worth showing: the running ones, then those that finished in the last 10 minutes
export const commanderAgents = (cmd) => (cmd?.helpers || []).filter((h) => h.status === "running" || Date.now() - h.at < 10 * 60_000).sort((a, b) => (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1) || a.start - b.start).slice(0, 8);
export const agentName = (h) => clean(h.desc) || String(h.type || "agent").split(":").pop();

// The popup for one agent: what it was asked, what it's doing now, its recent steps and its report
export function agentDetail(h, w) {
  const out = [], add = (text, role = "text") => out.push({ text, role });
  const running = h.status === "running";
  add(`${running ? `${spinner()} RUNNING` : "✓ DONE"} · ${String(h.type || "agent").split(":").pop()} · started ${ago(h.start) === "now" ? "just now" : `${ago(h.start)} ago`} · ${plural(h.calls || 0, "step")}`, running ? "violet" : "done");
  add("");
  if (running) { add("NOW", "dim"); for (const l of wrapMsg(h.doing || "thinking…", w - 2)) add(l, "head"); add(""); }
  const recent = [...(h.recent || [])].reverse();
  add(`RECENT ACTIONS${recent.length ? ` (${recent.length})` : ""}`, "dim");
  if (!recent.length) add("none recorded yet (actions show up as it works)", "dim");
  for (const r of recent) add(`${cut(ago(r.at), 8).padEnd(9)}${cut(clean(r.text), w - 11)}`);
  if (h.report) { add(""); add("REPORT", "dim"); for (const l of wrapMsg(h.report, w - 2)) add(l); }
  add(""); add("started by the AXA commander", "dim");
  return out;
}

// ---------- the whole screen ----------
// a log line's time (formatting a time is slow, and the lanes redraw ~12 times a second: each one once)
const times = new Map();
const timeOf = (ts) => {
  let t = times.get(ts);
  if (t === undefined) { if (times.size > 500) times.clear(); t = new Date(ts).toLocaleTimeString([], { hour12: false }); times.set(ts, t); }
  return t;
};
// ctx: { motion, sessions, chats, act, selId, zone, chatSel, focusInput, input, nameOf, question, yesOpt, noOpt, waiting, armed, mapHits, chatHits }
// it fills in what a click can hit: mapHits, chatHits, apHits (the approval buttons), cmdText, inputRow, sendHit
export function controlRows(ctx, W, B) {
  if (ctx.motion) setMotion(ctx.motion); // spinners follow the same setting
  const { sessions, act } = ctx;
  const alive = sessions.filter((s) => s.alive);
  const cnt = (st) => alive.filter((s) => s.mode !== "axa" && s.status === st).length;
  const L = Math.round(W * 0.62), R = W - L;
  const topH = B >= 30 ? 5 : 0, botH = Math.max(6, Math.min(12, Math.round(B * 0.27))), midH = B - topH - botH;
  const out = [];

  // top: metrics and activity
  if (topH) {
    const nActive = alive.filter((s) => s.mode !== "axa").length, nNeeds = needTally(sessions).total;
    const tiles = [["Active", nActive, "accent", "sessions open"], ["Working", cnt("working"), "work", "busy right now"], ["Needs you", nNeeds, nNeeds ? "wait" : "dim", "waiting on you"], ["Done today", act?.runs?.done ?? 0, "done", `of ${plural(act?.runs?.today ?? 0, "run")}`]];
    const tw = Math.floor((L - 2) / 4), max = Math.max(1, nActive);
    const cellW = (k) => (k === 3 ? L - 2 - tw * 3 : tw);
    const body = [
      tiles.map(([label, n, role], k) => line([[`  ${n}`, `1;${sgrOf(role)}`], [`  ${label.toUpperCase()}`, "dim"]], cellW(k))).join(""),
      tiles.map(([, n, role], k) => "  " + segBar(Math.min(1, n / (k === 3 ? Math.max(1, act?.runs?.today ?? 0) : max)), Math.max(4, Math.min(14, cellW(k) - 6)), role) + " ".repeat(Math.max(0, cellW(k) - 2 - Math.max(4, Math.min(14, cellW(k) - 6))))).join(""),
      tiles.map(([, , , sub], k) => line([[`  ${sub}`, "frame"]], cellW(k))).join(""),
    ];
    const pm = act?.perMinute || Array(60).fill(0), peak = Math.max(...pm), total = pm.reduce((a, b) => a + b, 0);
    const chart = areaChart(R - 4, 2, pm, { line: sgrOf("accent"), fill: sgrOf("frame") }).render();
    const abody = [...chart.map((r) => " " + r + " "), line([["60m ago", "frame"]], R - 2, [[`peak ${peak}/min · ${plural(total, "event")} · now`, "dim"]])];
    out.push(...beside([panel("Global status", L, topH, body, { tag: `${plural(act?.runs?.today ?? 0, "run")} today` }), L], [panel("Activity", R, topH, abody, { tag: "events / min" }), R]));
  }

  // middle: the live lanes, and approvals + the commander
  // no sessions and no commander agents: the commander gets the extra room
  const ls = laneSessions(sessions, ctx.selId), cmd = sessions.find((s) => s.mode === "axa" && s.alive);
  const midL = !ls.sessions && !commanderAgents(cmd).length ? Math.round(W * 0.38) : L, mR = W - midL;
  ctx.midL = midL;
  const map = laneRows(ctx, midL - 2, midH - 2);
  const nAgents = alive.reduce((n, s) => n + (s.helpers || []).filter((h) => h.status === "running").length, 0);
  const mapPanel = panel("Live", midL, midH, map, { tag: [plural(ls.sessions, "session"), needText(needTally(sessions)), ls.hidden ? `${ls.hidden} idle` : "", nAgents ? plural(nAgents, "agent") : ""].filter(Boolean).join(" · ") });
  const w = ctx.waiting;
  const apH = Math.min(midH - 6, w ? 13 : 3); // nothing waiting: a 3-row strip, the commander gets the rest
  const ab = [];
  const iw = mR - 2;
  if (w) {
    const opts = w.choices.options;
    // (one urgency component: the yellow bar above is where you answer; this panel shows the detail, quietly)
    ab.push(line([["  SESSION  ", "dim"], [ctx.nameOf(w), "head"]], iw));
    ab.push(line([["  WHERE    ", "dim"], [w.cwd.replace(process.env.HOME || "", "~"), "text"]], iw));
    ab.push(" ".repeat(iw));
    for (const l of wrap(ctx.question(w.choices), iw - 4).slice(0, Math.max(1, apH - 7 - Math.min(4, opts.length)))) ab.push(line([["  " + l, "wait"]], iw));
    for (const o of opts.slice(0, 4)) ab.push(line([[`   ${o.n}. ${clean(o.label)}`, "dim"]], iw));
    while (ab.length < apH - 3) ab.push(" ".repeat(iw));
    ab.length = apH - 3;
    ab.push(line([["  " + fitFirst(APPROVE_HINTS, iw - 2), "dim"]], iw));
  } else {
    ab.push(line([["  ✓ Nothing needs your approval", "done"], [` · ${act?.runs?.approvals ?? 0} handled by AXA today`, "dim"]], iw));
  }
  const apPanel = panel(w ? "Waiting on you" : "Approvals", mR, apH, ab, { tag: w ? `${ctx.waitingCount} waiting` : "" });
  // the commander: the conversation (yours and AXA's messages), scrollable, and a box to talk to it
  const chH = midH - apH, cb = [];
  // Claude Code's own status, mirrored from the commander's screen: the activity line above the input,
  // the status line(s) under it (mode, esc to interrupt, agents), in their own colors
  const cst = (cmd && ctx.cmdStatus) || { mode: "", activity: "", lines: [] };
  const mirror = (l) => sliceAnsi(" " + l.replace(/^\s+/, " "), 0, iw);
  const actRow = cst.activity ? [mirror(cst.activity)] : [];
  // the mode, model, context and tokens live in the full-width status bar at the bottom of the screen
  // up to 2 of Claude's footer lines; when only one fits, the mode line (⏵⏵ / ⏸) wins over a custom statusLine
  const nStat = chH >= 14 ? 2 : chH >= 12 ? 1 : 0, modeLine = cst.lines.find((l) => /⏵⏵|⏸/.test(l));
  const statRows = (nStat === 1 && modeLine ? [modeLine] : cst.lines.slice(0, nStat)).map(mirror);
  cb.push(line([["  ", ""], [`${I.axa} AXA`, "title"], [cmd?.status === "working" && cmd.doing ? `   ${spinner()} ${clean(cmd.doing)}` : "", "work"]], iw, [cmd ? chipOf(cmd) : [" OFF ", "chipOff"]]));
  const convo = [];
  const msgs = ctx.cmdMsgs || [];
  if (!cmd && !msgs.length) convo.push(["Offline. Type below (or press a) to start it.", "dim"]);
  else if (!msgs.length) convo.push([clean(cmd.last_report) || "Standing by. Tell me what you want done across your projects.", "text"]);
  for (const [k, m] of msgs.entries()) {
    // a console note (supervisor update, background agent done): one dim line, no header
    if (m.role === "system") { for (const l of wrapMsg(`⚙ ${m.notice ? "notice" : "supervisor"} · ${m.text}`, iw - 6).map((l, i) => (i ? "  " + l : l))) convo.push([l, "dim", k]); continue; }
    convo.push(["", "", k]);
    convo.push([m.role === "you" ? "You" : `${I.axa} AXA`, m.role === "you" ? "you" : "claude", k]);
    for (const [l, role] of msgLines(m.text, iw - 4)) convo.push([l, role || (m.role === "you" ? "text" : "idle"), k]);
  }
  const room = chH - 5 - actRow.length - statRows.length;
  const maxScroll = Math.max(0, convo.length - room);
  ctx.cmdScroll = Math.min(ctx.cmdScroll || 0, maxScroll);
  ctx.cmdMaxScroll = maxScroll;
  const end = convo.length - ctx.cmdScroll, shown = convo.slice(Math.max(0, end - room), end);
  // what's on screen, so a drag can be mapped to text (body rows; columns 1-based like mouse x)
  ctx.cmdText = [];
  const cmdTop = (topH || 0) + apH;
  for (const [t, role, msg = -1] of shown) {
    const l = { row: cmdTop + 1 + cb.length, col0: midL + 4, text: t, msg };
    ctx.cmdText.push(l);
    const r = selRange(l, ctx.cmdSel), ch = [...t];
    cb.push(line(r ? [["  " + ch.slice(0, r[0]).join(""), role], [ch.slice(r[0], r[1]).join(""), "sel"], [ch.slice(r[1]).join(""), role]] : [["  " + t, role]], iw));
  }
  while (cb.length < chH - 4 - actRow.length - statRows.length) cb.push(" ".repeat(iw));
  cb.push(...actRow);
  const prompt = ctx.focusInput ? ctx.input + "▏" : ctx.input || fitFirst(INPUT_HINTS, iw - 14);
  cb.push(paint("frame", " " + "─".repeat(iw - 2) + " "));
  // the input line, with a send button at its right end (clickable; dim while there's nothing to send)
  const inSegs = [[" › ", "accent"], [ctx.focusInput || ctx.input ? cut(prompt.slice(-(iw - 16)), iw - 14) : prompt, ctx.focusInput || ctx.input ? "head" : "dim"]], send = [[" ⏎ send ", (ctx.input || "").trim() ? "keycap" : "dim"]];
  ctx.inputRow = cmdTop + 1 + cb.length;
  ctx.sendHit = segSpans(inSegs, iw, send, midL + 2).right[0] || null;
  cb.push(line(inSegs, iw, send));
  cb.push(...statRows);
  const above = Math.max(0, end - room);
  const chPanel = panel("Commander", mR, chH, cb, { on: ctx.focusInput, tag: ctx.cmdScroll ? `↓ ${ctx.cmdScroll} newer · PgDn` : above ? `↑ ${above} more · PgUp` : "Enter sends" });
  ctx.cmdTop = (topH || 0) + apH; // body row where the commander panel starts
  ctx.cmdBottom = ctx.cmdTop + chH;
  const right = [...apPanel, ...chPanel];
  out.push(...mapPanel.map((r, i) => r + (right[i] ?? " ".repeat(mR))));
  ctx.mapTop = (topH ? topH : 0) + 1; // body row (0-based) where the map's canvas starts

  // bottom: recent chats, the agents at work, and the log
  const chW = Math.round(L * 0.55), agW = L - chW;
  const cb2 = [], ciw = chW - 2;
  const chats = ctx.chats.slice(0, botH - 2);
  chats.forEach((c, k) => {
    const sel = ctx.zone === "chats" && k === ctx.chatSel;
    cb2.push(line([[` ${c.open_in ? "●" : I.chat} `, c.open_in ? "work" : "dim"], [clean(c.title), sel ? "head" : "text"]], ciw, [[`${c.cwd === process.env.HOME ? "~" : c.project} · ${ago(c.updated)}`, "dim"]], sel ? "sel" : null));
    ctx.chatHits.push({ row: k, i: k });
  });
  if (!chats.length) cb2.push(line([["  " + fitFirst(["No chats yet · N starts a session", "No chats yet"], ciw - 2), "dim"]], ciw));
  const chatPanel = panel("Recent chats", chW, botH, cb2, { tag: ctx.zone === "chats" ? "⏎ resume · ← map" : "→ to pick", on: ctx.zone === "chats" });
  const ab2 = [], aiw = agW - 2;
  const running = sessions.flatMap((s) => (s.helpers || []).map((h) => ({ s, h }))).filter(({ h }) => h.status === "running" || Date.now() - h.at < 10 * 60_000).sort((a, b) => (a.h.status === "running" ? 0 : 1) - (b.h.status === "running" ? 0 : 1) || b.h.at - a.h.at);
  for (const { s, h } of running.slice(0, Math.floor((botH - 2) / 2))) {
    const on = h.status === "running", mins = Math.max(0, Math.round(((h.end || Date.now()) - h.start) / 60_000));
    ab2.push(line([[` ${on ? spinner() : I.done} `, on ? "violet" : "done"], [h.type.split(":").pop(), on ? "head" : "dim"], [`  in ${s.mode === "axa" ? "AXA" : clean(s.name)}`, "dim"]], aiw, [[`${plural(h.calls || 0, "step")} · ${mins}m`, "dim"]]));
    ab2.push(line([[`   ${clean(on ? h.doing || h.desc : h.report || h.desc) || "…"}`, on ? "text" : "dim"]], aiw));
  }
  if (!running.length) ab2.push(line([["  No agents running (sessions start them)", "dim"]], aiw));
  const nRun = running.filter(({ h }) => h.status === "running").length;
  const agentPanel = panel("Agents at work", agW, botH, ab2, { tag: nRun ? `${nRun} running` : "" });
  const tablePanel = beside([chatPanel, chW], [agentPanel, agW]);
  ctx.tableTop = B - botH + 1; // body row of the chats panel's first row
  const lb = [], lw = R - 2;
  const names = new Map(sessions.map((s) => [s.id, s.mode === "axa" ? "AXA" : clean(s.name)]));
  // repeats in a row are one line ("AXA woke the commander ×4", at the latest time)
  const evs = collapseRepeats((act?.events || []).map((e) => [e, said(e)]).filter(([, d]) => d).map(([e, [text, role]]) => ({ e, text, role, who: names.get(e.terminal) || (e.event === "MilestoneReview" ? "review" : "?") })), (x) => `${x.who}\n${x.text}`).slice(-(botH - 2));
  for (const { e, text, role, who, n } of evs) {
    const t = timeOf(e.ts);
    lb.push(line([[` ${t} `, "dim"], [`${cut(who, 10)} `, "accent"], [text, role], [n > 1 ? ` ×${n}` : "", "dim"]], lw));
  }
  if (!evs.length) lb.push(line([["  quiet: nothing has happened in the last hour", "dim"]], lw));
  const logPanel = panel("Log", R, botH, lb, { tag: "live" });
  out.push(...beside([tablePanel, L], [logPanel, R]));
  return out;
}
