// Part B of docs/tasks/briefing.md: the projects review, against temp git repos (ahead/behind, dirty,
// worktrees, handoff parsing), its text for the commander's review_projects and `axa projects`, and the
// daily brief. Temp folders only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-projects-test-")));
process.env.HOME = join(base, "home");
process.env.AXA_HOME = join(base, "axahome");
mkdirSync(process.env.HOME, { recursive: true });
const P = await import("../src/core/projects.mjs");

const git = (cwd, ...a) => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8", env: { ...process.env, ...gitDate } }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
let gitDate = {};
// a remote, a clone with 2 commits ahead and 1 behind, 2 uncommitted files, a worktree
function project() {
  const dir = mkdtempSync(join(base, "p-")), remote = join(dir, "remote.git"), work = join(dir, "feed"), other = join(dir, "other");
  git(dir, "init", "-q", "--bare", remote);
  git(dir, "clone", "-q", remote, work);
  writeFileSync(join(work, "a.txt"), "a\n"); git(work, "add", "."); git(work, "commit", "-qm", "first"); git(work, "push", "-q", "origin", "HEAD:main");
  git(work, "branch", "-q", "--set-upstream-to=origin/main");
  git(dir, "clone", "-q", remote, other);
  appendFileSync(join(other, "a.txt"), "b\n"); git(other, "commit", "-qam", "theirs"); git(other, "push", "-q", "origin", "HEAD:main");
  git(work, "fetch", "-q");
  for (const m of ["one", "two: fix login"]) { appendFileSync(join(work, "a.txt"), m + "\n"); git(work, "commit", "-qam", m); }
  writeFileSync(join(work, "new.txt"), "x"); appendFileSync(join(work, "a.txt"), "dirty\n");
  git(work, "worktree", "add", "-q", "-b", "axa/try", join(dir, "wt"));
  return work;
}

test("git facts: branch, ahead/behind, uncommitted, last commit, commits today, worktrees", async () => {
  const work = project();
  const g = await P.gitFacts(work);
  assert.equal(g.branch, "main");
  assert.deepEqual([g.upstream, g.ahead, g.behind, g.dirty], [true, 2, 1, 2]);
  assert.equal(g.last_commit.subject, "two: fix login");
  assert.ok(Date.now() - g.last_commit.at < 60_000);
  assert.equal(g.commits_24h, 3);
  assert.deepEqual(g.worktrees.map((w) => w.branch), ["axa/try"]);
  assert.equal(await P.gitFacts(mkdtempSync(join(base, "plain-"))), null);
});

const HANDOFF = `# Handoff

## Done
- shipped the feed

## In progress
- **Login** rewrite (\`src/auth.ts\`)
  - a detail that isn't an item

## Next up
1. Fix the [flaky test](https://x/y)
2. Add pagination
### Notes for next up
- [ ] dark mode
- e
- f
- g
- h
- i
- j (the ninth: left out)

## Later
- not next
`;
test("the handoff file: Next up and In progress, first 8 items, plain text", () => {
  const h = P.parseHandoff(HANDOFF);
  assert.deepEqual(h.in_progress, ["Login rewrite (src/auth.ts)"]);
  assert.deepEqual(h.next, ["Fix the flaky test", "Add pagination", "dark mode", "e", "f", "g", "h", "i"]);
  assert.deepEqual(P.parseHandoff("# Nothing here\n- x"), { next: [], in_progress: [] });
  const dir = mkdtempSync(join(base, "h-"));
  assert.equal(P.readHandoff(dir), null);
  writeFileSync(join(dir, "TODO.md"), "## Next steps\n- todo item\n");
  assert.deepEqual(P.readHandoff(dir), { file: "TODO.md", next: ["todo item"], in_progress: [] });
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "HANDOFF.md"), HANDOFF);
  assert.equal(P.readHandoff(dir).file, "docs/HANDOFF.md", "docs/HANDOFF.md first");
});

test("a project's review: sessions there, its last milestone review, idle time; cached 60 s", async () => {
  const work = project();
  mkdirSync(join(work, "docs")); writeFileSync(join(work, "docs", "HANDOFF.md"), HANDOFF);
  const sessions = [
    { id: "s1", name: "feed", mode: "claude", alive: true, status: "waiting", cwd: work, doing: "needs approval · Bash" },
    { id: "s2", name: "wt", mode: "claude", alive: true, status: "working", cwd: "/elsewhere", worktree: { repo: work } },
    { id: "s3", name: "x", mode: "claude", alive: true, status: "ready", cwd: "/other" },
    { id: "c", name: "AXA", mode: "axa", alive: true, status: "ready", cwd: work },
  ];
  const stored = { [`${work}#main`]: { sha: "abc", at: Date.now() - 3 * 86_400_000, verdict: "approve" } };
  const [r] = await P.reviewProjects({ projects: [{ name: "feed", path: work }], sessions, stored, fresh: true });
  for (const k of ["name", "path", "git", "sessions", "milestone", "handoff", "idle_days"]) assert.ok(k in r, k);
  assert.deepEqual(r.sessions.map((s) => [s.id, s.status]), [["s1", "waiting"], ["s2", "working"]]);
  assert.deepEqual([r.milestone.verdict, r.milestone.branch], ["approve", "main"]);
  assert.equal(r.idle_days, 0);
  assert.equal(r.handoff.next[0], "Fix the flaky test");
  // a review that ran since the daemon started wins over the stored milestone
  const [r2] = await P.reviewProjects({ projects: [{ name: "feed", path: work }], sessions, stored, reviews: [{ repo: work, state: "done", verdict: "warn", ended: Date.now(), branch: "main" }], fresh: true });
  assert.equal(r2.milestone.verdict, "warn");
  // cached: a new commit isn't seen for 60 s, sessions are always fresh
  git(work, "commit", "-qam", "three");
  const [c] = await P.reviewProjects({ projects: [{ name: "feed", path: work }], sessions: [] });
  assert.equal(c.git.last_commit.subject, "two: fix login");
  assert.deepEqual(c.sessions, []);
  const [f] = await P.reviewProjects({ projects: [{ name: "feed", path: work }], sessions: [], fresh: true });
  assert.equal(f.git.last_commit.subject, "three");
});

