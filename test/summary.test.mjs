// Part C of docs/tasks/briefing.md: spoken summaries. A fake summariser (AXA_SUMMARY_CMD) stands in for
// the fast model: a long reply is spoken as its summary; a timeout falls back to whole sentences and a
// natural closing line; a question for the user is always said. No real model runs here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-summary-test-")));
process.env.HOME = join(base, "home");
process.env.AXA_HOME = join(base, "axahome");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.AXA_HOME, { recursive: true });
const FAKE = fileURLToPath(new URL("./fixtures/fake-summary.mjs", import.meta.url));
const Sm = await import("../src/core/summary.mjs");
const { SHORT } = await import("../src/core/speech.mjs");

const env = (o = {}) => ({ ...process.env, AXA_SUMMARY_CMD: `${process.execPath} ${FAKE}`, AXA_TERMINAL_ID: "should-not-pass", ...o });
const run = (o, timeoutMs) => (md) => Sm.runSummary(md, { env: env(o), timeoutMs });
const LONG = [
  "## Done",
  "I rewrote the login flow in `src/auth/login.ts` and moved the session handling into its own module, commit 3f2a9c1e.",
  "",
  "- 42 tests pass, 0 fail; the build takes 38 s now instead of 61 s.",
  "- The flaky test in `test/feed.test.ts` was a race on the clock; it uses a fake timer now.",
  "",
  "The old cookie format is still read, so nobody gets logged out, and the migration runs on the first request after deploy.",
  "I also cleaned up three unused helpers and updated the handoff file with what's left.",
].join("\n");
const ASK = `${LONG}\n\nShould I push this to main now, or open a pull request first?\n- push to main\n- open a pull request`;

