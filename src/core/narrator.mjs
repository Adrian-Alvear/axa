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
// Tiers, as speech-dispatcher (SSIP) has them (research/voice-narration.md):
//   important     needs you, blocked (a limit), an approval heading your way, a re-alert: never interrupted; it
//                 cancels queued notification/progress and postpones message/text (cut at a sentence, the
//                 unheard rest said after it, what was heard never replayed)
//   message       done, failed, exited, a review verdict, digests and recaps
//   text          AXA's replies and their summaries: latest wins (a newer one replaces a queued or playing one)
//   notification  a tool starting ("running the tests, usually a minute"), links: only when nothing else is
//                 queued, and only the last one kept
//   progress      ticks (still working, heartbeats, taking longer): dropped while anything speaks; the final
//                 item of a stream (final: true) is promoted to message so a completion is never lost
//   routine       an earcon at most, never words
export const TIERS = ["important", "message", "text", "notification", "progress", "routine"];
const TIER_PRIORITY = { important: P0, message: P1, text: P1, notification: P2, progress: P2, routine: P3 };
export const KIND_TIER = {
  waiting: "important", needs_trust: "important", escalate: "important", limited: "important", realert: "important",
  done: "message", failed: "message", exited: "message", stuck: "message", milestone: "message", brief: "message", whatsup: "message", digest: "message", recap: "message",
  reply: "text",
  eta: "notification", link: "notification", declined: "notification", fixer: "notification",
  progress: "progress", liveness: "progress", heartbeat: "progress", longer: "progress",
  routine: "routine",
};
export const KIND_PRIORITY = Object.fromEntries(Object.entries(KIND_TIER).map(([k, t]) => [k, TIER_PRIORITY[t]]));
export const TTL = [Infinity, 90_000, 15_000, 5_000];
// the budget per priority: the least time between two lines of it (P3: between two earcons)
export const GAP = [0, 0, 20_000, 10_000];
export const BURST_MS = 4_000; // a burst is merged into one line, said at most this long after its first item
export const SETTLE_MS = 1_200; // ...or this long after its last one, whichever comes first
export const REPEAT_MS = 60_000;
// a session's state: one slot per session, a newer state replaces the older one
const STATE_KINDS = new Set(["waiting", "needs_trust", "failed", "limited", "exited", "done", "stuck", "escalate"]);

