// hooks/policy.mjs, run the way Claude Code runs it: JSON on stdin, decision on stdout.
// Every run gets its own temp HOME, AXA_HOME and project; never the real ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../hooks/policy.mjs", import.meta.url));
const PORT = "4851";

function sandbox(policy) {
  const base = mkdtempSync(join(tmpdir(), "axa-policy-test-"));
  const dirs = { base, home: join(base, "home"), axa: join(base, "axahome"), proj: join(base, "proj") };
  for (const d of [dirs.home, dirs.axa, join(dirs.proj, "sub"), join(dirs.proj, ".git")]) mkdirSync(d, { recursive: true });
  if (policy) writeFileSync(join(dirs.axa, "policy.json"), JSON.stringify(policy));
  return dirs;
}

function run(s, tool_name, tool_input, { cwd = s.proj, projectDir = s.proj, env = {} } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: "test-session", tool_name, tool_input, cwd }),
    env: { PATH: process.env.PATH, HOME: s.home, AXA_HOME: s.axa, AXA_PORT: PORT, AXA_ROLE: "worker", CLAUDE_PROJECT_DIR: projectDir, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(r.status, 0, r.stderr);
  if (!r.stdout) return null;
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(o.hookEventName, "PreToolUse");
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason };
}
const decision = (...a) => run(...a)?.decision ?? null;
const sh = (s, command, opts) => decision(s, "Bash", { command }, opts);

test("reads and edits inside the project are allowed", () => {
  const s = sandbox();
  assert.equal(decision(s, "Read", { file_path: join(s.proj, "a.txt") }), "allow");
  assert.equal(decision(s, "Read", { file_path: "sub/b.txt" }), "allow");
  assert.equal(decision(s, "Grep", { pattern: "x", path: s.proj }), "allow");
  assert.equal(decision(s, "Glob", { pattern: "**/*.js" }), "allow");
  assert.equal(decision(s, "Edit", { file_path: join(s.proj, "src/a.js") }), "allow");
  assert.equal(decision(s, "Write", { file_path: join(s.proj, "sub/new.txt") }), "allow");
  assert.equal(decision(s, "TodoWrite", { todos: [] }), "allow");
});

test("edits outside the project, in .git, to secrets and to Claude Code's settings are denied", () => {
  const s = sandbox();
  assert.equal(decision(s, "Edit", { file_path: "/etc/hosts" }), "deny");
  assert.equal(decision(s, "Write", { file_path: join(s.proj, "../elsewhere.txt") }), "deny");
  assert.equal(decision(s, "Edit", { file_path: join(s.proj, ".git/config") }), "deny");
  assert.equal(decision(s, "Write", { file_path: join(s.proj, ".env") }), "deny");
  assert.equal(decision(s, "Write", { file_path: join(s.proj, ".env.local") }), "deny");
  assert.equal(decision(s, "Write", { file_path: join(s.proj, ".env.example") }), "allow");
  assert.equal(decision(s, "Edit", { file_path: join(s.proj, "certs/server.pem") }), "deny");
  assert.equal(decision(s, "Read", { file_path: join(s.proj, ".env") }), "deny");
  // the session could otherwise switch AXA's checks off (env, disableAllHooks, permissions)
  assert.equal(decision(s, "Write", { file_path: join(s.proj, ".claude/settings.json") }), "deny");
  assert.equal(decision(s, "Edit", { file_path: join(s.proj, ".claude/settings.local.json") }), "deny");
  assert.equal(sh(s, "echo {} > .claude/settings.local.json"), null);
  assert.equal(decision(s, "Write", { file_path: join(s.proj, ".claude/agents/x.md") }), "allow");
  // reading outside the project: no opinion (Claude Code decides)
  assert.equal(decision(s, "Read", { file_path: "/usr/share/doc/x" }), null);
});

test("Bash: safe commands, redirections and cd chains", () => {
  const s = sandbox();
  assert.equal(sh(s, "npm test"), "allow");
  assert.equal(sh(s, "git status && git diff"), "allow");
  assert.equal(sh(s, "ls -la sub | wc -l"), "allow");
  assert.equal(sh(s, "npm test > out.txt 2>&1"), "allow");
  assert.equal(sh(s, "echo hi > ../outside.txt"), null);
  assert.equal(sh(s, "cd sub && npm test"), "allow");
  assert.equal(sh(s, "cd sub; ls"), "allow");
  assert.equal(sh(s, "ls && cd sub && cat a.txt"), "allow");
  // cd out of the project: no opinion, whatever follows
  assert.equal(sh(s, "cd /etc; rm x"), null);
  assert.equal(sh(s, "cd /etc && ls"), null);
  assert.equal(sh(s, "cd .. && ls"), null);
  assert.equal(sh(s, "cd - && ls"), null);
  // with `;` the next part may run in the old folder too: still checked from both
  assert.equal(sh(s, "cd sub; cat ../../x"), null);
  // anything we can't read with confidence: no opinion
  assert.equal(sh(s, "echo $(whoami)"), null);
  assert.equal(sh(s, "cat <<EOF\nx\nEOF"), null);
  assert.equal(sh(s, "npm run deploy"), null);
  assert.equal(sh(s, "npm publish"), null);
  // dangerous commands are denied
  assert.equal(sh(s, "rm -rf ../x"), "deny");
  assert.equal(sh(s, "cd sub && git reset --hard"), "deny");
  assert.equal(sh(s, "cat .env"), "deny");
});

