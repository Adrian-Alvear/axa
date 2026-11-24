// Part 2 of docs/tasks/landscape-build.md: the review queue (finished work waiting for you) and the worker cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-queue-")));
process.env.AXA_HOME = join(base, "axahome");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = (f) => readFileSync(join(ROOT, f), "utf8");
const Q = await import("../src/core/queue.mjs");
const g = (cwd, ...a) => { const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout; };

test("checks: the session's last check command, pass or fail, from the hook log", () => {
  const c = Q.createCheckTracker();
  c.event({ event: "PreToolUse", tool: "Bash", tool_use_id: "a", terminal: "f", command: "npm run check" });
  c.event({ event: "PostToolUse", tool_use_id: "a", terminal: "f", ts: 5 });
  assert.deepEqual(c.of("f"), { ok: true, cmd: "npm run check", at: 5 });
  c.event({ event: "PreToolUse", tool: "Bash", tool_use_id: "b", terminal: "f", command: "pytest -q" });
  c.event({ event: "PostToolUseFailure", tool_use_id: "b", terminal: "f", ts: 9 });
  assert.equal(c.of("f").ok, false);
  c.event({ event: "PreToolUse", tool: "Bash", tool_use_id: "x", terminal: "f", command: "git status" });
  c.event({ event: "PostToolUse", tool_use_id: "x", terminal: "f", ts: 10 });
  assert.equal(c.of("f").cmd, "pytest -q", "not a check: ignored");
  assert.equal(c.of("other"), null);
  for (const cmd of ["npm test", "pnpm run typecheck", "node \"$CLAUDE_PLUGIN_ROOT/skills/verify/verify.mjs\" .", "cargo test", "go test ./...", "node --test"]) assert.ok(Q.CHECK_RE.test(cmd), cmd);
});

test("a branch's unlanded work: commits not on its upstream (or main), diff size, uncommitted", () => {
  const repo = join(base, "repo"), remote = join(base, "remote.git");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "a.txt"), "1\n"); g(repo, "add", "-A"); g(repo, "commit", "-qm", "init");
  g(base, "init", "-q", "--bare", remote); g(repo, "remote", "add", "origin", remote); g(repo, "push", "-q", "-u", "origin", "main");
  writeFileSync(join(repo, "a.txt"), "1\n2\n3\n"); g(repo, "commit", "-qam", "more lines");
  writeFileSync(join(repo, "b.txt"), "new\n"); g(repo, "add", "-A"); g(repo, "commit", "-qm", "add b");
  let f = Q.branchFacts(repo);
  assert.equal(f.branch, "main"); assert.equal(f.base, "origin/main");
  assert.equal(f.commits.length, 2); assert.match(f.commits[0], /add b$/);
  assert.deepEqual([f.files, f.added, f.removed, f.uncommitted], [2, 3, 0, 0]);
  writeFileSync(join(repo, "a.txt"), "1\n2\n"); // uncommitted
  f = Q.branchFacts(repo);
  assert.equal(f.uncommitted, 1); assert.equal(f.removed, 1);
  // a branch without an upstream is compared with main
  g(repo, "checkout", "-q", "-b", "feature"); g(repo, "commit", "-qam", "feature work");
  f = Q.branchFacts(repo);
  assert.equal(f.base, "main"); assert.equal(f.commits.length, 1);
});

test("the queue: ready to land = commits, checks pass, reviewer approved, nothing uncommitted; ready ones first", () => {
  const s = (id) => ({ id, name: id, status: "done" });
  const facts = { branch: "feat", base: "main", commits: ["abc add x", "def fix y"], files: 3, added: 40, removed: 5, uncommitted: 0 };
  const ok = { ok: true, cmd: "npm test" };
  const ready = Q.queueRow(s("feed"), facts, ok, "approve");
  assert.equal(ready.ready, true); assert.equal(ready.why, "ready to land"); assert.equal(ready.checks, "pass");
  assert.equal(Q.queueRow(s("a"), facts, { ok: false }, "approve").why, "checks failed");
  assert.equal(Q.queueRow(s("a"), facts, null, null).why, "no checks run, not reviewed");
  assert.equal(Q.queueRow(s("a"), { ...facts, uncommitted: 2 }, ok, "approve").why, "2 file(s) uncommitted");
  assert.equal(Q.queueRow(s("a"), facts, ok, "warn").why, "reviewer: warn");
  assert.equal(Q.queueRow(s("a"), { ...facts, commits: [], uncommitted: 0 }, ok, "approve"), null, "nothing to land");
  const rows = Q.sortQueue([Q.queueRow(s("api"), facts, null, null), ready, null]);
  assert.deepEqual(rows.map((r) => r.name), ["feed", "api"]);
  assert.match(Q.queueText(rows), /^✓ READY feed on feat \(vs main\): 2 commits, 3 files \+40 -5; checks pass, reviewer approve\n· api on feat/);
  assert.equal(Q.queueText([]), "Nothing waiting for review: no session has unlanded work.");
});

test("the worker cap: at most sessions.maxWorking working; past it a send is refused, or queued until a slot frees", async () => {
  assert.equal(Q.maxWorking({}), 5); assert.equal(Q.maxWorking({ sessions: { maxWorking: 3 } }), 3); assert.equal(Q.maxWorking({ sessions: { maxWorking: 0 } }), 5);
  const w = (id, status = "working", mode = "claude") => ({ id, name: id, status, mode, alive: true });
  const ss = [w("a"), w("b"), w("c", "ready"), w("axa", "working", "axa")];
  assert.equal(Q.capRefusal(ss, "c", 3), null, "2 working (the commander doesn't count)");
  assert.match(Q.capRefusal(ss, "c", 2), /^Not sent: 2 sessions are already working \(the cap is 2/);
  assert.equal(Q.capRefusal(ss, "a", 2), null, "already working: no new slot");
  const sent = [];
  const q = Q.createSendQueue({ send: async (it) => sent.push(it.text) });
  assert.equal(q.add({ id: "c", text: "/goal do the thing" }), 1);
  await q.tick(ss, 2);
  assert.deepEqual(sent, [], "still full");
  ss[0].status = "done";
  await q.tick(ss, 2);
  assert.deepEqual(sent, ["/goal do the thing"]);
  assert.equal(q.list().length, 0);
});

test("wiring: the daemon refuses the commander's send over the cap (not yours), /api/queue, review_queue, axa queue, hub L", () => {
  const s = src("src/core/server.mjs");
  assert.match(s, /if \(!fromUser\(req\)\) \{\n\s*const no = capRefusal\(S\.listSessions\(\), m\[1\], maxWorking\(uiCfg\(\)\)\);/);
  assert.match(s, /\["GET", \/\^\\\/api\\\/queue\$\/, \(\) => \[200, reviewQueue\(\)\]\]/);
  const mcp = src("mcp/axa-terminals.mjs");
  assert.match(mcp, /name: "review_queue"/);
  assert.match(mcp, /body: \{ text: `\/goal \$\{text\}`, queue: queue === true \}/);
  assert.match(src("bin/axa"), /case "queue": \{/);
  assert.match(src("src/tui/app.mjs"), /case "L": return openQueue\(\);/);
});
