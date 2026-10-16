// Shared safety checks for AXA. Patterns adapted from ECC (affaan-m/everything-claude-code, MIT);
// see CREDITS.md. Everything here is plain functions with no dependencies, safe to call from hooks.

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

export function redact(value) {
  if (value == null) return value;
  let s = String(value);
  if (s.length > MAX_SCAN) s = s.slice(-MAX_SCAN);
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
const ONE_WAY = [
  [/\bgit\s+push\b[^\n]*(?:\s--(?:delete|mirror|all|tags)\b|\s-d\b|\s:[\w/.-]+)/, "delete or rewrite remote git refs"],
  [/\bgit\s+push\b[^\n]*\s(?:[\w/.-]+:)?(?:main|master|production|prod|release)(?:\s|$)/, "push to a main/production branch"],
  [/\bgh\s+(?:pr\s+(?:merge|close)|release|repo\s+(?:create|delete|edit|rename|archive)|secret|variable|workflow\s+run|api\b[^\n]*(?:-X|--method)\s*(?!GET\b)[A-Z])/, "change something on GitHub"],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:publish|unpublish|deprecate|owner|token|login)\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bgem\s+push\b/, "publish a package"],
  [/\b(?:vercel|netlify|firebase|fly|flyctl|wrangler|heroku|railway|amplify|surge)\b[^\n]*\b(?:deploy|publish|--prod|promote|release)\b|\bvercel\s+--prod\b/, "deploy"],
  [/\b(?:terraform|tofu|pulumi)\s+(?:apply|destroy|up)\b|\bkubectl\s+(?:apply|delete|create|replace|scale|rollout)\b|\bhelm\s+(?:install|upgrade|uninstall)\b|\bdocker\s+push\b|\bsupabase\s+db\s+(?:push|reset)\b/, "change live infrastructure"],
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

// Why this tool call is a one-way door (the user's call), or null
export function oneWayDoor(tool, input = {}) {
  if (tool === "Bash") {
    const t = String(input.command || "").replace(/\\\n/g, " ");
    const danger = dangerousShell(t);
    if (danger) return danger;
    for (const [re, why] of ONE_WAY) if (re.test(t) && !(why === SEND && onlyLocal(t))) return why;
    return null;
  }
  if (String(tool).startsWith("mcp__") && ONE_WAY_TOOL.test(String(tool).split("__").pop())) return `an outside action (${tool})`;
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
