// Part A of docs/tasks/reliability.md: sessions start unattended. The MCP server comes from the plugin
// (no project .mcp.json prompt) and gives tools to the commander only; the trust dialog is its own
// status; `axa trust` edits a temp HOME's ~/.claude.json; nothing is typed before a session is ready.
// Every test uses temp folders: never the real HOME, ~/.axa or ~/.claude.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-start-test-")));
process.env.HOME = join(base, "home");
process.env.AXA_HOME = join(base, "axahome");
process.env.AXA_PORT = "4853";
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.AXA_HOME, { recursive: true });

const { trustOnScreen, promptOnScreen } = await import("../src/core/screen.mjs");
const S = await import("../src/core/sessions.mjs");

// ---------- the MCP server: declared by the plugin, tools for the commander only ----------
test("the terminals server is declared in plugin.json, and there is no project .mcp.json", () => {
  const p = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(p.mcpServers.terminals, { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/mcp/axa-terminals.mjs"] });
  assert.equal(existsSync(join(ROOT, ".mcp.json")), false);
});

function mcpTools(role) {
  return new Promise((ok, fail) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, AXA_HOME: process.env.AXA_HOME, AXA_PORT: "4853" };
    if (role) env.AXA_ROLE = role;
    const p = spawn(process.execPath, [join(ROOT, "mcp", "axa-terminals.mjs")], { env });
    let out = "";
    const timer = setTimeout(() => { p.kill(); fail(new Error(`no reply (${out})`)); }, 10_000);
    p.stdout.on("data", (d) => {
      out += d;
      const lines = out.split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)); // complete lines only
      const list = lines.find((m) => m.id === 2), call = lines.find((m) => m.id === 3);
      if (list && call) { clearTimeout(timer); p.kill(); ok({ tools: list.result.tools.map((t) => t.name), call }); }
    });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    // (the commander's real tools would start a daemon: it gets an unknown one instead)
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: role === "commander" ? "no_such_tool" : "list_sessions", arguments: {} } }) + "\n");
  });
}

test("only the commander gets session tools; workers, the reviewer and plain sessions get none", async () => {
  const cmd = await mcpTools("commander");
  for (const t of ["list_sessions", "send_to_session", "open_session"]) assert.ok(cmd.tools.includes(t), t);
  for (const role of ["worker", "reviewer", undefined, "COMMANDER", "shell"]) {
    const r = await mcpTools(role);
    assert.deepEqual(r.tools, [], String(role));
    assert.match(r.call.error.message, /unknown tool/, String(role));
  }
});

