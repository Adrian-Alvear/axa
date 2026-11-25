// The Control screen's live view: one lane per session, its agents hanging off it as branches.
//   ◆ AXA      ──╱╲───╱╲╱╲──▏standing by
//   ▲ charlie  ▃▅▇▇▅▃▁▁▁▁▁▁▁▏NEEDS YOU  deploy:preview?          waiting 2m
//   ✶ alpha    ▂▃▅▆▇▆•▆▇▅▆▇▆▏WORKING    npm test     +2 agents  ~1 min left
//    ├──────── ✻ researcher  Grep flaky
//    └──────── ✻ reviewer  Read test/app.test.mjs
//   ✓ delta    ▅▃▂▁▁         ▏DONE       README updated             5m ago
// Each lane: status glyph + name, an activity strip (events per time bucket over the last 15 minutes, the
// newest at the right, the playhead ▏ marking now), the status word in its colour, what it's doing now (or the
// question it waits on), its running agents, and time (how long it has waited, the time left from the duration
// store, how long ago). The commander comes first, then what needs you, then what failed or is stuck, then what
// works, then the rest; within a group the order is stable (by when the session started), so rows don't jump.
// Motion only with meaning (alive.mjs, docs/tasks/map-alive.md): each step flies along its lane as a packet, agents'
// branches grow and fold, glyphs breathe and pulse, the doing text shimmers, the commander's sends travel down the
// gutter, a lane that changes group slides there. Nothing moves when everything is idle; Motion "reduced" keeps
// only colour changes, "off" keeps everything still.
// Pure parts (ordering, bucketing, layout, time text) are exported for the tests.
import { I, clean, cut, line, look, mix, width } from "./draw.mjs";
import { graphemes } from "./width.mjs";
import { DONE_MS, FADE_MS, FLASH_MS, FRAME_MS, GLYPHS, KIND_ROLE, PACKET_CAP, PULSE_MS, agentsOf, branchBudget, branchView, breath, doingSince, doneFade, dotRow, flicker, flickerNext, heartbeat, mergeCells, observeSessions, packetAt, pending, shimmer, slideOrder, sliding, spinFrames, typeIn, wave } from "./alive.mjs";

export const LANE_IDLE_MS = 20 * 60_000; // a finished session leaves the lanes after this long idle
export const STRIP_SPAN_MS = 15 * 60_000;
const BLOCKS = "▁▂▃▄▅▆▇█";
const NEEDS = ["waiting", "needs_trust"], TROUBLE = ["stuck", "failed", "limited"], BUSY = ["working", "starting"];

// ---------- which lanes, in which order ----------
// 0 commander, 1 needs you, 2 failed/stuck/limited, 3 working, 4 done/ready/idle/exited
export const laneGroup = (s) => (s.mode === "axa" ? 0 : NEEDS.includes(s.status) ? 1 : TROUBLE.includes(s.status) ? 2 : BUSY.includes(s.status) ? 3 : 4);
export const laneOrder = (sessions) => sessions
  .map((s, i) => [s, i])
  .sort(([a, i], [b, j]) => laneGroup(a) - laneGroup(b) || (a.created || 0) - (b.created || 0) || i - j)
  .map(([s]) => s);
// The lanes shown (alive sessions, commander first) and how many idle ones are left off: a finished session
// idle for LANE_IDLE_MS leaves (it stays open, in the Sessions tab) unless it's the selected one
export function laneSessions(sessions, selId) {
  const alive = sessions.filter((s) => s.alive);
  const idle = (s) => s.mode !== "axa" && s.id !== selId && ["done", "ready", "exited"].includes(s.status) && (s.idle_seconds || 0) * 1000 > LANE_IDLE_MS;
  const lanes = laneOrder(alive.filter((s) => !idle(s)));
  return { lanes, hidden: alive.length - lanes.length, sessions: lanes.filter((s) => s.mode !== "axa").length };
}

// What waits on you, counted one way everywhere (the title's chip, the lanes' header, the status line, the tab):
// need = a prompt or trust question, stuck = a step that hangs. The chip shows the sum; the texts show both parts.
export function needTally(sessions) {
  const alive = sessions.filter((s) => s.alive);
  const need = alive.filter((s) => NEEDS.includes(s.status)).length, stuck = alive.filter((s) => s.status === "stuck").length;
  return { need, stuck, total: need + stuck };
}
export const needText = ({ need, stuck }) => [need ? `${need} need${need === 1 ? "s" : ""} you` : "", stuck ? `${stuck} stuck` : ""].filter(Boolean).join(" · ");

