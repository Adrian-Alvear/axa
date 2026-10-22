// hooks/policy.mjs, run the way Claude Code runs it: JSON on stdin, decision on stdout.
// Every run gets its own temp HOME, AXA_HOME and project; never the real ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  assert.equal(sh(s, "echo {} > .claude/settings.local.json"), "deny");
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

test("Bash: sort, uniq and git that write files are never auto-allowed", () => {
  const s = sandbox();
  assert.equal(sh(s, "sort x.json"), "allow");
  assert.equal(sh(s, "uniq a.txt"), "allow");
  assert.equal(sh(s, "git log --oneline"), "allow");
  for (const cmd of ["sort -o out.txt x.json", "sort -ro out.txt x.json", "sort -oout.txt x.json", "sort --output=out.txt x.json", "sort --out out.txt x.json", "uniq a.txt b.txt", "git log --output=out.txt", "git diff --output ../x.patch", "git show --outp=x HEAD", "git format-patch --output=x", "sort --output=../outside.txt x"]) assert.equal(sh(s, cmd), null, cmd);
  // an option's value naming a file outside the project or a secret is checked like a plain path
  assert.equal(sh(s, "grep --file=../outside.txt x"), null);
  assert.equal(sh(s, "wc --files0-from=/etc/passwd"), null);
});

test("Bash: tree -o writes and sort --compress-program runs a program: never auto-allowed", () => {
  const s = sandbox();
  assert.equal(sh(s, "tree src"), "allow");
  for (const cmd of ["tree -o out.txt", "tree -ao out.txt src", "tree --output=x", "tree --outputfile x", "sort -S 1K --compress-program=sh data.txt", "sort --comp=sh data.txt"]) assert.equal(sh(s, cmd), null, cmd);
  assert.equal(sh(s, "tree -o .claude/settings.json"), "deny");
});

test("Bash: git options that run programs or read outside the repo are never auto-allowed", () => {
  const s = sandbox();
  assert.equal(sh(s, "git fetch origin"), "allow");
  assert.equal(sh(s, "git diff src/a.js"), "allow");
  assert.equal(sh(s, "git fetch --prune origin"), "allow");
  assert.equal(sh(s, "git push -u origin feat"), "allow");
  for (const cmd of ["git fetch --upl=sh origin", "git fetch --upload sh origin", "git push --rec=sh origin feat", "git push -fu origin feat", "git push origin feat:Main", "git push origin feat:refs/for/main", "git diff --ext=x", "git log --outp=x"]) assert.equal(sh(s, cmd), null, cmd);
  for (const cmd of ["git fetch --upload-pack=true /tmp","git fetch --upload-pack touch .", "git diff --no-index /dev/null /etc/passwd", "git diff --ext-diff", "git show --textconv HEAD", "git log -- /etc/passwd", "git diff ../outside.txt"]) assert.equal(sh(s, cmd), null, cmd);
});

test("Bash: pushing HEAD counts as pushing the current branch", () => {
  const s = sandbox();
  rmSync(join(s.proj, ".git"), { recursive: true });
  const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: s.proj, encoding: "utf8" });
  git("init", "-q", "-b", "main"); git("commit", "-q", "--allow-empty", "-m", "x");
  for (const cmd of ["git push origin HEAD", "git push", "git push -u origin HEAD", "git push origin feat:HEAD", "git push origin @", "git push origin feat:@", "git push origin HEAD~0", "git push origin @{0}"]) assert.equal(sh(s, cmd), null, cmd);
  git("checkout", "-q", "-b", "feat");
  assert.equal(sh(s, "git push origin HEAD"), "allow");
  assert.equal(sh(s, "git push"), "allow");
});

