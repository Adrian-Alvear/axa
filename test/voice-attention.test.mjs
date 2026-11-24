// docs/tasks/voice-live-2.md: speech-dispatcher tiers, salience, voices per project, the agent's own spoken line,
// re-alerts, the focus gate, heartbeats, "while you were away", and live / digest / quiet. Pure; temp HOME only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-attention-")));
process.env.AXA_HOME = join(base, "axahome");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = (f) => readFileSync(join(ROOT, f), "utf8");
const N = await import("../src/core/narrator.mjs");
const At = await import("../src/core/attention.mjs");
const An = await import("../src/core/anticipate.mjs");
const D = await import("../src/core/durations.mjs");
const { VOICES, DEFAULT_VOICE } = await import("../src/core/kokoro.mjs");

// a narrator with a fake clock; speak() resolves with what the test says was heard
function rig() {
  const r = { t: 0, timers: [], said: [], logs: [], ends: [], yields: [] };
  r.n = N.createNarrator({
    now: () => r.t,
    setTimer: (fn, ms) => { const h = { fn, at: r.t + ms }; r.timers.push(h); return h; },
    clearTimer: (h) => { r.timers = r.timers.filter((x) => x !== h); },
    speak: (text, { shouldYield, tier }) => new Promise((done) => { r.said.push({ text, tier }); r.yields.push(shouldYield); r.ends.push(done); }),
    log: (e) => r.logs.push(e),
  });
  r.run = (ms) => { r.t += ms; for (const h of r.timers.filter((x) => x.at <= r.t)) { r.timers = r.timers.filter((x) => x !== h); h.fn(); } };
  r.end = async (v) => { r.ends.shift()(v); await new Promise((ok) => setImmediate(ok)); };
  r.dropped = (why) => r.logs.filter((l) => l.act === "dropped" && l.why === why).map((l) => l.text);
  return r;
}

test("1. tiers: progress is dropped while anything speaks; its final item is promoted to message", async () => {
  const r = rig();
  r.n.add({ kind: "reply", session: "axa", solo: true, text: "A reply." });
  r.n.add({ kind: "heartbeat", session: "f", text: "feed: still running the tests." });
  assert.deepEqual(r.dropped("busy (progress)"), ["feed: still running the tests."]);
  r.n.add({ kind: "heartbeat", session: "f", final: true, text: "feed: the tests finished." });
  assert.equal(r.n.pending(), 1, "the final one is kept, as a message");
  await r.end();
  r.run(1300);
  assert.equal(r.said[1].text, "feed: the tests finished.");
  assert.equal(r.said[1].tier, "message");
});

test("1. tiers: a notification only when idle, the last one kept; text is latest-wins, even while it plays", async () => {
  const r = rig();
  r.n.add({ kind: "done", session: "a", name: "api", text: "api finished." });
  r.n.add({ kind: "eta", session: "f", text: "feed is running the tests." });
  r.n.add({ kind: "eta", session: "g", text: "web is building." });
  assert.deepEqual(r.dropped("a newer notification"), ["feed is running the tests."]);
  r.run(1300);
  assert.deepEqual(r.said.map((s) => s.text), ["api finished."], "the message first; the notification waits for idle");
  await r.end();
  assert.equal(r.said[1].text, "web is building.");
  await r.end();
  // text: a newer reply replaces a queued one, and cuts one being said at its next sentence
  r.n.add({ kind: "reply", session: "axa", solo: true, text: "First reply. Long." });
  r.n.add({ kind: "reply", session: "axa", key: "reply2", solo: true, text: "Second reply." });
  assert.equal(r.yields.at(-1)(), true, "a newer text: stop the old one");
  await r.end();
  assert.equal(r.said.at(-1).text, "Second reply.");
});

test("1. important postpones a message: cut at the sentence, the unheard rest said after it, the heard part never replayed", async () => {
  const r = rig();
  r.n.add({ kind: "done", session: "a", name: "api", text: "api finished: the migration is done. All 42 tests pass." });
  r.run(1300);
  r.n.add({ kind: "waiting", session: "w", name: "web", text: "web needs your approval: push to main." });
  assert.equal(r.yields[0](), true);
  await r.end({ heard: "api finished: the migration is done." });
  assert.equal(r.said[1].text, "web needs your approval: push to main.");
  await r.end();
  assert.equal(r.said[2].text, "All 42 tests pass.", "only the rest");
  assert.ok(r.logs.some((l) => l.act === "postponed"));
  // important never interrupted; queued notification/progress cancelled by it
  await r.end();
  r.n.add({ kind: "waiting", session: "x", name: "x", text: "x needs you." });
  assert.equal(r.said.at(-1).text, "x needs you.");
  r.n.add({ kind: "eta", session: "y", text: "y is building." });
  r.n.add({ kind: "realert", session: "z", name: "z", text: "z is still waiting for you." });
  assert.equal(r.yields.at(-1)(), false);
  assert.deepEqual(r.dropped("cancelled by important"), ["y is building."]);
});

