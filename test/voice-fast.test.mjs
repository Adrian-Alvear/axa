// Part B of docs/tasks/voice-live.md: template lines said at once, the summary as a follow-up (started at Stop),
// earcons generated in code, a short first sentence, liveness lines. Pure (no audio, no model).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as N from "../src/core/narrator.mjs";
import * as E from "../src/core/earcons.mjs";
import * as Sm from "../src/core/summary.mjs";
import { chunkText, FIRST_CHUNK, speakChunks } from "../src/core/voice.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = (f) => readFileSync(join(ROOT, f), "utf8");

test("template lines for the frequent events: one sentence, said the moment it happens", () => {
  const L = (kind, title, body, project = "feed") => N.lineFor({ kind, title, body, project });
  assert.equal(L("done", "feed finished", "Updated the README with the install steps. All 42 tests pass."), "feed finished: Updated the README with the install steps.");
  assert.equal(L("done", "feed finished", "its turn is done"), "feed finished.");
  assert.equal(L("waiting", "feed needs you", "needs your approval · it wants to push to main"), "feed needs your approval: it wants to push to main.");
  assert.equal(L("waiting", "feed needs you", "Claude needs your permission to use Bash"), "feed needs your permission to use Bash.");
  assert.equal(L("waiting", "feed needs you", "asks you: Squash the commits or keep them?"), "feed asks: Squash the commits or keep them?");
  assert.equal(L("failed", "feed failed", "API Error: 529 overloaded. Retrying did not help."), "feed failed: API Error: 529 overloaded.");
  assert.equal(L("limited", "feed hit a usage limit", "it resets 3pm (Europe/Madrid)"), "feed hit a usage limit; it resets 3pm (Europe/Madrid).");
  assert.equal(L("exited", "feed exited", ""), "Claude exited in feed.");
  assert.equal(N.lineFor({ kind: "milestone", title: "review of axa: warn", body: "2 findings", project: "axa" }), "The review of axa has warnings.");
  assert.equal(N.lineFor({ kind: "link", title: "link fired: feed → api", body: "run the e2e tests", project: "api" }), "link fired: feed → api: run the e2e tests.");
  // a long report is cut at a word, to one sentence
  assert.ok(N.sentence1("word ".repeat(80), 40).length <= 40);
});

test("a reply: a short one is said whole; a long one's first sentence at once, its question kept for the follow-up", () => {
  assert.deepEqual(Sm.firstLine("Done. The tests pass."), { text: "Done. The tests pass.", long: false, question: null });
  const long = `I finished the migration of the settings page. ${"The new form library is wired in and every test passes. ".repeat(8)}Should I squash the commits or keep them?`;
  const f = Sm.firstLine(long);
  assert.equal(f.long, true);
  assert.equal(f.text, "I finished the migration of the settings page.");
  assert.match(f.question, /^Should I squash the commits or keep them\?/);
});

test("the summary starts at Stop (speculatively) and the reply waits for that one, not a second", async () => {
  let calls = 0;
  const summarize = () => { calls++; return new Promise((ok) => setTimeout(() => ok("Short summary for speaking."), 20)); };
  const md = `A long reply about the settings page. ${"More detail that goes on. ".repeat(30)}`;
  const p = Sm.prefetchSummary(md, { summarize, mode: "model" });
  assert.ok(p);
  const r = await Sm.spokenReply(md, { mode: "model", summarize });
  assert.equal(r.how, "summary");
  assert.equal(calls, 1, "one model call for both");
  assert.equal(Sm.prefetchSummary("Short.", { summarize, mode: "model" }), null, "a short reply needs none");
  assert.equal(Sm.prefetchSummary(md + " x", { summarize, mode: "full" }), null);
});

test("earcons: generated in code as valid WAVs; which one goes with a line", () => {
  const w = E.toneWav(E.EARCONS.done);
  assert.equal(w.toString("ascii", 0, 4), "RIFF"); assert.equal(w.toString("ascii", 8, 12), "WAVE");
  assert.equal(w.readUInt16LE(22), 1); assert.equal(w.readUInt32LE(24), 22050);
  assert.equal(w.readUInt32LE(40), w.length - 44);
  assert.ok(Math.abs(w.readUInt32LE(40) / 2 / 22050 - 0.25) < 0.01, "0.25 s");
  assert.equal(w.readInt16LE(44), 0, "fades in from silence");
  assert.equal(E.earconFor([{ kind: "failed", priority: 0 }]), "failed");
  assert.equal(E.earconFor([{ kind: "waiting", priority: 0 }]), "attention");
  assert.equal(E.earconFor([{ kind: "done", priority: 1 }]), "done");
  assert.equal(E.earconFor([{ kind: "progress", priority: 2 }]), null);
  const f = E.earconFile("attention", mkdtempSync(join(tmpdir(), "axa-earcon-")));
  assert.equal(readFileSync(f).toString("ascii", 0, 4), "RIFF");
  assert.equal(E.earconFile("nope"), null);
});

