// The Control screen's live view: one lane per session.
//   ◆ AXA      ▁▁▂▂▁▁▁▁▁▁▃▂▁  standing by
//   ▲ charlie  ▃▅▇▇▅▃▁▁▁▁▁▁▁  NEEDS YOU  deploy:preview?          waiting 2m
//   ⠹ alpha    ▂▃▅▆▇▆▅▆▇▅▆▇▆  WORKING    npm test     +2 agents  ~1 min left
//   ✓ delta    ▅▃▂▁▁          DONE       README updated             5m ago
// Each lane: status glyph + name, an activity strip (events per time bucket over the last 15 minutes, the
// newest at the right), the status word in its colour, what it's doing now (or the question it waits on),
// its running agents, and time (how long it has waited, the time left from the duration store, how long ago).
// The commander comes first, then what needs you, then what failed or is stuck, then what works, then the rest;
// within a group the order is stable (by when the session started), so rows don't jump.
// Motion only with meaning: a working glyph spins, a needs-you glyph pulses gently, the newest bucket fills as
// events come in. Nothing moves when everything is idle; Motion "reduced"/"off" keeps glyphs still.
// Pure parts (ordering, bucketing, layout, time text) are exported for the tests.
import { I, clean, cut, line, look, spinner, width } from "./draw.mjs";

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
// counts -> [[text, role]]: blank before the session existed, ▁ (faint) when quiet, taller with more events
// (scaled to `max`, shared by all lanes so they compare)
export function stripSegs(buckets, max, role) {
  const segs = [];
  const add = (ch, r) => { const l = segs.at(-1); if (l && l[1] === r) l[0] += ch; else segs.push([ch, r]); };
  for (const c of buckets) {
    if (c === null) add(" ", "");
    else if (!c) add(BLOCKS[0], "frame");
    else add(BLOCKS[Math.max(1, Math.min(7, Math.ceil((c / Math.max(1, max)) * 7)))], role);
  }
  return segs;
}

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

