// AXA permission policy (PreToolUse hook). Lets project sessions that AXA starts keep working
// without stopping for the user on routine actions:
//   - ALLOW clearly safe calls: reading and editing inside the project, builds, tests, installs,
//     normal git (status/diff/add/commit, new branches, pushing a non-main branch)
//   - DENY dangerous ones: the shared dangerous-command list, edits outside the project or to
//     .git internals or secret files, reading secret files
//   - everything else: no opinion, so Claude Code's own permission mode decides (it may ask)
// Acts in AXA project sessions (AXA_ROLE=worker) and, with its own narrower rules, in AXA's commander
// (AXA_ROLE=commander, see "the commander" below); never in your own sessions. Every decision is
// logged to ~/.axa/events.jsonl. Per-project settings live in ~/.axa/policy.json (see README).
// Never throws; prints nothing when it has no opinion. The approver imports its helpers
// (localReversible, heredocWrite, commanderRead...), so the hook only runs when this is the script.
// Hook contract: https://code.claude.com/docs/en/hooks#pretooluse-decision-control
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { dangerousShell, oneWayDoor, redact } from "../lib/safety.mjs";

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

const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  let raw = "";
  process.stdin.on("data", (c) => { if (raw.length < MAX_INPUT) raw += c; });
  process.stdin.on("end", () => {
    try {
      const role = process.env.AXA_ROLE;
      if (role !== "worker" && role !== "commander") return process.exit(0);
      const e = JSON.parse(raw);
      const ctx = context(e);
      if (ctx.settings.mode === "off") return process.exit(0);
      const verdict = (role === "commander" ? decideCommander : decide)(e.tool_name, e.tool_input || {}, ctx);
      if (!verdict) return process.exit(0);
      log(e, verdict);
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: verdict.decision, permissionDecisionReason: `AXA policy: ${verdict.reason}` } }));
    } catch {}
    process.exit(0);
  });
}