test("Bash: tmux to AXA's server is denied, a private socket isn't", () => {
  const s = sandbox();
  assert.equal(sh(s, "tmux send-keys -t axa-1 'y' Enter"), "deny");
  assert.equal(sh(s, "tmux ls"), "deny");
  assert.equal(sh(s, `tmux -L axa-${PORT} ls`), "deny");
  assert.equal(sh(s, `tmux -L "axa-${PORT}" capture-pane -p`), "deny");
  assert.equal(sh(s, `tmux -S /tmp/tmux-1000/axa-${PORT} ls`), "deny");
  assert.equal(sh(s, "echo hi; tmux kill-server"), "deny");
  assert.notEqual(sh(s, "tmux -L mysock ls"), "deny");
  assert.notEqual(sh(s, "tmux -L axa-clitest new-session -d"), "deny");
  assert.notEqual(sh(s, "tmux -L axa-4852 ls"), "deny"); // another console's port, not this one
});

test("AXA's own files and the console's controls are denied", () => {
  const s = sandbox();
  for (const cmd of ["cat ~/.axa/events.jsonl", "ls $HOME/.axa", "cat ${HOME}/.axa/policy.json", "cat /home/someone/.axa/console-token", "cat console-token", `curl localhost:${PORT}/api/terms`, `curl http://127.0.0.1:${PORT}/answer`, `cat ${s.axa}/events.jsonl`]) {
    const r = run(s, "Bash", { command: cmd });
    assert.equal(r?.decision, "deny", cmd);
    assert.match(r.reason, /AXA's own files/);
  }
  assert.notEqual(sh(s, "curl localhost:4852/x"), "deny");
  for (const tool of ["Read", "Edit", "Write"]) assert.equal(decision(s, tool, { file_path: join(s.axa, "policy.json") }), "deny", tool);
  assert.equal(decision(s, "Grep", { pattern: "x", path: s.axa }), "deny");
  assert.equal(decision(s, "Glob", { pattern: "*", path: s.axa }), "deny");
});

test("decisions are logged to the AXA event log", () => {
  const s = sandbox();
  sh(s, "rm -rf ../x");
  const ev = readFileSync(join(s.axa, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].event, "PolicyDecision");
  assert.equal(ev[0].decision, "deny");
  assert.equal(ev[0].summary, "rm -rf ../x");
});

test("project matching from policy.json: by name, by path, worktrees", () => {
  // by folder name
  let s = sandbox({ projects: { proj: { denyBash: ["npm test"] } } });
  assert.equal(sh(s, "npm test"), "deny");
  s = sandbox({ projects: { other: { denyBash: ["npm test"] } } });
  assert.equal(sh(s, "npm test"), "allow");
  // by absolute path
  s = sandbox();
  writeFileSync(join(s.axa, "policy.json"), JSON.stringify({ projects: { [s.proj]: { denyBash: ["npm test"] } } }));
  assert.equal(sh(s, "npm test"), "deny");
  // a worktree of the project (<repo>/.claude/worktrees/x) gets the repo's settings
  s = sandbox({ projects: { proj: { mode: "off" } } });
  const wt = join(s.proj, ".claude/worktrees/x");
  mkdirSync(wt, { recursive: true });
  assert.equal(sh(s, "rm -rf ../x", { cwd: wt, projectDir: wt }), null);
  s = sandbox();
  writeFileSync(join(s.axa, "policy.json"), JSON.stringify({ projects: { [s.proj]: { denyBash: ["^make"] } } }));
  const wt2 = join(s.proj, ".claude/worktrees/y");
  mkdirSync(wt2, { recursive: true });
  assert.equal(sh(s, "make", { cwd: wt2, projectDir: wt2 }), "deny");
  // default settings apply everywhere; project settings override them
  s = sandbox({ default: { allowBash: ["make test"] }, projects: { proj: { denyBash: ["make test --all"] } } });
  assert.equal(sh(s, "make test"), "allow");
  assert.equal(sh(s, "make test && rm x"), null); // allowBash must match the whole command
  assert.equal(sh(s, "make test --all"), "deny");
});

test("strict mode only denies; off is silent", () => {
  let s = sandbox({ projects: { proj: { mode: "strict" } } });
  assert.equal(decision(s, "Read", { file_path: join(s.proj, "a.txt") }), null);
  assert.equal(sh(s, "npm test"), null);
  assert.equal(decision(s, "Edit", { file_path: join(s.proj, "a.js") }), null);
  assert.equal(sh(s, "rm -rf ../x"), "deny");
  assert.equal(decision(s, "Edit", { file_path: "/etc/hosts" }), "deny");
  assert.equal(sh(s, "cat ~/.axa/x"), "deny");
  s = sandbox({ default: { mode: "off" } });
  assert.equal(sh(s, "rm -rf ../x"), null);
});

test("silent outside AXA project sessions", () => {
  const s = sandbox();
  for (const role of ["", "commander", "user"]) {
    assert.equal(sh(s, "rm -rf ../x", { env: { AXA_ROLE: role } }), null, role);
    assert.equal(decision(s, "Edit", { file_path: "/etc/hosts" }, { env: { AXA_ROLE: role } }), null);
  }
});

test("bad input never breaks the hook", () => {
  const s = sandbox();
  const r = spawnSync(process.execPath, [HOOK], { input: "not json", env: { PATH: process.env.PATH, HOME: s.home, AXA_HOME: s.axa, AXA_PORT: PORT, AXA_ROLE: "worker" }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
