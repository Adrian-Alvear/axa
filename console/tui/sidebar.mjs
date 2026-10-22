// The sessions as the app sees them (names, workspaces, display order) and the sidebar that lists them:
// a tree (AXA at the root, a project per branch) or a compact list.
import { basename } from "node:path";
import { look, STATUS, needsYou, byUrgency, clean, cut, pad, width, question, fmtTok, gitText, what, reasonOf, costText, githubBits } from "./theme.mjs";
import { spark, SPARK_BUCKETS } from "./events.mjs";

// helper agents grouped by the work they do: "● builder ×2 · ✓ reviewer"
export function helperGroups(arr) {
  const by = new Map();
  for (const h of arr) { const g = by.get(h.type) || { run: 0, done: 0, desc: "" }; if (h.status === "running") { g.run++; g.desc ||= h.desc; } else g.done++; by.set(h.type, g); }
  return [...by.entries()].map(([type, g]) => (g.run ? [`● ${type}${g.run > 1 ? ` ×${g.run}` : ""}`, "work", g.desc] : [`✓ ${type}${g.done > 1 ? ` ×${g.done}` : ""}`, "done", ""]));
}

export function sidebar(c) {
  const { cfg, seen } = c;
  // your own display names for sessions (Ctrl-b r), like herdr's agent labels
  const nameOf = (s) => clean(cfg.labels?.[s.id]) || (s.mode === "axa" ? "AXA commander" : clean(s.name));
  // inside its workspace, a worktree session goes by its own name ("fix-login", not "launches:fix-login")
  const shortName = (s) => clean(cfg.labels?.[s.id]) || (s.worktree ? clean(s.name).split(":").pop() : nameOf(s));
  // "done" stays bright until you've looked at it, then it's just idle (herdr's done vs idle)
  const unseenDone = (s) => s.status === "done" && (seen.get(s.id) || 0) < (s.last_event_at || 0);
  // AXA first, then sessions by urgency; sessions are numbered 1-9 in this order (AXA is 0)
  // Workspaces, like herdr's: one per project (a worktree session belongs to its repo). A workspace's
  // state rolls up from its sessions: needs you > working > done (not yet seen) > idle.
  const wsKey = (s) => s.worktree?.repo || s.cwd;
  const rollup = (arr) => { const [st, rank] = arr.some(needsYou) ? ["waiting", 0] : arr.some((s) => s.status === "working") ? ["working", 1] : arr.some(unseenDone) ? ["done", 2] : [null, 3]; return st ? [STATUS[st].glyph, STATUS[st].word, STATUS[st].tui, rank] : [STATUS.ready.glyph, "idle", "off", rank]; };
  function workspaces() {
    const by = new Map();
    for (const s of c.list) if (s.mode !== "axa") { const k = wsKey(s); by.set(k, [...(by.get(k) || []), s]); }
    return [...by.entries()].map(([key, ss]) => ({ key, name: basename(key), sessions: ss.sort(byUrgency), state: rollup(ss) }))
      .sort((a, b) => a.state[3] - b.state[3] || Math.max(...b.sessions.map((s) => s.last_event_at || s.created)) - Math.max(...a.sessions.map((s) => s.last_event_at || s.created)));
  }
  // sessions in display order (by workspace, then urgency): their numbers 1-9 follow it
  const sessions = () => workspaces().flatMap((w) => w.sessions);
  const ordered = () => [...c.list.filter((x) => x.mode === "axa"), ...sessions()];
  const workspaceOf = (id) => workspaces().find((w) => w.sessions.some((s) => s.id === id));

  // Sidebar as a tree (the default). AXA is the root; each project hangs off it with its status at the
  // right edge, then what it's doing and its branch underneath. A project with several sessions lists
  // them one level deeper. The selected session is marked with a bar at the left edge.
  function treeRows(L, rows, hits) {
    const { renderSegs } = c;
    // (animation runs off the app's shared tick, which only ticks fast while something works)
    const w = L.side, frame = Math.floor((c.tickN || 0) / 2), ss = sessions(), axa = c.list.find((s) => s.mode === "axa");
    // one row: left segments, and right-aligned segments (the status)
    const line = (segs, id, isSel, right = []) => {
      const marked = isSel && segs[0]?.[0]?.startsWith(" ") ? [["▌", "accent"], [segs[0][0].slice(1), segs[0][1]], ...segs.slice(1)] : segs;
      const rw = right.reduce((n, [t]) => n + width(t), 0);
      rows.push(renderSegs(marked, Math.max(0, w - rw)) + (rw ? renderSegs(right, rw) : ""));
      hits[rows.length - 1] = id;
    };
    const status = (s) => {
      const [g, word, role0] = look(s), fresh = unseenDone(s), role = s.status === "done" && !fresh ? "off" : role0;
      const sp = spark(c.ev, s.id);
      return [...(sp ? [[sp + " ", "work"]] : []), [`${c.glyph(s)} ${word}`, role], [fresh ? " •" : "", "done"], [" ", ""]];
    };
    // stuck or failed: why (when the console says); waiting: the question; else what it's doing
    const doing = (s) => (reasonOf(s) ? [reasonOf(s), "stuck"] : s.status === "waiting" && s.choices ? [question(s.choices), "waitSoft"] : s.mode === "shell" ? null : s.status === "done" && !unseenDone(s) ? null : [what(s), "dim"]);
    const meta = (s) => [gitText(s.git), costText(s.cost) ? "" : s.usage?.tokens ? `${fmtTok(s.usage.tokens)} tok${s.usage.over_budget ? "!" : ""}` : "", s.worktree ? "worktree" : ""].filter(Boolean).join(" · ");
    // cost, the PR and the CI run (links to GitHub), when the console knows them
    const ghRow = (pre, s) => {
      const b = githubBits(s.github, c.icons()), cost = costText(s.cost);
      if (cost) b.push({ text: c.icon("cost") === "$" ? cost : `${c.icon("cost")} ${cost}`, role: "dim" });
      if (b.length) line([[pre, "rule"], ...b.flatMap((x, i) => [[i ? " · " : "", "dim"], [x.text, x.role, x.url]])], s.id, s.id === c.selId());
    };
    const recent = (id) => (c.ev.helpers.get(id) || []).filter((h) => h.status === "running" || Date.now() - h.ts < 15 * 60_000);
    const helpersRow = (pre, id) => { const hg = helperGroups(recent(id)); if (hg.length) line([[`${pre}└ `, "rule"], ...hg.flatMap(([t, r], k) => [[k ? " · " : "", "dim"], [t, r]]), [hg.length === 1 && hg[0][2] ? `: ${hg[0][2]}` : "", "dim"]], `agents:${id}`, false); };
    const linksRows = (pre, s) => {
      for (const ch of c.chainsList.filter((ch) => ch.from === s.id && !ch.failed && (!ch.fired || Date.now() - ch.fired < 15 * 60_000))) {
        const to = c.list.find((x) => x.id === ch.to);
        line([[`${pre}──▶ `, ch.fired ? "dim" : "accent"], [to ? nameOf(to) : ch.to_name || "?", ch.fired ? "dim" : "accent"], [ch.fired ? " ✓ sent" : " when done", "dim"]], s.id, false);
      }
    };
    // a session: its name row (with the branch animating while it works), then details under it
    const session = (s, stemPre, joint, pre, name) => {
      const isSel = s.id === c.selId(), n = nums.get(s.id), p = frame % 3;
      const wire = s.status === "working" ? [0, 1, 2].map((k) => (k === p ? "●" : "─")).join("").slice(0, 2) : "──";
      line([[`${stemPre}${joint}`, "rule"], [wire, s.status === "working" ? "work" : s.status === "waiting" ? "wait" : "rule"], [" ", ""], [n.trim() ? `${n} ` : "", "dim"], [name, s.status === "waiting" ? "wait" : "title"]], s.id, isSel, status(s));
      const d = doing(s);
      if (d) line([[pre, "rule"], d], s.id, isSel);
      const m = meta(s);
      if (m) line([[pre, "rule"], [m, "dim"]], s.id, isSel);
      ghRow(pre, s);
      helpersRow(pre, s.id);
      linksRows(pre, s);
    };

    const wss = workspaces(), nums = new Map(ss.map((s, i) => [s.id, i < 9 ? String(i + 1) : " "]));
    const down = wss.length ? "│" : " ";
    if (axa) {
      const isSel = axa.id === c.selId(), [, word, role] = look(axa), g = c.glyph(axa);
      line([[` ${c.icon("axa")} `, "title"], ["AXA", "title"]], axa.id, isSel, [[`${g} ${axa.status === "done" ? "ready" : word}`, axa.status === "done" ? "idle" : role], [" ", ""]]);
      const d = axa.status === "working" ? what(axa) : axa.status === "waiting" ? "needs your approval" : "ready for your next message";
      line([[` ${down} `, "rule"], [d, axa.status === "waiting" ? "waitSoft" : "dim"]], axa.id, isSel);
      helpersRow(` ${down} `, axa.id);
    } else line([[` ${c.icon("axa")} AXA`, "title"]], null, false, [["not running · Ctrl-b o ", "dim"]]);
    if (!wss.length) return;
    wss.forEach((ws, wi) => {
      const lastWs = wi === wss.length - 1, wstem = lastWs ? " " : "│";
      line([[" │", "rule"]], null, false);
      // one session: the project row is the session
      if (ws.sessions.length === 1) return session(ws.sessions[0], " ", lastWs ? "└" : "├", ` ${wstem}    `, ws.name);
      // several: the project, then its sessions one level deeper
      const [wg, wword, wrole] = ws.state;
      line([[` ${lastWs ? "└" : "├"}── `, "rule"], [ws.name, "title"], [w - 6 - width(ws.name) - width(`${wg} ${wword}`) >= width(`  ${ws.sessions.length} sessions`) + 1 ? `  ${ws.sessions.length} sessions` : ` ×${ws.sessions.length}`, "dim"]], ws.sessions[0].id, false, [[`${wg} ${wword}`, wrole], [" ", ""]]);
      ws.sessions.forEach((s, i) => {
        const last = i === ws.sessions.length - 1;
        session(s, ` ${wstem}   `, last ? "└" : "├", ` ${wstem}   ${last ? " " : "│"}    `, shortName(s));
      });
    });
  }
  function sideRows(L) {
    const { sgr } = c;
    const rows = [], o = ordered(), w = L.side, hits = [];
    c.sideHits = hits;
    if (cfg.sidebarStyle !== "list") treeRows(L, rows, hits);
    else { rows.push(sgr("title", pad(" AXA mission control", w))); rows.push(sgr("rule", "─".repeat(w))); }
    const nums = new Map(sessions().map((s, i) => [s.id, i < 9 ? String(i + 1) : " "]));
    for (const s of cfg.sidebarStyle === "list" ? o : []) {
      const [, word, role] = look(s), g = c.glyph(s);
      const isSel = s.id === c.selId(), shown = c.onScreen(s.id), num = s.mode === "axa" ? "0" : nums.get(s.id);
      const head = `${shown && !isSel ? "▸" : " "}${num} ${g} ${cut(nameOf(s), w - 7)}`;
      const sub = `     ${cut(s.status === "waiting" && s.choices ? question(s.choices) : (s.mode === "axa" && ["ready", "starting"].includes(s.status)) || (s.mode === "shell" && word === "shell") ? what(s) : `${word} · ${what(s)}`, w - 6)}`;
      // the activity sparkline sits at the right end of the session's name row
      const sp = spark(c.ev, s.id), spW = sp ? SPARK_BUCKETS + 1 : 0;
      const metaText = s.mode === "axa" ? null : `     ${cut([gitText(s.git), s.usage?.tokens ? `${fmtTok(s.usage.tokens)} tok${s.usage.over_budget ? "!" : ""}` : ""].filter(Boolean).join(" · "), w - 6)}`;
      const lines = [[head, role, true], [sub, "dim", false], ...(metaText !== null ? [[metaText, "dim", false]] : [])];
      for (const [t, r, withSpark] of lines) {
        const body = withSpark && sp ? pad(t, w - spW) : pad(t, w);
        rows.push(isSel ? sgr("sel", body + (withSpark && sp ? " " + sp : "")) : sgr(r, body) + (withSpark && sp ? " " + sgr(role === "off" ? "dim" : "work", sp) : ""));
        hits[rows.length - 1] = s.id;
      }
    }
    if (!c.list.some((s) => s.mode !== "axa")) rows.push(sgr("dim", pad("   no sessions yet: Ctrl-b c", w)));
    while (rows.length < c.H - 1) rows.push(" ".repeat(w));
    rows.length = c.H - 1;
    return rows;
  }
  return { nameOf, shortName, unseenDone, workspaces, sessions, ordered, workspaceOf, sideRows };
}
