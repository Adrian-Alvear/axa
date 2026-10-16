// AXA permission policy (PreToolUse hook). Lets project sessions that AXA starts keep working
// without stopping for the user on routine actions:
//   - ALLOW clearly safe calls: reading and editing inside the project, builds, tests, installs,
//     normal git (status/diff/add/commit, new branches, pushing a non-main branch)
//   - DENY dangerous ones: the shared dangerous-command list, edits outside the project or to
//     .git internals or secret files, reading secret files
//   - everything else: no opinion, so Claude Code's own permission mode decides (it may ask)
// Only acts in AXA project sessions (AXA_ROLE=worker); never in the commander or your own
// sessions. Every decision is logged to ~/.axa/events.jsonl. Per-project settings live in
// ~/.axa/policy.json (see README). Never throws; prints nothing when it has no opinion.
// Hook contract: https://code.claude.com/docs/en/hooks#pretooluse-decision-control
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { dangerousShell, redact } from "../lib/safety.mjs";

const MAX_INPUT = 1024 * 1024;
const home = process.env.AXA_HOME || join(homedir(), ".axa");
const CONSOLE_PORT = Number(process.env.AXA_PORT || 4747);
// Bash that reaches for AXA's controls: the console token, the console's address, ~/.axa, AXA's tmux
const AXA_CONTROLS = new RegExp(String.raw`console-token|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):${CONSOLE_PORT}\b|(?:~|\$HOME|\$\{HOME\}|/home/[^/\s]+|/Users/[^/\s]+)/\.a.a\b`);
// tmux reaching AXA's live server: no -L/-S (inside an AXA session that's AXA's server), -L axa-<port>,
// or -S pointing at that socket. Private sockets (tmux -L axa-clitest, a project's own) are fine.
const reachesAxaTmux = (cmd) => [...cmd.matchAll(/\btmux\b([^\n;&|]*)/g)].some(([, args]) => {
  const sock = /(?:^|\s)-([LS])\s*(\S+)/.exec(args);
  if (!sock) return true;
  const name = sock[2].replace(/^["']|["']$/g, "");
  return sock[1] === "L" ? name === `axa-${CONSOLE_PORT}` : name.split("/").pop() === `axa-${CONSOLE_PORT}`;
});

let raw = "";
process.stdin.on("data", (c) => { if (raw.length < MAX_INPUT) raw += c; });
process.stdin.on("end", () => {
  try {
    if (process.env.AXA_ROLE !== "worker") return process.exit(0);
    const e = JSON.parse(raw);
    const ctx = context(e);
    if (ctx.settings.mode === "off") return process.exit(0);
    const verdict = decide(e.tool_name, e.tool_input || {}, ctx);
    if (!verdict) return process.exit(0);
    log(e, verdict);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: verdict.decision, permissionDecisionReason: `AXA policy: ${verdict.reason}` } }));
  } catch {}
  process.exit(0);
});

// ---------- context: project root, scratch folder, per-project settings ----------
function context(e) {
  const cwd = e.cwd || process.cwd();
  const root = real(process.env.CLAUDE_PROJECT_DIR || cwd);
  // a session in its own worktree (<repo>/.claude/worktrees/<name>) gets its repo's project settings
  const proj = root.replace(/\/\.claude\/worktrees\/[^/]+$/, "");
  let settings = {};
  try {
    const file = JSON.parse(readFileSync(join(home, "policy.json"), "utf8"));
    const projects = file.projects || {};
    const match = Object.entries(projects).find(([k]) => (isAbsolute(k) ? real(k.replace(/^~(?=$|\/)/, homedir())) === proj : k === basename(proj)));
    settings = { ...(file.default || {}), ...(match?.[1] || {}) };
  } catch {}
  return { cwd, root, scratch: e.scratchpad_dir ? real(e.scratchpad_dir) : null, settings };
}

