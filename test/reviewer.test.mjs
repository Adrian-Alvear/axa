// src/core/reviewer.mjs (verdict parsing, block confirmation, rounds, skip rules, settings, running it),
// hooks/policy.mjs for AXA_ROLE=reviewer, and a dry end-to-end run of the supervisor with a fake reviewer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// everything AXA writes goes to a throwaway home, before the modules load
const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-reviewer-test-")));
const axaHome = join(base, "axahome");
mkdirSync(axaHome, { recursive: true });
process.env.AXA_HOME = axaHome;
process.env.AXA_DONE_MS = "1";
delete process.env.AXA_REVIEWER;
const FAKE = fileURLToPath(new URL("./fixtures/fake-reviewer.mjs", import.meta.url));
process.env.AXA_REVIEWER_CMD = `${process.execPath} ${FAKE}`;
const R = await import("../src/core/reviewer.mjs");
const { trackEvent, lastRun } = await import("../src/core/events.mjs");
const { deps, reviewsSettled, supervise, trackReviews } = await import("../src/core/supervisor.mjs");
test.after(() => rmSync(base, { recursive: true, force: true }));

const verdict = (v) => JSON.stringify(v);
const FINDING = { severity: "high", file: "src/a.js", line: 2, quote: "return x + 1;", problem: "off by one", evidence: "node -e 'console.log(require(\"./src/a.js\")(1))' prints 2, expected 1" };
const GOOD = { verdict: "warn", summary: "works; README out of date", checks: [{ cmd: "node --test", ok: true, tail: "# pass 4" }], findings: [{ ...FINDING, severity: "med" }] };

// ---------- parsing ----------
test("parseVerdict: a good verdict, bare or as claude -p --output-format json prints it", () => {
  const bare = R.parseVerdict(verdict(GOOD));
  assert.equal(bare.verdict, "warn");
  assert.equal(bare.findings.length, 1);
  assert.deepEqual(bare.checks, [{ cmd: "node --test", ok: true, tail: "# pass 4" }]);
  const wrapped = R.parseVerdict(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: verdict(GOOD) }));
  assert.deepEqual(wrapped, bare);
  assert.equal(R.parseVerdict(verdict({ verdict: "approve", summary: "fine", checks: [], findings: [] })).verdict, "approve");
});

test("parseVerdict: extra text or code fences around the JSON", () => {
  assert.equal(R.parseVerdict(`Here is my verdict:\n${verdict(GOOD)}\nThanks.`).verdict, "warn");
  assert.equal(R.parseVerdict("```json\n" + verdict(GOOD) + "\n```").verdict, "warn");
  const wrapped = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.\n```json\n" + verdict(GOOD) + "\n```" });
  assert.equal(R.parseVerdict(wrapped).verdict, "warn");
});

test("parseVerdict: malformed answers are an error, never a pass", () => {
  const bad = [
    "", "not json at all", "[1,2]", "{ broken",
    verdict({ ...GOOD, verdict: "lgtm" }),
    verdict({ ...GOOD, summary: "" }),
    verdict({ ...GOOD, checks: "ran tests" }),
    verdict({ ...GOOD, checks: [{ cmd: "npm test", ok: "yes" }] }),
    verdict({ ...GOOD, findings: [{ ...FINDING, quote: "" }] }),
    verdict({ ...GOOD, findings: [{ ...FINDING, evidence: undefined }] }),
    verdict({ ...GOOD, findings: [{ ...FINDING, line: "2" }] }),
    verdict({ ...GOOD, findings: [{ ...FINDING, line: 0 }] }),
    verdict({ ...GOOD, findings: [{ ...FINDING, severity: "critical" }] }),
    JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "" }),
  ];
  for (const b of bad) assert.equal(R.parseVerdict(b).verdict, "error", b);
});

// ---------- confirm before block ----------
function project() {
  const dir = mkdtempSync(join(base, "proj-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.js"), ["module.exports = function (x) {", "  return x + 1;", "};", ...Array.from({ length: 20 }, (_, i) => `// line ${i + 4}`)].join("\n"));
  return dir;
}

