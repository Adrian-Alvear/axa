// The Control screen: AXA's mission control. A live map in the middle (the AXA core, every session on
// its orbit, helper agents circling them), metrics and activity on top, what needs your approval and the
// commander on the right, the sessions table and the log underneath.
import { Canvas, areaChart } from "./canvas.mjs";
import { I, ago, chipOf, clean, cut, fmtTok, line, look, paint, sgrOf, spinner, width } from "./draw.mjs";

// ---------- pieces ----------
// A framed panel: thin border, a small uppercase title, an optional tag at the right of the top edge
export function panel(title, w, h, body, { tag = "", on = false } = {}) {
  const fr = on ? "frameOn" : "frame";
  const t = ` ${title.toUpperCase()} `, tg = tag ? ` ${tag} ` : "";
  const top = paint(fr, "┌─") + paint(on ? "accent" : "dim", cut(t, w - 4)) + paint(fr, "─".repeat(Math.max(0, w - 4 - width(cut(t, w - 4)) - width(tg)))) + paint("dim", tg) + paint(fr, "─┐");
  const rows = [top];
  for (let i = 0; i < h - 2; i++) rows.push(paint(fr, "│") + (body[i] ?? " ".repeat(w - 2)) + paint(fr, "│"));
  rows.push(paint(fr, "└" + "─".repeat(Math.max(0, w - 2)) + "┘"));
  return rows;
}
// Columns of panels side by side: each [rows, width]
const beside = (...cols) => cols[0][0].map((_, i) => cols.map(([rows, w]) => rows[i] ?? " ".repeat(w)).join(""));

// Big digits, three rows tall
const DIG = { 0: ["█▀█", "█ █", "▀▀▀"], 1: ["▀█ ", " █ ", "▀▀▀"], 2: ["▀▀█", "█▀▀", "▀▀▀"], 3: ["▀▀█", " ▀█", "▀▀▀"], 4: ["█ █", "▀▀█", "  ▀"], 5: ["█▀▀", "▀▀█", "▀▀▀"], 6: ["█▀▀", "█▀█", "▀▀▀"], 7: ["▀▀█", "  █", "  ▀"], 8: ["█▀█", "█▀█", "▀▀▀"], 9: ["█▀█", "▀▀█", "▀▀▀"] };
const bigNum = (n) => [0, 1, 2].map((r) => String(n).split("").map((d) => DIG[d]?.[r] ?? "   ").join(" "));
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
  }
  return null;
}

