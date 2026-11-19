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
  const ccol = cols / 2, crow = rows / 2; // the core, in cells
  // a faint orbit behind everything
  const RC = Math.max(14, cols * 0.34), RR = Math.max(3, rows / 2 - 3);
  cv.ring(ccol * 2, crow * 4, RC * 2, RR * 4, S("frame"), 3);
  const cmd = sessions.find((s) => s.mode === "axa" && s.alive);
  const coreRole = !cmd ? "dim" : cmd.status === "waiting" ? "wait" : cmd.status === "working" ? "work" : "accent";
  const ss = sessions.filter((s) => s.mode !== "axa" && s.alive);
  // where each session sits: evenly around the orbit, starting at the top
  const nodes = ss.map((s, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(ss.length, 1) + (ss.length === 2 ? Math.PI / 2 : 0);
    return { s, col: ccol + RC * Math.cos(a), row: crow + RR * Math.sin(a) };
  });
  // links: solid and lit while working or waiting, dotted when idle; a pulse runs along working ones
  nodes.forEach(({ s, col, row }, i) => {
    const role = look(s)[2], live = s.status === "working" || s.status === "waiting" || s.id === selId;
    const dx = col * 2 - ccol * 2, dy = row * 4 - crow * 4, d = Math.hypot(dx, dy) || 1;
    const x0 = ccol * 2 + (dx / d) * 25, y0 = crow * 4 + (dy / d) * 21, x1 = col * 2, y1 = row * 4;
    cv.line(x0, y0, x1, y1, S(live ? (s.id === selId && !["working", "waiting"].includes(s.status) ? "head" : role) : "frame"), live ? {} : { on: 1, off: 2 });
    if (live) cv.line(x0 + 1, y0, x1 + 1, y1, S(role)); // a second strand: a bolder line
    if (s.status === "working") for (const off of [0, 0.5]) { const t = (Date.now() / 1600 + i * 0.29 + off) % 1; cv.disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 1.5, S("head")); }
  });
  // the core: AXA inside a clean ring, a faint orbit with a turning sweep, dial ticks, and a ripple
  // while the commander works
  const X = ccol * 2, Y = crow * 4, t = Date.now() / 1000;
  const coreSub = !cmd ? "OFFLINE" : cmd.status === "working" ? "WORKING" : cmd.status === "waiting" ? "NEEDS YOU" : "STANDING BY";
  if (cmd?.status === "working" || cmd?.status === "waiting") { const r = 11 + ((t * 7) % 9); cv.ring(X, Y, r * 1.15, r, S(coreRole), 3); }
  cv.ring(X, Y, 17, 14.5, S("frame"), 2);
  if (cmd) { const a0 = t * 1.4; cv.arc(X, Y, 17, a0, a0 + 1.0, S(coreRole)); }
  for (let k = 0; k < 16; k++) { const a = (k / 16) * 2 * Math.PI, big = k % 4 === 0; cv.line(X + 20.5 * Math.cos(a), Y + 17.5 * Math.sin(a), X + (big ? 23 : 21.5) * Math.cos(a), Y + (big ? 19.5 : 18.3) * Math.sin(a), S(big ? coreRole : "frame")); }
  cv.ring(X, Y, 10.5, 8.5, S(coreRole));
  const t1 = `${I.axa} AXA`;
  cv.clear(Math.round(ccol - width(t1) / 2) - 1, Math.round(crow), width(t1) + 2);
  cv.put(Math.round(ccol - width(t1) / 2), Math.round(crow), t1, S("title"));
  const sr = Math.round(crow) + 2;
  cv.clear(Math.round(ccol - width(coreSub) / 2) - 1, sr, width(coreSub) + 2);
  cv.put(Math.round(ccol - width(coreSub) / 2), sr, coreSub, S(coreRole));
  ctx.mapHits.push({ col0: ccol - 10, col1: ccol + 10, row0: crow - 4, row1: crow + 4, id: cmd?.id || "commander" });
  // session cards
  for (const { s, col, row } of nodes) {
    const [g, , role] = look(s), sel = s.id === selId;
    const name = `${g} ${clean(s.name)}`, sub = `${chipOf(s)[0].trim()}${s.usage?.tokens ? ` · ${fmtTok(s.usage.tokens)}` : ""}`;
    const w = Math.min(28, Math.max(width(name), width(sub)) + 4);
    const c0 = Math.max(0, Math.min(cols - w, col - w / 2)), r0 = Math.max(0, Math.min(rows - 4, row - 2));
    cv.box(c0, r0, w, 4, S(sel ? "head" : role), [[cut(name, w - 4), S(sel ? "head" : "text")], [cut(sub, w - 4), S(role)]], sel ? "heavy" : "round");
    ctx.mapHits.push({ col0: c0, col1: c0 + w, row0: r0, row1: r0 + 3, id: s.id });
    // its agents, tagged under the card
    const hs = (s.helpers || []).filter((h) => h.status === "running");
    if (hs.length) {
      const tag = `${spinner()} ${hs.map((h) => h.type.split(":").pop()).slice(0, 3).join(" · ")}${hs.length > 3 ? ` +${hs.length - 3}` : ""}`;
      const tr = r0 + 4 < rows ? r0 + 4 : r0 - 1;
      cv.clear(c0, tr, width(tag) + 2);
      cv.put(c0 + 1, tr, tag, S("violet"));
    }
  }
  if (!ss.length) { const m = "no sessions yet · n starts one in a project"; cv.put(Math.floor((cols - width(m)) / 2), rows - 1, m, S("dim")); }
  return cv.render();
}

