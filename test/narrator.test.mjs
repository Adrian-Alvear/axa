// The narrator (narrator.mjs): one queue that stays current. Pure: a fake clock, timers and speaker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as N from "../src/core/narrator.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = (f) => readFileSync(join(ROOT, f), "utf8");

// a narrator with a fake clock: speak() resolves when the test says the line ended
function rig({ isCurrent = () => true, admit } = {}) {
  const r = { t: 1_000_000, timers: [], said: [], logs: [], ends: [], yields: [], tones: [] };
  r.n = N.createNarrator({
    now: () => r.t,
    setTimer: (fn, ms) => { const h = { fn, at: r.t + ms }; r.timers.push(h); return h; },
    clearTimer: (h) => { r.timers = r.timers.filter((x) => x !== h); },
    speak: (text, { shouldYield, priority }) => new Promise((done) => { r.said.push({ text, priority }); r.yields.push(shouldYield); r.ends.push(done); }),
    earcon: (name) => r.tones.push(name),
    isCurrent, admit, log: (e) => r.logs.push(e),
  });
  r.run = (ms) => { r.t += ms; for (const h of r.timers.filter((x) => x.at <= r.t)) { r.timers = r.timers.filter((x) => x !== h); h.fn(); } };
  r.end = async () => { r.ends.shift()(); await new Promise((ok) => setImmediate(ok)); };
  r.dropped = (why) => r.logs.filter((l) => l.act === "dropped" && l.why === why).map((l) => l.text);
  return r;
}

test("priorities and TTLs by kind; a session's states share one slot", () => {
  const it = (kind) => N.normalize({ kind, text: "x" }, 0);
  assert.equal(it("waiting").priority, N.P0); assert.equal(it("limited").priority, N.P0); assert.equal(it("escalate").priority, N.P0);
  // speech-dispatcher tiers: done / failed / exited are messages (they never cut in); needs you is important
  assert.equal(it("failed").tier, "message"); assert.equal(it("exited").priority, N.P1); assert.equal(it("waiting").tier, "important");
  assert.equal(it("reply").tier, "text"); assert.equal(it("eta").tier, "notification"); assert.equal(it("heartbeat").tier, "progress");
  assert.equal(N.normalize({ kind: "heartbeat", final: true, text: "x" }, 0).tier, "message", "a progress stream's final item is promoted");
  assert.equal(it("done").priority, N.P1); assert.equal(it("milestone").priority, N.P1);
  assert.equal(it("progress").priority, N.P2); assert.equal(it("routine").priority, N.P3);
  assert.equal(it("waiting").ttl, Infinity); assert.equal(it("done").ttl, 90_000); assert.equal(it("progress").ttl, 15_000);
  assert.equal(it("done").key, "state"); assert.equal(it("waiting").key, "state"); assert.equal(it("progress").key, "progress");
});

test("coalesce: a newer item replaces a queued older one for the same session and key", async () => {
  const r = rig();
  r.n.add({ kind: "progress", key: "tests", session: "f", text: "feed is running tests" });
  r.run(500);
  r.n.add({ kind: "progress", key: "tests", session: "f", text: "feed's tests passed" });
  assert.equal(r.n.pending(), 1);
  r.run(2000);
  assert.deepEqual(r.said.map((s) => s.text), ["feed's tests passed"]);
  assert.deepEqual(r.dropped("replaced"), ["feed is running tests"]);
});