test("open_session takes wait", async () => {
  const src = readFileSync(join(ROOT, "mcp", "axa-terminals.mjs"), "utf8");
  assert.match(src, /wait: \{ type: "boolean"/);
});

// ---------- the trust dialog on screen ----------
const TRUST_OLD = ["", "╭──────────────────────────────╮", "│ Do you trust the files in this folder? │", "│ /home/me/proj │", "│ ❯ 1. Yes, proceed │", "│   2. No, exit │", "│ Enter to confirm · Esc to exit │", "╰──────────────────────────────╯"];
const TRUST_NEW = ["Accessing workspace:", "", " /home/me/proj", "", " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known", " open source project, or work from your team).", "", " ❯ 1. Yes, I trust this folder", "   2. No, exit", "", " Enter to confirm · Esc to cancel"];
const PERMISSION = [" Bash command", "   npm publish", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend"];
const MCP = [" New MCP server found in .mcp.json: terminals", " ❯ 1. Use this and all future MCP servers in this project", "   2. Use this MCP server", "   3. Continue without using this MCP server", "", " Enter to confirm · Esc to reject"];

test("the trust dialog is recognized (old and new wording), other dialogs aren't trust", () => {
  assert.equal(trustOnScreen(TRUST_OLD), true);
  assert.equal(trustOnScreen(TRUST_NEW), true);
  assert.equal(trustOnScreen(PERMISSION), false);
  assert.equal(promptOnScreen(PERMISSION), true);
  assert.equal(trustOnScreen(MCP), false);
  // answered and scrolled up: no longer open
  assert.equal(trustOnScreen([...TRUST_NEW, "", "✻ Welcome to Claude Code", "  /help for help", "  cwd: /home/me/proj", "", "> ", "  ? for shortcuts"]), false);
});

// ---------- status and typing ----------
test("needs_trust wins over everything while the dialog is open (not for shells)", () => {
  assert.equal(S.deriveStatus({ alive: true, mode: "claude", tr: null, trust: true, prompt: true }), "needs_trust");
  assert.equal(S.deriveStatus({ alive: true, mode: "axa", tr: { status: "ready" }, trust: true, prompt: true }), "needs_trust");
  assert.equal(S.deriveStatus({ alive: true, mode: "shell", tr: null, trust: true, prompt: true }), "waiting");
  assert.equal(S.deriveStatus({ alive: false, mode: "claude", tr: null, trust: true }), "exited");
  assert.equal(S.deriveStatus({ alive: true, mode: "claude", tr: null, trust: false, prompt: false }), "starting");
  assert.equal(S.deriveStatus({ alive: true, mode: "claude", tr: null, trust: false, prompt: false, restored: true }), "ready");
  assert.equal(S.deriveStatus({ alive: true, mode: "claude", tr: { status: "working", asking: 1 }, prompt: true }), "working");
  assert.equal(S.deriveStatus({ alive: true, mode: "claude", tr: { status: "ready" }, prompt: true }), "waiting");
  assert.match(S.TRUST_HINT, /the user must answer the trust prompt \(or run axa trust <project>\)/);
});

test("nothing is typed while starting, while the trust prompt is open, or before SessionStart", () => {
  const s = (o) => ({ alive: true, mode: "claude", status: "ready", started: true, ...o });
  assert.match(S.inputRefusal(s({ status: "starting", started: false })), /still starting/);
  assert.match(S.inputRefusal(s({ status: "needs_trust", started: false })), /trust prompt.*axa trust/);
  assert.match(S.inputRefusal(s({ status: "needs_trust", started: true })), /trust prompt/);
  // a status from a stray event (a `claude -p` inside) but no SessionStart yet
  assert.match(S.inputRefusal(s({ status: "working", started: false })), /still starting/);
  assert.match(S.inputRefusal(s({ alive: false, status: "exited" })), /exited/);
  assert.equal(S.inputRefusal(s({})), null);
  assert.equal(S.inputRefusal(s({ status: "done" })), null);
  assert.equal(S.inputRefusal({ alive: true, mode: "shell", status: "ready", started: true }), null);
});

test("wait settles on ready, waiting, needs_trust or exit, not on starting", () => {
  const s = (o) => ({ alive: true, mode: "claude", status: "ready", started: true, ...o });
  assert.equal(S.settled(s({})), true);
  assert.equal(S.settled(s({ status: "waiting", started: false })), true);
  assert.equal(S.settled(s({ status: "needs_trust", started: false })), true);
  assert.equal(S.settled(s({ alive: false, status: "exited" })), true);
  assert.equal(S.settled(s({ status: "starting", started: false })), false);
  assert.equal(S.settled(s({ status: "working", started: false })), false);
});

test("waitReady returns at once for an unknown session and the SessionStart event marks a session started", async () => {
  const r = await S.waitReady("nope", { timeoutMs: 50 });
  assert.equal(r.timed_out, false);
  assert.equal(r.alive, false);
  const E = await import("../src/core/events.mjs");
  E.trackEvent({ event: "SessionStart", terminal: "t-start", session: "s1", role: "worker" });
  assert.equal(E.statusOf("t-start").started, true);
});

test("a new commander starts in its own folder in AXA's home", () => {
  const d = S.commanderDir();
  assert.equal(d, join(process.env.AXA_HOME, "commander"));
  assert.equal(lstatSync(d).isDirectory(), true);
});

// ---------- axa trust, against a temp HOME ----------
function axa(args, home) {
  return spawnSync(process.execPath, [join(ROOT, "bin", "axa"), ...args], { env: { PATH: process.env.PATH, HOME: home, AXA_HOME: join(home, ".axa-test"), AXA_PORT: "4853" }, encoding: "utf8", timeout: 15_000 });
}
function tempHome() {
  const h = realpathSync(mkdtempSync(join(base, "h-")));
  const repo = join(h, "proj");
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  spawnSync("git", ["init", "-q", repo]);
  return { h, repo };
}

test("axa trust marks the git repo root trusted, keeps the rest of the file", () => {
  const { h, repo } = tempHome();
  writeFileSync(join(h, ".claude.json"), JSON.stringify({ numStartups: 3, projects: { "/other": { hasTrustDialogAccepted: false, allowedTools: ["x"] }, [repo]: { allowedTools: ["y"] } } }), { mode: 0o600 });
  const r = axa(["trust", join(repo, "src", "deep")], h);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`Trusted ${repo}: set projects\\["${repo}"\\]\\.hasTrustDialogAccepted = true`));
  const cfg = JSON.parse(readFileSync(join(h, ".claude.json"), "utf8"));
  assert.equal(cfg.numStartups, 3);
  assert.deepEqual(cfg.projects["/other"], { hasTrustDialogAccepted: false, allowedTools: ["x"] });
  assert.deepEqual(cfg.projects[repo], { allowedTools: ["y"], hasTrustDialogAccepted: true });
  assert.equal(lstatSync(join(h, ".claude.json")).mode & 0o777, 0o600);
  // again: nothing to change
  const again = axa(["trust", repo], h);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already trusted/);
});