// ---------- the map ----------
function mapRows(ctx, cols, rows) {
  const cv = new Canvas(cols, rows);
  const S = (role) => sgrOf(role);
  const { sessions, selId } = ctx;
  const cx = cv.W / 2, cy = cv.H / 2;
  // blueprint grid
  for (let y = 2; y < cv.H; y += 12) for (let x = 2; x < cv.W; x += 12) cv.set(x, y, S("frame"));
  // orbits
  const RX = cv.W * 0.33, RY = cv.H * 0.38;
  cv.ring(cx, cy, RX * 0.45, RY * 0.45, S("frame"), 3);
  cv.ring(cx, cy, RX, RY, S("frame"), 2);
  cv.ring(cx, cy, RX * 1.12, RY * 1.12, S("frame"), 5);
  // the core: AXA (the commander)
  const cmd = sessions.find((s) => s.mode === "axa" && s.alive);
  const coreRole = !cmd ? "dim" : cmd.status === "waiting" ? "wait" : cmd.status === "working" ? "work" : "accent";
  const pulse = (Date.now() / 900) % 1;
  cv.disc(cx, cy, 3, S(coreRole));
  cv.ring(cx, cy, 7, 7, S(coreRole));
  if (cmd?.status === "working") cv.ring(cx, cy, 9 + pulse * 6, 9 + pulse * 6, S("work"), 2);
  else cv.ring(cx, cy, 11, 11, S("frame"), 2);
  // sessions around it
  const ss = sessions.filter((s) => s.mode !== "axa" && s.alive);
  const labels = [];
  ss.forEach((s, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(ss.length, 1) + (ss.length === 2 ? Math.PI / 2 : 0);
    const nx = cx + RX * Math.cos(a), ny = cy + RY * Math.sin(a);
    const [, , role] = look(s);
    const live = s.status === "working" || s.status === "waiting";
    // the link from the core
    const dx = nx - cx, dy = ny - cy, d = Math.hypot(dx, dy) || 1;
    const sx = cx + (dx / d) * 13, sy = cy + (dy / d) * 13, ex = nx - (dx / d) * 6, ey = ny - (dy / d) * 6;
    cv.line(sx, sy, ex, ey, S(live ? role : "frame"), live ? {} : { on: 1, off: 2 });
    if (s.status === "working") { const t = (Date.now() / 1400 + i * 0.37) % 1; cv.disc(sx + (ex - sx) * t, sy + (ey - sy) * t, 1, S("head")); }
    // the node
    cv.disc(nx, ny, 2, S(role));
    cv.ring(nx, ny, 5, 5, S(s.id === selId ? "head" : role));
    if (s.status === "waiting") cv.ring(nx, ny, 7 + pulse * 3, 7 + pulse * 3, S("wait"), 2);
    // its helper agents, circling it
    const hs = (s.helpers || []).filter((h) => h.status === "running");
    hs.forEach((h, k) => { const b = Date.now() / 1200 + (2 * Math.PI * k) / hs.length; cv.disc(nx + 9 * Math.cos(b), ny + 9 * Math.sin(b) * 0.8, 1, S("violet")); });
    labels.push({ s, col: nx / 2, row: ny / 4, right: nx >= cx, hs });
  });
  // labels on top (callouts next to each node)
  for (const L of labels) {
    const { s } = L, [chipText] = chipOf(s), sel = s.id === selId;
    const name = `${sel ? "▸ " : ""}${clean(s.name)}`, sub = `${chipText.trim()}${s.usage?.tokens ? ` · ${fmtTok(s.usage.tokens)}` : ""}${L.hs.length ? ` · ${L.hs.length} agent${L.hs.length > 1 ? "s" : ""}` : ""}`;
    const w = Math.max(width(name), width(sub)) + 2;
    const col = L.right ? Math.min(cols - w, L.col + 5) : Math.max(0, L.col - 5 - w);
    const row = Math.max(0, Math.min(rows - 2, Math.round(L.row) - 1));
    cv.clear(col, row, w); cv.clear(col, row + 1, w);
    cv.put(col + 1, row, name, S(sel ? "head" : s.status === "waiting" ? "wait" : "text"));
    cv.put(col + 1, row + 1, sub, S(look(s)[2]));
    ctx.mapHits.push({ col0: col, col1: col + w, row0: row, row1: row + 1, id: s.id });
  }
  // the core's label
  const coreTxt = "AXA", coreSub = !cmd ? "OFFLINE · press a" : cmd.status === "working" ? `${spinner()} WORKING` : cmd.status === "waiting" ? "NEEDS YOU" : "STANDING BY";
  const ccol = Math.round(cx / 2), crow = Math.round(cy / 4);
  cv.clear(ccol - Math.ceil(width(coreSub) / 2) - 1, crow + 3, width(coreSub) + 2);
  cv.put(ccol - 1, crow + 2 < rows ? crow + 2 : crow, coreTxt, S("title"));
  cv.put(ccol - Math.floor(width(coreSub) / 2), crow + 3, coreSub, S(coreRole));
  ctx.mapHits.push({ col0: ccol - 6, col1: ccol + 6, row0: crow - 2, row1: crow + 3, id: cmd?.id || "commander" });
  if (!ss.length) { const m = "no sessions yet · n starts one in a project"; cv.put(Math.floor((cols - width(m)) / 2), rows - 2, m, S("dim")); }
  return cv.render();
}