test("Bash: a push that reaches main in any refspec is never auto-allowed", () => {
  const s = sandbox();
  assert.equal(sh(s, "git push origin feat"), "allow");
  assert.equal(sh(s, "git push origin feat other"), "allow");
  for (const cmd of ["git push origin feat main", "git push origin HEAD:refs/heads/main", "git push origin refs/heads/master", "git push -u origin feat:production", "git push origin heads/main", "git push origin for/main", "git push origin x:refs/heads/release", "git push origin feat:team/main"]) assert.equal(sh(s, cmd), null, cmd);
});

test("Bash: writes to Claude Code's settings are denied, any spelling or case", () => {
  const s = sandbox();
  for (const cmd of ["sort -o .claude/settings.local.json x.json", "sort --output=.claude/settings.json x.json", "uniq x.json .claude/settings.local.json", "git diff --output=.claude/settings.json", "cp x.json .claude/settings.local.json", "echo {} | tee .claude/settings.json", "echo {} > .CLAUDE/Settings.Local.json", "cd sub && sort -o ../.claude/settings.json x"]) {
    const r = run(s, "Bash", { command: cmd });
    assert.equal(r?.decision, "deny", cmd);
    assert.match(r.reason, /Claude Code's settings/);
  }
  assert.equal(decision(s, "Write", { file_path: join(s.proj, ".Claude/Settings.json") }), "deny");
  assert.equal(decision(s, "Edit", { file_path: join(s.proj, ".claude/SETTINGS.LOCAL.JSON") }), "deny");
  // reading them is fine
  assert.equal(sh(s, "cat .claude/settings.json"), "allow");
});

test("Bash: relative paths and option values into AXA's folder are denied", () => {
  const s = sandbox();
  for (const cmd of ["sort --output=../axahome/policy.json x.json", "sort -o ../axahome/policy.json x.json", "cat ../axahome/policy.json", "grep --file=../axahome/console-x y", "cd .. && cat axahome/events.jsonl", "cd sub; cat ../../axahome/x", "ls -d../axahome", "echo x > ../axahome/policy.json"]) {
    const r = run(s, "Bash", { command: cmd });
    assert.equal(r?.decision, "deny", cmd);
    assert.match(r.reason, /AXA's own files/, cmd);
  }
});

test("allowBash never auto-allows a one-way door", () => {
  const s = sandbox({ default: { allowBash: [".*"] } });
  assert.equal(sh(s, "make test"), "allow");
  for (const cmd of ["npm publish", "git push origin main", "vercel deploy --prod", "sudo rm x"]) assert.equal(sh(s, cmd), null, cmd);
  // what it can't allow, denyBash and the AXA checks still deny
  assert.equal(sh(s, "sort -o ../axahome/policy.json x"), "deny");
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

test("silent outside AXA sessions (the commander has its own rules, below)", () => {
  const s = sandbox();
  for (const role of ["", "user", "Commander"]) {
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

test("backslashes the shell removes don't hide a path", () => {
  const s = sandbox();
  // what runs (.env, .claude) differs from how it reads: no opinion
  for (const c of ["cat \\.env", "cat .en\\v", "grep x \"a\\.b\"", "ls \"'\" \\sub \"'\""]) assert.equal(sh(s, c), null, c);
  // and the deny checks see the real path
  for (const c of ["cp sub/x .cl\\aude/settings.json", `cat ${s.axa.replace(/\//g, "/\\")}/policy.json`]) assert.equal(sh(s, c), "deny", c);
  assert.equal(sh(s, "grep 'a\\.b' sub"), "allow"); // inside single quotes a backslash is just text
});

// ---------- the commander (AXA_ROLE=commander) ----------
// Its home folder holds a project, private places and AXA's folder (~/.axa, the default spelling)
function commanderBox() {
  const s = sandbox();
  s.axa = join(s.home, ".axa");
  s.work = join(s.home, "work");
  s.proj = join(s.work, "proj");
  for (const d of [s.axa, join(s.proj, "src"), join(s.proj, ".git"), join(s.home, ".ssh"), join(s.home, ".config/gh")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(s.work, "notes.txt"), "x");
  writeFileSync(join(s.proj, "a.js"), "x");
  return s;
}
const cmd = (s, tool, input, opts = {}) => run(s, tool, input, { cwd: s.home, projectDir: s.home, ...opts, env: { AXA_ROLE: "commander", AXA_HOME: s.axa, ...opts.env } });
const cd = (...a) => cmd(...a)?.decision ?? null;
const csh = (s, command, opts) => cd(s, "Bash", { command }, opts);

test("commander: read-only tools anywhere in the home folder except secrets, private places and AXA's files", () => {
  const s = commanderBox();
  assert.equal(cd(s, "Read", { file_path: join(s.work, "notes.txt") }), "allow");
  assert.equal(cd(s, "Read", { file_path: "work/proj/a.js" }), "allow");
  assert.equal(cd(s, "LS", { path: s.home }), "allow");
  assert.equal(cd(s, "Grep", { pattern: "x", path: s.work }), "allow");
  assert.equal(cd(s, "Glob", { pattern: "**/*.js", path: s.work }), "allow");
  // outside the home folder, private places, a search over a tree that holds them: no opinion
  for (const [tool, input] of [["Read", { file_path: "/usr/share/doc/x" }], ["Read", { file_path: join(s.home, ".config/gh/hosts.yml") }], ["Grep", { pattern: "x" }], ["Grep", { pattern: "x", path: s.home }], ["Glob", { pattern: "**/*", path: s.home }], ["Glob", { pattern: "../*", path: s.work }], ["Glob", { pattern: "{/etc,x}/*", path: s.work }]])
    assert.equal(cd(s, tool, input), null, `${tool} ${JSON.stringify(input)}`);
  // secrets: denied, as for project sessions
  assert.equal(cd(s, "Read", { file_path: join(s.proj, ".env") }), "deny");
  assert.equal(cd(s, "Read", { file_path: join(s.home, ".ssh/id_ed25519") }), "deny");
  assert.equal(cd(s, "Read", { file_path: join(s.home, ".ssh/config") }), "deny"); // all of ~/.ssh counts as secret
  // AXA's folder: only its event log, session list and console token are read without asking
  for (const f of ["events.jsonl", "sessions.json", "console-token"]) assert.equal(cd(s, "Read", { file_path: join(s.axa, f) }), "allow", f);
  for (const [tool, input] of [["Read", { file_path: join(s.axa, "policy.json") }], ["Read", { file_path: join(s.axa, "approver/x.json") }], ["Grep", { pattern: "x", path: s.axa }], ["LS", { path: s.axa }]]) assert.equal(cd(s, tool, input), null, `${tool} ${JSON.stringify(input)}`);
});

test("commander: edits only inside a real project it runs in; AXA's files and settings denied", () => {
  const s = commanderBox();
  // in the home folder (where the commander usually runs) nothing counts as its project
  assert.equal(cd(s, "Edit", { file_path: join(s.proj, "a.js") }), null);
  assert.equal(cd(s, "Write", { file_path: join(s.home, "x.txt") }), null);
  const inProj = { cwd: s.proj, projectDir: s.proj };
  assert.equal(cd(s, "Edit", { file_path: join(s.proj, "a.js") }, inProj), "allow");
  assert.equal(cd(s, "Write", { file_path: join(s.work, "notes.txt") }, inProj), null);
  assert.equal(cd(s, "Edit", { file_path: join(s.proj, ".git/config") }, inProj), "deny");
  assert.equal(cd(s, "Write", { file_path: join(s.proj, ".env") }, inProj), "deny");
  assert.equal(cd(s, "Write", { file_path: join(s.proj, ".claude/settings.json") }, inProj), "deny");
  for (const f of ["policy.json", "ui.json", "approver/x.json", "events.jsonl"]) {
    const r = cmd(s, "Write", { file_path: join(s.axa, f) }, inProj);
    assert.equal(r?.decision, "deny", f);
    assert.match(r.reason, /AXA's own files/);
  }
  // strict mode: only denies
  writeFileSync(join(s.axa, "policy.json"), JSON.stringify({ default: { mode: "strict" } }));
  assert.equal(cd(s, "Edit", { file_path: join(s.proj, "a.js") }, inProj), null);
  assert.equal(cd(s, "Read", { file_path: join(s.work, "notes.txt") }), null);
  assert.equal(cd(s, "Write", { file_path: join(s.axa, "ui.json") }), "deny");
});

test("commander: read-only Bash in the home folder", () => {
  const s = commanderBox();
  for (const c of ["cat work/notes.txt", "head -n 5 work/notes.txt", "wc -l work/notes.txt", "ls -la", "pwd", "grep -n x work/notes.txt", "rg x work", "grep -rn x work", "cd work/proj && git log --oneline", "git status", "git branch --list", "node --check work/proj/a.js", "cat ~/.axa/events.jsonl", "tail -n 20 ~/.axa/sessions.json", "ls work | wc -l"])
    assert.equal(csh(s, c), "allow", c);
  // node --test runs the project's code: only in a project folder it runs in
  assert.equal(csh(s, "node --test", { cwd: s.proj, projectDir: s.proj }), "allow");
  assert.equal(csh(s, "node --test src", { cwd: s.proj, projectDir: s.proj }), "allow");
  assert.equal(csh(s, "node --test"), null);
  // node --check with an option runs code (--import/--require preloads): not read-only
  for (const c of [`node --check '--import=data:text/javascript,import cp from "child_process";cp.execSync("id")'`, "node --check --require=./x.js", "node --check work/missing.js", "cat \\.ssh/config", "cat work/proj/\\.env"])
    assert.equal(csh(s, c), null, c);
  for (const c of ["rg x", "grep -rn x .", "ls -R", "cat .ssh/config", "cat /etc/hosts", "cat ~/.axa/policy.json", "ls ~/.axa", "cd ~/.axa && ls", "cat work/notes.txt > out.txt", "rg --pre=sh x work", "git push origin feat", "git log --output=x", "git diff --no-index /etc/passwd x", "node -e 'x'", "node work/proj/a.js", "echo $(id)", "cat <<EOF\nx\nEOF", "make", "tmux -L x ls"])
    assert.equal(csh(s, c), null, c);
  // dangerous commands and writes into AXA's folder are denied
  for (const c of ["rm -rf ../x", "git reset --hard", "echo x > ~/.axa/policy.json", "rm ~/.axa/approver/x.json", "cp work/notes.txt ~/.axa/ui.json", "sed -i s/a/b/ ~/.axa/policy.json", "touch .axa/x", "env rm .axa/policy.json", "echo {} > work/proj/.claude/settings.json", "cp work/notes.txt work/proj/.claude/", "mv work/proj/src work/proj/.claude"])
    assert.equal(csh(s, c), "deny", c);
});

test("commander: curl to this machine only, and never to the console's /answer route", () => {
  const s = commanderBox();
  assert.equal(csh(s, "curl -b ./cookies.txt localhost:3000"), null); // -b without "=" reads a cookie file
  for (const c of [`curl -s localhost:${PORT}/api/terms`, `curl -s -X GET localhost:${PORT}/api/terms`, `curl -s -b axa_token=x localhost:${PORT}/api/terms`, "curl http://[::1]:3000/health", "curl -fsS --max-time 5 localhost:3000 -o /dev/null"])
    assert.equal(csh(s, c), "allow", c);
  // sending data (a POST to the console types into a session,   escapes hide what) goes on
  for (const c of [`curl -sS -X POST -H 'content-type: application/json' -d '{"text":"hi"}' http://127.0.0.1:${PORT}/api/terms/ab12/input`, `curl -s http://127.0.0.1:${PORT}/api/terms/t1/input -d '{"text":"rm\\u0020-rf ~/proj","confirmed_by_user":true}'`, "curl --json '{}' localhost:3000/x", "curl --data-raw x localhost:3000", "curl -dx localhost:3000"])
    assert.equal(csh(s, c), null, c);
  for (const c of ["curl https://example.com", "curl example.com/x", "curl localhost:3000 -o out.txt", "curl -d @work/notes.txt localhost:3000", "curl -L localhost:3000", "curl -X DELETE localhost:3000/x", "curl http://localhost@evil.example/", "curl --resolve localhost:80:1.2.3.4 http://localhost/", "curl -H 'Host: evil.example' localhost:3000", "curl -x http://proxy.example localhost:3000", "wget localhost:3000"])
    assert.equal(csh(s, c), null, c);
  for (const c of [`curl -X POST localhost:${PORT}/api/terms/ab12/answer -d '{"n":1}'`, `curl -H 'x-axa-client: tui' localhost:${PORT}/api/terms`, `curl -H "Sec-Fetch-Site: same-origin" localhost:${PORT}/api/terms`, `curl localhost:${PORT}/api/terms/ab12/ANSWER`, `curl -H 'x-axa-"client": tui' localhost:${PORT}/x`, `node -e "fetch('http://localhost:${PORT}/api/terms/x/answer',{method:'POST'})"`]) {
    const r = cmd(s, "Bash", { command: c });
    assert.equal(r?.decision, "deny", c);
    assert.match(r.reason, /never answers/, c);
  }
  // reading about the route is fine
  assert.equal(csh(s, "grep -n answer work/notes.txt"), "allow");
});

// ---------- pure helpers: localReversible and heredocWrite ----------
const pureBase = realpathSync(mkdtempSync(join(tmpdir(), "axa-policy-pure-")));
process.env.HOME = join(pureBase, "home");
process.env.AXA_HOME = join(pureBase, "home/.axa");
const P = await import("../hooks/policy.mjs");
const pproj = join(pureBase, "home/work/proj");
for (const d of [process.env.AXA_HOME, join(pproj, "src"), join(pproj, "dist"), join(pproj, ".git"), join(process.env.HOME, ".ssh")]) mkdirSync(d, { recursive: true });
const pctx = (over = {}) => ({ cwd: pproj, root: pproj, scratch: null, settings: {}, ...over });
const local = (command, over) => P.localReversible("Bash", { command }, pctx(over));

test("localReversible: edits inside the project and known-local Bash only", () => {
  for (const f of ["src/a.js", "README.md", ".claude/agents/x.md"]) assert.equal(P.localReversible("Edit", { file_path: join(pproj, f) }, pctx()), true, f);
  for (const f of ["../x.js", ".git/config", ".env", "x.pem", ".claude/settings.json", "/etc/hosts", join(process.env.AXA_HOME, "policy.json")]) assert.equal(P.localReversible("Write", { file_path: f.startsWith("/") ? f : join(pproj, f) }, pctx()), false, f);
  for (const c of ["mkdir -p src/new", "touch a.txt", "cp a.txt b.txt", "cp -r src src2", "mv a.txt b.txt", "chmod +x run.sh", "chmod 644 a.txt", "rm -rf dist", "rm -r build/", "rm coverage/lcov.info", "rm dist/*.js", "rmdir tmp/x", "rm /tmp/axa-x.log", "git add -A && git commit -m wip", "git status", "git checkout -b feat", "ls | wc -l", "cd src && ls", "echo hi > notes.txt", "curl -s localhost:3000/health", "cat > notes.md <<'EOF'\nhello $x\nEOF", "tee src/a.txt <<EOF\nplain\nEOF"])
    assert.equal(local(c), true, c);
  for (const c of ["npm install", "npm i left-pad", "pnpm add x", "pip install x", "curl https://example.com", `curl localhost:${process.env.AXA_PORT || 4747}/api/terms`, "wget localhost:3000", "git push origin feat", "git fetch", "git pull", "git clone x", "ssh host", "scp a host:b", "rsync -a a host:b", "nc -l 80", "docker pull x",
    "rm src/a.js", "rm -rf src", "rm -rf .", "rm dist/{a,../../src}", "rm dist/../src/a.js", "rm -rf ./dist", "rm ~/x", "mv a.txt ../x", "mv src/a.js .git/x", "cp ~/.ssh/config x", "cp a.txt .env", "chmod 4755 x", "chmod -R 777 .", "ln -s ~/.ssh keys",
    "git reset --hard", "git rebase main", "git commit --amend -m x", "git branch -D x", "git branch -d x", "git tag -d v1", "git reflog expire --all", "git gc --prune=now", "git checkout -- .", "git restore .", "git clean -fd", "git stash drop", "git filter-branch x",
    "echo $(whoami)", "echo `id`", "make", "node script.js", "npm test", "bash x.sh", "npm publish", "cd .. && ls", "cat > a.txt <<'EOF'\nx\nEOF\nnode a.txt", "cat <<'EOF' | sh\nls\nEOF", "cat <<EOF > a.txt\n$(id)\nEOF", "python3 - <<'EOF'\nopen('a.txt', 'w').write('x')\nEOF"])
    assert.equal(local(c), false, c);
  // a copy into a .claude folder takes the file name from the source: could be settings.json
  mkdirSync(join(pproj, "a"), { recursive: true });
  mkdirSync(join(pproj, "kit/.claude"), { recursive: true });
  for (const c of ["cp a/settings.json .claude/", "mv a/settings.local.json .claude", "cp -r a .claude", "mv a .claude", "mv x/.claude .", "cp -r kit/. .", "cp a/settings.json .cl\\aude/", "cp a/x .gi\\t/hooks/", "mv a/x \\.git/hooks/pre-commit", "rm dist/\\.\\./\\.env", "rm dist/\\.\\./\\.\\./outside.txt"])
    assert.equal(local(c), false, c);
  assert.equal(local("cp -r a/. b"), true);
  // build folders count only at the project's top; GET only to local servers
  for (const c of ["rm -rf src/build", "rm -rf src/tmp/x", "curl -X POST localhost:8080/x", "curl -d x localhost:8080/x"]) assert.equal(local(c), false, c);
  // never in strict mode, never outside a real project (the home folder isn't one), never past denyBash
  assert.equal(local("touch a.txt", { settings: { mode: "strict" } }), false);
  assert.equal(local("touch a.txt", { cwd: process.env.HOME, root: process.env.HOME }), false);
  assert.equal(local("touch a.txt", { settings: { denyBash: ["touch"] } }), false);
});

test("heredocWrite: only text written to a project file, by cat/tee or file-only Python", () => {
  const h = (c) => P.heredocWrite(c, pctx());
  const kind = (c) => h(c)?.kind ?? null;
  assert.deepEqual(h("cat > test/x.test.mjs <<'EOF'\nnpm publish --tag next\nEOF"), { kind: "shell", targets: ["test/x.test.mjs"], stripped: "cat > test/x.test.mjs <<'EOF'" });
  for (const c of ["cat <<'EOF' > a.txt\nnpm publish\nEOF", "cat >>a.txt <<\"EOF\"\nx\nEOF\n", "cat <<EOF > a.txt\nno expansions here\nEOF", "tee a.txt <<'EOF'\nx\nEOF", "tee -a a.txt >/dev/null <<'EOF'\nx\nEOF", "cat <<-'EOF' > a.txt\n\tx\n\tEOF"]) assert.equal(kind(c), "shell", c);
  for (const c of ["cat <<'EOF' | sh\nnpm publish\nEOF", "cat <<'EOF' | bash\nx\nEOF", "cat > a.sh <<'EOF' && sh a.sh\nx\nEOF", "cat > a.txt <<'EOF'\nx\nEOF\nsh a.txt", "cat <<EOF > a.txt\n$(npm publish)\nEOF", "cat <<EOF > a.txt\n`id`\nEOF", "bash <<'EOF'\nnpm publish\nEOF", "node <<'EOF'\nx\nEOF", "cat > ../out.txt <<'EOF'\nx\nEOF", "cat > .git/hooks/pre-commit <<'EOF'\nx\nEOF", "cat > .claude/settings.json <<'EOF'\n{}\nEOF", "cat > .env <<'EOF'\nx\nEOF", `cat > ${process.env.AXA_HOME}/policy.json <<'EOF'\n{}\nEOF`, "cat > a.txt 2> b.txt <<'EOF'\nx\nEOF", "tee a.txt b.txt <<'EOF'\nx\nEOF", "cat > a.txt <<'EOF'\nx", "cat a.txt", "cat x > a.txt <<'EOF'\ny\nEOF", "cat > a.txt <<'EOF' <<'EOF2'\nx\nEOF\ny\nEOF2"])
    assert.equal(h(c), null, c);
  // Python: file-only code, the matched text in its strings
  const py = "python3 - <<'EOF'\nimport re\np = 'test/policy.test.mjs'\ns = open(p).read()\ns = s.replace('x', 'npm publish and subprocess and http://x')\nwith open(p, 'w', encoding='utf8') as f:\n    f.write(s)\nEOF";
  assert.deepEqual(h(py), { kind: "python", targets: ["test/policy.test.mjs"], stripped: "python3 - <<'EOF'" });
  assert.equal(kind(`python3 -c 'open("a.txt", "w").write("npm publish")'`), "python");
  assert.equal(kind("python - <<'EOF'\nimport json\nwith open('a.json', mode='w') as f: json.dump({'cmd': 'npm publish'}, f)\nEOF"), "python");
  for (const code of ["import subprocess\nopen('a.txt','w')", "import os\nopen('a.txt','w')", "open('a.txt','w')\n__import__('os').system('x')", "open('a.txt','w').write(eval('1'))", "exec('x')\nopen('a.txt','w')", "import urllib.request\nopen('a.txt','w')", "import importlib\nopen('a.txt','w')", "import socket\nopen('a.txt','w')", "x = getattr(open, 'x')\nopen('a.txt','w')", "open('a.txt','w').write(f'{1}')", "open('/etc/passwd','w')", "open('../x','w')", "open('.git/config','w')", "open('src/a.js')", "open(q, 'w')", "p = 'a.txt'\np = '/etc/x'\nopen(p, 'w')", "p = 'a.txt'\nfor p in ['/etc/x']: open(p, 'w')", "p = 'a.txt'\n(p, q) = ('/etc/x', 1)\nopen(p, 'w')", "def f(p='a.txt'):\n  open(p, 'w')", "import io\nio.open('a.txt','w')", "x.open('a.txt','w')", "o = open\no('/etc/x','w')", "from os import system\nopen('a.txt','w')", "open('a.txt','w')\n[c for c in ().__class__.__bases__]"])
    assert.equal(h(`python3 - <<'EOF'\n${code}\nEOF`), null, code);
  // Python folds Unicode names (a fullwidth ｅxec is exec): no non-ASCII outside strings
  assert.equal(h("python3 - <<'EOF2'\nopen('out.txt','w').write('x')\nｅxec(\"import subprocess as s; s.run('npm publish', shell=True)\")\nEOF2"), null);
  assert.equal(kind("python3 - <<'EOF'\nopen('a.txt','w').write('café ｅxec')\nEOF"), "python");
  // an unquoted delimiter: the shell would expand $ in the code; double-quoted -c code likewise
  assert.equal(h("python3 - <<EOF\nopen('a.txt','w').write('$(id)')\nEOF"), null);
  assert.equal(h(`python3 -c "open('a.txt','w')"`), null);
  // outside a real project (the commander in the home folder): never
  assert.equal(P.heredocWrite("cat > a.txt <<'EOF'\nx\nEOF", pctx({ cwd: process.env.HOME, root: process.env.HOME })), null);
});
