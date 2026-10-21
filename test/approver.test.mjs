// hooks/approver.mjs: its helpers, and the whole hook through stdin with the model call stubbed
// (test/fixtures/approver-run.mjs). No test ever calls a real model or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("./fixtures/approver-run.mjs", import.meta.url));
const HOOK = fileURLToPath(new URL("../hooks/approver.mjs", import.meta.url));
const PORT = "4851";

// Pure helpers are imported with a temp HOME and AXA_HOME, so nothing looks at the real ones
const pureBase = mkdtempSync(join(tmpdir(), "axa-approver-pure-"));
process.env.HOME = join(pureBase, "home");
process.env.AXA_HOME = join(pureBase, "axahome");
mkdirSync(join(process.env.HOME, ".ssh"), { recursive: true });
mkdirSync(process.env.AXA_HOME, { recursive: true });
const A = await import("../hooks/approver.mjs");

function sandbox(policy) {
  const base = mkdtempSync(join(tmpdir(), "axa-approver-test-"));
  const s = { base, home: join(base, "home"), axa: join(base, "axahome"), proj: join(base, "proj"), calls: join(base, "judge-calls.jsonl") };
  for (const d of [s.home, s.axa, join(s.proj, "sub")]) mkdirSync(d, { recursive: true });
  if (policy) writeFileSync(join(s.axa, "policy.json"), JSON.stringify(policy));
  return s;
}
function run(s, tool_name, tool_input, { judge = '{"decision":"allow","reason":"fine."}', session = "sess-1", cwd = s.proj, projectDir = s.proj, env = {}, script = RUNNER } = {}) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ session_id: session, tool_name, tool_input, cwd }),
    env: { PATH: process.env.PATH, HOME: s.home, AXA_HOME: s.axa, AXA_PORT: PORT, AXA_ROLE: "worker", CLAUDE_PROJECT_DIR: projectDir, AXA_TEST_JUDGE: judge, AXA_TEST_JUDGE_LOG: s.calls, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.decision : null;
}
const calls = (s) => (existsSync(s.calls) ? readFileSync(s.calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const decisions = (s) => (existsSync(join(s.axa, "events.jsonl")) ? readFileSync(join(s.axa, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === "AxaDecision") : []);
const sh = (s, command, opts) => run(s, "Bash", { command }, opts);

// ---------- helpers ----------
test("unquote removes quoted text", () => {
  assert.equal(A.unquote(`echo "npm publish" 'git push origin main'`), "echo '' ''");
  assert.equal(A.unquote(`echo "a \\" b" done`), "echo '' done");
  assert.equal(A.unquote("npm publish"), "npm publish");
});

test("RUNS_TEXT spots commands that could run quoted text", () => {
  for (const c of [`sh -c "npm publish"`, `bash -c 'x'`, "eval \"$X\"", "echo x | xargs npm", "source ./env.sh", ". ./env.sh", "echo npm publish | sh", "node -e 'x'", "python3 -c 'x'", "ssh host 'x'", "watch 'x'", "nohup x", "tmux send-keys 'x' Enter"]) assert.ok(A.RUNS_TEXT.test(c), c);
  for (const c of [`echo "npm publish"`, "grep 'git push' notes.md", "node script.mjs", "ls ./dir"]) assert.ok(!A.RUNS_TEXT.test(c), c);
});

test("normalizeCommand only folds whitespace the shell ignores", () => {
  assert.equal(A.normalizeCommand("  npm   test\t--watch  "), "npm test --watch");
  assert.equal(A.normalizeCommand(`echo "a   b"  'c  d'`), `echo "a   b" 'c  d'`);
  assert.equal(A.normalizeCommand("a  \n  b"), "a \n b"); // a newline separates commands: kept
  assert.notEqual(A.normalizeCommand("a\nb"), A.normalizeCommand("a b"));
  assert.equal(A.normalizeCommand("echo a\\    b"), "echo a\\  b"); // escaped space kept, the rest folded
  assert.notEqual(A.normalizeCommand("echo a\\  b"), A.normalizeCommand("echo a b"));
  assert.equal(A.normalizeCommand("ls foo\\ "), "ls foo\\ "); // a trailing escaped space is part of the word
  for (const exact of ["cat <<EOF\n  a   b\nEOF", `echo "unbalanced  x`, "echo $'a\\'  b'", "trailing \\"]) assert.equal(A.normalizeCommand(exact), exact);
});

test("decisionKey: same only for same session, project, folder, tool, command and settings", () => {
  const e = { session_id: "s1", cwd: pureBase };
  const k = (ev, tool, input, settings = {}) => A.decisionKey(ev, tool, input, settings);
  const base = k(e, "Bash", { command: "make  lint" });
  assert.equal(base, k(e, "Bash", { command: " make lint ", description: "different words" }));
  assert.notEqual(base, k({ ...e, session_id: "s2" }, "Bash", { command: "make lint" }));
  assert.notEqual(base, k({ ...e, cwd: process.env.HOME }, "Bash", { command: "make lint" }));
  assert.notEqual(base, k(e, "Bash", { command: "make lint2" }));
  assert.notEqual(base, k(e, "Bash", { command: "make lint" }, { rules: "x" }));
  assert.notEqual(k(e, "WebFetch", { url: "https://a.test", prompt: "x" }), k(e, "WebFetch", { url: "https://b.test", prompt: "x" }));
  assert.equal(k(e, "WebFetch", { url: "https://a.test", prompt: "x" }), k(e, "WebFetch", { prompt: "x", url: "https://a.test" }));
  assert.equal(k({ cwd: pureBase }, "Bash", { command: "x" }), null); // no session: nothing remembered
});

test("readOnlyVerdict: reads skip the model unless private", () => {
  const proj = join(pureBase, "proj");
  mkdirSync(proj, { recursive: true });
  const e = { cwd: proj };
  const v = (tool, input) => A.readOnlyVerdict(tool, input, e)?.decision ?? null;
  assert.equal(v("Read", { file_path: "/usr/share/doc/readme" }), "allow");
  assert.equal(v("Glob", { pattern: "**/*.md", path: "/usr/share/doc" }), "allow");
  assert.equal(v("LS", { path: "/usr" }), "allow");
  assert.equal(v("Grep", { pattern: "x", path: proj }), "allow");
  assert.equal(v("Grep", { pattern: "x" }), "allow");
  // Grep reads contents across a tree: outside the project the model judges
  assert.equal(v("Grep", { pattern: "x", path: "/usr" }), null);
  // AXA's own files: denied
  assert.equal(v("Read", { file_path: join(process.env.AXA_HOME, "events.jsonl") }), "deny");
  assert.equal(v("Glob", { pattern: `${process.env.AXA_HOME}/*` }), "deny");
  assert.equal(v("Grep", { pattern: "x", path: process.env.AXA_HOME }), "deny");
  // secrets and private places: the model judges, as before
  for (const p of [join(proj, ".env"), "~/.ssh/id_ed25519", "~/.claude/.credentials.json", "~/.claude.json", "~/.config/gh/hosts.yml", "/proc/self/environ", "~/.bash_history", join(proj, "x.pem")]) assert.equal(v("Read", { file_path: p }), null, p);
  assert.equal(v("Glob", { pattern: "~/.ssh/*" }), null);
  assert.equal(v("LS", { path: "~/.aws" }), null);
  // a symlink inside the project pointing at a private place
  symlinkSync(join(process.env.HOME, ".ssh"), join(proj, "keys"));
  assert.equal(v("Read", { file_path: join(proj, "keys/id_rsa_backup") }), null);
  // other tools aren't read-only
  for (const t of ["Bash", "Edit", "Write", "WebFetch", "mcp__x__read"]) assert.equal(A.readOnlyVerdict(t, { file_path: "/usr/x" }, e), null, t);
});

// ---------- the hook ----------
test("one-way doors go to the user; the model is never asked", () => {
  const s = sandbox();
  assert.equal(sh(s, "npm publish"), null);
  assert.equal(sh(s, 'sh -c "npm publish"'), null);
  assert.equal(run(s, "mcp__slack__send_message", { text: "hi" }), null);
  assert.equal(calls(s).length, 0);
  const d = decisions(s);
  assert.equal(d.length, 3);
  assert.ok(d.every((x) => x.decision === "escalate" && x.by === "rule" && /^one-way door/.test(x.reason)));
});

test("a door matched only inside quotes is judged, told so, and never remembered", () => {
  const s = sandbox();
  assert.deepEqual(sh(s, 'echo "npm publish" >> notes.md'), { behavior: "allow" });
  assert.deepEqual(sh(s, 'echo "npm publish" >> notes.md'), { behavior: "allow" });
  const c = calls(s);
  assert.equal(c.length, 2);
  assert.match(c[0].prompt, /matched only text inside quotes/);
  assert.ok(decisions(s).every((x) => !x.cached));
});

test("user escalate rules go to the user, even after an earlier allow", () => {
  const s = sandbox();
  assert.deepEqual(sh(s, "make bundle"), { behavior: "allow" });
  writeFileSync(join(s.axa, "policy.json"), JSON.stringify({ default: { escalate: ["^make bundle$"] } }));
  assert.equal(sh(s, "make bundle"), null);
  assert.equal(calls(s).length, 1);
  assert.equal(decisions(s).at(-1).reason, "one-way door: your rule (^make bundle$)");
});

test("read-only tools are allowed without a model call", () => {
  const s = sandbox();
  assert.deepEqual(run(s, "Read", { file_path: "/usr/share/doc/x" }), { behavior: "allow" });
  assert.deepEqual(run(s, "Glob", { pattern: "*", path: "/usr" }), { behavior: "allow" });
  assert.equal(calls(s).length, 0);
  assert.equal(decisions(s)[0].by, "rule");
  // AXA's own files: denied without a model call
  const d = run(s, "Read", { file_path: join(s.axa, "policy.json") });
  assert.equal(d.behavior, "deny");
  assert.equal(calls(s).length, 0);
  // a secret: the model decides
  assert.deepEqual(run(s, "Read", { file_path: join(s.home, ".ssh/id_rsa") }, { judge: '{"decision":"deny","reason":"no keys."}' }), { behavior: "deny", message: "AXA declined this: no keys. Find another way that doesn't need it; if it's truly required, finish what you can and explain in your report." });
  assert.equal(calls(s).length, 1);
});

test("with standing rules, reads still go to the model", () => {
  const s = sandbox({ default: { rules: "never read outside the project" } });
  assert.deepEqual(run(s, "Read", { file_path: "/usr/share/doc/x" }), { behavior: "allow" });
  assert.equal(calls(s).length, 1);
  assert.match(calls(s)[0].prompt, /never read outside the project/);
});

test("decisions are remembered per session, project, folder and command", () => {
  const s = sandbox();
  assert.deepEqual(sh(s, "make lint"), { behavior: "allow" });
  assert.deepEqual(sh(s, "  make   lint ", { judge: "fail" }), { behavior: "allow" }); // reused, model not asked
  assert.equal(calls(s).length, 1);
  const d = decisions(s);
  assert.equal(d[1].cached, true);
  assert.equal(d[1].decision, "allow");
  assert.equal(d[1].by, "judge");
  assert.equal(d[0].cached, undefined);
  // anything different is judged again
  sh(s, "make lint", { session: "sess-2" });
  sh(s, "make lint", { cwd: join(s.proj, "sub") });
  const other = join(s.base, "other");
  mkdirSync(other);
  sh(s, "make lint", { cwd: other, projectDir: other });
  sh(s, "make lint --fix");
  assert.equal(calls(s).length, 5);
  // a remembered deny is reused as a deny
  assert.equal(sh(s, "make nuke", { judge: '{"decision":"deny","reason":"not needed."}' }).behavior, "deny");
  assert.equal(sh(s, "make nuke").behavior, "deny");
  assert.equal(calls(s).length, 6);
});

test("ask and failures aren't remembered", () => {
  const s = sandbox();
  assert.equal(sh(s, "make release-notes", { judge: '{"decision":"ask","reason":"unsure."}' }), null);
  assert.equal(sh(s, "make release-notes", { judge: "fail" }), null);
  assert.equal(sh(s, "make release-notes", { judge: "throw" }), null);
  assert.deepEqual(sh(s, "make release-notes"), { behavior: "allow" });
  assert.equal(calls(s).length, 4);
  assert.deepEqual(decisions(s).map((d) => [d.decision, d.by]), [["escalate", "judge"], ["escalate", "error"], ["escalate", "error"], ["allow", "judge"]]);
  // garbage from the model is no answer
  assert.equal(sh(s, "make other", { judge: '{"decision":"yes"}' }), null);
});

test("approver state is private (0600 file in a 0700 folder) and holds no secrets", () => {
  const s = sandbox();
  appendFileSync(join(s.axa, "events.jsonl"), JSON.stringify({ event: "UserPromptSubmit", session: "sess-1", prompt: "use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz" }) + "\n");
  sh(s, "make lint");
  const dir = join(s.axa, "approver");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.equal(statSync(join(dir, files[0])).mode & 0o777, 0o600);
  const text = readFileSync(join(dir, files[0]), "utf8");
  assert.ok(!text.includes("abcdefghijklmnop"), text);
  assert.ok(text.includes("[REDACTED]"));
});

test("the session goal is read incrementally from the event log", () => {
  const s = sandbox();
  const log = join(s.axa, "events.jsonl");
  const prompt = (session, p) => appendFileSync(log, JSON.stringify({ ts: 1, event: "UserPromptSubmit", session, prompt: p }) + "\n");
  prompt("sess-1", "/goal build the importer");
  prompt("sess-other", "unrelated work");
  prompt("sess-1", "first step");
  sh(s, "make a");
  let p = calls(s).at(-1).prompt;
  assert.match(p, /\/goal build the importer\n---\nfirst step/);
  assert.ok(!p.includes("unrelated work"));
  // overwrite what was already read (same length): a re-read would see the change, the state doesn't
  const before = readFileSync(log, "utf8");
  const fd = openSync(log, "r+");
  writeSync(fd, before.slice(0, before.indexOf("\n")).replace("importer", "XXXXXXXX"), 0);
  closeSync(fd);
  prompt("sess-1", "second step");
  sh(s, "make b");
  p = calls(s).at(-1).prompt;
  assert.match(p, /build the importer/);
  assert.match(p, /first step\n---\nsecond step/);
});

test("goalOf: a half-written last line is read once it's complete", () => {
  const log = join(process.env.AXA_HOME, "events.jsonl");
  const line = (p) => JSON.stringify({ event: "UserPromptSubmit", session: "g-1", prompt: p }) + "\n";
  writeFileSync(log, line("/goal ship it") + line("one"));
  const state = { goal: null };
  assert.equal(A.goalOf("g-1", state), "/goal ship it\n---\none");
  assert.equal(state.goal.offset, statSync(log).size);
  const two = line("two");
  appendFileSync(log, two.slice(0, 20));
  assert.equal(A.goalOf("g-1", state), "/goal ship it\n---\none");
  appendFileSync(log, two.slice(20));
  assert.equal(A.goalOf("g-1", state), "/goal ship it\n---\none\n---\ntwo");
  assert.equal(A.goalOf("nobody", { goal: null }), "");
});

test("a replaced (rotated) event log is read again from the start", () => {
  const s = sandbox();
  const log = join(s.axa, "events.jsonl");
  appendFileSync(log, JSON.stringify({ event: "UserPromptSubmit", session: "sess-1", prompt: "old goal text ".repeat(20) }) + "\n");
  sh(s, "make a");
  writeFileSync(log, JSON.stringify({ event: "UserPromptSubmit", session: "sess-1", prompt: "new" }) + "\n");
  sh(s, "make b");
  const p = calls(s).at(-1).prompt;
  assert.match(p, /<session_goal>\nnew\n<\/session_goal>/);
});

test("silent outside AXA project sessions or when switched off", () => {
  let s = sandbox();
  assert.equal(sh(s, "make lint", { env: { AXA_ROLE: "commander" } }), null);
  assert.equal(sh(s, "make lint", { env: { AXA_ROLE: "" } }), null);
  s = sandbox({ default: { approver: { mode: "off" } } });
  assert.equal(sh(s, "make lint"), null);
  s = sandbox({ projects: { proj: { mode: "off" } } });
  assert.equal(sh(s, "make lint"), null);
  assert.equal(calls(s).length, 0);
});

test("the real hook has no stub switch: test env vars are ignored", () => {
  // PATH holds no `claude`, so the real model call fails and the prompt is left for the user even
  // though AXA_TEST_JUDGE says allow
  const s = sandbox();
  const empty = join(s.base, "empty-bin");
  mkdirSync(empty);
  assert.equal(sh(s, "make lint", { script: HOOK, env: { PATH: empty } }), null);
  assert.equal(calls(s).length, 0);
  assert.equal(decisions(s)[0].by, "error");
  // and it still answers read-only calls itself when run as the hook
  assert.deepEqual(run(s, "Read", { file_path: "/usr/share/doc/x" }, { script: HOOK, env: { PATH: empty } }), { behavior: "allow" });
});
