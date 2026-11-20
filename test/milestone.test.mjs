// Milestone reviews (src/core/milestone.mjs): reviewer modes, base selection, the range diff, the prompt,
// streamed progress and timeouts, and the verifier <-> fixer loop with a fake reviewer (AXA_REVIEWER_CMD)
// and a fake fixer (its session list driven by hand). No real model runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-milestone-test-")));
const axaHome = join(base, "axahome");
mkdirSync(axaHome, { recursive: true });
process.env.AXA_HOME = axaHome;
process.env.AXA_DONE_MS = "1";
delete process.env.AXA_REVIEWER;
const FAKE = fileURLToPath(new URL("./fixtures/fake-reviewer.mjs", import.meta.url));
process.env.AXA_REVIEWER_CMD = `${process.execPath} ${FAKE}`;
const R = await import("../src/core/reviewer.mjs");
const M = await import("../src/core/milestone.mjs");
const { trackEvent } = await import("../src/core/events.mjs");
const { deps, reviewsSettled, supervise, trackReviews } = await import("../src/core/supervisor.mjs");
test.after(() => rmSync(base, { recursive: true, force: true }));

const git = (cwd, ...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8" });
const sha = (cwd, ref = "HEAD") => git(cwd, "rev-parse", ref).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function repo(commits = 1) {
  const dir = mkdtempSync(join(base, "repo-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.js"), ["module.exports = function (x) {", "  return x + 1;", "};", ""].join("\n"));
  git(dir, "init", "-q"); git(dir, "add", "."); git(dir, "commit", "-qm", "init");
  for (let i = 1; i < commits; i++) { appendFileSync(join(dir, "src/a.js"), `// c${i}\n`); git(dir, "commit", "-qam", `c${i}`); }
  return dir;
}
const verdict = (v) => JSON.stringify(v);
const FINDING = { severity: "high", file: "src/a.js", line: 2, quote: "return x + 1;", problem: "off by one", evidence: "node -e 'console.log(require(\"./src/a.js\")(1))' prints 2, expected 1" };
const BLOCK = verdict({ verdict: "block", summary: "off by one", checks: [{ cmd: "node --test", ok: false, tail: "1 failing" }], findings: [FINDING] });
const APPROVE = verdict({ verdict: "approve", summary: "all good now", checks: [{ cmd: "node --test", ok: true, tail: "# pass 3" }], findings: [] });

// ---------- modes and timeouts ----------
test("reviewSettings: milestone is the default; turn, off, the old \"on\", per-mode timeouts", () => {
  const f = join(base, "policy-modes.json");
  const d = R.reviewSettings("/x/p", join(base, "missing.json"));
  assert.equal(d.mode, "milestone");
  assert.equal(d.timeout_ms, 15 * 60_000, "a turn review: 15 min");
  assert.equal(d.milestone_timeout_ms, 30 * 60_000, "a milestone review: 30 min");
  assert.equal(d.milestone_rounds, 3);
  writeFileSync(f, JSON.stringify({ default: { reviewer: { mode: "turn", milestone_timeout_ms: 1234 } }, projects: { old: { reviewer: { mode: "on" } }, quiet: { reviewer: { mode: "off" } }, odd: { reviewer: { mode: "sometimes", timeout_ms: -1 } } } }));
  assert.equal(R.reviewSettings("/x/p", f).mode, "turn");
  assert.equal(R.reviewSettings("/x/p", f).milestone_timeout_ms, 1234);
  assert.equal(R.reviewSettings("/x/old", f).mode, "turn", "\"on\" is the old name of turn mode");
  assert.equal(R.reviewSettings("/x/quiet", f).mode, "off");
  assert.equal(R.reviewSettings("/x/odd", f).mode, "milestone", "an unknown mode falls back to the default");
  assert.equal(R.reviewSettings("/x/odd", f).timeout_ms, 15 * 60_000);
  process.env.AXA_REVIEWER = "0";
  try { assert.equal(R.reviewSettings("/x/p", f).mode, "off"); } finally { delete process.env.AXA_REVIEWER; }
});

test("shouldReview by mode: milestone skips the per-turn review, turn unchanged, off", () => {
  const w = { id: "w", mode: "claude", alive: true, status: "done" }, run = { status: "done", edits: 2, prompt: "add x" };
  assert.equal(R.shouldReview(w, run, { settings: { ...R.DEFAULTS, mode: "milestone" } }).review, false);
  assert.equal(R.shouldReview(w, run, { settings: { ...R.DEFAULTS, mode: "turn" } }).review, true);
  assert.equal(R.shouldReview(w, run, { settings: { ...R.DEFAULTS, mode: "off" } }).review, false);
  R.setFixer("w", "m1");
  try { assert.equal(R.shouldReview(w, run, { settings: { ...R.DEFAULTS, mode: "turn" } }).review, false, "a fixer's turns are re-reviewed by its milestone review"); } finally { R.setFixer("w", null); }
});

test("milestone mode end to end: a worker's code-changing turn gets no model review, the commander the usual wake", async () => {
  const dir = repo(), callLog = join(base, "calls-mode.jsonl");
  process.env.FAKE_REVIEW_LOG = callLog;
  const sent = [];
  deps.send = async (id, text) => { sent.push({ id, text }); return { ok: true }; };
  deps.lastInputAt = () => 0; deps.log = () => {};
  const list = (status) => [{ id: "wm", name: "mode", mode: "claude", alive: true, status, cwd: dir, last_report: "done" }, { id: "c1", name: "axa", mode: "axa", alive: true, status: "ready" }];
  const tick = async (status) => { const l = list(status); trackReviews(l); supervise(l); await reviewsSettled(); await sleep(5); };
  await tick("ready");
  trackEvent({ event: "UserPromptSubmit", terminal: "wm", role: "worker", cwd: dir, prompt: "change f" });
  await tick("working");
  trackEvent({ event: "PreToolUse", terminal: "wm", role: "worker", tool: "Edit", summary: "src/a.js", tool_use_id: "e1" });
  appendFileSync(join(dir, "src/a.js"), "// edited\n");
  trackEvent({ event: "Stop", terminal: "wm", role: "worker", message: "done" });
  await tick("done"); await tick("done"); await tick("done");
  assert.equal(existsSync(callLog), false, "no reviewer ran");
  assert.match(sent.at(-1).text, /mode \(wm\) finished its turn\. Handle this/);
  delete process.env.FAKE_REVIEW_LOG;
});

// ---------- the base ----------
test("pickBase: fallback HEAD~20 (or the first commit), upstream merge-base, origin/<branch>, a stored milestone, a given base", () => {
  const many = repo(25);
  const b = M.pickBase(many);
  assert.equal(b.base, sha(many, "HEAD~20"));
  assert.match(b.why, /HEAD~20/);
  assert.equal(b.branch, "main");
  const few = repo(3);
  assert.equal(M.pickBase(few).base, sha(few, "HEAD~2"), "fewer than 21 commits: from the first one");
  assert.match(M.pickBase(repo(1)).why, /only commit/);

  // a clone with work on top of its upstream
  const origin = repo(3);
  const clone = join(base, `clone-${Date.now()}`);
  git(base, "clone", "-q", origin, clone);
  const forked = sha(clone);
  for (const n of [1, 2]) { appendFileSync(join(clone, "src/a.js"), `// local ${n}\n`); git(clone, "commit", "-qam", `local ${n}`); }
  const up = M.pickBase(clone);
  assert.equal(up.base, forked);
  assert.equal(up.why, "upstream merge-base");
  git(clone, "branch", "--unset-upstream");
  const og = M.pickBase(clone);
  assert.equal(og.base, forked);
  assert.match(og.why, /origin\/main/);

  // a stored milestone wins, if it is still an ancestor of HEAD
  const mid = sha(clone, "HEAD~1");
  M.recordMilestone(realpathSync(clone), "main", mid, "approve");
  const st = M.pickBase(clone);
  assert.deepEqual([st.base, st.why], [mid, "last milestone"]);
  M.recordMilestone(realpathSync(clone), "main", "0123456789abcdef0123456789abcdef01234567", "approve");
  assert.equal(M.pickBase(clone).why, og.why, "an unknown stored sha is ignored");
  assert.ok(JSON.parse(readFileSync(join(axaHome, "milestones.json"), "utf8"))[`${realpathSync(clone)}#main`].at > 0);

  // given
  assert.deepEqual([M.pickBase(clone, { base: forked.slice(0, 10) }).base, M.pickBase(clone, { base: "HEAD~2" }).why], [forked, "given"]);
  assert.throws(() => M.pickBase(clone, { base: "--output=/tmp/x" }), /commit/);
  assert.throws(() => M.pickBase(clone, { base: "nope-not-a-ref" }), /doesn't know/);
  assert.throws(() => M.pickBase(base), /isn't a git repository/);
});

// ---------- the range ----------
test("rangeDiff: the commits since base, the committed and uncommitted work, new files; no secret files", async () => {
  const dir = repo(), start = sha(dir);
  writeFileSync(join(dir, "src/b.js"), "export const committed = 1;\n");
  git(dir, "add", "."); git(dir, "commit", "-qm", "add b");
  writeFileSync(join(dir, ".env"), "TOKEN=1\n"); git(dir, "add", "-f", ".env"); git(dir, "commit", "-qm", "env");
  appendFileSync(join(dir, "src/a.js"), "// uncommitted edit\n");
  writeFileSync(join(dir, "new.txt"), "x");
  const r = await M.rangeDiff(dir, start);
  assert.deepEqual(r.commits.map((c) => c.replace(/^\w+ /, "")), ["env", "add b"]);
  assert.equal(r.commits_total, 2);
  assert.match(r.diff, /committed = 1/);
  assert.match(r.diff, /uncommitted edit/);
  assert.doesNotMatch(r.diff, /TOKEN/, "secret files are left out");
  assert.deepEqual(r.untracked, ["new.txt"]);
  assert.equal(r.partial, false);
  assert.equal(r.head, sha(dir));
  const p = M.milestonePrompt({ repo: dir, branch: "main", why: "given", range: r });
  assert.match(p, /as a whole/);
  assert.match(p, /does each commit do what its message says/);
  assert.match(p, /checks ONCE/);
  assert.match(p, /Commits \(2\):\n- \w+ env\n- \w+ add b/);
  assert.match(p, /<diff>[\s\S]*committed = 1[\s\S]*<\/diff>/);
  assert.match(p, /New files \(untracked, 1\): new\.txt/);
});

test("rangeDiff over budget: source files before tests, docs and fixtures; everything left out is listed", async () => {
  const dir = repo(), start = sha(dir);
  const big = (n) => Array.from({ length: n }, (_, i) => `line ${i} ${"y".repeat(60)}`).join("\n") + "\n";
  mkdirSync(join(dir, "test/fixtures"), { recursive: true }); mkdirSync(join(dir, "docs")); mkdirSync(join(dir, "lib"));
  // the tests, docs and fixtures change the most lines; the source files fewer
  writeFileSync(join(dir, "test/x.test.mjs"), big(500));
  writeFileSync(join(dir, "test/fixtures/data.mjs"), big(500));
  writeFileSync(join(dir, "docs/guide.md"), big(500));
  writeFileSync(join(dir, "README.md"), big(450));
  writeFileSync(join(dir, "src/logic.mjs"), big(300));
  writeFileSync(join(dir, "lib/util.mjs"), big(250));
  git(dir, "add", "."); git(dir, "commit", "-qm", "big");
  const r = await M.rangeDiff(dir, start);
  assert.equal(r.partial, true);
  assert.match(r.diff, /src\/logic\.mjs/);
  assert.match(r.diff, /lib\/util\.mjs/);
  assert.ok(r.left_out.length > 0);
  for (const f of r.left_out) assert.ok(!["src/logic.mjs", "lib/util.mjs"].includes(f), `${f}: a source file is never left out for a test or a doc`);
  const shown = ["test/x.test.mjs", "test/fixtures/data.mjs", "docs/guide.md", "README.md", "src/logic.mjs", "lib/util.mjs"].filter((f) => !r.left_out.includes(f));
  assert.equal(shown.length + r.left_out.length, 6, "each file is either inlined or listed as left out");
  assert.deepEqual([M.weight({ file: "src/a.mjs" }), M.weight({ file: "hooks/h.mjs" }), M.weight({ file: "scripts/s.sh" }), M.weight({ file: "test/a.test.mjs" }), M.weight({ file: "test/fixtures/f.mjs" }), M.weight({ file: "README.md" }), M.weight({ file: "package-lock.json" })], [4, 4, 3, 2, 1, 1, 0]);
  const p = M.milestonePrompt({ repo: dir, branch: "main", why: "given", range: r });
  assert.match(p, new RegExp(`Not included below: ${r.left_out.map((f) => f.replace(/[.]/g, "\\.")).join(", ")}`));
});

test("rangeDiff: over ~150 KB, per-file stats and the important files' diffs; lockfiles left for the reviewer", async () => {
  const dir = repo(), start = sha(dir);
  const big = (n) => Array.from({ length: n }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n") + "\n";
  writeFileSync(join(dir, "package-lock.json"), big(2500));
  for (const n of [1, 2, 3]) writeFileSync(join(dir, `src/m${n}.js`), big(400 * n));
  git(dir, "add", "."); git(dir, "commit", "-qm", "big");
  const r = await M.rangeDiff(dir, start);
  assert.equal(r.partial, true);
  assert.ok(r.diff.length <= 120 * 1024);
  assert.ok(r.left_out.includes("package-lock.json"));
  assert.match(r.diff, /src\/m\d\.js/);
  assert.ok(r.stats.some((s) => s.file === "package-lock.json" && s.added === 2500));
  const p = M.milestonePrompt({ repo: dir, branch: "main", why: "given", range: r });
  assert.match(p, /per-file stats/);
  assert.match(p, /package-lock\.json \+2500/);
  assert.match(p, /Not included below: .*package-lock\.json/);
});

// ---------- progress and timeouts ----------
test("runReviewer: streamed progress, and a timeout says how far it got", async () => {
  const dir = repo(), seen = [];
  const r = await R.runReviewer({ cwd: dir, prompt: "p", env: { ...process.env, FAKE_REVIEW_MODE: "stream", FAKE_REVIEW: APPROVE }, onProgress: (p) => seen.push(p) });
  assert.equal(r.verdict, "approve", "the verdict is the stream's result line");
  assert.deepEqual(seen, ["checks running: npm test"]);
  const hung = await R.runReviewer({ cwd: dir, prompt: "p", settings: { ...R.DEFAULTS, timeout_ms: 400 }, env: { ...process.env, FAKE_REVIEW_MODE: "stream-hang" } });
  assert.equal(hung.verdict, "error");
  assert.match(hung.summary, /timed out after 1 min \(got as far as: checks running: npm test, 1 step\)/);
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const gone = async (pid) => { for (let i = 0; i < 100 && alive(pid); i++) await sleep(50); return !alive(pid); };
for (const [mode, detached] of [["hang", "0"], ["stream-hang", "0"], ["hang", "1"]]) {
  test(`runReviewer timeout (${mode}${detached === "1" ? ", the check in its own process group" : ""}): the reviewer and the processes it started are gone`, { skip: process.platform === "win32" }, async () => {
    const dir = repo(), pids = join(base, `pids-${mode}-${detached}.json`);
    const t0 = Date.now();
    const r = await R.runReviewer({ cwd: dir, prompt: "p", settings: { ...R.DEFAULTS, timeout_ms: 600 }, env: { ...process.env, FAKE_REVIEW_MODE: mode, FAKE_REVIEW_PIDS: pids, FAKE_REVIEW_CHILD_DETACHED: detached } });
    assert.ok(Date.now() - t0 < 5000, "ended at its limit");
    assert.equal(r.verdict, "error");
    assert.match(r.summary, /timed out after \d+ min \(got as far as: /);
    const { pid, child } = JSON.parse(readFileSync(pids, "utf8"));
    assert.ok(await gone(pid), "the reviewer is gone");
    assert.ok(await gone(child), "the check it started is gone");
  });
}

// ---------- the verifier <-> fixer loop ----------
// The fake fixer: a session the test opens, drives (status) and makes commit, like a real one would
function harness() {
  const h = { sent: [], opened: [], closed: [], logged: [], fixer: null };
  deps.send = async (id, text) => { h.sent.push({ id, text }); return { ok: true }; };
  deps.lastInputAt = () => 0; deps.log = () => {};
  M.mdeps.open = async ({ cwd, name }) => { h.opened.push({ cwd, name }); return { id: "fx1", name }; };
  M.mdeps.close = (id) => h.closed.push(id);
  M.mdeps.log = (e) => h.logged.push(e);
  h.cmd = { id: "c1", name: "axa", mode: "axa", alive: true, status: "ready" };
  // one tick of the daemon: the supervisor (commander wakes) and the milestone loop
  h.tick = async (fixerStatus, extra = {}) => {
    const list = [h.cmd, ...(fixerStatus ? [{ id: "fx1", name: "fixer", mode: "claude", alive: true, status: fixerStatus, cwd: h.dir, ...extra }] : [])];
    M.tickMilestones(list); supervise(list);
    await M.milestonesSettled(); await M.milestonesSettled(); // the send to the fixer, then a re-review it starts
  };
  h.toFixer = () => h.sent.filter((m) => m.id === "fx1");
  h.toCommander = () => h.sent.filter((m) => m.id === "c1");
  // the fixer takes the instruction, commits a fix, finishes
  h.fixRound = async (n) => {
    await h.tick("ready");
    await h.tick("working");
    writeFileSync(join(h.dir, "src/a.js"), ["module.exports = function (x) {", `  return x + 1; // round ${n}`, "};", ""].join("\n"));
    git(h.dir, "commit", "-qam", `Fix review findings: off by one (${n})`);
    await h.tick("done", { last_event_at: Date.now() });
    await sleep(3);
    await h.tick("done", { last_event_at: Date.now() });
  };
  return h;
}

test("block -> fixer -> re-review approve: milestone recorded, fixer closed, commander told with the fix commits", async () => {
  const h = harness(), dir = (h.dir = repo(3)), callLog = join(base, "calls-loop.jsonl");
  process.env.FAKE_REVIEW_LOG = callLog;
  await h.tick(null); // the supervisor's first pass only learns the states
  process.env.FAKE_REVIEW = BLOCK;
  const started = M.startMilestone({ cwd: dir, goal: "the off-by-one fix" });
  assert.equal(started.state, "reviewing");
  assert.equal(started.base, sha(dir, "HEAD~2"));
  assert.equal(M.startMilestone({ cwd: dir }).already, true, "one review per repo and branch at a time");
  await M.milestonesSettled();
  let r = M.getMilestoneReview(started.id);
  assert.deepEqual([r.state, r.round, r.verdict], ["fixer-starting", 1, "block"]);
  assert.deepEqual(h.opened, [{ cwd: realpathSync(dir), name: "fixer" }]);
  assert.equal(R.fixerOf("fx1"), started.id, "the session is labelled as this review's fixer");

  process.env.FAKE_REVIEW = APPROVE;
  await h.fixRound(1);
  assert.equal(h.toFixer().length, 1, "one instruction to the fixer");
  const ins = h.toFixer()[0].text;
  assert.ok(ins.startsWith(M.FIX_PREFIX));
  assert.match(ins, /Fix exactly these: \(1\) src\/a\.js:2 \[high\] off by one \| quote: return x \+ 1; \| evidence: node -e/);
  assert.match(ins, /commit locally with the message "Fix review findings: off by one"/);
  assert.match(ins, /never push/);

  r = M.getMilestoneReview(started.id);
  assert.deepEqual([r.state, r.verdict, r.round], ["done", "approve", 1]);
  const calls = readFileSync(callLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls.length, 2, "the review and one re-review");
  assert.equal(calls[1].role, "reviewer");
  assert.match(calls[1].prompt, /This is re-review 1/);
  assert.match(calls[1].prompt, /<previous_findings>\n\(1\) src\/a\.js:2 \[high\] off by one/);
  assert.match(calls[1].prompt, new RegExp(`${sha(dir, "HEAD~3").slice(0, 12)}\\.\\.${sha(dir).slice(0, 12)}`), "same base, new HEAD");
  assert.match(calls[0].prompt, /<goal>\nthe off-by-one fix\n<\/goal>/);

  // recorded, closed, told
  const stored = JSON.parse(readFileSync(join(axaHome, "milestones.json"), "utf8"))[`${realpathSync(dir)}#main`];
  assert.deepEqual([stored.sha, stored.verdict], [sha(dir), "approve"]);
  assert.deepEqual(h.closed, ["fx1"]);
  assert.equal(R.fixerOf("fx1"), null);
  assert.equal(r.fix_commits.length, 1);
  assert.ok(sha(dir).startsWith(r.fix_commits[0]), "the fixer's commit");
  await h.tick(null);
  const wake = h.toCommander().at(-1)?.text || "";
  assert.match(wake, new RegExp(`milestone review repo-\\w+: ✓ approve · all good now · fix commits: ${r.fix_commits[0]}`));
  assert.ok(!h.toCommander().some((m) => /fixer \(fx1\) finished its turn/.test(m.text)), "the fixer's turns don't wake the commander");
  assert.ok(h.logged.some((e) => e.event === "MilestoneReview" && /milestone review .*fix round 1/.test(e.summary)));

  // the next review starts from the milestone; nothing new: no model run
  const next = M.startMilestone({ cwd: dir });
  assert.deepEqual([next.base, next.base_why], [sha(dir), "last milestone"]);
  await M.milestonesSettled();
  assert.match(M.getMilestoneReview(next.id).summary, /nothing changed/);
  assert.equal(readFileSync(callLog, "utf8").trim().split("\n").length, 2);
  delete process.env.FAKE_REVIEW_LOG;
});

test("block x3: three fix rounds that still block -> the commander gets what's still open; no milestone", async () => {
  const h = harness(), dir = (h.dir = repo(2));
  process.env.FAKE_REVIEW = BLOCK;
  const { id } = M.startMilestone({ cwd: dir });
  await M.milestonesSettled();
  for (const n of [1, 2, 3]) {
    assert.equal(M.getMilestoneReview(id).round, n);
    await h.fixRound(n);
  }
  const r = M.getMilestoneReview(id);
  assert.deepEqual([r.state, r.verdict, r.round], ["done", "block", 3]);
  assert.equal(h.opened.length, 1, "one fixer session for all rounds");
  assert.equal(h.toFixer().length, 3, "three instructions");
  assert.deepEqual(r.history.map((x) => x.verdict), ["block", "block", "block", "block"], "the review and three re-reviews");
  assert.deepEqual(h.closed, [], "the fixer stays open for the commander");
  assert.equal(R.fixerOf("fx1"), null, "and is an ordinary session again");
  await h.tick(null);
  assert.match(h.toCommander().at(-1).text, /milestone review repo-\w+: ✗ block after 3 fix rounds, still open: src\/a\.js:2 off by one .*the fixer session \(fx1\) is still open/);
  assert.equal(JSON.parse(readFileSync(join(axaHome, "milestones.json"), "utf8"))[`${realpathSync(dir)}#main`], undefined);
});

test("only an approve records a milestone: a warn keeps the base (its findings stay in the next range); an error never records", async () => {
  const h = harness(), dir = (h.dir = repo(3)), key = `${realpathSync(dir)}#main`;
  const stored = () => JSON.parse(existsSync(join(axaHome, "milestones.json")) ? readFileSync(join(axaHome, "milestones.json"), "utf8") : "{}")[key];
  const first = M.pickBase(dir).base;
  process.env.FAKE_REVIEW = verdict({ verdict: "warn", summary: "naming could be better", checks: [], findings: [{ ...FINDING, severity: "med", problem: "naming" }] });
  const a = M.startMilestone({ cwd: dir });
  await M.milestonesSettled();
  assert.deepEqual([M.getMilestoneReview(a.id).state, M.getMilestoneReview(a.id).verdict], ["done", "warn"]);
  assert.equal(stored(), undefined, "a warn is not a milestone");
  assert.equal(M.pickBase(dir).base, first, "the next review covers the warned code again");
  assert.deepEqual(h.opened, [], "no fixer for a warn without high findings");
  process.env.FAKE_REVIEW_MODE = "crash";
  try { const b = M.startMilestone({ cwd: dir }); await M.milestonesSettled(); assert.equal(M.getMilestoneReview(b.id).verdict, "error"); }
  finally { delete process.env.FAKE_REVIEW_MODE; }
  assert.equal(stored(), undefined, "an error is not a milestone");
  process.env.FAKE_REVIEW = APPROVE;
  const c = M.startMilestone({ cwd: dir });
  await M.milestonesSettled();
  assert.deepEqual([stored().sha, stored().verdict, M.getMilestoneReview(c.id).verdict], [sha(dir), "approve", "approve"]);
  assert.equal(M.pickBase(dir).why, "last milestone");
  // axa review --reset-milestone: forget it
  const before = stored();
  assert.deepEqual(M.forgetMilestone(dir), { key, removed: before });
  assert.equal(stored(), undefined);
  assert.equal(M.forgetMilestone(dir).removed, null, "nothing stored: nothing removed");
  assert.equal(M.pickBase(dir).base, first);
  assert.throws(() => M.forgetMilestone(base), /isn't a git repository/);
});

test("decide is awaited: a fixer that can't be opened ends the review as failed, seen by milestonesSettled", async () => {
  const h = harness(), dir = (h.dir = repo(2));
  M.mdeps.open = async () => { await new Promise((ok) => setTimeout(ok, 20)); throw new Error("no room for a session"); };
  process.env.FAKE_REVIEW = BLOCK;
  const { id } = M.startMilestone({ cwd: dir });
  await M.milestonesSettled();
  const r = M.getMilestoneReview(id);
  assert.deepEqual([r.state, r.verdict], ["failed", "block"]);
  assert.match(r.line, /the fixer couldn't be opened \(no room for a session\)/);
  await h.tick(null);
  assert.ok(h.toCommander().some((m) => /fixer couldn't be opened/.test(m.text)));
});

test("a warn with a confirmed high finding goes to the fixer too; a reviewer error goes to the commander", async () => {
  const h = harness(), dir = (h.dir = repo(2));
  process.env.FAKE_REVIEW = verdict({ verdict: "warn", summary: "mostly fine", checks: [], findings: [FINDING, { ...FINDING, severity: "med", problem: "naming" }] });
  const a = M.startMilestone({ cwd: dir });
  await M.milestonesSettled();
  assert.equal(M.getMilestoneReview(a.id).state, "fixer-starting");
  await h.tick("ready");
  assert.match(h.toFixer().at(-1).text, /\(1\) src\/a\.js:2 \[high\] off by one/);
  assert.doesNotMatch(h.toFixer().at(-1).text, /naming/, "only the confirmed high findings");

  const other = repo(2);
  process.env.FAKE_REVIEW_MODE = "crash";
  try {
    const b = M.startMilestone({ cwd: other });
    await M.milestonesSettled();
    assert.deepEqual([M.getMilestoneReview(b.id).state, M.getMilestoneReview(b.id).verdict], ["failed", "error"]);
  } finally { delete process.env.FAKE_REVIEW_MODE; }
  await h.tick(null);
  assert.ok(h.toCommander().some((m) => /milestone review repo-\w+: \? error: .*not reviewed/.test(m.text)));
  // the reviewer off: no milestone review either
  writeFileSync(join(axaHome, "policy.json"), JSON.stringify({ default: { reviewer: { mode: "off" } } }));
  try { assert.throws(() => M.startMilestone({ cwd: repo() }), /reviewer is off/); } finally { rmSync(join(axaHome, "policy.json")); }
});