test("confirmBlock: a high finding stands only if its quote is in the file near its line", () => {
  const dir = project();
  assert.equal(R.quoteNear(dir, FINDING), true);
  assert.equal(R.quoteNear(dir, { ...FINDING, line: 7 }), true, "within 5 lines");
  assert.equal(R.quoteNear(dir, { ...FINDING, line: 15 }), false, "too far from its line");
  assert.equal(R.quoteNear(dir, { ...FINDING, quote: "return x - 1;" }), false, "not in the file");
  assert.equal(R.quoteNear(dir, { ...FINDING, quote: "return   x + 1;" }), true, "whitespace doesn't matter");
  assert.equal(R.quoteNear(dir, { ...FINDING, file: "../../etc/passwd", quote: "root" }), false, "outside the project");
  assert.equal(R.quoteNear(dir, { ...FINDING, file: "src/missing.js" }), false);

  const block = { verdict: "block", summary: "bug", checks: [], findings: [FINDING, { ...FINDING, line: 20, quote: "made up" }, { ...FINDING, severity: "low", quote: "unchecked" }] };
  const kept = R.confirmBlock(block, dir);
  assert.equal(kept.verdict, "block");
  assert.equal(kept.findings.length, 2); // the confirmed high one and the low one
  assert.equal(kept.dropped.length, 1);

  const onlyBad = R.confirmBlock({ ...block, findings: [{ ...FINDING, quote: "made up" }] }, dir);
  assert.equal(onlyBad.verdict, "warn", "no confirmed high finding: downgraded");
  assert.equal(onlyBad.findings.length, 0);
  assert.equal(R.confirmBlock({ ...block, findings: [{ ...FINDING, severity: "med" }] }, dir).verdict, "warn", "a block without a high finding is a warn");
  assert.equal(R.confirmBlock(GOOD, dir).verdict, "warn", "non-blocks untouched");
});

// ---------- rounds ----------
test("nextStep: block, block, then the third goes to the commander", () => {
  const st = new Map();
  assert.deepEqual(R.nextStep(st, "w", { prompt: "add x" }, "block"), { to: "worker", round: 1, goal: "add x" });
  const fix = { prompt: `${R.BLOCK_PREFIX} Fix them...` };
  assert.deepEqual(R.nextStep(st, "w", fix, "block"), { to: "worker", round: 2, goal: "add x" });
  assert.deepEqual(R.nextStep(st, "w", fix, "block"), { to: "commander", round: 3, goal: "add x", exhausted: true });
  // a new instruction starts the count again
  assert.equal(R.nextStep(st, "w", { prompt: "now do y" }, "block").round, 1);
  // a fix that passes goes to the commander
  assert.equal(R.nextStep(st, "w", fix, "approve").to, "commander");
  // rounds: 0 sends every block straight to the commander
  assert.equal(R.nextStep(new Map(), "w", { prompt: "z" }, "block", 0).to, "commander");
});

// ---------- skip rules ----------
test("shouldReview: only a worker's finished turn that changed code", () => {
  const w = { id: "w", mode: "claude", alive: true, status: "done" };
  const run = { status: "done", edits: 2, prompt: "add x" };
  assert.equal(R.shouldReview(w, run).review, true);
  assert.equal(R.shouldReview(w, { ...run, edits: 0 }).review, false, "reading/research turn");
  assert.equal(R.shouldReview(w, { ...run, edits: 0 }, { changed: false }).review, false);
  assert.equal(R.shouldReview(w, { ...run, edits: 0 }, { changed: true }).review, true, "git moved (e.g. sed -i, a commit)");
  assert.equal(R.shouldReview(w, { ...run, edits: 0, prompt: `${R.BLOCK_PREFIX} ...` }).review, true, "a fix round is always re-checked");
  assert.equal(R.shouldReview({ ...w, mode: "axa" }, run).review, false, "the commander");
  assert.equal(R.shouldReview({ ...w, mode: "shell" }, run).review, false, "a shell");
  assert.equal(R.shouldReview({ ...w, status: "waiting" }, run).review, false);
  assert.equal(R.shouldReview({ ...w, status: "stuck" }, run).review, false);
  assert.equal(R.shouldReview(w, { ...run, status: "running" }).review, false);
  assert.equal(R.shouldReview(w, run, { settings: { mode: "off" } }).review, false);
});

