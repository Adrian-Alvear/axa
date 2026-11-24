// AXA's narrator: everything the voice says goes through one queue that stays current. The user often isn't
// looking at the screen, so what's said must be what's true NOW, as soon as possible, and never old news.
//
// Items: { session, key, kind, priority, at, ttl, text, name, expect }.
//   P0  needs you / failed / limited / exited / an approval heading your way: never rate-limited, no TTL (they
//       stay until resolved: the session's state says when), and they cut in after the sentence being spoken
//   P1  done / review verdict / milestone / AXA's replies: TTL 90 s
//   P2  progress (heads-ups, "still working"): TTL 15 s, at most one per 20 s
//   P3  routine: an earcon at most, never words
// One "now speaking" slot and a pending list:
//   - coalesced by (session, key): a newer item replaces a queued older one ("tests passed" replaces "running
//     tests"; a session's new state replaces its old one)
//   - dropped at dequeue when stale (its TTL passed) or obsolete (isCurrent says the session moved on: you
//     answered the prompt, it started working again, the reply was superseded)
//   - P1-P3 arriving within ~4 s of each other are said as ONE line about the current state, from templates
//     ("Two sessions finished, axa and feed. Feed needs you."), no model involved
//   - the same thing about the same session isn't said twice within a minute
// Every item said or dropped is logged with its reason (the daemon's console log), to tune the thresholds.
// Pure: time, timers, speech and the session state are injected (unit-tested; server.mjs wires the real ones).
export const P0 = 0, P1 = 1, P2 = 2, P3 = 3;
export const TTL = [Infinity, 90_000, 15_000, 5_000];
// the budget per priority: the least time between two lines of it (P3: between two earcons)
export const GAP = [0, 0, 20_000, 10_000];
export const BURST_MS = 4_000; // a burst is merged into one line, said at most this long after its first item
export const SETTLE_MS = 1_200; // ...or this long after its last one, whichever comes first
export const REPEAT_MS = 60_000;

export const KIND_PRIORITY = {
  waiting: P0, needs_trust: P0, failed: P0, limited: P0, exited: P0, escalate: P0,
  done: P1, stuck: P1, milestone: P1, brief: P1, reply: P1, whatsup: P1,
  fixer: P2, link: P2, declined: P2, progress: P2, eta: P2, longer: P2, liveness: P2,
  routine: P3,
};
// a session's state: one slot per session, a newer state replaces the older one
const STATE_KINDS = new Set(["waiting", "needs_trust", "failed", "limited", "exited", "done", "stuck"]);