// ctx: { sessions, selId, act (with lanes: { id: [event times] }), motion, question, mapHits } -> rows exactly
// `cols` wide; fills ctx.mapHits (one per lane row, agent names on its second line) and ctx.anim
export function laneRows(ctx, cols, rows, now = Date.now()) {
  const { lanes, hidden, sessions: nSessions } = laneSessions(ctx.sessions, ctx.selId);
  const motion = ctx.motion || "full", full = motion === "full";
  const out = [], hits = ctx.mapHits || (ctx.mapHits = []);
  let anim = false;
  const blank = () => " ".repeat(cols);
  if (!lanes.length) {
    const m = ["No sessions yet · N starts one · : talk to AXA", "No sessions yet · N starts one", "N: new session"].find((t) => width(t) + 2 <= cols) || "";
    out.push(line([["  " + m, "dim"]], cols));
    while (out.length < rows) out.push(blank());
    ctx.anim = false;
    return out.slice(0, rows);
  }
  // what each lane says, then the widths that fit it
  const info = lanes.map((s) => {
    const agents = runningAgents(s);
    return { s, word: laneWord(s), doing: laneDoing(s, ctx.question), time: laneTime(s, now), agents, agentText: agents.length ? `+${agents.length} agent${agents.length > 1 ? "s" : ""}` : "" };
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
  // second lines (a lane's running agents) only when every lane and its agents fit
  const extra = info.reduce((n, x) => n + (x.agents.length ? 1 : 0), 0);
  const footer = hidden ? 1 : 0;
  const withAgents = L.doing && cols >= 50 && lanes.length + extra + footer + (nSessions ? 0 : 1) <= rows;
  // a window of lanes that keeps the selected one in view, and a "+N more" line when they don't all fit
  const fitsAll = lanes.length + footer <= rows;
  const per = fitsAll ? lanes.length : Math.max(1, rows - 1); // (one line for "+N more" and the idle note)
  const selIdx = Math.max(0, lanes.findIndex((s) => s.id === ctx.selId));
  const start = fitsAll ? 0 : Math.max(0, Math.min(lanes.length - per, selIdx - per + 1));
  for (let k = start; k < Math.min(lanes.length, start + per); k++) {
    const x = info[k], s = x.s, sel = s.id === ctx.selId, cmd = s.mode === "axa";
    const [g, , role] = look(s);
    let glyph = g, gRole = role;
    if (cmd) { glyph = I.axa; gRole = "title"; if (s.status === "working") { glyph = spinner(); gRole = "work"; } else if (s.status === "waiting") gRole = "wait"; }
    if (BUSY.includes(s.status) && full) anim = true;
    // a needs-you lane: its glyph pulses gently (full motion), steady otherwise
    if (NEEDS.includes(s.status)) { gRole = full && Math.floor(now / 900) % 2 ? "waitSoft" : "wait"; if (full) anim = true; }
    const wordRole = cmd && laneGroup({ ...s, mode: "" }) === 4 ? "dim" : role === "idle" ? "text" : role;
    const segs = [[" ", ""], [`${glyph} `, gRole], [fit(cmd ? "AXA" : clean(s.name), L.nameW), cmd ? "title" : "head"], [" ", ""]];
    segs.push(...stripSegs(buckets[k], max, ["done", "idle", "off"].includes(role) ? "dim" : role));
    segs.push([" ", ""], [fit(x.word, L.statusW), wordRole]);
    const hint = sel && s.status === "waiting" && s.choices;
    if (L.doing) {
      const dRole = NEEDS.includes(s.status) ? "waitSoft" : TROUBLE.includes(s.status) ? "stuck" : BUSY.includes(s.status) ? "text" : "dim";
      if (hint && L.doingW >= width(HINT) + 8) { const d = cut(x.doing, L.doingW - width(HINT) - 2); segs.push([" ", ""], [d, dRole], ["  ", ""], [fit(HINT, L.doingW - width(d) - 2), "key"]); }
      else segs.push([" ", ""], [fit(x.doing, L.doingW), dRole]);
    }
    if (L.agentsW) segs.push([" ", ""], [fit(x.agentText, L.agentsW), "violet"]);
    if (L.timeW) segs.push([" ", ""], [hint && !L.doing && L.timeW >= width(HINT) ? fitRight(HINT, L.timeW) : fitRight(x.time, L.timeW), hint && !L.doing ? "key" : NEEDS.includes(s.status) ? "waitSoft" : "dim"]);
    out.push(line(segs, cols, [], sel ? "selDim" : null));
    hits.push({ col0: 0, col1: cols, row0: out.length - 1, row1: out.length - 1, id: s.id });
    // its running agents, under its name: each clickable (opens what it's doing)
    if (withAgents && x.agents.length) {
      const segs2 = [[" ".repeat(3) + "└ ", "frame"]];
      let col = 5;
      for (const [j, h] of x.agents.entries()) {
        const label = `${spinner()} ${cut(String(h.type || "agent").split(":").pop(), 18)}${h.doing ? `: ${clean(h.doing)}` : ""}`;
        const t = cut(label, Math.max(4, cols - col - (j < x.agents.length - 1 ? 4 : 1)));
        if (col + width(t) > cols - 1) break;
        segs2.push([t, "violet"]);
        hits.push({ col0: col, col1: col + width(t) - 1, row0: out.length, row1: out.length, id: s.id, agent: h.id });
        col += width(t);
        if (j < x.agents.length - 1) { segs2.push([" · ", "frame"]); col += 3; }
      }
      out.push(line(segs2, cols));
      if (full) anim = true;
    }
  }
  const more = lanes.length - (start + per), before = start;
  const notes = [];
  if (before || more > 0) notes.push(`${before ? `↑ ${before} above` : ""}${before && more > 0 ? " · " : ""}${more > 0 ? `+${more} more` : ""} · ↑↓ scroll`);
  if (hidden) notes.push(`${hidden} idle hidden · Sessions tab`);
  if (!nSessions && out.length < rows) out.push(line([["  No sessions yet · N starts one · : talk to AXA", "dim"]], cols));
  if (notes.length) out.push(line([["  " + notes.join(" · "), "dim"]], cols));
  while (out.length < rows) out.push(blank());
  ctx.anim = anim;
  return out.slice(0, rows);
}
