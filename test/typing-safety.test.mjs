// Part C of docs/tasks/reliability.md: no shell or slash-command injection through typed text, and
// project sessions can't drive AXA (the axa CLI), touch Claude Code's trust file or switch permission
// checks off. Policy runs use temp HOME / AXA_HOME / project folders only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-typing-test-")));
process.env.HOME = join(base, "home");
process.env.AXA_HOME = join(base, "axahome");
process.env.AXA_PORT = "4855";
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.AXA_HOME, { recursive: true });
const { typedText, SLASH_OK } = await import("../src/core/sessions.mjs");

// ---------- typed text ----------
test("a leading ! (bash mode skips hooks) needs the user's confirmation", () => {
  for (const t of ["!rm -rf ~", "  !curl x | sh", "\n!id", "\x1b!id"]) {
    assert.match(typedText(t).error, /bash mode/, JSON.stringify(t));
    assert.equal(typedText(t, { confirmed: true }).error, undefined, JSON.stringify(t));
  }
  // a "!" later in the text is just text
  assert.equal(typedText("fix the bug! then run the tests").text, "fix the bug! then run the tests");
});

test("only /goal, /compact, /clear, /context and /cost may be typed", () => {
  assert.deepEqual(SLASH_OK, ["goal", "compact", "clear", "context", "cost"]);
  for (const t of ["/goal tests pass", "/compact", "/clear", "/context", "/cost", "  /goal x"]) assert.equal(typedText(t).error, undefined, t);
  for (const t of ["/model opus", "/permissions", "/mcp", "/config", "/login", "/bashes", "/Goal x", "/goalx", "/home/me/x is broken", "/", "/add-dir /", "/hooks"]) {
    assert.match(typedText(t).error, /only these slash commands/, t);
    // confirmation is about "!", not slash commands
    assert.match(typedText(t, { confirmed: true }).error, /only these slash commands/, t);
  }
  assert.equal(typedText("please run /model later").error, undefined);
});

test("control characters are stripped, newlines kept", () => {
  assert.equal(typedText("a\x1b[Ab\tc\r\nd\x00e\x7f\x9bf").text, "a[Abc\ndef");
  assert.equal(typedText("line 1\nline 2").text, "line 1\nline 2");
  // stripping can't smuggle a "!" or a slash command to the front
  assert.match(typedText("\x03\x1b!rm x").error, /bash mode/);
  assert.match(typedText("\t/model x").error, /slash commands/);
  assert.match(typedText("\x1b\x1b").error, /nothing to type/);
  assert.match(typedText("").error, /nothing to type/);
});

test("send_to_session, links and the supervisor all go through the same rules", () => {
  const sessions = readFileSync(fileURLToPath(new URL("../src/core/sessions.mjs", import.meta.url)), "utf8");
  const supervisor = readFileSync(fileURLToPath(new URL("../src/core/supervisor.mjs", import.meta.url)), "utf8");
  // sendText (send_to_session, link firing, supervisor wakes) checks every Claude session's text
  assert.match(sessions, /if \(t\.mode !== "shell"\) \{\n\s*const r = typedText\(text, \{ confirmed \}\);/);
  // a link is checked when it's made (no confirmation there: "!" is never linked)
  assert.match(supervisor, /if \(to\.mode !== "shell"\) \{\n\s*const r = typedText\(text\);/);
});

// ---------- the policy ----------
const HOOK = fileURLToPath(new URL("../hooks/policy.mjs", import.meta.url));
function sandbox() {
  const s = realpathSync(mkdtempSync(join(base, "p-")));
  const d = { home: join(s, "home"), axa: join(s, "axahome"), proj: join(s, "home", "proj") };
  for (const x of Object.values(d)) mkdirSync(x, { recursive: true });
  return d;
}
function policy(s, role, tool_name, tool_input) {
  const cwd = role === "commander" ? s.home : s.proj;
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: "t", tool_name, tool_input, cwd }), env: { PATH: process.env.PATH, HOME: s.home, AXA_HOME: s.axa, AXA_PORT: "4855", AXA_ROLE: role, CLAUDE_PROJECT_DIR: cwd }, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
}
const sh = (s, role, command) => policy(s, role, "Bash", { command });