// ---------- the activity strip ----------
// Event times -> counts per bucket, oldest first, the newest bucket (the one `now` falls in) last. Buckets sit on
// a fixed time grid (not sliding with `now`), so a strip only shifts when a new bucket starts, and the newest fills
// up live. Buckets that ended before the session existed are null (drawn blank).
export function stripBuckets(times, { now, n, span = STRIP_SPAN_MS, since = 0 }) {
  if (n <= 0) return [];
  const size = Math.max(1000, Math.ceil(span / n / 1000) * 1000), last = Math.floor(now / size);
  const out = Array(n).fill(0);
  for (const t of times || []) { const i = n - 1 - (last - Math.floor(t / size)); if (i >= 0 && i < n && t <= now) out[i]++; }
  if (since) for (let i = 0; i < n; i++) if ((last - (n - 1 - i) + 1) * size <= since) out[i] = null;
  return out;
}
// counts -> cells [[char, role]]: blank before the session existed, ▁ (faint) when quiet, taller with more events
// (scaled to `max`, shared by all lanes so they compare)
export const stripCells = (buckets, max, role) => buckets.map((c) => (c === null ? [" ", ""] : !c ? [BLOCKS[0], "frame"] : [BLOCKS[Math.max(1, Math.min(7, Math.ceil((c / Math.max(1, max)) * 7)))], role]));
export const stripSegs = (buckets, max, role) => mergeCells(stripCells(buckets, max, role));