test("the earcon plays while the first sentence is made; onStart reports the first sound, then the first words", async () => {
  const order = [];
  let made = 0;
  const job = { stopped: false, kills: new Set(), kill() {} };
  await speakChunks(["One.", "Two."], {
    synth: async (c) => { made++; return { out: c }; }, play: async (w) => { order.push(w.out); }, job,
    intro: "tone.wav", onStart: (what) => order.push(`start:${what}`),
  });
  assert.deepEqual(order, ["start:sound", "tone.wav", "start:words", "One.", "Two."]);
  assert.equal(made, 2);
});

test("the first chunk is short: the first sentence, not 200 characters of them", () => {
  const t = "Done. The tests pass and the build is green on the branch. I also updated the handoff file with the rest. Next I'll open the pull request for review.";
  const c = chunkText(t, 200, FIRST_CHUNK);
  assert.ok(c[0].length <= FIRST_CHUNK, c[0]);
  assert.equal(c[0], "Done. The tests pass and the build is green on the branch.");
  assert.equal(c.join(" "), t);
  // a first sentence of some length is alone: its end is where a P0 can cut in
  assert.deepEqual(chunkText("Three sessions finished, axa, feed and docs. The review of api approved it.", 200, FIRST_CHUNK),
    ["Three sessions finished, axa, feed and docs.", "The review of api approved it."]);
  assert.deepEqual(chunkText("Three sessions finished, axa, feed and docs. The review of api approved it."), ["Three sessions finished, axa, feed and docs. The review of api approved it."], "(the default: 200-character chunks)");
});

test("liveness: after 3 min of work with nothing said, at most every 5 min, not when quiet", () => {
  const base = { name: "feed", doing: "Bash · Run the test suite", workingFor: 4 * 60_000, sinceSaid: Infinity };
  assert.equal(N.livenessLine(base), "feed is still working: Run the test suite.");
  assert.equal(N.livenessLine({ ...base, workingFor: 2 * 60_000 }), null);
  assert.equal(N.livenessLine({ ...base, sinceSaid: 4 * 60_000 }), null);
  assert.equal(N.livenessLine({ ...base, sinceSaid: 6 * 60_000, verbosity: "chatty" }), "feed is still working: Run the test suite.");
  assert.equal(N.livenessLine({ ...base, verbosity: "quiet" }), null);
  assert.equal(N.livenessLine({ ...base, doing: "" }), "feed is still working.");
});

test("a reply is said at once and alone, even while a burst of notifications settles", async () => {
  const said = [], timers = [];
  const n = N.createNarrator({ now: () => 0, speak: (t) => { said.push(t); return new Promise(() => {}); }, setTimer: (fn) => { timers.push(fn); return fn; }, clearTimer: () => {} });
  n.add({ kind: "done", session: "1", name: "api", text: "api finished." });
  n.add({ kind: "reply", key: "reply", session: "axa", solo: true, text: "I finished the migration." });
  assert.deepEqual(said, ["I finished the migration."]);
  assert.equal(n.pending(), 1, "the burst waits its turn");
});

test("the daemon: template lines, the summary prefetched at Stop, the reply's first line first, earcons, time to first audio", () => {
  const s = src("src/core/server.mjs");
  assert.match(s, /text: cap\(V\.toSpeech\(safe\(lineFor\(n\)\), \{ more: false \}\)\)/);
  assert.match(s, /e\.event === "Stop" && e\.role === "commander"[^\n]*prefetchSummary\(safe\(e\.message\)\)/);
  assert.match(s, /const f = firstLine\(md\), gen = \+\+voiceGen;\n\s*narrator\.add\(\{ \.\.\.item, text: f\.text/);
  assert.match(s, /onStart: ttfa\(items\), intro: tone \? earconFile\(tone\) : null/);
  assert.match(s, /voice: first \$\{k\} \$\{Date\.now\(\) - t0\} ms after the event/);
  assert.match(src("src/core/voice.mjs"), /earcons: cfg\.voiceEarcons !== "off"/);
});