test("TTL: a P2 queued behind a long line is dropped once 15 s old; a P0 never expires", async () => {
  const r = rig();
  r.n.add({ kind: "reply", session: "axa", text: "A long reply being read." });
  r.run(1300);
  assert.equal(r.said.length, 1);
  r.n.add({ kind: "eta", session: "f", text: "feed is running tests" });
  r.n.add({ kind: "waiting", session: "w", name: "web", text: "web needs you" });
  r.run(20_000); // the reply is still being read 20 s later (one long sentence: no boundary to cut in at)
  await r.end();
  // the slot frees: the P0 goes first, and the P2, now 20 s old, is dropped as stale
  assert.equal(r.said[1].text, "web needs you");
  await r.end();
  // (important cancels a queued notification at once: speech-dispatcher's rule)
  assert.deepEqual(r.dropped("cancelled by important"), ["feed is running tests"]);
  assert.equal(r.said.length, 2);
  // a notification alone behind a long line goes stale (15 s TTL)
  const r2 = rig();
  r2.n.add({ kind: "reply", session: "axa", solo: true, text: "A long reply." });
  r2.n.add({ kind: "eta", session: "f", text: "feed is building" });
  r2.run(20_000); await r2.end();
  assert.deepEqual(r2.dropped("stale"), ["feed is building"]);
});

test("obsolete: the prompt was answered before the line came up, so it's never said", async () => {
  let answered = false;
  const r = rig({ isCurrent: (it) => !(it.kind === "waiting" && answered) });
  r.n.add({ kind: "reply", session: "axa", text: "Something long." });
  r.run(1300);
  r.n.add({ kind: "waiting", session: "f", text: "feed needs you" });
  answered = true;
  await r.end();
  assert.deepEqual(r.dropped("obsolete"), ["feed needs you"]);
  assert.equal(r.said.length, 1);
});

test("preemption: a P0 cuts in after the current sentence; a P0 itself is never cut", async () => {
  const r = rig();
  r.n.add({ kind: "done", session: "a", name: "api", text: "api finished: long report." });
  r.run(1300);
  assert.equal(r.yields[0](), false, "nothing waiting: keep going");
  r.n.add({ kind: "waiting", session: "f", name: "feed", text: "feed needs your approval: push to main." });
  assert.equal(r.said.length, 1, "it waits for the sentence boundary");
  assert.equal(r.yields[0](), true, "asked between sentences: give way");
  await r.end();
  assert.equal(r.said[1].text, "feed needs your approval: push to main.");
  r.n.add({ kind: "waiting", session: "w", text: "web needs you" });
  assert.equal(r.yields[1](), false, "a P0 being said is never cut");
  assert.ok(r.logs.some((l) => l.act === "cut" && l.why === "important cut in (postponed)"));
});

test("a stale P2 being spoken stops at the next sentence", async () => {
  let working = true;
  const r = rig({ isCurrent: (it) => it.kind !== "progress" || working });
  r.n.add({ kind: "progress", session: "f", text: "feed is running the tests, usually about a minute." });
  r.run(1300);
  assert.equal(r.yields[0](), false);
  working = false;
  assert.equal(r.yields[0](), true);
});

test("a burst within ~4 s: the strongest in full, the rest as one short line; notifications wait until idle", async () => {
  const r = rig();
  r.n.add({ kind: "done", session: "1", name: "axa", text: "axa finished: x." });
  r.run(500); r.n.add({ kind: "done", session: "2", name: "feed", text: "feed finished: y." });
  r.run(500); r.n.add({ kind: "link", session: "3", name: "web", text: "link fired: web to api" });
  r.run(500); r.n.add({ kind: "done", session: "2", name: "feed", text: "feed finished: y." });
  assert.equal(r.said.length, 0, "still settling");
  r.run(1300);
  assert.deepEqual(r.said.map((x) => x.text), ["axa finished: x. Also, feed finished."]);
  await r.end();
  assert.equal(r.said[1].text, "link fired: web to api", "the notification, once idle");
  // a burst can't hold things back for long: said at most BURST_MS after it began
  const r2 = rig();
  for (let i = 0; i < 8; i++) { r2.n.add({ kind: "done", session: String(i), name: `s${i}`, text: `s${i} finished.` }); r2.run(600); }
  assert.equal(r2.said.length, 1);
  assert.equal(r2.said[0].text, "s0 finished. Also, s1, s2, s3, s4, s5 and s6 finished.");
  // mergeLine (digests, recaps): grouped, who needs you last
  assert.equal(N.mergeLine([{ kind: "done", name: "axa" }, { kind: "done", name: "feed" }, { kind: "waiting", name: "feed" }]), "Two sessions finished, axa and feed. Feed needs you.");
});