// ---------- time ----------
const span = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(m / 1440)}d`;
};
const left = (ms) => (ms < 60_000 ? "<1 min left" : ms < 90 * 60_000 ? `~${Math.round(ms / 60_000)} min left` : `~${Math.round(ms / 3600_000)} h left`);
// The right column: how long it has waited on you, how long a stuck step has run, the time left for a working
// one (from the duration store: s.eta), else how long ago it last did something
export function laneTime(s, now = Date.now()) {
  if (NEEDS.includes(s.status)) return s.wait_since ? `waiting ${span(now - s.wait_since)}` : "waiting";
  if (s.status === "stuck") return s.stuck_minutes != null ? `stuck ${span(s.stuck_minutes * 60_000)}` : "stuck";
  if (s.status === "working") {
    if (s.eta?.over) return "longer than usual";
    if (s.eta?.left_ms > 0) return left(s.eta.left_ms);
    return s.turn_start ? `for ${span(now - s.turn_start)}` : "";
  }
  if (s.status === "starting") return "";
  if (s.status === "limited" && s.limit_resets) return `resets ${s.limit_resets}`;
  const at = s.last_event_at || s.created;
  if (!at) return "";
  return now - at < 60_000 ? "just now" : `${span(now - at)} ago`;
}

// ---------- words ----------
const firstLine = (t) => clean(String(t || "").split("\n").find((l) => l.trim()) || "");
// The status word: the commander idling "stands by"; everything else in capitals
export const laneWord = (s) => (s.mode === "axa" && ["ready", "done", "starting"].includes(s.status) ? (s.status === "starting" ? "starting" : "standing by") : look(s)[1].toUpperCase());
// What a prompt is about: a permission prompt's own question is generic ("Do you want to proceed?"), so the
// command or file it names comes first ("npm run deploy:preview?"); a real question stays as it is
const GENERIC = /^(?:do you want to\b|bash command$|edit file$|write file$|read file$|create file$|tool use$|fetch$|web ?fetch$)/i;
export function asked(c, question = (x) => x?.question || "") {
  const q = clean(question(c));
  if (!/^do you want to\b/i.test(q)) return q;
  const what = String(c.question || "").split("\n").map(clean).find((l) => l && !GENERIC.test(l));
  return what ? `${what.replace(/[?.:]+$/, "")}?` : q;
}
// What it's doing now: its current step, the question it waits on, what went wrong, what it reported
export function laneDoing(s, question = (c) => c?.question || "") {
  if (s.status === "waiting") return clean(s.choices ? asked(s.choices, question) : s.doing) || "waiting on you";
  if (s.status === "needs_trust") return "trust this folder? (or axa trust <project>)";
  if (s.status === "failed") return firstLine(s.error) || "the turn failed";
  if (s.status === "limited") return firstLine(s.error) || "usage limit";
  if (s.status === "exited") return s.mode === "shell" ? "shell ended" : "Claude has exited";
  if (BUSY.includes(s.status) || s.status === "stuck") return clean(s.doing) || (s.status === "starting" ? "" : "thinking…");
  return s.mode === "axa" ? "" : firstLine(s.last_report);
}
export const runningAgents = (s) => (s.helpers || []).filter((h) => h.status === "running");

// ---------- layout ----------
const DOING_MIN = 10, STRIP_MIN = 4, NAME_MIN = 4;
// Column widths for a panel `cols` wide. Wanted widths come from what's on show (the longest name, status word,
// time text, agent count). Columns drop when it's narrow: the agents first, then the time, then what it's doing;
// after that the strip, then the names, get narrower. Each lane: " " glyph " " name " " strip " " status
// [" " doing] [" " agents] [" " time] " ".
export function laneLayout(cols, { nameW = 8, statusW = 9, timeW = 0, agentsW = 0 } = {}) {
  const L = { nameW, strip: Math.max(STRIP_MIN, Math.min(32, Math.round(cols * 0.16))), statusW, doingW: 0, agentsW, timeW, doing: true };
  const base = () => 3 + L.nameW + 1 + L.strip + 1 + L.statusW + 1;
  const need = () => base() + (L.doing ? 1 + DOING_MIN : 0) + (L.agentsW ? 1 + L.agentsW : 0) + (L.timeW ? 1 + L.timeW : 0);
  if (need() > cols) L.agentsW = 0;
  if (need() > cols) L.timeW = 0;
  if (need() > cols) L.doing = false;
  while (need() > cols && L.strip > STRIP_MIN) L.strip--;
  while (need() > cols && L.nameW > NAME_MIN) L.nameW--;
  if (L.doing) L.doingW = cols - base() - 1 - (L.agentsW ? 1 + L.agentsW : 0) - (L.timeW ? 1 + L.timeW : 0);
  return L;
}

// ---------- drawing ----------
const fit = (t, n) => { const c = cut(t, n); return c + " ".repeat(Math.max(0, n - width(c))); };
const fitRight = (t, n) => { const c = cut(t, n); return " ".repeat(Math.max(0, n - width(c))) + c; };
const HINT = "y yes · x no";
// lanes out of step with each other (their spinners and shimmer don't all beat together)
const phaseOf = (id) => { let h = 7; for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 2654435761); return (h >>> 0) % 4000; };
// the doing text with the shimmer's bright band over it
function shimmerSegs(text, now, phase) {
  const g = graphemes(text), b = shimmer(g.length, now, phase);
  return mergeCells(g.map((ch, i) => [ch, b[i] > 0 ? mix("text", "hi", Math.ceil(b[i] * 3) / 3) : "text"]));
}
// an agent's branch with reduced or no motion: there or not (a finished one shows its ✓ while it flashes)
const stillView = (b, now, full, color) => (b.ended ? (color && now - b.ended < FLASH_MS ? { run: full, chars: Infinity, mark: b.failed ? "fail" : "done", flash: 1 - (now - b.ended) / FLASH_MS } : { gone: true }) : { run: full, chars: Infinity, mark: "spin", flash: 0 });

// ctx: { sessions, selId, act (with lanes: { id: [event times] }), motion, question, mapHits, alive (alive.mjs: what
// the hub has seen; without it nothing moves), glyphs ("safe" | "ascii") } -> rows exactly `cols` wide; fills
// ctx.mapHits (one per lane row, one per agent branch), ctx.next (ms until the next frame differs, null = still)
// and ctx.anim (the next frame is due at once)
export function laneRows(ctx, cols, rows, now = Date.now()) {
  const { lanes: ordered, hidden, sessions: nSessions } = laneSessions(ctx.sessions, ctx.selId);
  const motion = ctx.motion || "full", full = motion === "full", color = motion !== "off";
  const A = ctx.alive || null, set = ctx.glyphs || "safe", G = GLYPHS[set] || GLYPHS.safe, frames = spinFrames(set);
  const out = [], hits = ctx.mapHits || (ctx.mapHits = []);
  let next = Infinity;
  const wake = (ms = FRAME_MS) => { next = Math.min(next, Math.max(FRAME_MS, ms)); };
  const done = () => { ctx.next = next === Infinity ? null : next; ctx.anim = next <= FRAME_MS; };
  const blank = () => " ".repeat(cols);
  if (A) observeSessions(A, ctx.sessions, now);
  if (!ordered.length) {
    const m = ["No sessions yet · N starts one · : talk to AXA", "No sessions yet · N starts one", "N: new session"].find((t) => width(t) + 2 <= cols) || "";
    out.push(line([["  " + m, "dim"]], cols));
    while (out.length < rows) out.push(blank());
    done();
    return out.slice(0, rows);
  }
  // while a lane slides to its new group, the rows are laid out by where it is on the way
  let lanes = ordered;
  if (A) {
    const order = slideOrder(A, ordered.map((s) => s.id), now), byId = new Map(ordered.map((s) => [s.id, s]));
    if (full) { lanes = order.map((id) => byId.get(id)); if (sliding(A, now)) wake(); }
  }
  // what each lane says, then the widths that fit it
  const info = lanes.map((s) => {
    const agents = runningAgents(s);
    const branches = A ? agentsOf(A, s.id) : agents.map((h) => ({ sid: s.id, h, born: 0, ended: 0 }));
    return { s, word: laneWord(s), doing: laneDoing(s, ctx.question), time: laneTime(s, now), agents, branches, agentText: agents.length ? `+${agents.length} agent${agents.length > 1 ? "s" : ""}` : "" };
  });
  const L = laneLayout(cols, {
    nameW: Math.min(16, Math.max(5, ...info.map((x) => width(x.s.mode === "axa" ? "AXA" : clean(x.s.name))))),
    statusW: Math.max(...info.map((x) => width(x.word))),
    timeW: Math.min(18, Math.max(0, ...info.map((x) => width(x.time)))),
    agentsW: Math.max(0, ...info.map((x) => width(x.agentText))),
  });
  // the strips: one shared scale so a busy lane looks busier than a quiet one
  const times = ctx.act?.lanes || {};
  const buckets = info.map((x) => stripBuckets(times[x.s.id], { now, n: L.strip, since: x.s.created || 0 }));
  const max = Math.max(4, ...buckets.flat().filter((c) => c != null));
  // a window of lanes that keeps the selected one in view, and a "+N more" line when they don't all fit
  const footer = hidden ? 1 : 0;
  const fitsAll = lanes.length + footer <= rows;
  const per = fitsAll ? lanes.length : Math.max(1, rows - 1); // (one line for "+N more" and the idle note)
  const selIdx = Math.max(0, lanes.findIndex((s) => s.id === ctx.selId));
  const start = fitsAll ? 0 : Math.max(0, Math.min(lanes.length - per, selIdx - per + 1));
  // agents hang off their lane as branches when every lane fits: the selected lane shows all of them, the others
  // up to 3 (and "+N more"); fewer when the rows run out
  const B = L.nameW + 1; // a branch's run: its agent's glyph sits under the lane's strip
  const views = info.map((x) => x.branches.map((b) => [b, full ? branchView(b, now, B) : stillView(b, now, B, color)]).filter(([, v]) => !v.gone));
  const room = L.doing && cols >= 50 && fitsAll ? rows - lanes.length - footer - (nSessions ? 0 : 1) : 0;
  const want = branchBudget(views.map((v) => v.length), lanes.findIndex((s) => s.id === ctx.selId), room);
  // packets on a track `cells` long (the strip's cells or a branch's run)
  const flying = (tracks, n) => {
    if (!A || !full) return [];
    const ps = A.packets.filter((p) => tracks(p)).sort((a, b) => a.start - b.start), at = [];
    for (const p of ps) {
      if (now < p.start) { wake(p.start - now); continue; }
      const c = packetAt(p, now, n);
      if (c != null) { at.push([c, p]); wake(); }
    }
    return at.slice(-PACKET_CAP);
  };
  const R = []; // rows as segments (the gutter first: the commander's sends travel down it), drawn at the end
  for (let k = start; k < Math.min(lanes.length, start + per); k++) {
    const x = info[k], s = x.s, sel = s.id === ctx.selId, cmd = s.mode === "axa", busy = BUSY.includes(s.status);
    const [g, , role] = look(s);
    let glyph = g, gRole = role;
    // working: a breathing glyph (Claude Code's); needs you: a slow amber pulse; stuck: a short flicker now and
    // then; done: a flash that fades to dim; failed: solid red
    const breathe = () => { if (full) wake(); return full ? breath(now + phaseOf(s.id), frames) : G.still; };
    if (busy) glyph = breathe();
    if (cmd) { glyph = I.axa; gRole = "title"; if (s.status === "working") { glyph = breathe(); gRole = "work"; } else if (s.status === "waiting") gRole = "wait"; }
    if (NEEDS.includes(s.status)) { gRole = color ? mix("wait", "waitHi", wave(now + phaseOf(s.id))) : "wait"; if (color) wake(); }
    if (s.status === "stuck" && color) { if (flicker(now)) gRole = "dim"; wake(flickerNext(now)); }
    if (s.status === "done" && !cmd) {
      const st = A?.status.get(s.id), dt = st?.since ? now - st.since : Infinity;
      gRole = color && dt < DONE_MS ? mix("hi", "dim", doneFade(dt)) : "dim";
      if (color && dt < DONE_MS) wake();
    }
    // a lane that just started fades in
    const born = A?.born.get(s.id), nameRole = cmd ? "title" : "head";
    const nRole = color && born != null && now - born < FADE_MS ? (wake(), mix("frame", nameRole, (now - born) / FADE_MS)) : nameRole;
    const wordRole = cmd && laneGroup({ ...s, mode: "" }) === 4 ? "dim" : role === "idle" ? "text" : role;
    const segs = [[" ", ""], [glyph, gRole], [" ", ""], [fit(cmd ? "AXA" : clean(s.name), L.nameW), nRole], [" ", ""]];
    // the strip (the commander's is a heartbeat): its newest cell lights up on each event, the playhead marks now,
    // and the steps fly along it
    const cells = cmd ? heartbeat(buckets[k], set) : stripCells(buckets[k], max, ["done", "idle", "off"].includes(role) ? "dim" : role);
    const head = [G.head, "frame"], pt = A?.pulses.get(s.id);
    if (color && pt != null && now >= pt && now < pt + PULSE_MS) {
      const f = (now - pt) / PULSE_MS, last = cells.at(-1);
      if (last && last[0] !== " ") last[1] = mix("hi", last[1] || "frame", f);
      head[1] = mix("hi", "frame", f);
      wake();
    } else if (color && pt != null && now < pt) wake(pt - now);
    const vis = views[k].slice(0, want[k] || 0), shownAgents = new Set(vis.map(([b]) => `a:${b.h.id}`));
    for (const [c, p] of flying((p) => p.lane === s.id && (p.track === `l:${s.id}` || !shownAgents.has(p.track)), cells.length)) cells[c] = [G.packet, KIND_ROLE[p.kind]];
    segs.push(...mergeCells(cells), head, [fit(x.word, L.statusW), wordRole]);
    const hint = sel && s.status === "waiting" && s.choices;
    if (L.doing) {
      const dRole = NEEDS.includes(s.status) ? "waitSoft" : TROUBLE.includes(s.status) ? "stuck" : BUSY.includes(s.status) ? "text" : "dim";
      const since = A ? doingSince(A, s.id, x.doing, now) : 0;
      if (hint && L.doingW >= width(HINT) + 8) { const d = cut(x.doing, L.doingW - width(HINT) - 2); segs.push([" ", ""], [d, dRole], ["  ", ""], [fit(HINT, L.doingW - width(d) - 2), "key"]); }
      else if (busy && full && x.doing) {
        // working: the text types in when it changes, and the shimmer slides over it
        const typed = typeIn(x.doing, since, now), t = cut(typed, L.doingW);
        segs.push([" ", ""], ...shimmerSegs(t, now, phaseOf(s.id)), [" ".repeat(Math.max(0, L.doingW - width(t))), ""]);
        wake();
      } else segs.push([" ", ""], [fit(x.doing, L.doingW), dRole]);
    }
    if (L.agentsW) segs.push([" ", ""], [fit(x.agentText, L.agentsW), "violet"]);
    if (L.timeW) segs.push([" ", ""], [hint && !L.doing && L.timeW >= width(HINT) ? fitRight(HINT, L.timeW) : fitRight(x.time, L.timeW), hint && !L.doing ? "key" : NEEDS.includes(s.status) ? "waitSoft" : "dim"]);
    R.push({ segs, on: sel ? "selDim" : null, lane: s.id, name: cmd ? "" : clean(s.name), project: String(s.cwd || "").split("/").filter(Boolean).pop() || "" });
    hits.push({ col0: 0, col1: cols, row0: R.length - 1, row1: R.length - 1, id: s.id });
    // its agents, as branches under it: each clickable (opens what it's doing)
    const more = views[k].length - vis.length;
    vis.forEach(([b, v], j) => {
      const last = j === vis.length - 1, h = b.h;
      const run = Array.from({ length: v.run }, () => [G.run, "frame"]);
      for (const [c, p] of flying((p) => p.track === `a:${h.id}`, run.length)) run[c] = [G.packet, KIND_ROLE[p.kind]];
      const mark = v.mark === "spin" ? [full ? breath(now + phaseOf(h.id), frames) : G.still, "violet"]
        : v.mark === "done" ? [G.done, color ? mix("hi", "done", 1 - v.flash) : "done"]
          : v.mark === "fail" ? [G.fail, color ? mix("hi", "stuck", 1 - v.flash) : "stuck"] : [" ", ""];
      if (v.mark === "spin" ? full : v.mark || v.run < B || v.chars !== Infinity) wake();
      // the label types in after the branch has grown
      const type = cut(String(h.type || "agent").split(":").pop(), 18), step = h.doing ? `  ${clean(h.doing)}` : "";
      const tg = graphemes(type), sg = graphemes(step), n = v.chars === Infinity ? Infinity : v.chars;
      const typeShown = n >= tg.length ? type : tg.slice(0, n).join(""), stepShown = n >= tg.length + sg.length ? step : n > tg.length ? sg.slice(0, n - tg.length).join("") : "";
      const b2 = [[" ", ""], [last ? G.end : G.tee, "frame"], ...mergeCells(run), [" ".repeat(B - v.run), ""], [" ", ""], mark, [" ", ""], [typeShown, "violet"], [stepShown, "dim"]];
      if (last && more > 0) b2.push([`  +${more} more`, "dim"]);
      R.push({ segs: b2, on: null, lane: s.id, branch: true });
      const col0 = 3 + B;
      hits.push({ col0, col1: cols - 1, row0: R.length - 1, row1: R.length - 1, id: s.id, agent: h.id });
    });
  }
  // the commander's sends: a dot down the gutter, from its lane to the session it went to
  if (A && full) {
    for (const d of A.sends) {
      if (now < d.start) { wake(d.start - now); continue; }
      const from = R.findIndex((r) => !r.branch && r.lane === d.from);
      const to = R.findIndex((r) => !r.branch && (d.to.id ? r.lane === d.to.id : d.to.name && (r.name === d.to.name || r.project === d.to.name)));
      if (from < 0 || to < 0) continue;
      const y = dotRow(d, now, from, to);
      if (y == null) continue;
      R[y].segs[0] = [G.dot, "hi"];
      wake();
    }
  }
  for (const r of R) out.push(line(r.segs, cols, [], r.on));
  const moreLanes = lanes.length - (start + per), before = start;
  const notes = [];
  if (before || moreLanes > 0) notes.push(`${before ? `↑ ${before} above` : ""}${before && moreLanes > 0 ? " · " : ""}${moreLanes > 0 ? `+${moreLanes} more` : ""} · ↑↓ scroll`);
  if (hidden) notes.push(`${hidden} idle hidden · Sessions tab`);
  if (!nSessions && out.length < rows) out.push(line([["  No sessions yet · N starts one · : talk to AXA", "dim"]], cols));
  if (notes.length) out.push(line([["  " + notes.join(" · "), "dim"]], cols));
  while (out.length < rows) out.push(blank());
  if (A && full && pending(A, now)) wake();
  done();
  return out.slice(0, rows);
}
