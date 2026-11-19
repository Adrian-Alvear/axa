// Shared safety checks for AXA. Patterns adapted from ECC (affaan-m/everything-claude-code, MIT);
// see CREDITS.md. Everything here is plain functions with no dependencies, safe to call from hooks.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// ---------- secrets: blank them out before anything is logged or shown ----------
// Bare provider tokens, recognizable on their own (no "key=" in front)
const TOKENS = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g, // Stripe
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g, // Hugging Face
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
// Command-line and header forms: --token abc, --password=abc, Authorization: Bearer abc, https://user:pass@host
const FORMS = [
  [/(--(?:token|password|passwd|secret|api-key|apikey|access-key|auth)(?:=|\s+))(["']?)[^\s"']{4,}\2/gi, "$1[REDACTED]"],
  [/(authorization\s*:\s*(?:bearer|basic|token|bot)?\s*)[^\s"',;]{6,}/gi, "$1[REDACTED]"],
  [/(\b[a-z][a-z0-9+.-]{0,15}:\/\/[^\s:/@]{1,64}:)[^\s@/]{3,128}(@)/gi, "$1[REDACTED]$2"], // URL schemes are short
];
// key=value / key: value: keep the key, blank the value. The name must END in a secret word
// (API_KEY, accessToken, db_password, client-secret) so code like `tokenCount = ...` or
// `author=...` is left alone; values that look like function calls are skipped. Bounded
// repetition keeps it fast on huge inputs.
const KEY_VALUE = /((?:^|[\s"'{,;(])[a-z0-9_.-]{0,40}?(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|credentials?)["']?\s*[:=]\s*["']?)((?:bearer|basic|token|bot)\s+)?([^\s"',;()]{8,256})(?![\w(])/gi;
// Text longer than this is cut before scanning (logs and screens never need more)
const MAX_SCAN = 64 * 1024;

// A token wrapped onto the next line(s) of a screen (Claude Code's TUI hard-wraps long lines, often
// inside a box border): runs of token characters that touch a line break, up to 5 lines. Written so
// it can't backtrack badly: each run starts at a run boundary and the separator has one parse.
const TOKEN_CHARS = "A-Za-z0-9_.-";
const WRAP_SEP = String.raw`[ \t]{0,200}(?:[│┃║][ \t]{0,200})?\r?\n[ \t]{0,200}(?:[│┃║][ \t]{0,200})?`;
const WRAPPED = new RegExp(`(?<![${TOKEN_CHARS}])[${TOKEN_CHARS}]+(?:${WRAP_SEP}[${TOKEN_CHARS}]+){1,4}`, "g");
const RUN = new RegExp(`[${TOKEN_CHARS}]+`, "g");
function unwrapTokens(s) {
  return s.replace(WRAPPED, (m) => {
    const pieces = m.match(RUN);
    const joined = pieces.join("");
    const breaks = [];
    for (let i = 0, at = 0; i < pieces.length - 1; i++) breaks.push((at += pieces[i].length));
    // redact every piece when a token in the joined text crosses a line break
    const spans = TOKENS.some((re) => [...joined.matchAll(new RegExp(re.source, "g"))].some((t) => breaks.some((b) => t.index < b && t.index + t[0].length > b)));
    return spans ? m.replace(RUN, "[REDACTED]") : m;
  });
}

export function redact(value) {
  if (value == null) return value;
  let s = String(value);
  if (s.length > MAX_SCAN) s = s.slice(-MAX_SCAN);
  if (s.includes("\n")) s = unwrapTokens(s);
  for (const re of TOKENS) s = s.replace(re, "[REDACTED]");
  for (const [re, to] of FORMS) s = s.replace(re, to);
  s = s.replace(KEY_VALUE, (m, key, scheme, val) => (val.startsWith("[REDACTED]") ? m : `${key}${scheme || ""}[REDACTED]`));
  return s;
}

// ---------- screen text from other sessions: data, never instructions ----------
// Strip terminal escape codes and characters that can hide or reorder text (bidi overrides,
// zero-width characters) before another session's output reaches the commander.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff\u202a-\u202e\u2066-\u2069]/g;
export const cleanText = (value) => (value == null ? value : String(value).replace(ANSI, "").replace(UNSAFE, ""));

// ---------- dangerous shell commands: need the user's explicit OK ----------
// Checked when the commander types into a plain shell session. Claude sessions are governed by
// Claude Code's own permissions instead.
const DANGEROUS = [
  [/\bgit\s+push\b[^\n]*(?:\s--force(?:-with-lease)?\b|\s-f\b|\s\+[\w/.-]+)/, "force-push to git"],
  [/\bgit\s+reset\s+--hard\b/, "git reset --hard"],
  [/\bgit\s+clean\s+(?!(?:[^\n]*\s)?-[a-z]*n)[^\n]*-[a-z]*f/, "git clean -f"], // a dry run (-n) is fine
  [/\bgit\s+branch\s+-D\b/, "delete a git branch"],
  [/\bgit\s+(?:checkout|restore)\b[^\n]*(?:\s--\s+\.|\s\.)(?:\s|$)/, "discard all local changes"],
  [/\bgit\s+stash\s+(?:drop|clear)\b/, "delete stashed work"],
  [/\bfind\b[^\n]*\s-delete\b|\bxargs\b[^\n]*\brm\b|\bshred\b/, "bulk or unrecoverable delete"],
  [/\bbase64\s+(?:-d|--decode)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\beval\s+["']?\$\(/, "run hidden/decoded code"],
  [/\bdd\b[^\n]*\bof=/, "dd onto a device or file"],
  [/\bmkfs(?:\.\w+)?\b/, "format a disk"],
  [/\bchmod\s+-R\s+0?777\b/, "chmod -R 777"],
  [/\b(?:drop|truncate)\s+(?:table|database|schema)\b/i, "drop/truncate data"],
  [/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, "pipe a download into a shell"],
  // .env, .env.local, .envrc… but not the shareable .env.example / .env.sample / .env.template
  [/(?:^|[\s/'"=<>])\.env(?:rc|\.(?!example\b|sample\b|template\b)[\w.-]+)?(?![\w.-])/, "touch a .env file"],
  [/\.(?:pem|p12|pfx)\b|\bid_(?:rsa|ed25519|ecdsa)\b|\.aws\/credentials\b|\bcredentials\.(?:json|csv|ya?ml)\b/, "touch keys or credentials"],
];
const SAFE_RM_TARGET = /^(?:\/tmp\/|\/var\/tmp\/|\$TMPDIR\/|\$\{TMPDIR\}\/|node_modules\/?$|\.next\/?$|dist\/?$|build\/?$)/;

// ---------- one-way doors: always the user's call, even when AXA approves everything else ----------
// Things that leave the machine or can't be taken back: shipping, publishing, deploying, touching
// accounts, sending data out, admin rights. AXA's approver never decides these; they go to the user.
const SEND = "send data to a website";
const PUSH_MAIN = "push to a main/production branch", PUSH_TAGS = "push git tags", PUSH_REWRITE = "delete or rewrite remote git refs";
// `<program> [options and their values] <sub>`: options in front of the subcommand don't hide it
// (an option word starts with -, a value doesn't, so this can't backtrack badly)
const OPTS = String.raw`(?:\s+-[^\s;&|]*(?:\s+[^\s;&|-][^\s;&|]*)?)*\s+`;
const sub = (progs, subs) => String.raw`\b(?:${progs})${OPTS}(?:${subs})\b`;
const ONE_WAY = [
  [/\bgh\s+(?:pr\s+(?:merge|close)|release|repo\s+(?:create|delete|edit|rename|archive)|secret|variable|workflow\s+run|api\b[^\n]*(?:-X|--method)\s*(?!GET\b)[A-Z])/, "change something on GitHub"],
  [new RegExp(String.raw`${sub("npm|pnpm|yarn|bun", "publish|unpublish|deprecate|owner|token|login")}|\btwine\s+upload\b|\bcargo\s+publish\b|\bgem\s+push\b`), "publish a package"],
  [/\bmigrate\s+deploy\b/, "apply database migrations"],
  [/\b(?:vercel|netlify|firebase|fly|flyctl|wrangler|heroku|railway|amplify|surge)\b[^\n]*(?:\b(?:deploy|publish|promote|release)\b|\s--prod\b)/, "deploy"],
  [new RegExp([sub("terraform|tofu|pulumi", "apply|destroy|up"), sub("kubectl", "apply|delete|create|replace|scale|rollout|patch|edit"), sub("helm", "install|upgrade|uninstall"), sub("docker", String.raw`(?:image\s+)?push`), String.raw`\bdocker(?:-compose|\s+compose)\b[^\n;&|]*\spush\b`, String.raw`\bsupabase\s+db\s+(?:push|reset)\b`].join("|")), "change live infrastructure"],
  [/\b(?:aws|gcloud|az|doctl|stripe)\s+(?!--version|help\b)[\w-]/, "use a cloud or payments account"],
  [/\b(?:sudo|su|doas|pkexec)\b|\bsystemctl\s+(?!status\b)|\bcrontab\s+(?!-l\b)/, "admin rights or system changes"],
  [/\b(?:ssh|scp|sftp|rsync)\s[^\n]*@|\brsync\b[^\n]*\s[\w.-]+:/, "connect to another machine"],
  [/\b(?:curl|wget|http|xh)\b[^\n]*(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s--request\s+(?:POST|PUT|PATCH|DELETE)\b|\s(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file|--post-data|--post-file)\b)/i, SEND],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b[^\n;&|]*\s(?:-g|--global)\b|\bpip3?\s+install\b(?![^\n;&|]*(?:-r\s|--requirement|-e\s|\.\s*(?:$|[;&|])))/, "install software outside the project"],
  [/\b(?:mail|sendmail|mutt)\b/, "send email"],
];
// Sending data to this machine (a local dev or test server) isn't sending it out: every command
// that sends data must name localhost / 127.0.0.1 and no other host
const LOCAL = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;
function onlyLocal(t) {
  for (const seg of t.split(/[;&|\n]+/)) {
    if (!/\b(?:curl|wget|http|xh)\b/.test(seg)) continue;
    const hosts = [...seg.matchAll(/(?:\b[a-z][a-z0-9+.-]*:\/\/)?((?:[\w-]+\.)*[\w-]+|\[::1\]):\d+|\b[a-z][a-z0-9+.-]*:\/\/([^\s/:'"]+)/gi)].map((m) => m[1] || m[2]);
    if (!hosts.length || !hosts.every((h) => LOCAL.test(h))) return false;
    if (/:\/\/(?!localhost\b|127\.|\[::1\])/i.test(seg)) return false;
    // any other word that could be a host (curl takes bare "example.com/x" as a URL)
    if (seg.split(/\s+/).map((w) => w.replace(/^["']|["']$/g, "")).some((w) => /^(?:[a-z][a-z0-9+.-]*:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i.test(w))) return false;
  }
  return true;
}
// Tools (MCP and others) whose names say they act on the outside world
const ONE_WAY_TOOL = /(?:^|_)(?:send|post|publish|deploy|delete|remove|create_(?:issue|pr|pull|release|payment|charge)|merge|transfer|pay|charge|purchase|order|invite|share|comment|reply|tweet|email)(?:_|$)/i;

// Why this tool call is a one-way door (the user's call), or null. `cwd` is where the command runs
// (to resolve which branch `git push origin HEAD` pushes); it defaults to this process's.
export function oneWayDoor(tool, input = {}, { cwd = process.cwd() } = {}) {
  if (tool === "Bash") {
    const raw = String(input.command || "");
    const t = raw.replace(/\\\n/g, " ");
    const danger = dangerousShell(t);
    if (danger) return danger;
    const segs = shellSegments(raw);
    // (unparseable: the old text rules for pushes, on the raw text)
    if (!segs) {
      if (/\bgit\b[^\n]*\spush\b[^\n]*(?:\s--(?:delete|mirror|all)\b|\s-d\b|\s:[\w/.-]+)/.test(t)) return PUSH_REWRITE;
      if (/\bgit\b[^\n]*\spush\b[^\n]*(?:\s--(?:tags|follow-tags)\b|\stags\/)/.test(t)) return PUSH_TAGS;
      if (/\bgit\b[^\n]*\spush\b[^\n]*\s["'+]?(?:[\w/.@-]+:)?(?:refs\/)?(?:heads\/)?(?:main|master|production|prod|release|HEAD|@)["']?(?:\s|$)/i.test(t)) return PUSH_MAIN;
    } else {
      const push = scanPushes(segs, cwd, raw, 0);
      if (push) return push;
    }
    // the text rules run on the words as the shell reads them, without commit messages
    const text = segs ? segs.map((w) => withoutMessages(w).join(" ")).join("\n") : t;
    for (const [re, why] of ONE_WAY) if (re.test(text) && !(why === SEND && onlyLocal(text))) return why;
    return null;
  }
  if (String(tool).startsWith("mcp__") && ONE_WAY_TOOL.test(String(tool).split("__").pop())) return `an outside action (${tool})`;
  return null;
}

// ---------- the shell's view of a command: segments of words ----------
// Splits on ; & | ( ) ` $( and newlines, honoring quotes (their content is kept, the quotes dropped)
// and backslashes as the shell reads them. null when a quote isn't closed.
export function shellSegments(cmd) {
  const s = String(cmd ?? ""), segs = [[]];
  let w = "", on = false;
  const end = () => { if (on) segs.at(-1).push(w); w = ""; on = false; };
  const cut = () => { end(); if (segs.at(-1).length) segs.push([]); };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { if (s[i + 1] !== "\n" && i + 1 < s.length) { w += s[i + 1]; on = true; } i++; }
    else if (c === "'") { const e = s.indexOf("'", i + 1); if (e < 0) return null; w += s.slice(i + 1, e); on = true; i = e; }
    else if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\" && /["\\$`\n]/.test(s[j + 1] || "")) { if (s[j + 1] !== "\n") w += s[j + 1]; j++; } else w += s[j];
      }
      if (j >= s.length) return null;
      on = true; i = j;
    }
    else if (c === "$" && s[i + 1] === "(") { cut(); i++; }
    else if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "`") {
      if (c === "&" && /[0-9]?[<>]$/.test(w)) { w += c; on = true; continue; } // 2>&1
      cut();
    }
    else if (/\s/.test(c)) end();
    else { w += c; on = true; }
  }
  end();
  return segs.filter((x) => x.length);
}

const base = (w) => String(w || "").split("/").pop();
// the program a segment runs: past VAR=value prefixes
const progOf = (words) => base(words.find((x) => !/^\w+=/.test(x)));
// programs whose arguments are only text (when nothing in the command can run text)
const TEXT_ONLY = new Set(["echo", "printf", "grep", "egrep", "fgrep"]);
// programs that can run text they're given (as an argument or on stdin)
const RUNS_TEXT = new Set("sh bash zsh dash ksh fish csh tcsh eval exec xargs source . env sudo doas nohup setsid watch parallel ssh script tmux node deno bun python python2 python3 perl ruby php lua awk gawk sed".split(" "));
// git's options before the subcommand that take the next word as their value
const GIT_GLOBAL_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
function gitCommand(words) {
  let i = 0, dir = null;
  while (i < words.length && words[i].startsWith("-")) {
    if (words[i] === "-C" && words[i + 1] !== undefined) dir = dir ? `${dir}/${words[i + 1]}` : words[i + 1];
    i += GIT_GLOBAL_VALUE.has(words[i]) ? 2 : 1;
  }
  return { sub: words[i], args: words.slice(i + 1), dir };
}
// Indexes of commit/tag/stash/merge messages in a segment (-m text, -am text, -mtext, --message=text,
// --message text): text, not a command
function messageIndexes(words) {
  const out = new Set();
  words.forEach((x, i) => {
    if (base(x) !== "git") return;
    const g = gitCommand(words.slice(i + 1));
    if (!["commit", "tag", "stash", "merge", "notes", "revert"].includes(g.sub)) return;
    const at = i + 1 + (words.length - i - 1 - g.args.length);
    g.args.forEach((a, k) => {
      if (/^-[a-zA-Z]*m$|^--message$/.test(a)) out.add(at + k + 1);
      else if (/^-[a-zA-Z]*m.|^--message=/.test(a)) out.add(at + k);
    });
  });
  return out;
}
const withoutMessages = (words) => { const skip = messageIndexes(words); return words.filter((_, i) => !skip.has(i)); };

const PROTECTED_BRANCH = /^(?:main|master|production|prod|release)$/i;
const VERSION_TAG = /^v?\d+(?:\.\d+)+(?:[-+][\w.+-]*)?$/i;
const PUSH_VALUE = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
const git = (args, cwd) => { try { return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const currentBranch = (cwd) => git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
const localTag = (name, cwd) => /^[\w][\w./-]*$/.test(name) && git(["rev-parse", "--verify", "--quiet", `refs/tags/${name}`], cwd) !== null;

// Why `git push <args>` (run in cwd) is a one-way door, or null: every refspec counts, src:dst pushes
// to dst, a leading + is dropped, refs/heads/ and heads/ (and Gerrit's refs/for/) name a branch,
// HEAD / @ / no refspec is the current branch; tags are pushed by refs/tags/, `tag x`, a version name,
// a local tag's name, --tags or --follow-tags
export function pushDoor(args, cwd = process.cwd()) {
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (!a.startsWith("-") || a === "-") { pos.push(a); continue; }
    if (/^--(?:delete|mirror|all|branches|prune)$/.test(a) || /^-[^-]*d/.test(a)) return PUSH_REWRITE;
    if (/^--(?:tags|follow-tags)$/.test(a)) return PUSH_TAGS;
    if (PUSH_VALUE.has(a)) i++;
  }
  const refs = pos.slice(1);
  if (!refs.length) refs.push("HEAD");
  for (const ref of refs) {
    if (ref === "tag") return PUSH_TAGS;
    if (ref.startsWith(":")) return PUSH_REWRITE;
    const r = ref.replace(/^\+/, "");
    const src = r.includes(":") ? r.slice(0, r.indexOf(":")) : r;
    const dst = (r.includes(":") ? r.slice(r.lastIndexOf(":") + 1) : "") || src;
    if ([src, dst].some((x) => /^(?:refs\/)?tags\//.test(x))) return PUSH_TAGS;
    let name = dst.replace(/^(?:refs\/)?(?:heads|for)\//, "");
    if (name === "HEAD" || name === "@") name = currentBranch(cwd) || "";
    if (PROTECTED_BRANCH.test(name)) return PUSH_MAIN;
    if (VERSION_TAG.test(name) || (src === dst && localTag(src, cwd))) return PUSH_TAGS;
  }
  return null;
}

// Find a door-worthy push anywhere in the command: every `git ... push` (past git's global options,
// after a `cd`), and inside quoted text a program could run (sh -c "...", $(...)). Text given to
// echo/printf/grep, and commit messages, aren't commands unless something in the command runs text.
function scanPushes(segs, cwd, raw, depth) {
  const runsText = /`|\$\(|<\(/.test(raw) || segs.some((w) => RUNS_TEXT.has(progOf(w)) || /\$/.test(w[0]));
  for (const words of segs) {
    const prog = progOf(words);
    if (prog === "cd" && words.length === 2) { cwd = resolve(cwd, words[1]); continue; }
    if (TEXT_ONLY.has(prog) && !runsText) continue;
    for (let i = 0; i < words.length; i++) {
      if (base(words[i]) !== "git") continue;
      const g = gitCommand(words.slice(i + 1));
      if (g.sub !== "push") continue;
      const why = pushDoor(g.args, g.dir ? resolve(cwd, g.dir) : cwd);
      if (why) return why;
    }
    if (depth >= 3) continue;
    const skip = messageIndexes(words);
    for (let i = 0; i < words.length; i++) {
      // a git alias (-c alias.p="push origin main", or "!git push ..." run by the shell)
      const alias = /^alias\.[^=]+=([\s\S]*)$/.exec(words[i]);
      const text = alias ? (alias[1].startsWith("!") ? alias[1].slice(1) : `git ${alias[1]}`) : words[i];
      if (skip.has(i) || (!alias && !/[\s;&|()`$]/.test(text))) continue;
      const inner = shellSegments(text);
      const why = inner && scanPushes(inner, cwd, text, depth + 1);
      if (why) return why;
    }
  }
  return null;
}

// The reason the text is dangerous, or null
export function dangerousShell(text) {
  const t = String(text || "").replace(/\\\n/g, " ");
  for (const [re, why] of DANGEROUS) if (re.test(t)) return why;
  // rm -r / -rf anywhere except temp folders and build output
  for (const m of t.matchAll(/\brm\s+((?:-[a-zA-Z-]*\s+)*)([^\n;&|]*)/g)) {
    if (!/(?:^|\s)(?:-[a-zA-Z]*r|--recursive\b)/i.test(m[1])) continue;
    const targets = m[2].trim().split(/\s+/).filter((x) => x && !x.startsWith("-")).map((x) => x.replace(/^["']|["']$/g, ""));
    if (!targets.length || targets.some((x) => x.includes("..") || !SAFE_RM_TARGET.test(x))) return "recursive delete";
  }
  return null;
}