// ---------- settings ----------
test("reviewSettings: defaults, per project, off switch", () => {
  const f = join(base, "policy-settings.json");
  assert.deepEqual(R.reviewSettings("/x/proj", join(base, "missing.json")), R.DEFAULTS);
  writeFileSync(f, JSON.stringify({ default: { reviewer: { effort: "xhigh" } }, projects: { scratch: { reviewer: { mode: "off" } }, "/x/fast": { reviewer: { model: "claude-sonnet-5-5", effort: "bogus" } } } }));
  assert.equal(R.reviewSettings("/x/proj", f).effort, "xhigh");
  assert.equal(R.reviewSettings("/x/proj", f).model, "claude-opus-5-5");
  assert.equal(R.reviewSettings("/x/scratch", f).mode, "off");
  assert.equal(R.reviewSettings("/x/scratch/.claude/worktrees/t1", f).mode, "off", "a worktree gets its repo's settings");
  assert.equal(R.reviewSettings("/x/fast", f).model, "claude-sonnet-5-5");
  assert.equal(R.reviewSettings("/x/fast", f).effort, "high", "an unknown effort falls back");
  process.env.AXA_REVIEWER = "0";
  try { assert.equal(R.reviewSettings("/x/proj", f).mode, "off"); } finally { delete process.env.AXA_REVIEWER; }
});

// ---------- running it (with the fake reviewer) ----------
test("runReviewer: claude's flags, AXA_ROLE=reviewer, never the worker's terminal id", async () => {
  const log = join(base, "calls-flags.jsonl"), dir = project();
  const env = { ...process.env, FAKE_REVIEW_LOG: log, AXA_TERMINAL_ID: "w1", FAKE_REVIEW: verdict(GOOD) };
  const r = await R.runReviewer({ cwd: dir, prompt: "PROMPT", settings: R.DEFAULTS, env });
  assert.equal(r.verdict, "warn");
  const call = JSON.parse(readFileSync(log, "utf8").trim());
  assert.equal(call.role, "reviewer");
  assert.equal(call.terminal, null);
  assert.equal(call.cwd, dir);
  assert.equal(call.prompt, "PROMPT");
  const a = call.args, flag = (k) => a[a.indexOf(k) + 1];
  assert.ok(a.includes("-p"));
  assert.equal(flag("--model"), "claude-opus-5-5");
  assert.equal(flag("--effort"), "high");
  assert.equal(flag("--output-format"), "json");
  assert.equal(flag("--allowedTools"), R.ALLOWED_TOOLS);
  assert.match(flag("--disallowedTools"), /^Edit,Write,.*NotebookEdit,WebFetch,WebSearch/);
  assert.match(flag("--append-system-prompt"), /EVIDENCE RULE|evidence rule/i);
  assert.doesNotMatch(flag("--append-system-prompt"), /^---/, "frontmatter left out");
});

test("runReviewer: crash, hang (timeout) and junk are verdict error", async () => {
  const dir = project();
  assert.equal((await R.runReviewer({ cwd: dir, prompt: "p", env: { ...process.env, FAKE_REVIEW_MODE: "crash" } })).verdict, "error");
  const hung = await R.runReviewer({ cwd: dir, prompt: "p", settings: { ...R.DEFAULTS, timeout_ms: 300 }, env: { ...process.env, FAKE_REVIEW_MODE: "hang" } });
  assert.equal(hung.verdict, "error");
  assert.match(hung.summary, /timed out/);
  assert.equal((await R.runReviewer({ cwd: dir, prompt: "p", env: { ...process.env, FAKE_REVIEW_MODE: "raw", FAKE_REVIEW: "I think it's fine" } })).verdict, "error");
  assert.equal((await R.runReviewer({ cwd: dir, prompt: "p", env: { ...process.env, AXA_REVIEWER_CMD: join(base, "no-such-binary") } })).verdict, "error");
});

test("verdictLine and blockMessage", () => {
  assert.equal(R.verdictLine({ verdict: "warn", findings: [{ problem: "README out of date" }, { problem: "no test for X" }] }), "review: ⚠ warn: 2 findings (README out of date; no test for X)");
  assert.match(R.verdictLine({ verdict: "approve", summary: "all good", findings: [] }), /^review: ✓ approve: all good$/);
  assert.match(R.verdictLine({ verdict: "error", summary: "timed out" }), /not reviewed/);
  const m = R.blockMessage([FINDING]);
  assert.ok(m.startsWith(R.BLOCK_PREFIX));
  assert.match(m, /Fix them, re-run the checks, then finish: \(1\) src\/a\.js:2 \[high\] off by one/);
});