// Real path, resolving symlinks through the nearest folder that exists
function real(p) {
  let cur = resolve(p), rest = [];
  for (;;) {
    try { return join(realpathSync(cur), ...rest); } catch {}
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    rest.unshift(basename(cur)); cur = up;
  }
}
const pathOf = (p, ctx) => real(resolve(ctx.cwd, String(p).replace(/^~(?=$|\/)/, homedir())));
const inside = (p, dir) => { if (!dir) return false; const r = relative(dir, p); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
const inGit = (p, ctx) => relative(ctx.root, p).split(sep)[0] === ".git";
const SECRET = /^(?:\.env(?:rc|\.(?!example$|sample$|template$)[\w.-]+)?|.*\.(?:pem|p12|pfx|key)|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|credentials(?:\.json)?|\.netrc|\.npmrc|\.pypirc)$/i;
const isSecret = (p) => SECRET.test(basename(p)) || /\/\.ssh\/|\/\.aws\/|\/\.gnupg\//.test(p);

// ---------- the decision ----------
const allow = (reason) => ({ decision: "allow", reason });
const deny = (reason) => ({ decision: "deny", reason });

// AXA's own folder (console token, event log, policy) is off limits to project sessions: with the token
// a session could drive the console, e.g. answer its own permission prompts
const AXA_PRIVATE = "AXA's own files (~/.axa) and the console's controls belong to you and the commander; a project session can't use them";

function decide(tool, input, ctx) {
  const strict = ctx.settings.mode === "strict"; // strict: only ever denies
  const ok = (reason) => (strict ? null : allow(reason));
  const target = input.file_path || input.notebook_path || input.path;
  if (target && ["Read", "Glob", "Grep", "LS", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool) && inside(pathOf(target, ctx), real(home))) return deny(AXA_PRIVATE);
  switch (tool) {
    case "Read": {
      const p = pathOf(input.file_path || "", ctx);
      if (isSecret(p)) return deny(`reading a secret file (${basename(p)}) isn't allowed`);
      return inside(p, ctx.root) || inside(p, ctx.scratch) ? ok("reading inside the project") : null;
    }
    case "Glob": case "Grep": case "LS": {
      const p = pathOf(input.path || ".", ctx);
      return inside(p, ctx.root) || inside(p, ctx.scratch) ? ok("searching inside the project") : null;
    }
    case "Edit": case "Write": case "MultiEdit": case "NotebookEdit": {
      const p = pathOf(input.file_path || input.notebook_path || "", ctx);
      if (isSecret(p)) return deny(`editing a secret file (${basename(p)}) isn't allowed; ask the user`);
      if (inside(p, ctx.scratch)) return ok("writing to the session's scratch folder");
      if (!inside(p, ctx.root)) return deny(`${p} is outside this project (${ctx.root}); edit only inside the project`);
      if (inGit(p, ctx)) return deny("editing .git internals isn't allowed; use git commands");
      return ok("editing inside the project");
    }
    case "TodoWrite": case "Skill": case "Agent": case "Task": case "TaskCreate": case "TaskUpdate": case "TaskList": case "TaskGet": case "ToolSearch": case "WebSearch":
      return ok("planning/search tool");
    case "Bash":
      return bash(String(input.command || ""), ctx, ok);
  }
  return null;
}

// ---------- Bash ----------
function bash(cmd, ctx, ok) {
  const danger = dangerousShell(cmd);
  if (danger) return deny(`blocked: ${danger}. Ask the user if this is really needed`);
  // (a pattern check, so a speed bump against a determined session rather than a wall; together with
  // sessions not inheriting $TMUX it keeps project sessions off AXA's controls)
  if (AXA_CONTROLS.test(cmd) || reachesAxaTmux(cmd) || (home !== join(homedir(), ".axa") && cmd.includes(home))) return deny(AXA_PRIVATE);
  for (const re of ctx.settings.denyBash || []) if (safeRe(re)?.test(cmd)) return deny(`blocked by your policy (${re})`);
  if (ctx.settings.mode === "strict") return null;
  for (const re of ctx.settings.allowBash || []) if (safeRe(re, true)?.test(cmd)) return ok(`allowed by your policy (${re})`);
  // Anything we can't read with confidence gets no opinion: expansions, substitutions, heredocs
  if (/[`$]|<\(|>\(|<<|&>|\\\n/.test(cmd)) return null;
  const segments = split(cmd);
  if (!segments) return null;
  // `cd <folder in the project>` is fine. Later segments are checked from every folder they could
  // run in (with `;` the next one runs even if cd failed).
  let cwds = [ctx.cwd];
  for (const words of segments) {
    if (words[0] === "cd") {
      if (words.length !== 2 || words[1] === "-") return null;
      const next = cwds.map((cwd) => pathOf(words[1], { ...ctx, cwd }));
      if (!next.every((p) => inside(p, ctx.root))) return null;
      cwds = [...new Set([...cwds, ...next])];
      continue;
    }
    if (!cwds.every((cwd) => safeSegment(words, { ...ctx, cwd }))) return null;
  }
  return ok("safe command");
}
const safeRe = (s, anchored = false) => { try { return new RegExp(anchored ? `^(?:${s})$` : s); } catch { return null; } };

// Split into segments of words on && || ; | & and newlines, honoring quotes. null = unparseable.
function split(cmd) {
  const segs = [[]], word = { v: "", on: false };
  const push = () => { if (word.on) segs.at(-1).push(word.v); word.v = ""; word.on = false; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" || c === '"') {
      const end = cmd.indexOf(c, i + 1);
      if (end < 0) return null;
      word.v += cmd.slice(i + 1, end); word.on = true; i = end;
    } else if (/\s/.test(c) && c !== "\n") push();
    else if (c === "\n" || c === ";" || c === "|" || c === "&") {
      // keep redirections like 2>&1 and >/dev/null intact
      if (c === "&" && /[0-9]?>$/.test(word.v)) { word.v += c; word.on = true; continue; }
      push(); if (cmd[i + 1] === c) i++; segs.push([]);
    } else { word.v += c; word.on = true; }
  }
  push();
  return segs.filter((s) => s.length);
}

const READ_ONLY = new Set("ls cat head tail wc grep rg pwd echo which true false sort uniq diff tree file stat du cut tr basename dirname realpath printf date".split(" "));
const PKG = new Set(["npm", "pnpm", "yarn", "bun"]);
const NPX_TOOLS = new Set(["tsc", "eslint", "prettier", "vitest", "jest", "playwright", "next", "tsx", "biome", "astro", "vite", "turbo"]);

function safeSegment(words, ctx) {
  const args = [];
  // redirections: only to /dev/null, 2>&1, or files inside the project (not .git, not secrets)
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const m = /^([0-9]?>>?|<)(.*)$/.exec(w);
    if (!m) { args.push(w); continue; }
    const target = m[2] || words[++i];
    if (target === "&1" || target === "&2" || target === "/dev/null") continue;
    if (!target) return false;
    const p = pathOf(target, ctx);
    if (!inside(p, ctx.root) || inGit(p, ctx) || isSecret(p)) return false;
  }
  if (!args.length) return false;
  const [cmd, ...rest] = args;
  if (/=/.test(cmd) || cmd.includes("/")) return false; // env prefixes and ./scripts: no opinion
  const paths = (list) => list.filter((a) => !a.startsWith("-")).every((a) => !/[/~.]/.test(a[0]) || (inside(pathOf(a, ctx), ctx.root) && !isSecret(pathOf(a, ctx))));

  if (READ_ONLY.has(cmd)) return !(cmd === "rg" && rest.some((a) => a.startsWith("--pre"))) && paths(rest);
  if (cmd === "find") return !rest.some((a) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(a)) && paths(rest.filter((a) => !a.startsWith("-")).slice(0, 1));
  if (cmd === "node") return rest[0] === "-v" || rest[0] === "--version" || (rest.length >= 1 && !rest[0].startsWith("-") && inside(pathOf(rest[0], ctx), ctx.root));
  if (cmd === "git") return safeGit(rest, ctx);
  if (PKG.has(cmd)) {
    if (rest.some((a) => a === "-g" || a === "--global" || a === "publish" || a === "unpublish" || a === "login" || a === "token")) return false;
    const sub = rest[0];
    // scripts that ship things aren't routine: leave them to the user
    const script = ["run", "run-script"].includes(sub) ? rest[1] : sub;
    if (/deploy|publish|release|prod|migrate|seed|drop|reset/i.test(script || "")) return false;
    return ["install", "i", "ci", "add", "test", "t", "run", "run-script", "build", "lint", "typecheck", "dev"].includes(sub) || (cmd !== "npm" && sub && !sub.startsWith("-") && !["exec", "dlx", "x", "create", "init", "remove", "rm", "link"].includes(sub));
  }
  if (cmd === "npx") { const tool = rest.find((a) => !a.startsWith("-")); return NPX_TOOLS.has(tool) && !rest.includes("-y") && !rest.includes("--yes"); }
  if (cmd === "pytest") return true;
  if (cmd === "python" || cmd === "python3") return rest[0] === "-m" && ["pytest", "unittest", "mypy", "ruff"].includes(rest[1]);
  if (cmd === "cargo") return ["build", "test", "check", "clippy", "fmt", "run"].includes(rest[0]);
  if (cmd === "go") return ["build", "test", "vet", "fmt", "run"].includes(rest[0]);
  return false;
}

function safeGit(rest, ctx) {
  const [sub, ...a] = rest;
  const flags = a.filter((x) => x.startsWith("-"));
  switch (sub) {
    case "status": case "diff": case "log": case "show": case "rev-parse": case "fetch": case "shortlog": case "blame": case "ls-files":
      return true;
    case "remote": return a.length === 0 || (a.length === 1 && a[0] === "-v");
    case "branch": return a.every((x) => ["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all"].includes(x));
    case "add": return !a.some((x) => x === "-f" || x === "--force");
    case "commit": return !a.includes("--no-verify") && !a.includes("-n");
    case "checkout": case "switch": return (flags.includes("-b") || flags.includes("-c")) && !flags.includes("-B") && !flags.includes("-C");
    case "stash": return ["push", "list", "show", undefined].includes(a[0]);
    case "push": {
      if (a.some((x) => /^(?:-f|--force(?:-with-lease)?|--delete|-d|--mirror|--all|--tags)$/.test(x) || x.startsWith("+") || x.startsWith(":"))) return false;
      const positional = a.filter((x) => !x.startsWith("-"));
      let branch = positional[1];
      if (!branch) { try { branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.cwd, encoding: "utf8", timeout: 2000 }).trim(); } catch { return false; } }
      const target = branch.includes(":") ? branch.split(":").pop() : branch;
      return !["main", "master", "HEAD", "production", "prod", "release"].includes(target);
    }
  }
  return false;
}

// ---------- log ----------
function log(e, v) {
  try {
    const input = e.tool_input || {};
    const summary = redact(String(input.command || input.file_path || input.notebook_path || input.path || input.pattern || "")).slice(0, 200);
    const ev = { ts: Date.now(), event: "PolicyDecision", session: e.session_id, cwd: e.cwd, tool: e.tool_name, decision: v.decision, reason: v.reason, summary, terminal: process.env.AXA_TERMINAL_ID || undefined, role: process.env.AXA_ROLE };
    const file = join(home, "events.jsonl");
    if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
    const fresh = !existsSync(file);
    appendFileSync(file, JSON.stringify(ev) + "\n", { mode: 0o600 });
    if (fresh) chmodSync(file, 0o600);
  } catch {}
}