test("review_projects text: one block per project, idle ones marked", async () => {
  const dir = mkdtempSync(join(base, "old-"));
  gitDate = { GIT_AUTHOR_DATE: "2026-10-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T10:00:00Z" };
  git(dir, "init", "-q"); writeFileSync(join(dir, "a"), "a"); git(dir, "add", "."); git(dir, "commit", "-qm", "old work");
  gitDate = {};
  const now = Date.parse("2026-11-19T10:00:00Z");
  const [r] = await P.reviewProjects({ projects: [{ name: "old", path: dir }], fresh: true, now });
  const t = P.projectsText([r], now);
  assert.match(t, /^old \(.+\) · idle 7 weeks$/m);
  assert.match(t, /git: main \(no upstream\); last commit 7 weeks ago: old work/);
  assert.match(t, /sessions: none open/);
  assert.equal(P.projectsText([]), "No projects found (the roster, ~/projects, and git repos in your home folder).");
  const work = project();
  mkdirSync(join(work, "docs")); writeFileSync(join(work, "docs", "HANDOFF.md"), HANDOFF);
  const [w] = await P.reviewProjects({ projects: [{ name: "feed", path: work }], fresh: true, sessions: [{ id: "s1", name: "feed", mode: "claude", alive: true, status: "working", cwd: work, doing: "tests" }] });
  const wt = P.projectText(w);
  // (3 uncommitted: the handoff file written above is new too)
  assert.match(wt, /git: main \(2 ahead, 1 behind\), 3 uncommitted, 1 worktree; last commit \d+ min ago: two: fix login; 3 commits in the last day/);
  assert.match(wt, /sessions: \[s1\] feed working \(tests\)/);
  assert.match(wt, /in progress \(docs\/HANDOFF\.md\): Login rewrite/);
  assert.match(wt, /next up \(docs\/HANDOFF\.md\): Fix the flaky test \| Add pagination/);
  assert.equal(P.ageText(90_000), "2 min");
  assert.equal(P.ageText(3 * 86_400_000), "3 days");
  assert.equal(P.ageText(120 * 86_400_000), "4 months");
});

test("the commander has a review_projects tool", async () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const tools = await new Promise((ok, fail) => {
    const p = spawn(process.execPath, [join(ROOT, "mcp", "axa-terminals.mjs")], { env: { PATH: process.env.PATH, HOME: process.env.HOME, AXA_HOME: process.env.AXA_HOME, AXA_PORT: "4857", AXA_ROLE: "commander" } });
    let out = "";
    const t = setTimeout(() => { p.kill(); fail(new Error(out)); }, 10_000);
    p.stdout.on("data", (d) => { out += d; const m = out.split("\n").slice(0, -1).map((l) => JSON.parse(l)).find((x) => x.id === 2); if (m) { clearTimeout(t); p.kill(); ok(m.result.tools); } });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  });
  const rp = tools.find((t) => t.name === "review_projects");
  assert.ok(rp);
  assert.match(rp.description, /Next up/);
});

test("the daily brief: due once a day after its time; what changed, what waits, what's next", () => {
  const day = new Date(2026, 10, 23, 8, 59).getTime(), nine = new Date(2026, 10, 23, 9, 0).getTime();
  assert.equal(P.briefDue(null, nine, 0), false);
  assert.equal(P.briefDue("09:00", day, 0), false);
  assert.equal(P.briefDue("09:00", nine + 1000, 0), true);
  assert.equal(P.briefDue("09:00", nine + 5000, nine + 1000), false, "once a day");
  assert.equal(P.briefDue("09:00", nine + 86_400_000, nine + 1000), true, "the next day");
  const list = [
    { name: "feed", git: { commits_24h: 3, dirty: 1 }, sessions: [{ name: "feed", status: "waiting" }], handoff: { next: ["Add pagination"], in_progress: [] } },
    { name: "old", git: { commits_24h: 0, dirty: 0 }, sessions: [], handoff: null },
  ];
  assert.equal(P.briefText(list), "Since yesterday: feed: 3 new commits, 1 uncommitted. Waiting on you: feed (feed) waiting. Next up: feed: Add pagination.");
  assert.equal(P.briefText([list[1]]), "Nothing changed since yesterday. Nothing is waiting on you.");
});