// ---------- the whole screen ----------
// ctx: { sessions, chats, act, selId, zone, chatSel, focusInput, input, nameOf, question, yesOpt, noOpt, waiting, mapHits, chatHits }
export function controlRows(ctx, W, B) {
  const { sessions, act } = ctx;
  const alive = sessions.filter((s) => s.alive);
  const cnt = (st) => alive.filter((s) => s.mode !== "axa" && s.status === st).length;
  const L = Math.round(W * 0.62), R = W - L;
  const topH = B >= 30 ? 5 : 0, botH = Math.max(6, Math.min(12, Math.round(B * 0.27))), midH = B - topH - botH;
  const out = [];

  // top: metrics and activity
  if (topH) {
    const nActive = alive.filter((s) => s.mode !== "axa").length, nNeeds = cnt("waiting") + cnt("stuck");
    const tiles = [["Active", nActive, "accent", "sessions open"], ["Working", cnt("working"), "work", "busy right now"], ["Needs you", nNeeds, nNeeds ? "wait" : "dim", "waiting on you"], ["Done today", act?.runs?.done ?? 0, "done", `of ${act?.runs?.today ?? 0} runs`]];
    const tw = Math.floor((L - 2) / 4), max = Math.max(1, nActive);
    const cellW = (k) => (k === 3 ? L - 2 - tw * 3 : tw);
    const body = [
      tiles.map(([label, n, role], k) => line([[`  ${n}`, `1;${sgrOf(role)}`], [`  ${label.toUpperCase()}`, "dim"]], cellW(k))).join(""),
      tiles.map(([, n, role], k) => "  " + segBar(Math.min(1, n / (k === 3 ? Math.max(1, act?.runs?.today ?? 0) : max)), Math.max(4, Math.min(14, cellW(k) - 6)), role) + " ".repeat(Math.max(0, cellW(k) - 2 - Math.max(4, Math.min(14, cellW(k) - 6))))).join(""),
      tiles.map(([, , , sub], k) => line([[`  ${sub}`, "frame"]], cellW(k))).join(""),
    ];
    const pm = act?.perMinute || Array(60).fill(0), peak = Math.max(...pm), total = pm.reduce((a, b) => a + b, 0);
    const chart = areaChart(R - 4, 2, pm, { line: sgrOf("accent"), fill: sgrOf("frame") }).render();
    const abody = [...chart.map((r) => " " + r + " "), line([["60m ago", "frame"]], R - 2, [[`peak ${peak}/min · ${total} events · now`, "dim"]])];
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

  // bottom: recent chats, the agents at work, and the log
  const chW = Math.round(L * 0.55), agW = L - chW;
  const cb2 = [], ciw = chW - 2;
  const chats = ctx.chats.slice(0, botH - 2);
  chats.forEach((c, k) => {
    const sel = ctx.zone === "chats" && k === ctx.chatSel;
    cb2.push(line([[` ${c.open_in ? "●" : I.chat} `, c.open_in ? "work" : "dim"], [clean(c.title), sel ? "head" : "text"]], ciw, [[`${c.cwd === process.env.HOME ? "~" : c.project} · ${ago(c.updated)}`, "dim"]], sel ? "sel" : null));
    ctx.chatHits.push({ row: k, i: k });
  });
  if (!chats.length) cb2.push(line([["  no chats yet", "dim"]], ciw));
  const chatPanel = panel("Recent chats", chW, botH, cb2, { tag: ctx.zone === "chats" ? "⏎ resume · ← map" : "→ to pick", on: ctx.zone === "chats" });
  const ab2 = [], aiw = agW - 2;
  const running = sessions.flatMap((s) => (s.helpers || []).map((h) => ({ s, h }))).filter(({ h }) => h.status === "running" || Date.now() - h.at < 10 * 60_000).sort((a, b) => (a.h.status === "running" ? 0 : 1) - (b.h.status === "running" ? 0 : 1) || b.h.at - a.h.at);
  for (const { s, h } of running.slice(0, Math.floor((botH - 2) / 2))) {
    const on = h.status === "running", mins = Math.max(0, Math.round(((h.end || Date.now()) - h.start) / 60_000));
    ab2.push(line([[` ${on ? spinner() : I.done} `, on ? "violet" : "done"], [h.type.split(":").pop(), on ? "head" : "dim"], [`  in ${s.mode === "axa" ? "AXA" : clean(s.name)}`, "dim"]], aiw, [[`${h.calls || 0} steps · ${mins}m`, "dim"]]));
    ab2.push(line([[`   ${clean(on ? h.doing || h.desc : h.report || h.desc) || "…"}`, on ? "text" : "dim"]], aiw));
  }
  if (!running.length) { ab2.push(line([["  no agents running", "dim"]], aiw)); ab2.push(line([["  helpers show up here as sessions start them", "dim"]], aiw)); }
  const nRun = running.filter(({ h }) => h.status === "running").length;
  const agentPanel = panel("Agents at work", agW, botH, ab2, { tag: nRun ? `${nRun} running` : "" });
  const tablePanel = beside([chatPanel, chW], [agentPanel, agW]);
  ctx.tableTop = B - botH + 1; // body row of the chats panel's first row
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
  return out;
}