// ---------- context: project root, scratch folder, per-project settings ----------
export function context(e) {
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
// Claude Code's own settings: a session that edits them could switch AXA's checks off (env AXA_ROLE,
// disableAllHooks, permissions.allow), so they're never auto-approved
// (case-insensitive: folders on Windows drives, /mnt/c under WSL, ignore case)
const isClaudeSettings = (p) => /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/i.test(p);
// Secret files by name (the list above plus more credential stores and shell history), and private
// places: credential and config folders in the home folder, other processes' memory/env. Used for
// the commander's reads and the approver's read-only fast path.
const PRIVATE_NAME = /^(?:\.env(?:rc|\.(?!example$|sample$|template$)[\w.-]+)?|.*\.(?:pem|p12|pfx|key|keystore|jks|ppk)|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|\.?credentials(?:\.json)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.pgpass|\.htpasswd|\.vault-token|\.s3cfg|\.boto|\.claude\.json|kubeconfig|\.?\w*_history)$/i;
export const PRIVATE_HOME = [".ssh", ".aws", ".gnupg", ".claude", ".config", ".docker", ".kube", ".azure", ".gcloud", ".password-store", ".local/share", ".mozilla", ".pki", ".terraform.d"];
const PRIVATE_ROOT = /^\/(?:proc|sys|dev|root)(?:\/|$)|^\/etc\/(?:shadow|gshadow|sudoers)/;
export function isPrivatePath(p) {
  if (PRIVATE_NAME.test(basename(p)) || PRIVATE_ROOT.test(p)) return true;
  const h = real(homedir());
  return PRIVATE_HOME.some((d) => inside(p, join(h, d)));
}
// a folder whose tree holds a private place or AXA's folder (a recursive search from it reads them)
const holdsPrivate = (p) => [...PRIVATE_HOME.map((d) => join(real(homedir()), d)), real(home)].some((d) => inside(d, p));
// A real project folder: not the home folder (or above it), not AXA's folder, not a private place.
// The commander usually runs in the home folder: then nothing counts as "inside its project".
const projectRoot = (ctx) => !inside(real(homedir()), ctx.root) && !inside(ctx.root, real(home)) && !isPrivatePath(ctx.root);
// A file a session may change without the user: inside the project (not the folder itself), not
// .git, not a secret or private place, not Claude Code's settings, not AXA's folder
const projectFile = (p, ctx) => inside(p, ctx.root) && p !== ctx.root && !inGit(p, ctx) && !isSecret(p) && !isPrivatePath(p) && !isClaudeSettings(p) && !inside(p, real(home));

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
      if (isClaudeSettings(p)) return deny("editing Claude Code's settings (.claude/settings*.json) isn't allowed: it could switch off AXA's checks; ask the user");
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
  const segments = split(cmd);
  // any argument (relative too, or an --opt=value) that lands in AXA's folder, and writes to Claude
  // Code's settings, are denied whatever the command
  const touch = segments && touches(segments, ctx);
  if (touch) return touch;
  if (ctx.settings.mode === "strict") return null;
  // a one-way door is never auto-allowed by allowBash: no opinion, so the approver sends it to the user
  for (const re of ctx.settings.allowBash || []) if (safeRe(re, true)?.test(cmd)) return oneWayDoor("Bash", { command: cmd }) ? null : ok(`allowed by your policy (${re})`);
  // Anything we can't read with confidence gets no opinion: expansions, substitutions, heredocs
  if (/[`$]|<\(|>\(|<<|&>/.test(cmd) || escapes(cmd)) return null;
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
  // a one-way door (e.g. a push to main spelled in a way safeGit misses) is never auto-allowed
  return oneWayDoor("Bash", { command: cmd }) ? null : ok("safe command");
}
// Every word that could name a file: the word itself, the value of --opt=value / -o=value, the rest
// of a short option (-oFILE), a redirection's target
const pathWords = (w) => {
  const out = [];
  const r = /^[0-9]?(?:>>?|<)(.*)$/.exec(w);
  if (r) { if (r[1] && !r[1].startsWith("&")) out.push(r[1]); return out; }
  if (!w.startsWith("-")) out.push(w);
  const eq = w.indexOf("=");
  if (eq >= 0 && eq < w.length - 1) out.push(w.slice(eq + 1));
  if (/^-[^-]./.test(w)) out.push(w.slice(2));
  return out;
};
// Files a segment writes: redirection targets, sort -o/--output, uniq's output, git --output,
// tee's files, cp/mv/install's destination
function writeTargets(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const m = /^[0-9]?>>?(.*)$/.exec(words[i]);
    if (m) out.push(m[1] || words[i + 1] || "");
  }
  const args = words.filter((w, i) => !/^[0-9]?(?:>>?|<)/.test(w) && !(i > 0 && /^[0-9]?(?:>>?|<)$/.test(words[i - 1])));
  const [cmd, ...rest] = args;
  const pos = rest.filter((a) => !a.startsWith("-"));
  rest.forEach((a, i) => {
    if (cmd === "sort" || cmd === "git") {
      const long = /^--(?:o|out|outp|outpu|output)(?:=(.*))?$/.exec(a);
      if (long && (cmd === "sort" || a.startsWith("--out"))) out.push(long[1] ?? rest[i + 1] ?? "");
      if (cmd === "sort" && /^-[^-]*o/.test(a)) out.push(a.slice(a.indexOf("o") + 1) || rest[i + 1] || "");
    }
    if (cmd === "tree" && /^-[^-]*o/.test(a)) out.push(a.slice(a.indexOf("o") + 1) || rest[i + 1] || "");
    if (cmd === "tree" && a.startsWith("--o")) out.push(a.split("=")[1] || rest[i + 1] || "");
  });
  if (cmd === "uniq" && pos[1]) out.push(pos[1]);
  if (cmd === "tee") out.push(...pos);
  if (COPIERS.has(cmd) && pos.length) out.push(pos.at(-1));
  return out;
}
const COPIERS = new Set(["cp", "mv", "install", "ln", "rsync"]);
// A write that could land on Claude Code's settings: a target that names them, or a copy whose
// destination is a .claude folder (the file name then comes from the source) or that moves or
// copies a .claude folder itself, or a folder's contents ("x/.", ".", rsync's "x/") holding one
function settingsWrite(words, at) {
  if (writeTargets(words).some((w) => w && (isClaudeSettings(at(w)) || isClaudeSettings(w)))) return true;
  const args = words.filter((w) => !/^[0-9]?(?:>>?|<)/.test(w));
  if (!COPIERS.has(args[0])) return false;
  const pos = args.slice(1).filter((a) => !a.startsWith("-"));
  const claude = (w) => /^\.claude$/i.test(basename(at(w))) || /(?:^|\/)\.claude\/?$/i.test(w);
  const contents = (w) => w === "." || w.endsWith("/.") || (args[0] === "rsync" && w.endsWith("/"));
  return pos.some(claude) || pos.slice(0, -1).some((w) => contents(w) && existsSync(join(at(w), ".claude")));
}
const SETTINGS_WRITE = "writing Claude Code's settings (.claude/settings*.json) isn't allowed: it could switch off AXA's checks; ask the user";
// deny when any word reaches AXA's folder (from every folder the segment could run in) or a write
// lands on Claude Code's settings; null otherwise
function touches(segments, ctx) {
  const axa = real(home);
  let cwds = [ctx.cwd];
  for (const words of segments) {
    if (words[0] === "cd" && words.length === 2 && words[1] !== "-") {
      const next = cwds.map((cwd) => pathOf(words[1], { ...ctx, cwd }));
      if (next.some((p) => inside(p, axa))) return deny(AXA_PRIVATE);
      cwds = [...new Set([...cwds, ...next])];
      continue;
    }
    for (const cwd of cwds) {
      const at = (w) => pathOf(w, { ...ctx, cwd });
      if (words.flatMap(pathWords).some((w) => inside(at(w), axa))) return deny(AXA_PRIVATE);
      if (settingsWrite(words, at)) return deny(SETTINGS_WRITE);
    }
  }
  return null;
}
// A backslash the shell would act on (outside single quotes): what runs differs from how it reads
function escapes(cmd) {
  let q = "";
  for (const c of cmd) {
    if (q) { if (c === q) q = ""; else if (c === "\\" && q === '"') return true; }
    else if (c === "'" || c === '"') q = c;
    else if (c === "\\") return true;
  }
  return false;
}
const safeRe = (s, anchored = false) => { try { return new RegExp(anchored ? `^(?:${s})$` : s); } catch { return null; } };

// Split into segments of words on && || ; | & and newlines, honoring quotes and, outside them,
// backslashes as the shell reads them (.cl\aude is .claude). null = unparseable.
function split(cmd) {
  const segs = [[]], word = { v: "", on: false };
  const push = () => { if (word.on) segs.at(-1).push(word.v); word.v = ""; word.on = false; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\") {
      if (cmd[i + 1] !== "\n" && i + 1 < cmd.length) { word.v += cmd[i + 1]; word.on = true; }
      i++;
    } else if (c === "'" || c === '"') {
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
    if (!inside(p, ctx.root) || inGit(p, ctx) || isSecret(p) || isClaudeSettings(p)) return false;
  }
  if (!args.length) return false;
  const [cmd, ...rest] = args;
  if (/=/.test(cmd) || cmd.includes("/")) return false; // env prefixes and ./scripts: no opinion
  const paths = (list) => list.flatMap(pathWords).every((a) => !/[/~.]/.test(a[0]) || (inside(pathOf(a, ctx), ctx.root) && !isSecret(pathOf(a, ctx))));
  // option values that name files go through the same check as plain paths, for every command
  if (!paths(rest.filter((a) => a.startsWith("-")))) return false;
  // commands here that can write a file: not auto-allowed
  if (writeTargets(args).length) return false;

  // (rg --pre and sort --compress-program run a program of the session's choosing)
  if (READ_ONLY.has(cmd)) return !(cmd === "rg" && rest.some((a) => a.startsWith("--pre"))) && !(cmd === "sort" && rest.some((a) => a.startsWith("--co"))) && paths(rest);
  if (cmd === "find") return !rest.some((a) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(a)) && paths(rest.filter((a) => !a.startsWith("-")).slice(0, 1));
  if (cmd === "node") return rest[0] === "-v" || rest[0] === "--version" || (rest.length >= 1 && !rest[0].startsWith("-") && inside(pathOf(rest[0], ctx), ctx.root));
  if (cmd === "git") return paths(rest) && safeGit(rest, ctx);
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

const GIT_RISKY = ["upload-pack", "receive-pack", "exec", "exec-path", "ext-diff", "textconv", "no-index", "output"];
const GIT_SAFE_FLAGS = {
  fetch: new Set(["--all", "--prune", "-p", "--tags", "-t", "--no-tags", "--verbose", "-v", "--quiet", "-q", "--dry-run", "--unshallow", "--prune-tags", "-P", "--force-with-lease-never"]),
  push: new Set(["-u", "--set-upstream", "--verbose", "-v", "--quiet", "-q", "--dry-run", "-n", "--porcelain", "--progress"]),
};
// --output=FILE (log, diff, show, format-patch...) writes a file; other options run a program of the
// session's choosing (--upload-pack, --exec, external diff and textconv) or read files outside the
// repository (--no-index). (git takes any unambiguous prefix of a long option: --upl= is --upload-pack=)
const gitRisky = (rest) => rest.some((x) => /^--out(?:p(?:u(?:t)?)?)?(?:=|$)/.test(x)) || rest.some((x) => { const name = /^--([^=]+)/.exec(x)?.[1]; return name?.length >= 2 && GIT_RISKY.some((full) => full.startsWith(name)); });
const PROTECTED = ["main", "master", "head", "production", "prod", "release"];
function safeGit(rest, ctx) {
  const [sub, ...a] = rest;
  if (gitRisky(rest)) return false;
  // fetch and push only with flags known to be harmless
  if ((sub === "fetch" || sub === "push") && a.some((x) => x.startsWith("-") && !(GIT_SAFE_FLAGS[sub].has(x) || /^--depth=\d+$/.test(x)))) return false;
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
      // every refspec counts (`git push origin feat main` pushes main too), refs/heads/main is main
      // a bare HEAD (or no refspec) pushes the current branch under its own name
      const current = () => { try { return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.cwd, encoding: "utf8", timeout: 2000 }).trim(); } catch { return null; } };
      let refs = a.filter((x) => !x.startsWith("-")).slice(1);
      if (!refs.length) refs = ["HEAD"];
      return refs.every((ref) => {
        // (refs/for/main is a Gerrit push to main, git expands heads/main to refs/heads/main; remotes
        // may not care about case)
        let target = (ref.includes(":") ? ref.split(":").pop() : ref).replace(/^(?:refs\/)?(?:heads|for)\//, "");
        // HEAD and @ are the current branch; any other ref syntax (@{..}, ~, ^) isn't routine
        if (target === "HEAD" || target === "@") target = current();
        // stricter still: any ref ending in a protected name (x/main, remotes/origin/release) isn't routine
        return !!target && /^[\w./-]+$/.test(target) && !PROTECTED.includes(target.toLowerCase()) && !PROTECTED.includes(target.split("/").pop().toLowerCase());
      });
    }
  }
  return false;
}

// ---------- the commander (AXA_ROLE=commander) ----------
// The user's orchestrator: it reads across the home folder and drives the console's API, so it gets
// its own, narrower rules. It never answers prompts (the /answer route and the page/TUI headers are
// the user's), never changes AXA's own files and only reads three of them (event log, session list,
// console token: for its own console API). Its edits are auto-allowed only inside a real project
// folder it runs in (never the home folder, never AXA's own code). Everything else: no opinion, so
// the approver (or the user) decides.
const AXA_READABLE = new Set(["events.jsonl", "sessions.json", "console-token"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const NO_ANSWER = "the commander never answers permission prompts or questions: the console's /answer route (and its x-axa-client / sec-fetch-site headers) is only for the user";
const AXA_WRITE = "changing AXA's own files (~/.axa) is for the user; the commander only reads its event log, session list and console token";
const PLUGIN = real(join(dirname(fileURLToPath(import.meta.url)), ".."));
// Readable by the commander without asking: in the home folder, not a secret or private place; in
// AXA's folder only the three files above
const readable = (p) => { const axa = real(home); return inside(p, axa) ? AXA_READABLE.has(relative(axa, p)) : inside(p, real(homedir())) && !isSecret(p) && !isPrivatePath(p); };

// Bash that answers a prompt through the console: the /answer route or the page/TUI headers, with
// anything that can make a request (quotes and backslashes dropped first: x-axa-"client" counts)
export function answersPrompt(cmd) {
  const t = String(cmd || "").replace(/["'\\]/g, "");
  return /\b(?:curl|wget|https?|xh|nc|ncat|socat|telnet|node|deno|bun|python[\d.]*|perl|ruby|php|fetch)\b/i.test(t) && (/\/answer(?![\w-])/i.test(t) || /x-axa-client|sec-fetch-site/i.test(t));
}

export function decideCommander(tool, input, ctx) {
  const ok = (reason) => (ctx.settings.mode === "strict" ? null : allow(reason));
  if (EDIT_TOOLS.has(tool)) {
    const p = pathOf(input.file_path || input.notebook_path || "", ctx);
    if (inside(p, real(home))) return deny(AXA_WRITE);
    if (isSecret(p)) return deny(`editing a secret file (${basename(p)}) isn't allowed; ask the user`);
    if (isClaudeSettings(p)) return deny("editing Claude Code's settings (.claude/settings*.json) isn't allowed: it could switch off AXA's checks; ask the user");
    if (!projectRoot(ctx) || !inside(p, ctx.root) || inside(p, PLUGIN)) return null;
    if (inGit(p, ctx)) return deny("editing .git internals isn't allowed; use git commands");
    return projectFile(p, ctx) ? ok("editing inside the commander's project") : null;
  }
  if (READS.has(tool)) { const v = commanderRead(tool, input, ctx); return v?.decision === "allow" ? ok(v.reason) : v; }
  if (tool === "Bash") return commanderBash(String(input.command || ""), ctx, ok);
  return null;
}

// allow / deny for the commander's read-only tools, or null (no opinion). Shared with the approver.
export function commanderRead(tool, input, ctx) {
  if (!READS.has(tool)) return null;
  const axa = real(home);
  const base = pathOf(input.path || input.file_path || input.notebook_path || ".", ctx);
  const paths = [base];
  // a Glob pattern can climb out of its folder: check the fixed part before the first wildcard
  const pattern = tool === "Glob" ? String(input.pattern || "") : "";
  if (pattern) { const fixed = pattern.split(/[*?[{]/)[0]; paths.push(pathOf(fixed.includes("/") ? fixed.slice(0, fixed.lastIndexOf("/") + 1) || "/" : ".", { ...ctx, cwd: base })); }
  if (paths.some((p) => inside(p, axa))) return tool === "Read" && AXA_READABLE.has(relative(axa, base)) ? allow("reading AXA's event log, session list or console token (the commander's own console)") : null;
  if (tool === "Read" && isSecret(base)) return deny(`reading a secret file (${basename(base)}) isn't allowed`);
  if (!paths.every(readable)) return null;
  // Grep reads contents across a tree and a Glob lists names: not from a folder holding private
  // places or AXA's folder, and a Glob pattern must not climb out (.., or a brace group with a path)
  if (tool === "Grep" || tool === "Glob") {
    if (paths.some(holdsPrivate)) return null;
    if (/(?:^|[/{,])\.\.(?:$|[/},])/.test(pattern) || /\{[^}]*[/~][^}]*\}/.test(pattern) || /[{}]/.test(pattern.replace(/\{[^{}]*\}/g, ""))) return null;
  }
  return allow(`${tool} only reads; nothing is changed`);
}

function commanderBash(cmd, ctx, ok) {
  const danger = dangerousShell(cmd);
  if (danger) return deny(`blocked: ${danger}. Ask the user if this is really needed`);
  if (answersPrompt(cmd)) return deny(NO_ANSWER);
  for (const re of ctx.settings.denyBash || []) if (safeRe(re)?.test(cmd)) return deny(`blocked by your policy (${re})`);
  const segments = split(cmd);
  const w = segments && commanderWrites(segments, ctx);
  if (w) return w;
  if (ctx.settings.mode === "strict") return null;
  if (/[`$]|<\(|>\(|<<|&>/.test(cmd) || escapes(cmd) || !segments?.length) return null;
  let cwds = [ctx.cwd];
  for (const words of segments) {
    if (words[0] === "cd") {
      if (words.length !== 2 || words[1] === "-") return null;
      const next = cwds.map((cwd) => pathOf(words[1], { ...ctx, cwd }));
      if (!next.every(readable)) return null;
      cwds = [...new Set([...cwds, ...next])];
      continue;
    }
    if (!cwds.every((cwd) => readable(cwd) && commanderSegment(words, { ...ctx, cwd }))) return null;
  }
  return oneWayDoor("Bash", { command: cmd }) ? null : ok("read-only command");
}

// Writes into AXA's folder (redirections, cp/mv/tee targets, or any path of a command that changes
// files) and to Claude Code's settings: denied. Reads of AXA's folder are left to commanderSegment.
const CHANGERS = new Set("rm rmdir mv cp touch mkdir chmod chown chgrp truncate sed perl dd unlink shred tee install ln rsync".split(" "));
function commanderWrites(segments, ctx) {
  const axa = real(home);
  let cwds = [ctx.cwd];
  for (const words of segments) {
    if (words[0] === "cd" && words.length === 2 && words[1] !== "-") { cwds = [...new Set([...cwds, ...cwds.map((cwd) => pathOf(words[1], { ...ctx, cwd }))])]; continue; }
    // the program: past redirections, VAR=value prefixes and wrappers that run the next word
    const prog = words.find((w) => !/^[0-9]?(?:>>?|<)|^\w+=|^(?:env|command|nice|nohup|time|exec|builtin)$/.test(w));
    for (const cwd of cwds) {
      const at = (w) => pathOf(w, { ...ctx, cwd });
      const writes = writeTargets(words);
      if (settingsWrite(words, at)) return deny(SETTINGS_WRITE);
      if ((CHANGERS.has(prog) ? words.flatMap(pathWords) : writes).some((w) => w && inside(at(w), axa))) return deny(AXA_WRITE);
    }
  }
  return null;
}

function commanderSegment(words, ctx) {
  const args = [];
  // redirections: only to /dev/null or 2>&1, or reading a readable file
  for (let i = 0; i < words.length; i++) {
    const m = /^([0-9]?>>?|<)(.*)$/.exec(words[i]);
    if (!m) { args.push(words[i]); continue; }
    const target = m[2] || words[++i];
    if (target === "&1" || target === "&2" || target === "/dev/null") continue;
    if (m[1] !== "<" || !target || !readable(pathOf(target, ctx))) return false;
  }
  const [cmd, ...rest] = args;
  if (!cmd || /[=/]/.test(cmd)) return false;
  if (cmd === "curl") return localCurl(rest);
  // every word that could name a file (a grep pattern too, conservatively) must be readable
  if (!rest.flatMap(pathWords).every((w) => readable(pathOf(w, ctx)))) return false;
  const at = (w) => pathOf(w, ctx);
  // the folders a recursive search reads: the named paths when they all exist, else also the cwd
  const searched = (pattern) => {
    const pos = rest.filter((a) => !a.startsWith("-"));
    const named = pattern && !rest.some((a) => /^-[ef]|^--(?:regexp|file)\b/.test(a)) ? pos.slice(1) : pos;
    return named.length && named.every((w) => existsSync(at(w))) ? named.map(at) : [ctx.cwd, ...pos.map(at)];
  };
  switch (cmd) {
    case "cat": case "head": case "tail": case "wc": case "pwd": return true;
    case "ls": return !rest.some((a) => /^-[a-zA-Z]*R|^--recursive$/.test(a)) || !searched(false).some(holdsPrivate);
    case "grep": return !rest.some((a) => /^-[a-zA-Z]*[rRd]|^--(?:recursive|dereference-recursive|directories)\b/.test(a)) || !searched(true).some(holdsPrivate);
    case "rg": return !rest.some((a) => a.startsWith("--pre")) && !searched(true).some(holdsPrivate);
    case "git": {
      const [sub, ...a] = rest;
      if (gitRisky(rest)) return false;
      if (["log", "status", "diff", "show", "rev-parse"].includes(sub)) return true;
      return sub === "branch" && a.every((x) => ["--list", "-a", "-r", "-v", "-vv", "--all", "--show-current"].includes(x));
    }
    case "node":
      // (one plain file: an option such as --import=… would run code before the check)
      if (rest[0] === "--check") return rest.length === 2 && !rest[1].startsWith("-") && existsSync(at(rest[1]));
      // tests run the project's code: only inside a real project folder the commander runs in
      if (rest[0] === "--test") return projectRoot(ctx) && inside(ctx.cwd, ctx.root) && rest.slice(1).every((w) => !w.startsWith("-") && inside(at(w), ctx.root));
      return false;
  }
  return false;
}

// curl to this machine only: localhost / 127.0.0.1 / [::1], GET only, a few harmless options;
// nothing that sends data (a POST to the console can type into a session), reads a file into the
// request, writes a file, follows redirects elsewhere, changes the Host or goes through a proxy
const CURL_FLAG = /^-[sSfiv]+$|^--(?:silent|show-error|fail|fail-with-body|include|verbose|compressed|no-progress-meter|globoff)$/;
const CURL_VALUE = /^(?:-H|--header|-X|--request|-m|--max-time|--connect-timeout|-w|--write-out|-o|--output|-b|--cookie)$/;
const LOCAL_URL = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[\w\-./?=&,:+~]*)?$/i;
function localCurl(rest) {
  let urls = 0;
  for (let i = 0; i < rest.length; i++) {
    let a = rest[i], v;
    if (CURL_FLAG.test(a)) continue;
    const m = /^(--[\w-]+)=([\s\S]*)$/.exec(a) || /^(-[HXmwob])([\s\S]+)$/.exec(a);
    if (m) { a = m[1]; v = m[2]; }
    if (CURL_VALUE.test(a)) {
      if (v === undefined) { if (i + 1 >= rest.length) return false; v = rest[++i]; }
      if (v.startsWith("@")) return false;
      if (/^(?:-X|--request)$/.test(a) && v !== "GET") return false;
      // (a cookie value only: -b without "=" names a cookie file to read)
      if (/^(?:-b|--cookie)$/.test(a) && !v.includes("=")) return false;
      if (/^(?:-o|--output)$/.test(a) && v !== "/dev/null") return false;
      if (/^(?:-m|--max-time|--connect-timeout)$/.test(a) && !/^\d+(?:\.\d+)?$/.test(v)) return false;
      if (/^(?:-H|--header)$/.test(a) && /^\s*host\s*:/i.test(v)) return false;
      continue;
    }
    if (a.startsWith("-") || !LOCAL_URL.test(a)) return false;
    urls++;
  }
  return urls > 0;
}

// ---------- local and reversible: the approver's fallback when its model can't be reached ----------
// True only for what can't leave the machine or lose work: edits inside a real project folder, and
// Bash whose every part is a known local command (read-only commands, mkdir/touch/cp/mv/chmod inside
// the project, rm only in build output and temp folders, git that doesn't rewrite history or reach a
// remote) or a heredoc that only writes a project file. Never a one-way door, AXA's controls or
// anything unparseable; never in strict mode.
const DISPOSABLE = new Set(["dist", "build", "out", "coverage", ".cache", "tmp", "node_modules", "target", "__pycache__"]);
function disposable(p, ctx) {
  // (a build folder at the project's top only: src/build may be source)
  if (inside(p, ctx.root)) return projectFile(p, ctx) && DISPOSABLE.has(relative(ctx.root, p).split(sep)[0]);
  if (ctx.scratch && inside(p, ctx.scratch) && p !== ctx.scratch) return true;
  // (never the home folder, even when it sits under /tmp)
  return [real("/tmp"), real(tmpdir())].some((d) => inside(p, d) && p !== d) && !inside(p, real(homedir()));
}
export function localReversible(tool, input, ctx) {
  try {
    if (ctx.settings.mode === "strict" || !projectRoot(ctx)) return false;
    if (EDIT_TOOLS.has(tool)) return projectFile(pathOf(input.file_path || input.notebook_path || "", ctx), ctx);
    if (tool !== "Bash") return false;
    const cmd = String(input.command || "");
    if (!cmd.trim() || oneWayDoor("Bash", { command: cmd }) || answersPrompt(cmd)) return false;
    if (AXA_CONTROLS.test(cmd) || reachesAxaTmux(cmd) || cmd.includes(home)) return false;
    for (const re of ctx.settings.denyBash || []) if (safeRe(re)?.test(cmd)) return false;
    // a heredoc only when the whole command just writes its text to a project file (not Python:
    // without a model, code that could delete or rewrite files isn't "known local")
    if (cmd.includes("<<")) return heredocWrite(cmd, ctx)?.kind === "shell";
    if (/[`$]|<\(|>\(|&>/.test(cmd) || escapes(cmd)) return false;
    const segments = split(cmd);
    if (!segments?.length || touches(segments, ctx)) return false;
    let cwds = [ctx.cwd];
    for (const words of segments) {
      if (words[0] === "cd") {
        if (words.length !== 2 || words[1] === "-") return false;
        const next = cwds.map((cwd) => pathOf(words[1], { ...ctx, cwd }));
        if (!next.every((p) => inside(p, ctx.root))) return false;
        cwds = [...new Set([...cwds, ...next])];
        continue;
      }
      if (!cwds.every((cwd) => inside(cwd, ctx.root) && localSegment(words, { ...ctx, cwd }))) return false;
    }
    return true;
  } catch { return false; }
}
function localSegment(words, ctx) {
  // braces, brackets and .. segments can expand or resolve (through symlinks) differently from how
  // they read: not local
  if (!words.length || words.some((w) => /[{}[\]]|(?:^|\/)\.\.(?:\/|$)/.test(w))) return false;
  const [cmd, ...rest] = words;
  if (/[=/]/.test(cmd)) return false;
  if (READ_ONLY.has(cmd) || cmd === "find") return safeSegment(words, ctx);
  if (words.some((w) => /^[0-9]?(?:>>?|<)/.test(w))) return false;
  const opts = rest.filter((a) => a.startsWith("-")), pos = rest.filter((a) => !a.startsWith("-"));
  const proj = (w) => projectFile(pathOf(w, ctx), ctx);
  const only = (re) => opts.every((o) => re.test(o));
  switch (cmd) {
    case "mkdir": return pos.length > 0 && only(/^-[pv]+$|^--(?:parents|verbose)$/) && pos.every(proj);
    case "touch": return pos.length > 0 && !opts.length && pos.every(proj);
    case "cp": return pos.length >= 2 && only(/^-[rRapfnv]+$|^--(?:recursive|archive|force|no-clobber|verbose)$/) && pos.every(proj);
    case "mv": return pos.length >= 2 && only(/^-[fnv]+$|^--(?:force|no-clobber|verbose)$/) && pos.every(proj);
    // (no setuid/setgid/sticky: three octal digits or rwxX only)
    case "chmod": return !opts.length && pos.length >= 2 && /^(?:[0-7]{3}|[ugoa]*[-+=][rwxX]+(?:,[ugoa]*[-+=][rwxX]+)*)$/.test(pos[0]) && pos.slice(1).every(proj);
    case "rm": case "rmdir": return pos.length > 0 && only(/^-[rRfdv]+$|^--(?:recursive|force|dir|verbose)$/) && pos.every((w) => disposable(pathOf(w, ctx), ctx));
    case "curl": return localCurl(rest); // this machine only (AXA's console port was refused above)
    case "git": {
      // no remote (fetch/push), no history rewrite (commit --amend; reset/rebase/... aren't in safeGit)
      if (["fetch", "push", "remote"].includes(rest[0]) || (rest[0] === "commit" && rest.some((a) => a.startsWith("--am")))) return false;
      return rest.flatMap(pathWords).every((a) => !/[/~.]/.test(a[0]) || (inside(pathOf(a, ctx), ctx.root) && !isSecret(pathOf(a, ctx)))) && safeGit(rest, ctx);
    }
  }
  return false;
}

// ---------- heredocs and inline Python that only write a project file ----------
// When the whole command is exactly one of
//   cat > F <<'EOF' … EOF · cat <<EOF >> F … EOF · tee [-a] F [>/dev/null] <<EOF … EOF
//   python3 - <<'EOF' … EOF · python3 -c '…'  (code that only opens project files, imports nothing
//   but a few text modules, and has no subprocess/os/exec/eval/network/introspection words)
// returns { kind: "shell" | "python", targets, stripped }, where stripped is the command without
// its text (to check that a rule matched only the text); otherwise null. With an unquoted delimiter
// the shell expands $(…) and `…` in the text, so then the text may hold no $, ` or \. Every target
// must be a project file (not .git, a secret, Claude Code's settings or AXA's folder).
export function heredocWrite(cmd, ctx) {
  try {
    const s = String(cmd ?? "");
    if (!projectRoot(ctx)) return null;
    const pc = /^\s*python3?\s+-c\s+'([^']*)'\s*$/.exec(s);
    if (pc) { const t = pyWrites(pc[1], ctx); return t && { kind: "python", targets: t, stripped: "python3 -c ''" }; }
    const nl = s.indexOf("\n");
    if (nl < 0) return null;
    const head = s.slice(0, nl);
    const m = /<<(-?)[ \t]*(?:'([A-Za-z_][\w.-]*)'|"([A-Za-z_][\w.-]*)"|([A-Za-z_][\w.-]*))/.exec(head);
    if (!m || head.indexOf("<<", m.index + 2) >= 0) return null;
    const tag = m[2] || m[3] || m[4];
    const lines = s.slice(nl + 1).split("\n");
    const end = lines.findIndex((l) => (m[1] ? l.replace(/^\t+/, "") : l) === tag);
    if (end < 0 || lines.slice(end + 1).some((l) => l.trim())) return null;
    const body = lines.slice(0, end).join("\n");
    if (m[4] && /[`$\\]/.test(body)) return null;
    const rest = `${head.slice(0, m.index)} ${head.slice(m.index + m[0].length)}`;
    if (/[`$;&|()<\\]/.test(rest)) return null;
    const segs = split(rest);
    if (!segs || segs.length !== 1) return null;
    const [prog, ...args] = segs[0];
    if (prog === "python" || prog === "python3") {
      if (args.length > 1 || (args.length === 1 && args[0] !== "-")) return null;
      const t = pyWrites(body, ctx);
      return t && { kind: "python", targets: t, stripped: head };
    }
    const outs = [], plain = [];
    for (let i = 0; i < args.length; i++) {
      const r = /^([0-9]?)(>>?)(.*)$/.exec(args[i]);
      if (!r) { plain.push(args[i]); continue; }
      const t = r[3] || args[++i];
      if (!t || (r[1] && r[1] !== "1")) return null;
      outs.push(t);
    }
    let files;
    if (prog === "cat" && outs.length === 1 && plain.every((w) => w === "-")) files = outs;
    else if (prog === "tee" && outs.every((t) => t === "/dev/null")) {
      files = plain.filter((w) => w !== "-a" && w !== "--append");
      if (files.length !== 1 || files[0].startsWith("-")) return null;
    } else return null;
    return files.every((f) => projectFile(pathOf(f, ctx), ctx)) ? { kind: "shell", targets: files, stripped: head } : null;
  } catch { return null; }
}

