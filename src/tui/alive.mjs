// What makes the Control lanes feel alive (docs/tasks/map-alive.md). Every movement is a real event:
//   step packets   a tool call sends a • along its lane's strip (or its agent's branch), coloured by kind
//   branches       a new agent's branch draws itself out and its name types in; a finished one flashes ✓, folds
//   breathing      working glyphs breathe (· ✢ * ✶ ✻ ✽), needs-you pulses amber, stuck flickers, done flashes
//   shimmer        a working lane's "doing" text has a bright band sliding over it, and types in when it changes
//   live strip     the newest cell lights up on each event; the commander's strip is a heartbeat; its sends
//                  travel down the gutter as a dot to the session they went to
//   slides         a lane that changes group slides to its new place; a new lane fades in
// Nothing moves when nothing happens. Motion "reduced" keeps only colour changes (pulses, flashes, fades);
// "off" keeps everything still. The pure parts (positions over time, frames, colours) are exported for the tests;
// createAlive() holds what the hub has seen (events, statuses, agents, order) so it knows what just changed.
import { graphemes } from "./width.mjs";

export const FRAME_MS = 83; // one animation clock, ~12 fps, only while something moves
export const PACKET_MS = 600, PACKET_CAP = 3;
export const GROW_MS = 350, TYPE_CPS = 45, FLASH_MS = 400, FOLD_MS = 900;
export const SLIDE_MS = 450, FADE_MS = 700, PULSE_MS = 600, DONE_MS = 2200, SEND_MS = 700;
const PLAYBACK_MS = 1800, STALE_MS = 6000; // events arrive in batches (the activity poll): played back over this, in their own rhythm

export const clamp01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t);
export const easeOut = (t) => 1 - (1 - clamp01(t)) ** 2;
export const easeInOut = (t) => { t = clamp01(t); return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; };

// ---------- glyphs (single-width only: see width.mjs; ✉ was two wide in Windows Terminal) ----------
// Claude Code's own spinner, as it draws it off macOS: ✳ (an emoji in some fonts) is * there. The Linux console
// has none of these: plain ASCII.
const SETS = { safe: ["·", "✢", "*", "✶", "✻", "✽"], ascii: [".", "+", "*", "x", "X", "#"] };
export const glyphSet = (env = process.env) => (env.TERM === "linux" || /^(1|true|yes)$/i.test(env.AXA_ASCII || "") ? "ascii" : "safe");
export const GLYPHS = {
  safe: { packet: "•", dot: "•", head: "▏", done: "✓", fail: "✗", up: "╱", down: "╲", flat: "─", tee: "├", end: "└", run: "─", still: "✻" },
  ascii: { packet: "o", dot: "o", head: "|", done: "v", fail: "x", up: "/", down: "\\", flat: "-", tee: "|", end: "`", run: "-", still: "*" },
};
// the ping-pong cycle: · ✢ * ✶ ✻ ✽ ✻ ✶ * ✢ (10 frames)
export const spinFrames = (set = "safe") => { const s = SETS[set] || SETS.safe; return [...s, ...s.slice(1, -1).reverse()]; };
export const breath = (now, frames = spinFrames(), ms = 100) => frames[Math.floor(now / ms) % frames.length];
// a slow wave 0..1..0 (cosine eased): the needs-you pulse
export const wave = (now, period = 1600) => (1 - Math.cos((2 * Math.PI * (now % period)) / period)) / 2;
// stuck: a short dip every few seconds; and when the next edge comes (so the clock sleeps in between)
export const FLICKER = { every: 2600, dip: 180 };
export const flicker = (now) => now % FLICKER.every < FLICKER.dip;
export const flickerNext = (now) => { const p = now % FLICKER.every; return p < FLICKER.dip ? FLICKER.dip - p : FLICKER.every - p; };
// done: a flash (bright for a moment) that fades to dim over ~2 s; 1 = resting
export const doneFade = (dt) => (dt < 0 ? 1 : dt < 200 ? 0 : clamp01((dt - 200) / (DONE_MS - 200)));