// ---------- the policy for AXA_ROLE=reviewer ----------
const HOOK = fileURLToPath(new URL("../hooks/policy.mjs", import.meta.url));
function policy(proj, tool_name, tool_input) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: "t", tool_name, tool_input, cwd: proj }), env: { PATH: process.env.PATH, HOME: join(base, "home"), AXA_HOME: axaHome, AXA_PORT: "4799", AXA_ROLE: "reviewer", CLAUDE_PROJECT_DIR: proj }, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : null;
}
test("policy, AXA_ROLE=reviewer: read-only plus the project's checks", () => {
  const dir = project();
  for (const [tool, input] of [["Edit", { file_path: join(dir, "src/a.js"), old_string: "a", new_string: "b" }], ["Write", { file_path: join(dir, "x.txt"), content: "x" }], ["MultiEdit", { file_path: join(dir, "src/a.js") }], ["NotebookEdit", { notebook_path: join(dir, "n.ipynb") }], ["WebFetch", { url: "https://example.com" }], ["WebSearch", { query: "x" }], ["Agent", { prompt: "x" }], ["Read", { file_path: "/etc/hosts" }], ["Read", { file_path: join(dir, ".env") }], ["Read", { file_path: join(axaHome, "policy.json") }]])
    assert.equal(policy(dir, tool, input), "deny", `${tool} ${JSON.stringify(input)}`);
  for (const cmd of ["git push origin feat", "git push origin main", "git commit -m x", "git checkout -b x", "git reset --hard", ["rm", "-rf", "src"].join(" "), "echo x > src/a.js", "sed -i s/a/b/ src/a.js", "npm install", "npm publish", "npm run deploy", "node -e 'x'", "node --check --require=./x.js src/a.js", "curl https://example.com", "cat $(echo x)", "touch new.txt", "cp src/a.js b.js"])
    assert.equal(policy(dir, "Bash", { command: cmd }), "deny", cmd);
  for (const cmd of ["node --test", "node --test test", "node --check src/a.js", "git diff", "git diff HEAD --stat", "git status --short", "git log --oneline -5", "npm test", "npm run build", "npm run test:unit", "npx tsc --noEmit", "cat src/a.js", "grep -rn x src", "ls -la", "cd src && cat a.js", "npm test 2>&1 | tail -20"])
    assert.equal(policy(dir, "Bash", { command: cmd }), "allow", cmd);
  assert.equal(policy(dir, "Read", { file_path: join(dir, "src/a.js") }), "allow");
  assert.equal(policy(dir, "Grep", { pattern: "x", path: dir }), "allow");
  // the reviewer stays read-only even when the project's AXA policy is switched off
  writeFileSync(join(axaHome, "policy.json"), JSON.stringify({ default: { mode: "off" } }));
  try { assert.equal(policy(dir, "Edit", { file_path: join(dir, "src/a.js") }), "deny"); } finally { rmSync(join(axaHome, "policy.json")); }
});

