// GitHub status (console/github.mjs) with a fake `gh` on PATH: never the real gh or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksOf, prOf, ciOf, createGithub, GH_MS } from "../console/github.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A fake gh: logs its arguments, answers from files in its folder (auth.ok decides `auth status`)
function fakeGh({ authed = true, pr, runs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "axa-gh-"));
  writeFileSync(join(dir, "pr.json"), JSON.stringify(pr ?? null));
  writeFileSync(join(dir, "runs.json"), JSON.stringify(runs ?? []));
  writeFileSync(join(dir, "gh"), `#!/bin/sh
echo "$@" >> "${dir}/calls.log"
case "$1 $2" in
  "auth status") ${authed ? "exit 0" : "echo 'not logged in' >&2; exit 1"} ;;
  "pr view") if [ "$(cat "${dir}/pr.json")" = "null" ]; then echo 'no pull requests found' >&2; exit 1; fi; cat "${dir}/pr.json" ;;
  "run list") cat "${dir}/runs.json" ;;
  *) echo "unexpected gh call" >&2; exit 2 ;;
esac
`);
  chmodSync(join(dir, "gh"), 0o755);
  return { dir, calls: () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : []), done: () => rmSync(dir, { recursive: true, force: true }) };
}
async function withPath(dir, fn) {
  const old = process.env.PATH;
  process.env.PATH = `${dir}:${old}`;
  try { return await fn(); } finally { process.env.PATH = old; }
}
const settle = async (g) => { for (let i = 0; i < 100 && !g.idle(); i++) await sleep(20); };

test("checksOf: failing beats pending beats passing; none = null", () => {
  assert.equal(checksOf([]), null);
  assert.equal(checksOf(undefined), null);
  assert.equal(checksOf([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }]), "passing");
  assert.equal(checksOf([{ status: "IN_PROGRESS", conclusion: "" }, { status: "COMPLETED", conclusion: "SUCCESS" }]), "pending");
  assert.equal(checksOf([{ state: "PENDING" }]), "pending");
  assert.equal(checksOf([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]), "failing");
  assert.equal(checksOf([{ state: "ERROR" }]), "failing");
});

test("prOf / ciOf shape gh's JSON", () => {
  assert.deepEqual(prOf({ number: 12, state: "OPEN", url: "https://github.com/o/r/pull/12", isDraft: false, reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [{ state: "SUCCESS" }] }),
    { number: 12, state: "open", url: "https://github.com/o/r/pull/12", draft: false, review: "changes_requested", checks: "passing" });
  assert.equal(prOf(null), null);
  assert.deepEqual(ciOf([{ status: "completed", conclusion: "failure", name: "CI", url: "u", headBranch: "b" }]), { status: "completed", conclusion: "failure", name: "CI", url: "u" });
  assert.equal(ciOf([]), null);
});

test("authenticated: PR and CI cached per folder+branch, refreshed in the background, read-only calls only", async () => {
  const gh = fakeGh({ pr: { number: 7, state: "OPEN", url: "u7", isDraft: true, reviewDecision: "", statusCheckRollup: [{ state: "FAILURE" }] }, runs: [{ status: "in_progress", conclusion: "", name: "test", url: "r1" }] });
  const clock = { now: 1_000_000 };
  const g = createGithub({ enabled: true, now: () => clock.now });
  await withPath(gh.dir, async () => {
    assert.equal(g.githubOf(gh.dir, "feat/x"), null); // first ask: checks auth, never waits
    await settle(g);
    assert.equal(g.githubOf(gh.dir, "feat/x"), null); // now authed: refresh queued
    await settle(g);
    assert.deepEqual(g.githubOf(gh.dir, "feat/x"), { pr: { number: 7, state: "open", url: "u7", draft: true, review: null, checks: "failing" }, ci: { status: "in_progress", conclusion: null, name: "test", url: "r1" } });
    const n = gh.calls().length;
    g.githubOf(gh.dir, "feat/x"); await settle(g);
    assert.equal(gh.calls().length, n); // cached for GH_MS
    clock.now += GH_MS; g.githubOf(gh.dir, "feat/x"); await settle(g);
    assert.equal(gh.calls().length, n + 2);
  });
  assert.deepEqual(gh.calls().map((c) => c.split(" ").slice(0, 2).join(" ")).sort().filter((c, i, a) => a.indexOf(c) === i), ["auth status", "pr view", "run list"]);
  assert.ok(gh.calls().includes("run list --branch feat/x --limit 1 --json status,conclusion,name,url,headBranch,createdAt"));
  gh.done();
});

test("not authenticated, gh missing, detached or disabled: null and no further calls", async () => {
  const gh = fakeGh({ authed: false });
  const g = createGithub({ enabled: true });
  await withPath(gh.dir, async () => {
    g.githubOf(gh.dir, "main"); await settle(g);
    assert.equal(g.githubOf(gh.dir, "main"), null); await settle(g);
    assert.deepEqual(gh.calls(), ["auth status"]); // checked once per 10 minutes
  });
  const empty = mkdtempSync(join(tmpdir(), "axa-nogh-"));
  const old = process.env.PATH;
  process.env.PATH = empty;
  try { const g2 = createGithub({ enabled: true }); g2.githubOf("/tmp", "main"); await settle(g2); assert.equal(g2.githubOf("/tmp", "main"), null); }
  finally { process.env.PATH = old; rmSync(empty, { recursive: true, force: true }); }
  assert.equal(createGithub({ enabled: true }).githubOf("/tmp", "detached"), null);
  assert.equal(createGithub({ enabled: false }).githubOf("/tmp", "main"), null);
  gh.done();
});