// ---------- step packets ----------
// tool -> kind: read/search, edit/write, bash, web, agent (a spawn), other
export function toolKind(tool = "") {
  if (/^(Read|Grep|Glob|LS|NotebookRead|ToolSearch)$/.test(tool)) return "read";
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return "edit";
  if (/^(Bash|BashOutput|KillShell|KillBash)$/.test(tool)) return "bash";
  if (/^Web(Fetch|Search)$/.test(tool)) return "web";
  if (/^(Agent|Task)$/.test(tool)) return "agent";
  return "other";
}
export const KIND_ROLE = { read: "pRead", edit: "pEdit", bash: "pBash", web: "pWeb", agent: "pAgent", other: "accent" };
// where a packet is on a track `len` cells long (0 = by the name, len-1 = by the doing text), or null when it
// hasn't left yet or has arrived
export function packetAt(p, now, len) {
  const t = (now - p.start) / PACKET_MS;
  if (t < 0 || t >= 1 || len <= 0) return null;
  return Math.min(len - 1, Math.floor(easeOut(t) * len));
}
// add a packet: finished ones go, and at most `cap` per track are in flight (the oldest is dropped)
export function addPacket(list, p, now, cap = PACKET_CAP) {
  const out = list.filter((q) => now < q.start + PACKET_MS);
  out.push(p);
  const same = out.filter((q) => q.track === p.track).sort((a, b) => a.start - b.start);
  for (const q of same.slice(0, Math.max(0, same.length - cap))) out.splice(out.indexOf(q), 1);
  return out;
}

