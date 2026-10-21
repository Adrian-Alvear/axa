// The map (Ctrl-b m): AXA at the center, sessions branching off it, their helper agents and the links
// between them; plus the live detail panels for a session's agents and work and for one helper.
import { ESC, look, cut, width, question, yesOpt, noOpt, fmtTok, gitText, what, fmtDur } from "./theme.mjs";

export function map(c) {
  function mapRows(L) {
    const { renderSegs, nameOf } = c;
    const W2 = L.mainW, H2 = L.mainH, frame = Math.floor(Date.now() / 250);
    const ss = c.sessions(), axa = c.list.find((s) => s.mode === "axa");
    const TX = 24; // the trunk's column
    const entries = []; // { kind, s, i, h, c }
    ss.forEach((s, i) => {
      entries.push({ kind: "session", s, i });
      const hs = (c.ev.helpers.get(s.id) || []).filter((h) => h.status === "running" || Date.now() - h.ts < 30 * 60_000).slice(-6);
      for (const h of hs) entries.push({ kind: "helper", s, h });
      for (const ch of c.chainsList.filter((ch) => ch.from === s.id && (!ch.fired || Date.now() - ch.fired < 30 * 60_000))) entries.push({ kind: "link", s, c: ch });
      if (i < ss.length - 1) entries.push({ kind: "gap" });
    });
    const rows = Array.from({ length: H2 }, () => [["", ""]]);
    if (!ss.length) {
      rows[Math.floor(H2 / 2)] = [["   ◆ AXA", "title"], ["   no sessions yet: Ctrl-b c starts one, or ask the commander", "dim"]];
      return rows.map((r) => renderSegs(r, W2));
    }
    // sessions and helper agents are the nodes you move between (↑/↓); keep the selected one in view
    c.mapNodes = entries.filter((e) => e.kind === "session" || e.kind === "helper");
    if (c.mapWant) { const i = c.mapNodes.findIndex((n) => n.kind === "session" && n.s.id === c.mapWant); if (i >= 0) c.mapSel = i; c.mapWant = null; }
    c.mapSel = Math.max(0, Math.min(c.mapSel, c.mapNodes.length - 1));
    const selected = c.mapNodes[c.mapSel], selAt = entries.indexOf(selected);
    const off = entries.length <= H2 ? -Math.floor((H2 - entries.length) / 2) : Math.max(0, Math.min(selAt - Math.floor(H2 / 2), entries.length - H2));
    const sessRows = entries.map((e, k) => (e.kind === "session" ? k : -1)).filter((k) => k >= 0);
    const first = sessRows[0], last = sessRows.at(-1), mid = Math.round((first + last) / 2);
    for (let y = 0; y < H2; y++) {
      const k = y + off, e = entries[k];
      // AXA's node, left of the trunk, level with the middle of the sessions
      const left = " ".repeat(TX - 1);
      const [ag, aword, arole] = axa ? look(axa) : ["◆", "not running", "off"];
      const node = k === mid - 1 ? [[" ◆ AXA", "title"]] : k === mid ? [[` ${ag} ${aword}`, arole]] : k === mid + 1 ? [[` ${cut(axa ? what(axa) : "Ctrl-b 0", TX - 3)}`, "dim"]] : null;
      const segs = node ? [...node] : [[left, ""]];
      const used = node ? width(node.map(([t]) => t).join("")) : TX - 1;
      if (k === mid) segs.push(["─".repeat(Math.max(0, TX - 1 - used)), "rule"]); else segs.push([" ".repeat(Math.max(0, TX - 1 - used)), ""]);
      // the trunk
      const inSpan = k >= first && k <= last, isSess = e?.kind === "session";
      let tc = " ";
      if (inSpan) {
        if (first === last) tc = k === mid ? "─" : " ";
        else if (isSess) tc = k === first ? (k === mid ? "┬" : "┌") : k === last ? (k === mid ? "┴" : "└") : k === mid ? "┼" : "├";
        else tc = k === mid ? "┤" : "│";
      }
      segs.push([tc, "rule"]);
      if (!e || e.kind === "gap") { rows[y] = segs; continue; }
      const s = e.s, [g, word, role] = look(s);
      if (e.kind === "session") {
        // the branch: data flowing out to a working session
        let branch = "──────";
        if (s.status === "working") { const p = frame % 6; branch = "─".repeat(p) + "●" + "─".repeat(5 - p); }
        segs.push([branch, s.status === "working" ? "work" : s.status === "waiting" ? "wait" : "rule"]);
        const isSel = e === selected;
        segs.push([` ${g} `, role], [nameOf(s), isSel ? "sel" : role], ["  ", ""]);
        if (s.status === "waiting" && s.choices) segs.push([`${question(s.choices)}  `, "wait"], [`[y] ${yesOpt(s.choices).label}  [x] ${noOpt(s.choices).label}`, "waitSoft"]);
        else segs.push([`${word} · ${what(s)}`, "dim"]);
      } else if (e.kind === "helper") {
        const h = e.h, isSel = e === selected;
        segs.push(["         └─ ", "rule"], [h.status === "running" ? "● " : "✓ ", h.status === "running" ? "work" : "done"], [h.type, isSel ? "sel" : h.status === "running" ? "work" : "dim"], [h.desc ? `: ${cut(h.desc, 40)}` : "", "dim"]);
        // its tool calls as leaves: the one it just used lights up
        segs.push(...toolLeaves(h.calls));
      } else if (e.kind === "link") {
        const ch = e.c, to = c.list.find((x) => x.id === ch.to);
        segs.push(["         ──▶ ", ch.fired ? "dim" : "accent"], [to ? nameOf(to) : ch.to_name || "?", ch.fired ? "dim" : "accent"], [ch.fired ? `  ✓ sent ${fmtDur(Date.now() - ch.fired)} ago` : ch.failed ? `  ✗ ${ch.failed}` : "  when this finishes: ", ch.failed ? "stuck" : "dim"], [ch.fired || ch.failed ? "" : ch.text, "idle"]);
      }
      rows[y] = segs;
    }
    return rows.map((r) => renderSegs(r, W2));
  }
  // "⟶ Read ×4 · Edit ×2 · Bash ×1" (most used first; the one used in the last moment is bright)
  function toolLeaves(calls) {
    if (!calls?.size) return [];
    const now = Date.now(), top = [...calls.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 4);
    return [["  ⟶ ", "rule"], ...top.flatMap(([t, n], i) => [[i ? " · " : "", "dim"], [`${t} ×${n.count}`, now - n.at < 1500 ? "title" : "dim"]])];
  }
  // a tool tally as panel rows: "● Read ×4   a.js · b.js · c.js"
  function callLines(calls, w) {
    const now = Date.now();
    return [...calls.entries()].sort((a, b) => b[1].count - a[1].count).map(([tool, n]) => {
      const hot = now - n.at < 1500;
      return { raw: c.renderSegs([[`  ${hot ? "●" : "·"} `, hot ? "work" : "dim"], [`${tool} ×${n.count}`, hot ? "title" : "idle"], [n.recent.length ? `   ${n.recent.slice(0, 3).join(" · ")}` : "", "dim"]], w) };
    });
  }
  const textLines = (t, empty) => (t ? String(t).split("\n").map((l) => ({ text: `  ${l}` })) : [{ text: `  ${empty}`, role: "dim" }]);
  // A helper agent, live: its task, the instruction it got, its tool calls as they happen, its report
  function helperDetail(h, s) {
    const ov = { title: "", size: "large", lines: [], hint: "updates live · space/b scroll · Esc close" };
    ov.render = (p) => {
      const n = [...h.calls.values()].reduce((a, x) => a + x.count, 0);
      ov.title = `${h.status === "running" ? "●" : "✓"} ${h.type} · ${h.status === "running" ? "working" : "done"} · ${fmtDur((h.end || Date.now()) - h.start)}${s ? ` · helping ${c.nameOf(s)}` : ""}`;
      ov.lines = [
        ...(h.desc ? [{ text: `Task: ${h.desc}`, role: "title" }] : []),
        { text: "" }, { text: "The instruction it was given", role: "accent" }, ...textLines(h.prompt, "(not recorded; prompts are left out when AXA_LOG_PROMPTS=0)"),
        { text: "" }, { text: `Tool calls, live · ${n} so far${h.failures ? ` · ${h.failures} failed` : ""}`, role: "accent" }, ...(h.calls.size ? callLines(h.calls, p.cols) : [{ text: "  none yet", role: "dim" }]),
        { text: "" }, { text: "Its report", role: "accent" }, ...textLines(h.report, h.status === "running" ? "(still working)" : "(no report)"),
      ];
    };
    c.overlay = ov; c.schedule();
  }
  // A session's agents and work, live: what it's doing, its helpers (pick one), its own tool calls, links, report
  function sessionDetail(s) {
    if (!s) return;
    const ov = { title: "", size: "large", sel: 0, lines: [], hint: "j/k pick a helper · Enter its details · space/b scroll · Esc close" };
    let hs = [];
    ov.render = (p) => {
      const { renderSegs, nameOf } = c;
      const cur = c.list.find((x) => x.id === s.id) || s, [g, word] = look(cur);
      hs = (c.ev.helpers.get(s.id) || []).slice().reverse();
      ov.sel = Math.max(0, Math.min(ov.sel, hs.length - 1));
      ov.title = `${g} ${nameOf(cur)} · ${word} · agents and work`;
      const meta = [gitText(cur.git), cur.usage?.tokens ? `${fmtTok(cur.usage.tokens)} tokens` : "", cur.worktree ? `worktree ${cur.worktree.branch}` : ""].filter(Boolean).join(" · ");
      const links = c.chainsList.filter((ch) => ch.from === s.id || ch.to === s.id);
      const calls = c.ev.sessCalls.get(s.id) || new Map();
      ov.lines = [
        { text: `Now: ${what(cur)}`, role: "title" }, ...(meta ? [{ text: meta, role: "dim" }] : []),
        { text: "" }, { text: `Helper agents (${hs.length})`, role: "accent" },
        ...(hs.length ? hs.map((h, i) => ({ raw: renderSegs([[i === ov.sel ? " › " : "   ", "accent"], [h.status === "running" ? "● " : "✓ ", h.status === "running" ? "work" : "done"], [h.type, i === ov.sel ? "sel" : "title"], [h.desc ? `: ${h.desc}` : "", "idle"], [`   ${[...h.calls.values()].reduce((a, x) => a + x.count, 0)} calls · ${fmtDur((h.end || Date.now()) - h.start)}`, "dim"], ...toolLeaves(h.calls)], p.cols) })) : [{ text: "   none yet", role: "dim" }]),
        { text: "" }, { text: "Its own tool calls, live", role: "accent" }, ...(calls.size ? callLines(calls, p.cols) : [{ text: "  none yet", role: "dim" }]),
        ...(links.length ? [{ text: "" }, { text: "Links", role: "accent" }, ...links.map((ch) => ({ text: `  ${ch.from === s.id ? `→ ${ch.to_name}` : `← ${ch.from_name}`}: ${ch.text}${ch.fired ? "  (sent)" : ""}`, role: "dim" }))] : []),
        ...(cur.last_report ? [{ text: "" }, { text: "Last report", role: "accent" }, ...textLines(cur.last_report)] : []),
      ];
    };
    ov.onKey = (k) => {
      if (k === "j" || k === "\x1b[B") { ov.sel++; return true; }
      if (k === "k" || k === "\x1b[A") { ov.sel = Math.max(0, ov.sel - 1); return true; }
      if (k === "\r" && hs[ov.sel]) {
        const back = ov; helperDetail(hs[ov.sel], s);
        c.overlay.onKey = (k2) => { if (k2 === ESC || k2 === "q") { c.overlay = back; c.fullRedraw = true; return true; } return false; };
        return true;
      }
      return false;
    };
    c.overlay = ov; c.schedule();
  }
  function mapKey(k) {
    const node = c.mapNodes[c.mapSel], s = node?.s;
    if (k === "j" || k === "\x1b[B") c.mapSel = Math.min(c.mapNodes.length - 1, c.mapSel + 1);
    else if (k === "k" || k === "\x1b[A") c.mapSel = Math.max(0, c.mapSel - 1);
    else if (/^[1-9]$/.test(k)) { const i = c.mapNodes.findIndex((n) => n.kind === "session" && n.i === Number(k) - 1); if (i >= 0) c.mapSel = i; }
    // Enter: open a session / a helper's details; Space or →: details of either
    else if (k === "\r" && node?.kind === "helper") helperDetail(node.h, s);
    else if (k === "\r" && s) { c.mapMode = false; c.fullRedraw = true; c.show(s); }
    else if ((k === " " || k === "\x1b[C") && node) node.kind === "helper" ? helperDetail(node.h, s) : sessionDetail(s);
    else if ((k === "y" || k === "x") && s?.status === "waiting" && s.choices) c.answerSession(s, k === "y" ? yesOpt(s.choices) : noOpt(s.choices));
    else if (k === "d" && s) c.showDiff(s);
    else if (k === "g" && s) c.giveGoal(s);
    else if (k === "l" && s) c.linkFrom(s);
    else if (k === "v" && s) c.runVerify(s);
    else if (k === ESC || k === "m" || k === "q") { c.mapMode = false; c.fullRedraw = true; }
    c.schedule();
  }
  return { mapRows, helperDetail, sessionDetail, mapKey };
}