test("budgets: P0 never limited; P2 at most one line per 20 s; P3 is an earcon, never words", async () => {
  const r = rig();
  r.n.add({ kind: "progress", session: "a", text: "a is running tests" });
  r.run(1300); await r.end();
  r.run(5000);
  r.n.add({ kind: "progress", session: "b", text: "b is building" });
  r.run(1300);
  assert.equal(r.said.length, 1);
  assert.deepEqual(r.dropped("budget"), ["b is building"]);
  for (let i = 0; i < 3; i++) { r.n.add({ kind: "waiting", session: `w${i}`, name: `w${i}`, text: `w${i} needs you` }); await r.end().catch(() => {}); }
  assert.equal(r.said.filter((s) => s.priority === N.P0).length, 3);
  r.run(30_000);
  r.n.add({ kind: "routine", session: "z", earcon: "done", text: "" });
  r.run(1300);
  assert.deepEqual(r.tones, ["done"]);
  assert.equal(r.said.length, 4, "no words for a P3");
});

test("the same thing isn't said twice within a minute; clear() drops everything queued", async () => {
  const r = rig();
  r.n.add({ kind: "waiting", session: "f", text: "feed needs you" });
  await r.end();
  r.n.add({ kind: "waiting", session: "f", text: "feed needs you" });
  assert.deepEqual(r.dropped("already said"), ["feed needs you"]);
  r.n.add({ kind: "done", session: "a", text: "a" }); r.n.add({ kind: "done", session: "b", text: "b" });
  r.n.clear();
  r.run(5000);
  assert.equal(r.said.length, 1);
  assert.equal(r.n.pending(), 0);
});

test("every item said or dropped is logged with its reason", () => {
  assert.equal(N.logLine({ act: "dropped", why: "stale", priority: 2, kind: "progress", session: "f", text: "feed is running tests" }), "narrator: dropped (stale) P2 progress f: feed is running tests");
  assert.equal(N.logLine({ act: "spoke", priority: 1, kinds: ["done", "done"], waited: 1200, text: "Two sessions finished" }), "narrator: spoke P1 done+done after 1200 ms: Two sessions finished");
});

test("the daemon speaks only through the narrator, and stop/mute clear it", () => {
  const s = src("src/core/server.mjs");
  assert.match(s, /function hush\(\) \{ cancelSummaries\(\); voiceGen\+\+; voiceNow = null; narrator\.clear\(\); V\.stop\(\); \}/);
  assert.match(s, /if \(!\(V\.speaking\(\) \|\| summarizing > 0 \|\| narrator\.pending\(\) > 0\) \|\| V\.settings\(\)\.on\) return;/);
  assert.match(s, /await V\.speak\(text, \{ between: shouldYield/);
  assert.match(s, /add: \(n\) => \(n\.kind === "brief" \? speakBrief\(n\) : narrator\.add\(noteItem\(n\)\)\)/);
  assert.doesNotMatch(src("src/core/notify.mjs"), /createVoiceQueue|VOICE_GAP/);
});

test("voice: between() is asked at each sentence boundary and stops there cleanly; onStart fires once for the first sound and the first words", async () => {
  const { speakChunks } = await import("../src/core/voice.mjs");
  const played = [], cleaned = [];
  let asks = 0; const starts = [];
  const job = { stopped: false, kills: new Set(), kill() { this.stopped = true; } };
  const n = await speakChunks(["One.", "Two.", "Three.", "Four."], {
    synth: async (c) => ({ out: c }), play: async (w) => { played.push(w.out); }, job, cleanup: (w) => cleaned.push(w.out),
    between: () => ++asks >= 2, onStart: (what) => starts.push(what),
  });
  assert.equal(n, 2);
  assert.deepEqual(played, ["One.", "Two."], "stopped after the second sentence, never mid-sentence");
  assert.ok(cleaned.includes("Three."), "the next sentence (already made) is cleaned up");
  assert.deepEqual(starts, ["sound", "words"], "once each");
  assert.equal(job.yielded, true);
});