// ---------- the commander's sends ----------
const SEND = /(?:^|__)(send_to_session|start_goal|open_session)$/;
export const isSend = (tool) => SEND.test(tool || "");
// which session a send went to: its id, or the project open_session named (the summary is the tool's JSON input)
export function sendTarget(e) {
  const s = String(e.summary || "");
  const id = /"id"\s*:\s*"([^"]+)"/.exec(s), project = /"(?:project|name|folder)"\s*:\s*"([^"]+)"/.exec(s);
  return id ? { id: id[1] } : project ? { name: project[1].split("/").filter(Boolean).pop() } : {};
}
// the dot's row between the commander's row and the target's, or null when it isn't travelling
export function dotRow(d, now, from, to) {
  const t = (now - d.start) / SEND_MS;
  if (t < 0 || t >= 1) return null;
  return Math.round(from + (to - from) * easeInOut(t));
}

// ---------- agent branches ----------
// A branch `full` cells long: growing (the run draws out, then the label types in), steady, or finished (✓ flashes,
// then the run folds back and the row goes). -> { run, chars (label graphemes shown), mark: "spin"|"done"|"fail"|"",
// flash (0..1, 1 = brightest), gone }
export function branchView(b, now, full) {
  if (b.ended) {
    const dt = now - b.ended, mark = b.failed ? "fail" : "done";
    if (dt < FLASH_MS) return { run: full, chars: Infinity, mark, flash: 1 - dt / FLASH_MS, gone: false };
    if (dt < FOLD_MS) return { run: Math.round(full * (1 - easeOut((dt - FLASH_MS) / (FOLD_MS - FLASH_MS)))), chars: 0, mark, flash: 0, gone: false };
    return { run: 0, chars: 0, mark: "", flash: 0, gone: true };
  }
  const dt = b.born ? now - b.born : Infinity;
  if (dt < GROW_MS) return { run: Math.round(full * easeOut(dt / GROW_MS)), chars: 0, mark: "", flash: 0, gone: false };
  return { run: full, chars: dt === Infinity ? Infinity : Math.floor(((dt - GROW_MS) / 1000) * TYPE_CPS) + 1, mark: "spin", flash: 0, gone: false };
}
// how many branch rows each lane gets: the selected one all of its agents, the others up to `cap` (the rest says
// "+N more"); when they don't fit in `budget` rows, the biggest give one up first
export function branchBudget(counts, selIdx, budget, cap = 3) {
  const want = counts.map((n, i) => (i === selIdx ? n : Math.min(cap, n)));
  let total = want.reduce((a, b) => a + b, 0);
  while (total > Math.max(0, budget)) {
    let j = -1;
    for (let i = 0; i < want.length; i++) if (i !== selIdx && want[i] > 0 && (j < 0 || want[i] > want[j])) j = i;
    if (j < 0) j = selIdx;
    want[j]--; total--;
  }
  // the other lanes: all with agents get a branch or none does (a lone branch on one lane looks random)
  if (want.some((w, i) => i !== selIdx && counts[i] > 0 && w === 0)) want.forEach((_, i) => { if (i !== selIdx) want[i] = 0; });
  return want;
}

// ---------- text ----------
// the "doing" text typing in since `since` (a few characters per frame); 0 = shown whole
export function typeIn(text, since, now, cps = TYPE_CPS * 1.5) {
  if (!since) return text;
  const g = graphemes(text), n = 2 + Math.floor(((now - since) / 1000) * cps);
  return n >= g.length ? text : g.slice(0, n).join("");
}
// the shimmer: each grapheme's brightness 0..1, a band `band` wide sliding across at `speed` columns a second, with
// a pause (`gap` columns) between passes; `phase` keeps lanes out of step
export function shimmer(n, now, phase = 0, { speed = 26, band = 3, gap = 16 } = {}) {
  const cyc = n + gap + 2 * band, pos = ((((now + phase) / 1000) * speed) % cyc) - band;
  return Array.from({ length: n }, (_, i) => Math.max(0, 1 - Math.abs(i - pos) / band));
}

// ---------- the strip ----------
// The commander's strip as a heartbeat: flat, with a spike where it did something (consecutive buckets zigzag)
export function heartbeat(buckets, set = "safe") {
  const G = GLYPHS[set] || GLYPHS.safe, out = [];
  for (let i = 0; i < buckets.length; i++) {
    const c = buckets[i], prev = out[i - 1]?.[0];
    if (c === null) out.push([" ", ""]);
    else if (c > 0) out.push([prev === G.up ? G.down : G.up, "accent"]);
    else out.push([prev === G.up ? G.down : G.flat, prev === G.up ? "accent" : "frame"]);
  }
  return out;
}
// [[char, role], ...] -> segments (runs of one role joined)
export function mergeCells(cells) {
  const segs = [];
  for (const [ch, r] of cells) { const l = segs.at(-1); if (l && l[1] === r) l[0] += ch; else segs.push([ch, r]); }
  return segs;
}

// ---------- row slides ----------
// a lane's place while it slides from `from` to `idx` (fractional; the rows are laid out by it)
export const slideKey = (o, now) => (o.start ? o.from + (o.idx - o.from) * easeInOut((now - o.start) / SLIDE_MS) : o.idx);

// ---------- what the hub has seen ----------
export function createAlive() {
  return { primed: false, lastTs: 0, seen: new Set(), packets: [], sends: [], pulses: new Map(), status: new Map(), agents: new Map(), order: new Map(), born: new Map(), doing: new Map(), sessionsPrimed: false };
}
const evKey = (e) => `${e.ts}|${e.terminal}|${e.event}|${e.tool || ""}|${e.agent_id || ""}|${e.summary || ""}`;
// New events (the activity poll's list): packets, strip pulses, send dots. The first list only primes (what was
// already there doesn't animate). A batch is played back in its own rhythm, starting now.
export function feedEvents(A, events, now) {
  const list = (events || []).filter((e) => e && e.terminal && e.ts);
  const fresh = list.filter((e) => e.ts > A.lastTs || (e.ts === A.lastTs && !A.seen.has(evKey(e))));
  const top = Math.max(A.lastTs, ...list.map((e) => e.ts));
  A.seen = new Set(list.filter((e) => e.ts === top).map(evKey));
  A.lastTs = top;
  if (!A.primed) { A.primed = true; return 0; }
  if (!fresh.length) return 0;
  // (what happened while the lanes weren't on screen isn't replayed: only the last few seconds)
  const play = fresh.filter((e) => e.ts > now - STALE_MS);
  if (!play.length) return 0;
  const t0 = Math.min(...play.map((e) => e.ts));
  A.sends = A.sends.filter((d) => now < d.start + SEND_MS);
  for (const e of play.sort((a, b) => a.ts - b.ts)) {
    const start = now + Math.min(PLAYBACK_MS, e.ts - t0);
    A.pulses.set(e.terminal, start);
    if (e.event !== "PreToolUse") continue;
    A.packets = addPacket(A.packets, { track: e.agent_id ? `a:${e.agent_id}` : `l:${e.terminal}`, lane: e.terminal, kind: toolKind(e.tool), start }, now);
    if (isSend(e.tool)) A.sends.push({ from: e.terminal, to: sendTarget(e), start });
  }
  return play.length;
}
// The sessions as polled: status changes (done flashes), agents that started (grow) or finished (fold), new lanes
// (fade in). The first non-empty list only primes.
export function observeSessions(A, sessions, now) {
  const primed = A.sessionsPrimed;
  const live = new Set();
  for (const s of sessions || []) {
    if (!s.alive) continue;
    const st = A.status.get(s.id);
    if (!st) { A.status.set(s.id, { status: s.status, since: 0 }); if (primed) A.born.set(s.id, now); }
    else if (st.status !== s.status) A.status.set(s.id, { status: s.status, since: now });
    for (const h of s.helpers || []) {
      const k = `${s.id}:${h.id}`, b = A.agents.get(k);
      if (h.status === "running") {
        if (!b) A.agents.set(k, { sid: s.id, h, born: primed ? now : 0, ended: 0 });
        else if (!b.ended) b.h = h;
      } else if (b && !b.ended) Object.assign(b, { ended: now, failed: h.status === "failed", h: { ...b.h, ...h } });
      live.add(k);
    }
  }
  for (const [k, b] of A.agents) {
    if (!live.has(k) && !b.ended) Object.assign(b, { ended: now });
    if (b.ended && now - b.ended > FOLD_MS) A.agents.delete(k);
  }
  for (const [k, t] of A.born) if (now - t > FADE_MS) A.born.delete(k);
  if ((sessions || []).length) A.sessionsPrimed = true;
}
// a lane's agents as branches: running ones (in the order they started) and the ones still folding
export const agentsOf = (A, sid) => [...A.agents.values()].filter((b) => b.sid === sid);
// The display order while lanes slide: ids in their new order -> ids in the order they're drawn this frame
export function slideOrder(A, ids, now) {
  const keys = new Map();
  ids.forEach((id, idx) => {
    const o = A.order.get(id);
    if (!o) A.order.set(id, { idx, from: idx, start: 0 });
    else if (o.idx !== idx) A.order.set(id, { idx, from: A.primedOrder ? slideKey(o, now) : idx, start: A.primedOrder ? now : 0 });
    else if (o.start && now - o.start >= SLIDE_MS) o.start = 0;
    keys.set(id, slideKey(A.order.get(id), now));
  });
  for (const id of A.order.keys()) if (!keys.has(id)) A.order.delete(id);
  A.primedOrder = true;
  return [...ids].sort((a, b) => keys.get(a) - keys.get(b) || A.order.get(a).idx - A.order.get(b).idx);
}
export const sliding = (A, now) => [...A.order.values()].some((o) => o.start && now - o.start < SLIDE_MS);
// The "doing" text of a lane: since when it reads what it reads (0 = it was there when the hub started)
export function doingSince(A, id, text, now) {
  const d = A.doing.get(id);
  if (!d) { A.doing.set(id, { text, since: 0 }); return 0; }
  if (d.text !== text) { d.text = text; d.since = text ? now : 0; }
  return d.since;
}
// anything left to play: packets, sends or strip pulses still to start or running
export const pending = (A, now) => A.packets.some((p) => now < p.start + PACKET_MS) || A.sends.some((d) => now < d.start + SEND_MS) || [...A.pulses.values()].some((t) => now < t + PULSE_MS);