// ---------- dry end to end: events -> supervisor -> fake reviewer -> worker / commander ----------
test("end to end with a fake reviewer: two block rounds to the worker, the third to the commander", async () => {
  const git = (cwd, ...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
  const dir = project();
  git(dir, "init", "-q"); git(dir, "add", "."); git(dir, "commit", "-qm", "init");
  const callLog = join(base, "calls-e2e.jsonl");
  process.env.FAKE_REVIEW_LOG = callLog;
  const sent = [];
  deps.send = async (id, text) => { sent.push({ id, text }); return { ok: true }; };
  deps.lastInputAt = () => 0;
  const logged = [];
  deps.log = (e) => logged.push(e);

  const worker = (status) => ({ id: "w1", name: "feed", mode: "claude", alive: true, status, cwd: dir, last_report: "Done: fixed the bug, tests pass." });
  const cmd = { id: "c1", name: "axa", mode: "axa", alive: true, status: "ready" };
  const tick = async (status) => { const list = [worker(status), cmd]; trackReviews(list); supervise(list); await reviewsSettled(); await new Promise((r) => setTimeout(r, 5)); };
  // one turn: prompt, an edit (on disk too), stop; then the supervisor sees working -> done
  let n = 0;
  async function turn(prompt, { edit = true } = {}) {
    trackEvent({ event: "UserPromptSubmit", terminal: "w1", role: "worker", cwd: dir, prompt, ts: Date.now() + n++ });
    await tick("working");
    if (edit) { trackEvent({ event: "PreToolUse", terminal: "w1", role: "worker", tool: "Edit", summary: "src/a.js", tool_use_id: `t${n}` }); appendFileSync(join(dir, "src/a.js"), `\n// edit ${n}`); }
    trackEvent({ event: "Stop", terminal: "w1", role: "worker", message: "Done: fixed the bug, tests pass." });
    await tick("done");
    await tick("done"); // DONE_MS held: the review runs
    await tick("done"); // the commander's wake, if any
  }
  const toWorker = () => sent.filter((m) => m.id === "w1"), toCommander = () => sent.filter((m) => m.id === "c1");

  await tick("ready"); // the supervisor's first pass only learns the states
  process.env.FAKE_REVIEW = verdict({ verdict: "block", summary: "off by one", checks: [{ cmd: "node --test", ok: false, tail: "1 failing" }], findings: [FINDING] });
  await turn("make f return x");
  assert.equal(toWorker().length, 1, "round 1: back to the worker");
  assert.ok(toWorker()[0].text.startsWith(R.BLOCK_PREFIX));
  assert.match(toWorker()[0].text, /src\/a\.js:2 \[high\] off by one/);
  assert.equal(toCommander().length, 0, "the commander isn't woken while the worker fixes it");
  assert.equal(lastRun("w1").review.verdict, "block");
  assert.equal(R.reviewOf("w1").verdict, "block");

  await turn(toWorker()[0].text);
  assert.equal(toWorker().length, 2, "round 2: back to the worker again");
  const calls = readFileSync(callLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.match(calls.at(-1).prompt, /<instruction>\nmake f return x\n<\/instruction>/, "a fix round is reviewed against the original instruction");
  assert.match(calls.at(-1).prompt, /<diff>[\s\S]*src\/a\.js/);
  assert.equal(calls.at(-1).role, "reviewer");

  await turn(toWorker()[1].text);
  assert.equal(toWorker().length, 2, "round 3: not sent to the worker");
  assert.equal(toCommander().length, 1, "round 3: the commander is woken with the findings");
  assert.match(toCommander()[0].text, /feed \(w1\) finished its turn · review: ✗ block after 2 fix rounds, over to you: 1 finding \(off by one\)/);
  assert.deepEqual(logged.filter((e) => e.event === "Review").map((e) => [e.verdict, e.round]), [["block", 1], ["block", 2], ["block", 3]]);

  // a new instruction, a warn: the commander hears it with the verdict line
  process.env.FAKE_REVIEW = verdict(GOOD);
  await turn("update the docs");
  assert.match(toCommander().at(-1).text, /feed \(w1\) finished its turn · review: ⚠ warn: 1 finding \(off by one\)/);

  // a block whose quote isn't in the file is downgraded to warn and goes to the commander, not the worker
  const before = toWorker().length;
  process.env.FAKE_REVIEW = verdict({ verdict: "block", summary: "made up", checks: [], findings: [{ ...FINDING, quote: "this line does not exist" }] });
  await turn("tidy up");
  assert.equal(toWorker().length, before);
  assert.match(toCommander().at(-1).text, /review: ⚠ warn/);
  const last = logged.filter((e) => e.event === "Review").at(-1);
  assert.deepEqual([last.raw_verdict, last.verdict], ["block", "warn"], "raw and confirmed verdicts both logged");

  // a reading turn (no edits, git unchanged): no review, the usual wake
  const reviews = readFileSync(callLog, "utf8").trim().split("\n").length;
  await turn("what does f do?", { edit: false });
  assert.equal(readFileSync(callLog, "utf8").trim().split("\n").length, reviews, "no review for a reading turn");
  assert.match(toCommander().at(-1).text, /feed \(w1\) finished its turn\. Handle this/);

  // the reviewer crashes: AXA proceeds and says so
  process.env.FAKE_REVIEW_MODE = "crash";
  try { await turn("one more change"); } finally { delete process.env.FAKE_REVIEW_MODE; }
  assert.match(toCommander().at(-1).text, /review: \? error .*not reviewed/);
});