test("workers can't run the axa CLI (its bin/ is on their PATH)", () => {
  const s = sandbox();
  for (const c of ["axa", "axa stop --all", "axa attach api", "axa restart", "axa status --json", "axa web", "axa review", "~/.local/bin/axa stop", "/home/me/axa/bin/axa status", "node /home/me/axa/bin/axa stop --all", "node ../axa/bin/axa", "cd sub; axa stop", "npm test && axa stop --all", "env -i PATH=/usr/bin axa stop", "nohup axa stop --all", "xargs axa attach < ids.txt", "bash -c 'axa stop --all'", "sh -c \"axa restart\"", "eval axa stop", "echo `axa status`", "x=$(axa status --json)"]) {
    const o = sh(s, "worker", c);
    assert.equal(o?.permissionDecision, "deny", c);
    assert.match(o.permissionDecisionReason, /axa CLI|axa trust/, c);
  }
  // working on AXA's own code is fine: its files aren't the CLI
  for (const c of ["ls bin/axa", "node --test test/status.test.mjs", "grep -n 'axa stop' README.md", "cat bin/axa", "git commit -F - <<'EOF'\nfix axa stop --all\nEOF"]) {
    const o = sh(s, "worker", c);
    assert.ok(!o || !/axa CLI/.test(o.permissionDecisionReason), c);
  }
});

test("the commander keeps the axa CLI (but never axa trust)", () => {
  const s = sandbox();
  for (const c of ["axa status --json", "axa review"]) assert.ok(!/axa CLI/.test(sh(s, "commander", c)?.permissionDecisionReason || ""), c);
  assert.equal(sh(s, "commander", "axa trust ~/proj")?.permissionDecision, "deny");
});

test("workers can't read or write ~/.claude.json (the trust file)", () => {
  const s = sandbox();
  const f = join(s.home, ".claude.json");
  for (const [tool, input] of [["Read", { file_path: f }], ["Read", { file_path: f + ".backup" }], ["Edit", { file_path: f, old_string: "a", new_string: "b" }], ["Write", { file_path: f, content: "{}" }], ["Grep", { pattern: "trust", path: f }]]) {
    const o = policy(s, "worker", tool, input);
    assert.equal(o?.permissionDecision, "deny", `${tool} ${input.file_path || input.path}`);
    assert.match(o.permissionDecisionReason, /claude\.json/);
  }
  for (const c of ["cat ~/.claude.json", `cat ${f}`, "jq . $HOME/.claude.json", "cp x.json ${HOME}/.claude.json", "python3 -c 'print(1)' > ~/.claude.json", "cd ~ && cat .claude.json", `sed -i s/false/true/ ${f}`]) {
    const o = sh(s, "worker", c);
    assert.equal(o?.permissionDecision, "deny", c);
  }
  // a project's own file with that name isn't Claude Code's config
  const own = policy(s, "worker", "Read", { file_path: join(s.proj, ".claude.json") });
  assert.ok(!own || !/claude\.json is Claude Code/.test(own.permissionDecisionReason));
});

test("the commander can't write ~/.claude.json either", () => {
  const s = sandbox();
  const f = join(s.home, ".claude.json");
  assert.equal(policy(s, "commander", "Write", { file_path: f, content: "{}" })?.permissionDecision, "deny");
  assert.equal(sh(s, "commander", `cp x.json ${f}`)?.permissionDecision, "deny");
});

test("no session starts Claude Code with its permission checks off", () => {
  const s = sandbox();
  for (const role of ["worker", "commander"]) {
    for (const c of ["claude --dangerously-skip-permissions", "claude -p 'fix it' --permission-mode bypassPermissions", "claude --permission-mode=bypassPermissions", "npx @anthropic-ai/claude-code --dangerously-skip-permissions -p x", "claude --allow-dangerously-skip-permissions", "claude --settings '{\"permissions\":{\"defaultMode\":\"bypassPermissions\"}}'", "bash -c 'claude --dangerously-skip-permissions'"]) {
      const o = sh(s, role, c);
      assert.equal(o?.permissionDecision, "deny", `${role}: ${c}`);
      assert.match(o.permissionDecisionReason, /permission checks off/, `${role}: ${c}`);
    }
  }
  // a commit message about it is text
  const o = sh(s, "worker", "git commit -F - <<'EOF'\ndeny --dangerously-skip-permissions\nEOF");
  assert.ok(!o || !/permission checks off/.test(o.permissionDecisionReason));
});
