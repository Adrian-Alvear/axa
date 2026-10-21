// ---------- what each session changed (git): branch, files, lines, for review at a glance ----------
// Read-only and throttled (one refresh per folder every GIT_MS, in the background). GIT_OPTIONAL_LOCKS=0
// keeps `git status` from taking the index lock while the session itself runs git.
import { execFile } from "node:child_process";

const GIT_MS = 10_000;
const gitCache = new Map(); // cwd -> { at, busy, info }
// Don't leak the parent Claude Code session's identity into git (hooks, credential helpers)
export const gitEnv = () => {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  return env;
};
// stdout, or null when git failed
export const git = (cwd, args, max = 1 << 20) => new Promise((ok) =>
  execFile("git", args, { cwd, env: gitEnv(), timeout: 5000, maxBuffer: max }, (err, out) => ok(err ? null : out)));
// { status, stdout, stderr }, for commands whose error message matters (worktrees)
export const gitRun = (cwd, args) => new Promise((ok) =>
  execFile("git", args, { cwd, env: gitEnv(), timeout: 15_000, encoding: "utf8" }, (err, stdout, stderr) => ok({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: stdout || "", stderr: stderr || err?.message || "" })));
// Secret files never show in a diff (their contents would also be redacted, but leave them out entirely)
export const NO_SECRETS = ["--", ".", ":(exclude,glob)**/.env*", ":(glob,exclude)**/*.pem", ":(glob,exclude)**/*.key", ":(glob,exclude)**/id_rsa*", ":(glob,exclude)**/credentials*"];

export function refreshGit(cwd) {
  const c = gitCache.get(cwd) || {};
  if (c.busy || (c.at && Date.now() - c.at < GIT_MS)) return;
  c.busy = true; gitCache.set(cwd, c);
  (async () => {
    const st = await git(cwd, ["status", "--porcelain=v1", "-b"]);
    if (st == null) return null;
    const [head, ...files] = st.split("\n").filter(Boolean);
    const m = /^## (?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.\S+)?(?: \[(.+)\])?$/.exec(head || "") || [];
    const info = { branch: m[1] === "HEAD (no branch)" ? "detached" : m[1] || "?", files: files.length, untracked: files.filter((f) => f.startsWith("??")).length, added: 0, removed: 0 };
    info.ahead = Number(/ahead (\d+)/.exec(m[2] || "")?.[1]) || 0;
    info.behind = Number(/behind (\d+)/.exec(m[2] || "")?.[1]) || 0;
    const stat = info.files ? await git(cwd, ["diff", "HEAD", "--shortstat"]) : "";
    info.added = Number(/(\d+) insertion/.exec(stat || "")?.[1]) || 0;
    info.removed = Number(/(\d+) deletion/.exec(stat || "")?.[1]) || 0;
    return info;
  })().then((info) => { c.info = info; }, () => { c.info = null; }).finally(() => { c.busy = false; c.at = Date.now(); });
}
export const gitOf = (t) => { if (t.alive && t.mode !== "axa") refreshGit(t.cwd); return gitCache.get(t.cwd)?.info || null; };
// A folder no open session uses any more: forget it
export const forgetGit = (cwd) => gitCache.delete(cwd);

// The uncommitted changes in a folder against its last commit (staged ones when there's no commit
// yet), with secret files left out. null when it isn't a git repository or the diff is too large.
export async function rawDiff(cwd) {
  const base = (await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"])) ? ["diff", "HEAD"] : ["diff", "--cached"];
  return git(cwd, [...base, "--no-color", "--no-ext-diff", ...NO_SECRETS], 8 << 20);
}
export const untrackedFiles = async (cwd) => ((await git(cwd, ["ls-files", "--others", "--exclude-standard", ...NO_SECRETS])) || "").split("\n").filter(Boolean);