const NUM = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const names = (xs) => (xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const count = (n) => cap(NUM[n] || String(n));
// One line for a burst: the state each session is in now, grouped, what needs you last (it's what to act on)
export function mergeLine(items) {
  const G = { done: [], failed: [], limited: [], exited: [], stuck: [], needs: [] }, other = [];
  const group = { done: "done", failed: "failed", limited: "limited", exited: "exited", stuck: "stuck", waiting: "needs", needs_trust: "needs", escalate: "needs" };
  for (const it of items) {
    const g = group[it.kind], n = it.name || "a session";
    if (g) { if (!G[g].includes(n)) G[g].push(n); } else other.push(it);
  }
  const many = (xs, verb) => (xs.length > 1 ? `${count(xs.length)} sessions ${verb}, ${names(xs)}.` : `${cap(xs[0])} ${verb}.`);
  const out = [];
  if (G.done.length) out.push(many(G.done, "finished"));
  if (G.failed.length) out.push(many(G.failed, "failed"));
  if (G.limited.length) out.push(`${cap(names(G.limited))} hit a usage limit.`);
  if (G.exited.length) out.push(`Claude exited in ${names(G.exited)}.`);
  if (G.stuck.length) out.push(`${cap(names(G.stuck))} ${G.stuck.length > 1 ? "look" : "looks"} stuck.`);
  if (other.length) out.push(cap(other[0].text).replace(/\s*$/, "").replace(/([^.!?])$/, "$1.") + (other.length > 1 ? ` ${count(other.length - 1)} more ${other.length > 2 ? "updates" : "update"} on screen.` : ""));
  if (G.needs.length) out.push(`${cap(names(G.needs))} ${G.needs.length > 1 ? "need" : "needs"} you.`);
  return out.join(" ");
}

// raw item -> a queued one (priority from its kind, P2 by default; state kinds share the "state" key)
export function normalize(it, now) {
  const priority = it.priority ?? KIND_PRIORITY[it.kind] ?? P2;
  return { ...it, key: it.key || (STATE_KINDS.has(it.kind) ? "state" : it.kind || "note"), priority, at: it.at ?? now, ttl: it.ttl ?? TTL[priority], text: String(it.text || "").trim() };
}
const slot = (it) => `${it.session ?? "-"}:${it.key}`;

// deps:
//   speak(text, { items, priority, shouldYield }) -> Promise (resolves when said, or cut). shouldYield() is
//     asked between sentences: true = stop there (a P0 is waiting, or what's being said went stale)
//   earcon(name, items): a short tone, no words (P3)
//   isCurrent(item) -> bool: does the session's state still make this true?
//   admit(item) -> null | why not (verbosity, quiet hours, typing: Part C), log(entry)
export function createNarrator({ now = Date.now, speak, earcon = () => {}, isCurrent = () => true, admit = () => null, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, burstMs = BURST_MS, settleMs = SETTLE_MS } = {}) {
  let pending = [], current = null, timer = null, burstFrom = 0;
  const lastAt = [-Infinity, -Infinity, -Infinity, -Infinity];
  const said = new Map(); // slot -> { at, text }
  const drop = (it, why) => log({ act: "dropped", why, priority: it.priority, kind: it.kind, session: it.session, text: it.text });
  const whyGone = (it, t) => (t - it.at > it.ttl ? "stale" : !isCurrent(it) ? "obsolete" : null);

  function add(raw) {
    const t = now(), it = normalize(raw, t);
    if (!it.text && it.priority < P3) { drop(it, "empty"); return false; }
    const no = admit(it);
    if (no) { drop(it, no); return false; }
    const prev = said.get(slot(it));
    if (prev && prev.text === it.text && t - prev.at < REPEAT_MS) { drop(it, "already said"); return false; }
    for (const p of pending) if (slot(p) === slot(it)) drop(p, "replaced");
    pending = pending.filter((p) => slot(p) !== slot(it)).concat(it);
    // a P0, or a solo item (a reply: said at once, alone), doesn't wait for a burst to settle
    if (it.priority === P0 || it.solo) pump();
    else {
      // a burst: wait until it settles (or BURST_MS after it began), then say it as one line
      if (!burstFrom) burstFrom = t;
      if (timer) clearTimer(timer);
      timer = setTimer(flush, Math.max(0, Math.min(settleMs, burstFrom + burstMs - t)));
    }
    return true;
  }
  function flush() { timer = null; burstFrom = 0; pump(); }

  function pump() {
    if (current) return;
    const t = now();
    pending = pending.filter((it) => { const w = whyGone(it, t); if (w) drop(it, w); return !w; });
    if (!pending.length) return;
    const top = Math.min(...pending.map((p) => p.priority));
    const solo = top > P0 && pending.find((p) => p.solo);
    if (top > P0 && !solo && timer) return; // a burst is still settling: only a P0 (or a reply) goes now
    const take = top === P0 ? pending.filter((p) => p.priority === P0) : solo ? [solo] : pending;
    pending = pending.filter((p) => !take.includes(p));
    const words = [], tones = [];
    for (const it of take) {
      if (t - lastAt[it.priority] < GAP[it.priority]) { drop(it, "budget"); continue; }
      (it.priority === P3 ? tones : words).push(it);
    }
    if (!words.length) {
      if (tones.length) { lastAt[P3] = t; log({ act: "earcon", priority: P3, kind: tones[0].kind, session: tones[0].session }); try { earcon(tones[0].earcon || "done", tones); } catch {} }
      return;
    }
    for (const it of tones) drop(it, "merged into words");
    const text = words.length === 1 ? words[0].text : mergeLine(words);
    const me = { items: words, priority: Math.min(...words.map((w) => w.priority)), at: t };
    current = me;
    for (const w of words) { lastAt[w.priority] = t; said.set(slot(w), { at: t, text: w.text }); }
    log({ act: "spoke", priority: me.priority, kinds: words.map((w) => w.kind), sessions: words.map((w) => w.session), text, waited: t - Math.min(...words.map((w) => w.at)) });
    const done = () => { if (current === me) current = null; pump(); };
    try { Promise.resolve(speak(text, { items: words, priority: me.priority, shouldYield: () => shouldYield(me) })).then(done, done); } catch { done(); }
  }

  // asked between sentences of what's being said. A P0 is never cut.
  function shouldYield(me) {
    if (me !== current || me.priority === P0) return false;
    if (pending.some((p) => p.priority === P0)) { log({ act: "cut", why: "a P0 cut in", priority: me.priority, kinds: me.items.map((i) => i.kind) }); return true; }
    const t = now();
    if (me.priority >= P2 && me.items.every((it) => whyGone(it, t) || pending.some((p) => slot(p) === slot(it)))) { log({ act: "cut", why: "stale", priority: me.priority, kinds: me.items.map((i) => i.kind) }); return true; }
    return false;
  }

  return {
    add,
    // muted / Esc: nothing queued is said later
    clear() { for (const p of pending) drop(p, "cleared"); pending = []; if (timer) clearTimer(timer); timer = null; burstFrom = 0; },
    pending: () => pending.length,
    speaking: () => !!current,
    current: () => current && { priority: current.priority, kinds: current.items.map((i) => i.kind) },
    // when something about this session was last said (liveness lines, Part B)
    lastSaidAbout(session) { let at = 0; for (const [k, v] of said) if (k.startsWith(`${session}:`)) at = Math.max(at, v.at); return at; },
  };
}

// ---------- template lines (no model: said the moment it happens) ----------
const end = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);
// the first sentence, at most `max` characters (cut at a word)
export function sentence1(t, max = 160) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  let x = /^.*?[.!?](?=\s|$)/.exec(s)?.[0] || s;
  if (x.length > max) x = x.slice(0, max).replace(/\s+\S*$/, "").replace(/[,;:]$/, "");
  return x;
}
const VERDICT = { approve: "approved it", warn: "has warnings", block: "blocked it", error: "couldn't finish" };
// A notification ({ kind, project, title, body }) as one spoken line
export function lineFor(n) {
  const who = n.project || n.name || "a session", body = String(n.body || "").trim();
  switch (n.kind) {
    case "done": return body && body !== "its turn is done" ? `${who} finished: ${end(sentence1(body))}` : `${who} finished.`;
    case "waiting": {
      const ask = /^asks you: (.*)/i.exec(body), appr = /^needs (?:your )?approval · (.*)/i.exec(body), perm = /permission to use (\w+)/i.exec(body);
      if (ask) return `${who} asks: ${end(sentence1(ask[1], 200))}`;
      if (appr) return `${who} needs your approval: ${end(sentence1(appr[1]))}`;
      if (perm) return `${who} needs your permission to use ${perm[1]}.`;
      return body ? `${who} needs you: ${end(sentence1(body))}` : `${who} needs you.`;
    }
    case "needs_trust": return `${who} needs you to trust its folder.`;
    case "failed": return body ? `${who} failed: ${end(sentence1(body, 100))}` : `${who} failed.`;
    case "limited": return /resets/.test(body) ? `${who} hit a usage limit; ${end(sentence1(body, 80))}` : `${who} hit a usage limit.`;
    case "exited": return `Claude exited in ${who}.`;
    case "stuck": return `${who} looks stuck.`;
    case "milestone": {
      const repo = /^review of ([^:]+):/.exec(n.title || "")?.[1] || who, v = /\b(approve|warn|block|error)\b/.exec(n.title || "")?.[1];
      return `The review of ${repo} ${VERDICT[v] || "ended"}.`;
    }
    default: return end(`${n.title || who}${body ? `: ${sentence1(body)}` : ""}`);
  }
}

// ---------- liveness ----------
export const LIVE_AFTER_MS = 3 * 60_000, LIVE_EVERY_MS = 5 * 60_000;
// A session you gave a goal has been working a while and nothing has been said about it: one short line
// ("feed is still working: running tests"), at most every ~5 min, at verbosity normal or chatty.
export function livenessLine({ name, doing, workingFor, sinceSaid, verbosity = "normal" }) {
  if (verbosity === "quiet" || workingFor < LIVE_AFTER_MS || sinceSaid < LIVE_EVERY_MS) return null;
  const d = sentence1(String(doing || "").replace(/^(?:Bash|Edit|Write|Read|Grep|Glob|Task|Agent) · /, ""), 80).replace(/[.!?]$/, "");
  return d ? `${name} is still working: ${d}.` : `${name} is still working.`;
}

// The console log line for one narrator entry
export const logLine = (e) => `narrator: ${e.act}${e.why ? ` (${e.why})` : ""} P${e.priority ?? "?"} ${[].concat(e.kinds || e.kind || []).join("+")}${e.session ? ` ${e.session}` : ""}${e.waited != null ? ` after ${e.waited} ms` : ""}${e.text ? `: ${String(e.text).slice(0, 120)}` : ""}`;