test("the summariser runs a fast model with no tools, isolated and untraced", async () => {
  const log = join(base, "calls.jsonl");
  const s = await Sm.runSummary("some text", { env: env({ FAKE_SUMMARY: "Short and sweet.", FAKE_SUMMARY_LOG: log }) });
  assert.equal(s, "Short and sweet.");
  const call = JSON.parse(readFileSync(log, "utf8").trim().split("\n").pop());
  assert.deepEqual(call.args, ["-p", "--model", "claude-haiku-5-5", "--output-format", "text", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]);
  assert.equal(call.role, "reviewer", "the read-only reviewer's policy applies");
  assert.equal(call.terminal, null, "never traced as a session");
  assert.equal(call.cwd, realpathSync(join(tmpdir(), "axa-summary")), "an empty temp folder, not a project");
  assert.ok(call.prompt.startsWith(Sm.SUMMARY_PROMPT));
  assert.match(call.prompt, /<text>\nsome text\n<\/text>/);
  assert.match(Sm.SUMMARY_PROMPT, /2-5 short sentences.*question or choice the user must answer \(say the options\).*No markdown, no file paths, no commit ids\. Don't say 'on screen'\./s);
});

test("a timeout or a failure gives null, and the summariser is gone at its limit", async () => {
  const t0 = Date.now();
  assert.equal(await Sm.runSummary("x", { env: env({ FAKE_SUMMARY_MODE: "hang" }), timeoutMs: 300 }), null);
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(await Sm.runSummary("x", { env: env({ FAKE_SUMMARY_MODE: "fail" }) }), null);
  assert.equal(await Sm.runSummary("x", { env: env({ AXA_SUMMARY_CMD: "/nonexistent/claude" }) }), null);
});

test("a long reply is spoken as its summary (normalized), and cached by its text", async () => {
  let calls = 0;
  const summarize = async (md) => { calls++; return run({ FAKE_SUMMARY: "I rewrote the **login** flow; `42` tests pass and the build is 23 seconds faster." })(md); };
  const r = await Sm.spokenReply(LONG, { mode: "model", summarize });
  assert.equal(r.how, "summary");
  assert.equal(r.text, "I rewrote the login flow; 42 tests pass and the build is 23 seconds faster.");
  assert.ok(!/on screen/i.test(r.text));
  await Sm.spokenReply(LONG, { mode: "model", summarize });
  assert.equal(calls, 1, "the same reply isn't summarised twice");
});

test("short replies are said as they are; no model call", async () => {
  let calls = 0;
  const r = await Sm.spokenReply("Done: the tests pass.", { mode: "model", summarize: async () => { calls++; return "x"; } });
  assert.deepEqual(r, { text: "Done: the tests pass.", how: "short" });
  assert.equal(calls, 0);
});

test("timeout -> the old behaviour in whole sentences, ending with a natural line", async () => {
  const r = await Sm.spokenReply(LONG + "\n\nOne more paragraph to be sure.", { mode: "model", summarize: run({ FAKE_SUMMARY_MODE: "hang" }, 300) });
  assert.equal(r.how, "fallback");
  assert.ok(r.text.endsWith(` ${Sm.MORE_DETAIL}`), r.text);
  const body = r.text.slice(0, -Sm.MORE_DETAIL.length).trim();
  assert.match(body, /[.!?]$/, "ends on a whole sentence");
  assert.ok(body.length <= SHORT + 200);
  assert.ok(!/on screen/i.test(r.text));
  // one very long sentence is kept whole, never cut mid-sentence
  const one = `${"word ".repeat(120).trim()} end of the sentence.\n\nA second paragraph.`;
  const f = Sm.shortSpeech(one);
  assert.ok(f.startsWith("word word") && f.includes("end of the sentence."), f);
  assert.ok(f.endsWith(Sm.MORE_DETAIL));
  // nothing left out: no closing line
  assert.equal(Sm.shortSpeech("Just this."), "Just this.");
});

test("a question for the user is always spoken: summary, fallback, first paragraph", async () => {
  const q = Sm.questionOf(ASK);
  assert.match(q, /^Should I push this to main now, or open a pull request first\? push to main\. open a pull request\.$/i);
  // the summary left it out: it's added
  const s = await Sm.spokenReply(ASK, { mode: "model", summarize: run({ FAKE_SUMMARY: "The login rewrite is done and 42 tests pass." }) });
  assert.equal(s.how, "summary");
  assert.match(s.text, /^The login rewrite is done and 42 tests pass\. Should I push this to main now, or open a pull request first\?/);
  // the summary kept it: not said twice
  const k = await Sm.spokenReply(ASK + " ", { mode: "model", summarize: run({ FAKE_SUMMARY: "It's done. Should I push this to main now, or open a pull request first?" }) });
  assert.equal((k.text.match(/Should I push/g) || []).length, 1);
  // ...or kept it in other words (seen with the real model): not said twice either
  const o = await Sm.spokenReply(ASK + "   ", { mode: "model", summarize: run({ FAKE_SUMMARY: "It's done. Should I push it now, or open a pull request?" }) });
  assert.equal(o.text, "It's done. Should I push it now, or open a pull request?");
  // the fallback: the question before the closing line
  const f = await Sm.spokenReply(ASK + "  ", { mode: "model", summarize: async () => null });
  assert.equal(f.how, "fallback");
  assert.match(f.text, /Should I push this to main now, or open a pull request first\?.* There's more detail in the chat\.$/);
  // the old first-paragraph mode too
  const p = await Sm.spokenReply(ASK, { mode: "first-paragraph", more: true });
  assert.match(p.text, /Should I push this to main now/);
  assert.equal(Sm.questionOf("No question here. All done."), null);
});

test("modes: full says everything; the setting defaults to the model", async () => {
  const r = await Sm.spokenReply(LONG, { mode: "full", summarize: async () => { throw new Error("not called"); } });
  assert.equal(r.how, "full");
  assert.match(r.text, /handoff file with what's left\.$/);
  assert.equal(Sm.summaryMode({}), "model");
  assert.equal(Sm.summaryMode({ voiceSummary: "first-paragraph" }), "first-paragraph");
  assert.equal(Sm.summaryMode({ voiceSummary: "loud" }), "model");
});