// ---------- the whole screen ----------
// ctx: { sessions, act, selId, focusInput, input, nameOf, question, yesOpt, noOpt, waiting, mapHits, tableHits }
export function controlRows(ctx, W, B) {
  const { sessions, act } = ctx;
  const alive = sessions.filter((s) => s.alive);
  const cnt = (st) => alive.filter((s) => s.mode !== "axa" && s.status === st).length;
  const L = Math.round(W * 0.62), R = W - L;
  const topH = B >= 30 ? 6 : 0, botH = Math.max(6, Math.min(12, Math.round(B * 0.27))), midH = B - topH - botH;
  const out = [];

  // top: metrics and activity
  if (topH) {
    const tiles = [["Active", alive.filter((s) => s.mode !== "axa").length, "accent"], ["Working", cnt("working"), "work"], ["Needs you", cnt("waiting") + cnt("stuck"), cnt("waiting") + cnt("stuck") ? "wait" : "dim"], ["Done today", act?.runs?.done ?? 0, "done"]];
    const tw = Math.floor((L - 2) / 4);
    const body = [0, 1, 2, 3].map((r) => tiles.map(([label, n, role], k) => {
      const cellW = k === 3 ? L - 2 - tw * 3 : tw;
      if (r < 3) return line([["  " + bigNum(n)[r], role]], cellW);
      return line([[`  ${label.toUpperCase()}`, "dim"]], cellW);
    }).join(""));
    const pm = act?.perMinute || Array(60).fill(0), peak = Math.max(...pm), total = pm.reduce((a, b) => a + b, 0);
    const chart = areaChart(R - 4, 3, pm, { line: sgrOf("accent"), fill: sgrOf("frame") }).render();
    const abody = [...chart.map((r) => " " + r + " "), line([["60m ago", "dim"]], R - 2, [[`peak ${peak}/min · ${total} events · now`, "dim"]])];
    out.push(...beside([panel("Global status", L, topH, body, { tag: `${act?.runs?.today ?? 0} runs today` }), L], [panel("Activity", R, topH, abody, { tag: "events / min" }), R]));
  }

  // middle: the map, and approvals + the commander
  const map = mapRows(ctx, L - 2, midH - 2);
  const mapPanel = panel("Live map", L, midH, map, { tag: `${alive.filter((s) => s.mode !== "axa").length} sessions · ${alive.reduce((n, s) => n + (s.helpers || []).filter((h) => h.status === "running").length, 0)} agents` });
  const w = ctx.waiting;
  const apH = Math.min(midH - 6, w ? 13 : 6);
  const ab = [];
  const iw = R - 2;
  if (w) {
    const opts = w.choices.options;
    ab.push(line([["  SESSION  ", "dim"], [ctx.nameOf(w), "head"]], iw, [chipOf(w)]));
    ab.push(line([["  WHERE    ", "dim"], [w.cwd.replace(process.env.HOME || "", "~"), "text"]], iw));
    ab.push(" ".repeat(iw));
    for (const l of wrap(ctx.question(w.choices), iw - 4).slice(0, Math.max(1, apH - 9 - Math.min(4, opts.length)))) ab.push(line([["  " + l, "wait"]], iw));
    for (const o of opts.slice(0, 4)) ab.push(line([[`   ${o.n}. ${clean(o.label)}`, "dim"]], iw));
    while (ab.length < apH - 4) ab.push(" ".repeat(iw));
    ab.length = apH - 4; // keep room for the buttons
    const no = ctx.noOpt(w.choices), yes = ctx.yesOpt(w.choices);
    const bw = Math.floor((iw - 6) / 2);
    ab.push(" ".repeat(iw));
    ab.push(line([["  ", ""], [cut(` x  ${no.label} `.padEnd(bw), bw), "keycap"], ["  ", ""], [cut(` y  ${yes.label} `.padEnd(bw), bw), "tabOn"]], iw));
  } else {
    ab.push(line([["  ✓ Nothing needs your approval.", "done"]], iw));
    ab.push(line([[`  AXA's approver handled ${act?.runs?.approvals ?? 0} today; only one-way doors`, "dim"]], iw));
    ab.push(line([["  (shipping, deploying, spending) come here.", "dim"]], iw));
  }
  const apPanel = panel(w ? "Requires approval" : "Approvals", R, apH, ab, { tag: w ? `${ctx.waitingCount} waiting` : "", on: !!w });
  // the commander: what it last said, and a box to talk to it
  const cmd = sessions.find((s) => s.mode === "axa" && s.alive);
  const chH = midH - apH, cb = [];
  const cmdSaid = cmd ? clean(cmd.status === "working" ? cmd.doing : cmd.last_report || cmd.doing || "Standing by. Tell me what you want done across your projects.") : "Offline. Type below (or press a) to start it.";
  cb.push(line([["  ", ""], [cmd ? `${I.axa} AXA` : `${I.axa} AXA`, "title"]], iw, [cmd ? chipOf(cmd) : [" OFF ", "chipOff"]]));
  for (const l of wrap(cmdSaid, iw - 4).slice(-(chH - 6))) cb.push(line([["  " + l, cmd?.status === "working" ? "work" : "text"]], iw));
  while (cb.length < chH - 4) cb.push(" ".repeat(iw));
  const prompt = ctx.focusInput ? ctx.input + "▏" : ctx.input || "Ask anything…  (press : to type)";
  cb.push(paint("frame", " " + "─".repeat(iw - 2) + " "));
  cb.push(line([[" › ", "accent"], [cut(prompt.slice(-(iw - 6)), iw - 4), ctx.focusInput || ctx.input ? "head" : "dim"]], iw));
  const chPanel = panel("Commander", R, chH, cb, { on: ctx.focusInput, tag: "Enter sends" });
  const right = [...apPanel, ...chPanel];
  out.push(...mapPanel.map((r, i) => r + (right[i] ?? " ".repeat(R))));
  ctx.mapTop = (topH ? topH : 0) + 1; // body row (0-based) where the map's canvas starts

  // bottom: the sessions table and the log
  const tb = [], tw2 = L - 2;
  const cols = [["SESSION", 0.24], ["STATUS", 0.15], ["NOW", 0.37], ["BRANCH", 0.14], ["TOKENS", 0.10]];
  const cw = cols.map(([, f]) => Math.floor(f * tw2));
  cw[cw.length - 1] += tw2 - cw.reduce((a, b) => a + b, 0);
  tb.push(cols.map(([h], k) => paint("dim", ` ${h}`.padEnd(cw[k]).slice(0, cw[k]))).join(""));
  const rowsList = ctx.order;
  const room = botH - 3;
  const start = Math.max(0, Math.min(rowsList.findIndex((s) => s.id === ctx.selId) - room + 1, rowsList.length - room));
  rowsList.slice(Math.max(0, start), Math.max(0, start) + room).forEach((s, k) => {
    const [g, , role] = look(s), sel = s.id === ctx.selId;
    const cells = [[` ${s.mode === "axa" ? I.axa : g} ${ctx.nameOf(s)}`, s.mode === "axa" ? "title" : "head"], [` ${chipOf(s)[0].trim()}`, role], [` ${clean(s.status === "waiting" && s.choices ? ctx.question(s.choices) : s.status === "done" ? s.last_report || "finished" : s.doing || "")}`, "dim"], [` ${s.git?.branch || "–"}`, "dim"], [` ${s.usage?.tokens ? fmtTok(s.usage.tokens) : "–"}`, "dim"]];
    tb.push(cells.map(([t, r], c) => line([[t, r]], cw[c], [], sel ? "sel" : null)).join(""));
    ctx.tableHits.push({ row: k, id: s.id });
  });
  if (!rowsList.length) tb.push(line([["  nothing running · n starts a session · a the commander", "dim"]], tw2));
  const tablePanel = panel("Sessions", L, botH, tb, { tag: "⏎ open · d diff · g goal · X close" });
  const lb = [], lw = R - 2;
  const names = new Map(sessions.map((s) => [s.id, s.mode === "axa" ? "AXA" : clean(s.name)]));
  const evs = (act?.events || []).map((e) => [e, said(e)]).filter(([, d]) => d).slice(-(botH - 2));
  for (const [e, [text, role]] of evs) {
    const t = new Date(e.ts).toLocaleTimeString([], { hour12: false });
    lb.push(line([[` ${t} `, "dim"], [`${cut(names.get(e.terminal) || "?", 10)} `, "accent"], [text, role]], lw));
  }
  if (!evs.length) lb.push(line([["  quiet: nothing has happened in the last hour", "dim"]], lw));
  const logPanel = panel("Log", R, botH, lb, { tag: "live" });
  out.push(...beside([tablePanel, L], [logPanel, R]));
  ctx.tableTop = B - botH + 2; // body row of the table's first data row
  return out;
}