const NUM = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const names = (xs) => (xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const count = (n) => cap(NUM[n] || String(n));
const GROUP = { done: "done", failed: "failed", limited: "limited", exited: "exited", stuck: "stuck", waiting: "needs", needs_trust: "needs", escalate: "needs", realert: "needs" };
// One line for several sessions' states, grouped (what needs you last: it's what to act on). Used for the
// rest of a salience line, digests and recaps.
export function mergeLine(items) {
  const G = { done: [], failed: [], limited: [], exited: [], stuck: [], needs: [] }, other = [];
  for (const it of items) {
    const g = GROUP[it.kind], n = it.name || "a session";
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

// ---------- salience: several sessions with news at once (heard) ----------
// The strongest is said in full, the rest as one short project-named line: needs you > failed > done. Among
// "needs you", the blast radius ranks them: a one-way door > a question > a routine approval.
const STRENGTH = { waiting: 50, needs_trust: 50, escalate: 50, realert: 50, limited: 40, failed: 40, exited: 30, done: 20, stuck: 20, milestone: 20, reply: 15 };
const BLAST = { door: 3, question: 2, approval: 1 };
export const strength = (it) => (STRENGTH[it.kind] ?? 10) + (BLAST[it.blast] || 0);
// the session's name is said only when the speaker changes: "feed finished: x" right after feed spoke is "Finished: x"
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function withoutName(text, name) {
  if (!name) return text;
  const m = new RegExp(`^${escRe(name)}\\s+((?:finished|failed|needs|asks|hit|looks|is about to need you)\\b[\\s\\S]*)$`, "i").exec(text);
  return m ? cap(m[1]) : text;
}
export function salienceLine(items, lastSpeaker = null) {
  const sorted = [...items].sort((a, b) => strength(b) - strength(a) || a.at - b.at);
  const top = sorted[0], head = top.name && top.name === lastSpeaker ? withoutName(top.text, top.name) : top.text;
  const rest = sorted.slice(1).filter((x) => !(x.session && x.session === top.session));
  if (!rest.length) return head;
  return `${head.replace(/([^.!?])$/, "$1.")} Also, ${restLine(rest)}`;
}
// "axa and feed finished; docs failed." (short, every one named)
export function restLine(items) {
  const G = new Map();
  const verb = { done: ["finished", "finished"], failed: ["failed", "failed"], limited: ["hit a usage limit", "hit usage limits"], exited: ["exited", "exited"], stuck: ["looks stuck", "look stuck"], needs: ["needs you", "need you"] };
  let other = 0;
  for (const it of items) {
    const g = GROUP[it.kind];
    if (!g) { other++; continue; }
    if (!G.has(g)) G.set(g, []);
    if (!G.get(g).includes(it.name)) G.get(g).push(it.name || "a session");
  }
  const parts = [...G].map(([g, xs]) => `${names(xs)} ${verb[g][xs.length > 1 ? 1 : 0]}`);
  if (other) parts.push(`${count(other).toLowerCase()} more ${other > 1 ? "updates" : "update"} on screen`);
  return parts.join("; ") + ".";
}

// raw item -> a queued one: its tier (from its kind; progress with final: true is promoted to message), its
// priority (from the tier), its slot key (state kinds share "state") and TTL
export function normalize(it, now) {
  let tier = it.tier || KIND_TIER[it.kind] || (it.priority === P0 ? "important" : it.priority === P1 ? "message" : it.priority === P3 ? "routine" : "notification");
  if (tier === "progress" && it.final) tier = "message";
  const priority = it.priority ?? TIER_PRIORITY[tier];
  return { ...it, tier, key: it.key || (STATE_KINDS.has(it.kind) ? "state" : it.kind || "note"), priority, at: it.at ?? now, ttl: it.ttl ?? TTL[priority], text: String(it.text || "").trim() };
}
const slot = (it) => `${it.session ?? "-"}:${it.key}`;
const LOW = new Set(["notification", "progress"]);

// deps:
//   speak(text, { items, priority, tier, shouldYield }) -> Promise of { heard } (the part of text actually
//     heard, whole sentences) or nothing. shouldYield() is asked between sentences: true = stop there.
//   earcon(name, items): a short tone, no words (routine)
//   isCurrent(item) -> bool: does the session's state still make this true?
//   admit(item) -> null | why not (verbosity, quiet hours, typing, focus, digest mode), log(entry)
export function createNarrator({ now = Date.now, speak, earcon = () => {}, isCurrent = () => true, admit = () => null, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, burstMs = BURST_MS, settleMs = SETTLE_MS } = {}) {
  let pending = [], current = null, timer = null, burstFrom = 0, lastSpeaker = null;
  const lastAt = [-Infinity, -Infinity, -Infinity, -Infinity];
  const said = new Map(); // slot -> { at, text, kind }
  const drop = (it, why) => log({ act: "dropped", why, priority: it.priority, tier: it.tier, kind: it.kind, session: it.session, text: it.text });
  const current1 = (it) => (it.parts ? it.parts.every((p) => isCurrent(p)) : isCurrent(it));
  const whyGone = (it, t) => (t - it.at > it.ttl ? "stale" : !current1(it) ? "obsolete" : null);
  const busy = () => !!current || pending.some((p) => !LOW.has(p.tier) && p.tier !== "routine");

  function add(raw) {
    const t = now(), it = normalize(raw, t);
    if (!it.text && it.priority < P3) { drop(it, "empty"); return false; }
    const no = admit(it);
    if (no) { drop(it, no); return false; }
    const prev = said.get(slot(it));
    if (prev && prev.text === it.text && t - prev.at < REPEAT_MS) { drop(it, "already said"); return false; }
    // the approval heads-up (escalate) already told you: Claude Code's own "needs you" for it adds nothing
    const headsUp = (x) => x && x.kind === "escalate" && t - x.at < REPEAT_MS;
    if (it.kind === "waiting" && (headsUp(prev) || pending.some((p) => slot(p) === slot(it) && p.kind === "escalate"))) { drop(it, "heads-up already said"); return false; }
    // one turn, one "finished" (the agent's own line at Stop, then the notification's template)
    if (it.kind === "done" && prev?.kind === "done" && t - prev.at < REPEAT_MS) { drop(it, "already said"); return false; }
    // progress: dropped while anything speaks or waits
    if (it.tier === "progress" && busy()) { drop(it, "busy (progress)"); return false; }
    for (const p of pending) if (slot(p) === slot(it)) drop(p, "replaced");
    pending = pending.filter((p) => slot(p) !== slot(it));
    if (it.tier === "important") { for (const p of pending.filter((p) => LOW.has(p.tier))) drop(p, "cancelled by important"); pending = pending.filter((p) => !LOW.has(p.tier)); }
    if (it.tier === "text") { for (const p of pending.filter((p) => p.tier === "text")) drop(p, "a newer text"); pending = pending.filter((p) => p.tier !== "text"); }
    if (it.tier === "notification") { for (const p of pending.filter((p) => p.tier === "notification")) drop(p, "a newer notification"); pending = pending.filter((p) => p.tier !== "notification"); }
    pending.push(it);
    // important, or a solo item (a reply: said at once, alone), doesn't wait for a burst to settle
    if (it.tier === "important" || it.solo) pump();
    else {
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
    const imp = pending.filter((p) => p.tier === "important");
    const solo = !imp.length && pending.find((p) => p.solo);
    if (!imp.length && !solo && timer) return; // a burst is still settling: only important (or a reply) goes now
    // notification and progress only when nothing else is waiting
    const high = pending.filter((p) => !LOW.has(p.tier));
    // (important goes now, and the messages queued with it ride along as the line's short "Also, ..." part:
    // the strongest in full, the rest named once)
    const take = imp.length ? [...imp, ...pending.filter((p) => p.tier === "message" && !p.resumed)] : solo ? [solo] : high.length ? high : pending;
    pending = pending.filter((p) => !take.includes(p));
    const words = [], tones = [];
    for (const it of take) {
      if (!it.resumed && t - lastAt[it.priority] < GAP[it.priority]) { drop(it, "budget"); continue; }
      (it.tier === "routine" ? tones : words).push(it);
    }
    if (!words.length) {
      if (tones.length) { lastAt[P3] = t; log({ act: "earcon", priority: P3, kind: tones[0].kind, session: tones[0].session }); try { earcon(tones[0].earcon || "done", tones); } catch {} }
      return pump2();
    }
    for (const it of tones) drop(it, "merged into words");
    const text = words.length === 1 ? (words[0].name && words[0].name === lastSpeaker && !words[0].resumed ? withoutName(words[0].text, words[0].name) : words[0].text) : salienceLine(words, lastSpeaker);
    const top = [...words].sort((a, b) => strength(b) - strength(a))[0];
    const me = { items: words, priority: Math.min(...words.map((w) => w.priority)), tier: TIERS[Math.min(...words.map((w) => TIERS.indexOf(w.tier)))], at: t, text, cut: null };
    current = me;
    lastSpeaker = words.length === 1 || words.every((w) => w.name === top.name) ? top.name || null : null;
    for (const w of words) { lastAt[w.priority] = t; said.set(slot(w), { at: t, text: w.text, kind: w.kind }); }
    log({ act: "spoke", priority: me.priority, tier: me.tier, kinds: words.map((w) => w.kind), sessions: words.map((w) => w.session), text, waited: t - Math.min(...words.map((w) => w.at)) });
    const done = (r) => {
      if (current === me) current = null;
      // postponed by important: the unheard rest comes back first, what was heard isn't replayed
      if (me.cut === "postponed" && r && typeof r.heard === "string") {
        const norm = text.replace(/\s+/g, " ").trim(), heard = r.heard.replace(/\s+/g, " ").trim();
        const rest = norm.startsWith(heard) ? norm.slice(heard.length).trim() : "";
        if (rest) { pending.unshift({ ...words[0], kind: words.length > 1 ? "resumed" : words[0].kind, key: "resumed", session: words.length > 1 ? null : words[0].session, parts: words, text: rest, resumed: true, tier: me.tier, priority: me.priority, at: now(), ttl: TTL[me.priority] }); log({ act: "postponed", tier: me.tier, priority: me.priority, text: rest }); }
      }
      pump();
    };
    try { Promise.resolve(speak(text, { items: words, priority: me.priority, tier: me.tier, shouldYield: () => shouldYield(me) })).then(done, () => done()); } catch { done(); }
  }
  // (a pump with nothing said: try once more for what's left, e.g. after earcons)
  function pump2() { if (!current && pending.length && !timer) pump(); }

  // asked between sentences. Important is never cut.
  function shouldYield(me) {
    if (me !== current || me.tier === "important") return false;
    const kinds = me.items.map((i) => i.kind);
    if (pending.some((p) => p.tier === "important")) {
      me.cut = LOW.has(me.tier) ? "cancelled" : "postponed";
      log({ act: "cut", why: `important cut in (${me.cut})`, priority: me.priority, tier: me.tier, kinds });
      return true;
    }
    if (me.tier === "text" && pending.some((p) => p.tier === "text")) { me.cut = "replaced"; log({ act: "cut", why: "a newer text", priority: me.priority, tier: me.tier, kinds }); return true; }
    const t = now();
    if (LOW.has(me.tier) && me.items.every((it) => whyGone(it, t) || pending.some((p) => slot(p) === slot(it)))) { me.cut = "stale"; log({ act: "cut", why: "stale", priority: me.priority, tier: me.tier, kinds }); return true; }
    return false;
  }

  return {
    add,
    // muted / Esc: nothing queued is said later
    clear() { for (const p of pending) drop(p, "cleared"); pending = []; if (timer) clearTimer(timer); timer = null; burstFrom = 0; },
    pending: () => pending.length,
    speaking: () => !!current,
    current: () => current && { priority: current.priority, tier: current.tier, kinds: current.items.map((i) => i.kind) },
    // when something about this session was last said (liveness lines, heartbeats)
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