test("2. salience: news arriving together: what needs you goes at once, the queued messages ride along named once", async () => {
  const r = rig();
  r.n.add({ kind: "done", session: "1", name: "axa", text: "axa finished: the docs are updated." });
  r.n.add({ kind: "done", session: "2", name: "feed", text: "feed finished: tests pass." });
  r.n.add({ kind: "waiting", session: "3", name: "api", text: "api needs your approval: push to main." });
  assert.deepEqual(r.said.map((x) => x.text), ["api needs your approval: push to main. Also, axa and feed finished."]);
  assert.equal(r.n.pending(), 0);
});

test("2. salience: the strongest in full, the rest as one short named line; the name only when the speaker changes", async () => {
  const items = [
    { kind: "done", name: "axa", text: "axa finished: the docs are updated.", at: 1 },
    { kind: "done", name: "feed", text: "feed finished: tests pass.", at: 2 },
    { kind: "waiting", name: "api", text: "api needs your approval: push to main.", at: 3 },
  ];
  assert.equal(N.salienceLine(items), "api needs your approval: push to main. Also, axa and feed finished.");
  assert.equal(N.salienceLine([{ kind: "failed", name: "web", text: "web failed: build broke.", at: 1 }, { kind: "done", name: "a", text: "x", at: 2 }]), "web failed: build broke. Also, a finished.");
  // blast radius among needs-you: a one-way door > a question > a routine approval
  assert.match(N.salienceLine([
    { kind: "waiting", name: "q", text: "q asks: which branch?", blast: "question", at: 1 },
    { kind: "waiting", name: "d", text: "d is about to deploy.", blast: "door", at: 2 },
    { kind: "waiting", name: "r", text: "r needs your permission to use Bash.", blast: "approval", at: 3 },
  ]), /^d is about to deploy\. Also, q and r need you\.$/);
  assert.equal(N.withoutName("feed finished: tests pass.", "feed"), "Finished: tests pass.");
  assert.equal(N.withoutName("feed is running the tests.", "feed"), "feed is running the tests.");
  // the narrator drops the name when the same session speaks again
  const r = rig();
  r.n.add({ kind: "eta", session: "f", name: "feed", text: "feed is running the tests." });
  r.run(1300); await r.end();
  r.n.add({ kind: "done", session: "f", name: "feed", text: "feed finished: tests pass." });
  r.run(1300);
  assert.equal(r.said[1].text, "Finished: tests pass.");
});

test("3. who's talking: an earcon per class; a voice per project, stable, never the main voice", async () => {
  const E = await import("../src/core/earcons.mjs");
  assert.deepEqual(Object.keys(E.EARCONS).sort(), ["attention", "done", "failed"]);
  const v = At.voiceFor("feed", DEFAULT_VOICE, VOICES);
  assert.equal(At.voiceFor("feed", DEFAULT_VOICE, VOICES), v, "stable");
  assert.equal(At.voiceFor("Feed", DEFAULT_VOICE, VOICES), v, "case doesn't matter");
  assert.notEqual(v, DEFAULT_VOICE);
  assert.match(v, /^[ab][fm]_/);
  const many = new Set(["feed", "api", "web", "axa", "docs", "launches", "billing", "mobile"].map((p) => At.voiceFor(p, DEFAULT_VOICE, VOICES)));
  assert.ok(many.size >= 5, "projects get different voices");
  assert.equal(At.voiceFor("", "af_heart", VOICES), "af_heart");
  assert.match(src("src/core/voice.mjs"), /perProject: cfg\.voicePerProject === "on"/);
});