// Python source → the project files it writes, or null. String literals are set aside first (so
// test data in them doesn't count as code); f-strings (code inside the text) aren't read at all.
const PY_IMPORTS = new Set(["re", "json", "textwrap", "string", "collections", "itertools", "functools", "math"]);
const PY_BANNED = /\b(?:subprocess|os|sys|shutil|pathlib|io|codecs|exec|eval|compile|__import__|importlib|socket|urllib\d?|requests|http|httpx|aiohttp|ftplib|smtplib|ctypes|pty|multiprocessing|threading|asyncio|signal|getattr|setattr|delattr|globals|locals|vars|breakpoint|input|help|memoryview)\b|__\w+__/;
const S = "\u0001"; // marks a set-aside string literal in the code: \u0001<index>\u0001
function pyWrites(src, ctx) {
  const strs = [];
  let code = "";
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === "#") { const nl = src.indexOf("\n", i); i = nl < 0 ? src.length : nl; continue; }
    if (c !== "'" && c !== '"') { code += c; i++; continue; }
    if (/[fF]/.test(/[A-Za-z_]*$/.exec(code)[0])) return null; // an f-string (or a name ending in f: unread)
    const q = src.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
    let j = i + q.length;
    while (!src.startsWith(q, j)) {
      if (j >= src.length || (q.length === 1 && src[j] === "\n")) return null;
      j += src[j] === "\\" ? 2 : 1;
    }
    strs.push(src.slice(i + q.length, j));
    code += `${S}${strs.length - 1}${S}`;
    i = j + q.length;
  }
  // (Python folds Unicode names to ASCII, so a fullwidth ｅxec is exec: no non-ASCII outside strings)
  if (PY_BANNED.test(code) || /[^\x00-\x7f]/.test(code)) return null;
  const lines = code.split("\n");
  for (const l of lines) {
    if (!/\bimport\b/.test(l)) continue;
    const a = /^\s*import\s+([\w\s,.]+)$/.exec(l), b = /^\s*from\s+([\w.]+)\s+import\s+[\w\s,*()]+$/.exec(l);
    const mods = a ? a[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0]) : b ? [b[1]] : null;
    if (!mods || !mods.every((x) => PY_IMPORTS.has(x.split(".")[0]))) return null;
  }
  // where each line assigns: its last `=` outside brackets (keyword arguments don't count)
  let depth = 0;
  const eqAt = lines.map((l) => {
    let at = -1;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
      else if (c === "=" && !depth && !"=!<>:".includes(l[i - 1] || "") && l[i + 1] !== "=") at = i;
    }
    return at;
  });
  // a name's value: one plain `NAME = 'literal'` and no other assignment, loop, parameter or import of it
  const valueOf = (name) => {
    if (new RegExp(String.raw`\bfor\b[^\n]*?\b${name}\b[^\n]*?\bin\b|\bas\s+${name}\b|\b(?:global|nonlocal|del|import|def|class|lambda)\b[^\n]*\b${name}\b|\b${name}\s*:=`).test(code)) return null;
    let n = 0, v = null;
    lines.forEach((l, k) => {
      if (eqAt[k] < 0 || !new RegExp(String.raw`\b${name}\b`).test(l.slice(0, eqAt[k]))) return;
      n++;
      const m = new RegExp(String.raw`^\s*${name}\s*=\s*${S}(\d+)${S}\s*$`).exec(l);
      v = m ? strs[+m[1]] : null;
    });
    return n === 1 ? v : null;
  };
  const OPEN = new RegExp(String.raw`^open\s*\(\s*(?:${S}(\d+)${S}|([A-Za-z_]\w*))\s*(?:,\s*(?:mode\s*=\s*)?${S}(\d+)${S}\s*)?[,)]`);
  const writes = [];
  for (const o of code.matchAll(/\bopen\b/g)) {
    if (code[o.index - 1] === ".") return null; // some object's open(): unknown
    const m = OPEN.exec(code.slice(o.index));
    if (!m) return null;
    const path = m[1] !== undefined ? strs[+m[1]] : valueOf(m[2]);
    const mode = m[3] !== undefined ? strs[+m[3]] : "r";
    if (!path || path.includes("\\") || !/^[rwaxbt+]+$/.test(mode)) return null;
    if (!projectFile(pathOf(path, ctx), ctx)) return null;
    if (/[wax+]/.test(mode)) writes.push(path);
  }
  return writes.length ? [...new Set(writes)] : null;
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