test("axa trust creates the file when missing, trusts a plain folder as itself", () => {
  const { h } = tempHome();
  const plain = join(h, "notes");
  mkdirSync(plain);
  const r = axa(["trust", plain], h);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(h, ".claude.json"), "utf8")).projects[plain].hasTrustDialogAccepted, true);
});

test("axa trust refuses the home folder (and above it), bad JSON and no path", () => {
  const { h } = tempHome();
  writeFileSync(join(h, ".claude.json"), "{}");
  for (const p of [h, join(h, "."), base, "/"]) {
    const r = axa(["trust", p], h);
    assert.equal(r.status, 1, p);
    assert.match(r.stderr, /refusing to trust/, p);
  }
  assert.equal(readFileSync(join(h, ".claude.json"), "utf8"), "{}");
  writeFileSync(join(h, ".claude.json"), "{ not json");
  const bad = axa(["trust", join(h, "proj")], h);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /isn't valid JSON/);
  assert.equal(readFileSync(join(h, ".claude.json"), "utf8"), "{ not json");
  assert.equal(axa(["trust"], h).status, 1);
  assert.equal(axa(["trust", join(h, "missing")], h).status, 1);
});

test("axa trust writes through a symlinked ~/.claude.json and keeps the link", () => {
  const { h, repo } = tempHome();
  mkdirSync(join(h, "dotfiles"));
  writeFileSync(join(h, "dotfiles", "claude.json"), "{}");
  symlinkSync(join(h, "dotfiles", "claude.json"), join(h, ".claude.json"));
  assert.equal(axa(["trust", repo], h).status, 0);
  assert.equal(lstatSync(join(h, ".claude.json")).isSymbolicLink(), true);
  assert.equal(JSON.parse(readFileSync(join(h, "dotfiles", "claude.json"), "utf8")).projects[repo].hasTrustDialogAccepted, true);
});

// ---------- sessions never run axa trust ----------
const HOOK = join(ROOT, "hooks", "policy.mjs");
function policy(role, command) {
  const s = realpathSync(mkdtempSync(join(base, "p-")));
  const proj = join(s, "proj"), home = join(s, "home"), axaHome = join(s, "axahome");
  for (const d of [proj, home, axaHome]) mkdirSync(d, { recursive: true });
  const cwd = role === "commander" ? home : proj;
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: "t", tool_name: "Bash", tool_input: { command }, cwd }), env: { PATH: process.env.PATH, HOME: home, AXA_HOME: axaHome, AXA_PORT: "4853", AXA_ROLE: role, CLAUDE_PROJECT_DIR: cwd }, encoding: "utf8", timeout: 10_000 });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

test("workers and the commander can't run axa trust, however it's spelled", () => {
  for (const role of ["worker", "commander"]) {
    for (const c of ["axa trust .", "axa trust ~/proj", "/home/me/axa/bin/axa trust .", "node /home/me/axa/bin/axa trust .", "env FOO=1 axa trust .", "nohup axa trust . &", "cd x && axa trust .", "bash -c 'axa trust .'", "sh -c \"cd x; axa trust .\"", "eval \"axa trust .\"", "echo $(axa trust .)", "timeout 5 axa trust ."]) {
      const o = policy(role, c);
      assert.equal(o?.permissionDecision, "deny", `${role}: ${c}`);
      assert.match(o.permissionDecisionReason, /axa trust/, `${role}: ${c}`);
    }
  }
});

test("text that merely mentions axa trust (a commit message heredoc, a grep) isn't the CLI", async () => {
  const { axaCli } = await import("../hooks/policy.mjs");
  assert.equal(axaCli("git commit -F - <<'EOF'\nadd axa trust\nEOF"), null);
  assert.equal(axaCli("grep -n 'axa trust' README.md"), null);
  assert.equal(axaCli("cd ~/axa && npm test"), null);
  assert.equal(axaCli("ls bin/axa"), null);
  assert.equal(axaCli("axa"), "hub");
  assert.equal(axaCli("axa status --json"), "status");
});