test("4. the agent's spoken line: parsed (<= 12 words), stripped from what's shown, asked only of AXA's workers", () => {
  const msg = "I migrated the settings page.\n\n- 42 tests pass\n\n🔊 Tests pass; the settings page now uses the new form library.";
  assert.deepEqual(At.spokenLineOf(msg), { line: "Tests pass; the settings page now uses the new form library.", rest: "I migrated the settings page.\n\n- 42 tests pass" });
  assert.equal(At.spokenLineOf("🔊 one two three four five six seven eight nine ten eleven twelve thirteen fourteen").line, "one two three four five six seven eight nine ten eleven twelve.");
  assert.deepEqual(At.spokenLineOf("No line here."), { line: null, rest: "No line here." });
  assert.equal(At.stripSpoken("Done.\n🔊 **Done**, all green"), "Done.");
  const hook = (env) => spawnSync(process.execPath, [join(ROOT, "hooks/spoken-line.mjs")], { input: "{}", env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  const w = hook({ AXA_ROLE: "worker" });
  assert.equal(w.status, 0);
  const out = JSON.parse(w.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /starts with 🔊 followed by at most 12 plain words/);
  assert.equal(hook({}).stdout, "", "the user's own sessions: nothing");
  assert.equal(hook({ AXA_ROLE: "commander" }).stdout, "");
  assert.notEqual(hook({ AXA_SPOKEN_LINE: "1" }).stdout, "", "...unless they opt in");
  assert.match(src("hooks/hooks.json"), /hooks\/spoken-line\.mjs/);
  // a notification never shows it; one turn, one "finished"
  assert.match(src("src/core/notify.mjs"), /const firstLine = \(t\) => one\(stripSpoken\(/);
  assert.match(src("src/core/claude-data.mjs"), /stripSpoken\(text\)/);
  const r = rig();
  r.n.add({ kind: "done", session: "f", name: "feed", text: "feed finished: Tests pass." });
  r.run(1300); r.end();
  r.n.add({ kind: "done", session: "f", name: "feed", text: "feed finished: I migrated the settings page." });
  assert.deepEqual(r.dropped("already said"), ["feed finished: I migrated the settings page."]);
  assert.match(src("src/core/server.mjs"), /if \(line\) return narrator\.add\(\{ \.\.\.item, how: "agent line"/);
});

test("5. re-alerts: after 60 s, 3 and 10 min, at most 3 times; never after you typed in it", () => {
  const due = (ms, count, typedAt = 0) => At.realertDue({ since: 1000, count, now: 1000 + ms, typedAt });
  assert.equal(due(59_000, 0), false); assert.equal(due(60_000, 0), true);
  assert.equal(due(170_000, 1), false); assert.equal(due(180_000, 1), true);
  assert.equal(due(600_000, 2), true); assert.equal(due(3_600_000, 3), false, "three at most");
  assert.equal(due(60_000, 0, 5000), false, "you typed in it since");
  assert.equal(At.realertLine("feed"), "Feed is still waiting for you.");
  assert.equal(N.normalize({ kind: "realert", text: "x" }, 0).tier, "important");
  assert.match(src("src/core/server.mjs"), /realertDue\(\{ since: w\.since, count: w\.count, now, typedAt: S\.lastInputAt\(s\.id\) \}\)/);
});

test("6. focus gate: nothing routine about the session you're looking at", () => {
  assert.equal(An.admitItem({ kind: "eta", priority: 2, session: "f" }, { focus: "f" }), "you're looking at it");
  assert.equal(An.admitItem({ kind: "eta", priority: 2, session: "g" }, { focus: "f" }), null);
  assert.equal(An.admitItem({ kind: "waiting", priority: 0, session: "f" }, { focus: "f" }), null, "what needs you still goes");
  assert.match(src("src/tui/app.mjs"), /call\("\/api\/focus", \{ method: "POST", body: \{ session: id \} \}\)/);
});

test("7. heartbeat: <= 10 words, at most once a minute, only for work expected over 2 min (chatty)", () => {
  const b = { name: "feed", doing: "Bash · Run the whole end to end test suite against staging", expectedMs: 5 * 60_000, sinceSaid: Infinity, verbosity: "chatty" };
  const l = At.heartbeatLine(b);
  assert.ok(l.split(/\s+/).length <= 10, l);
  assert.equal(l, "feed, still working: run the whole end to end test.");
  assert.equal(At.heartbeatLine({ ...b, expectedMs: 90_000 }), null);
  assert.equal(At.heartbeatLine({ ...b, sinceSaid: 30_000 }), null);
  assert.equal(At.heartbeatLine({ ...b, verbosity: "normal" }), null);
  // the tracker knows what's expected: the turn's median, or a running command's
  const store = D.createStore(); let t = 0;
  const tr = D.createTracker({ store, now: () => t });
  const ev = (event, x = {}) => tr.event({ event, terminal: "f", cwd: "/x/feed", ts: t, ...x });
  for (let i = 0; i < 3; i++) { ev("UserPromptSubmit"); t += 4 * 60_000; ev("Stop"); }
  assert.equal(tr.expected("f"), null, "not working");
  ev("UserPromptSubmit");
  assert.equal(tr.expected("f"), 4 * 60_000);
  assert.match(src("src/core/server.mjs"), /heartbeatLine\(\{ name: s\.name, doing: s\.doing, expectedMs: tracker\.expected\(s\.id\)/);
});

test("8. while you were away: the latest state of each session, from templates", () => {
  const notes = [
    { kind: "working", session: "1", project: "feed", title: "x", at: 1 },
    { kind: "done", session: "1", project: "feed", title: "feed finished", at: 2 },
    { kind: "done", session: "2", project: "api", title: "api finished", at: 3 },
    { kind: "waiting", session: "3", project: "web", title: "web needs you", at: 4 },
  ];
  assert.equal(At.recapLine(notes), "While you were away: Two sessions finished, feed and api. Web needs you.");
  assert.equal(At.recapLine([]), null);
  assert.equal(At.RECAP_IDLE_MS, 10 * 60_000);
  assert.match(src("src/tui/app.mjs"), /if \(idle < RECAP_IDLE_MS\) return;\n\s*call\("\/api\/recap"/);
});

test("9. live / digest / quiet: only one-way doors and failures interrupt in digest; the rest as one ranked digest", () => {
  const door = { kind: "escalate", tier: "important", reason: "one-way door: push to main", text: "api is about to need you: push to main" };
  assert.equal(At.blastOf(door), "door");
  assert.equal(At.blastOf({ kind: "waiting", text: "web asks: which branch?" }), "question");
  assert.equal(At.blastOf({ kind: "waiting", text: "feed needs your permission to use Bash." }), "approval");
  assert.equal(At.blastOf({ kind: "done", text: "x" }), null);
  assert.equal(At.modeAdmit({ kind: "done", tier: "message" }, "live"), null);
  assert.equal(At.modeAdmit(door, "digest"), null);
  assert.equal(At.modeAdmit({ kind: "failed", tier: "message" }, "digest"), null);
  assert.equal(At.modeAdmit({ kind: "waiting", tier: "important", text: "web asks: which branch?" }, "digest"), "hold");
  assert.equal(At.modeAdmit({ kind: "done", tier: "message" }, "digest"), "hold");
  assert.equal(At.modeAdmit(door, "quiet"), "hold");
  assert.equal(At.modeAdmit({ kind: "whatsup", asked: true }, "quiet"), null);
  const held = [
    { kind: "done", session: "1", name: "feed", text: "feed finished: tests pass.", at: 1 },
    { kind: "waiting", session: "2", name: "web", text: "web asks: which branch?", at: 2 },
    { kind: "done", session: "3", name: "docs", text: "docs finished.", at: 3 },
    { kind: "done", session: "1", name: "feed", text: "feed finished: tests pass.", at: 4 },
  ];
  assert.equal(At.digestLine(held), "Since the last digest: web asks: which branch? Also, docs and feed finished.");
  assert.equal(At.digestLine([]), null);
});

test("9. the setting: ui.json notify.mode, `axa notify`, the status bar, Settings and w", async () => {
  const Nt = await import("../src/core/notify.mjs");
  const home = join(base, "cli"), axa = join(home, ".axa");
  mkdirSync(axa, { recursive: true });
  writeFileSync(join(axa, "ui.json"), JSON.stringify({ voice: "on", notify: { voice: "all", brief_at: "09:00" } }));
  const run = (...a) => spawnSync(process.execPath, [join(ROOT, "bin", "axa"), "notify", ...a], { env: { PATH: process.env.PATH, HOME: home, AXA_HOME: axa, AXA_PORT: "4859" }, encoding: "utf8", timeout: 15_000 });
  assert.match(run().stdout, /Interruptions: live\./);
  assert.equal(run("digest").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(axa, "ui.json"), "utf8")), { voice: "on", notify: { voice: "all", brief_at: "09:00", mode: "digest" } });
  assert.match(run().stdout, /Interruptions: digest \(a digest every 15 min\)/);
  const bad = run("loud");
  assert.equal(bad.status, 1); assert.match(bad.stderr, /isn't a mode/);
  assert.throws(() => Nt.writeNotifyMode(join(base, "nope.json"), "x"));
  const { axaStatusLine } = await import("../src/tui/control.mjs");
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain(axaStatusLine({}, [], 120, 1, { voice: true, notifyMode: "digest" })[0]), /voice on\s+· ◷ digest/);
  assert.doesNotMatch(plain(axaStatusLine({}, [], 120, 1, { voice: true })[0]), /digest|quiet/);
  const app = src("src/tui/app.mjs");
  assert.match(app, /value: "notifyMode"/); assert.match(app, /value: "voicePerProject"/);
  assert.match(src("src/core/server.mjs"), /const digest = held\.length \? digestNow\(\) : null;/);
  assert.match(src("commander.md"), /axa notify digest/);
});
