// Git, read-only and in the background: each folder's branch and uncommitted changes, a session's
// diff, and worktrees (a session on its own branch and folder so parallel work can't collide).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { inHome } from "../paths.mjs";
import { cleanEnv } from "./env.mjs";
import { safe } from "./text.mjs";

// GIT_OPTIONAL_LOCKS=0 keeps `git status` from taking the index lock while a session itself runs git
const gitEnv = () => ({ ...cleanEnv(), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
const git = (cwd, args, max = 1 << 20) => new Promise((ok) =>
  execFile("git", args, { cwd, env: gitEnv(), timeout: 5000, maxBuffer: max }, (err, out) => ok(err ? null : out)));
export const gitSync = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv(), timeout: 15_000 });

// Secret files never show in a diff
const NO_SECRETS = ["--", ".", ":(exclude,glob)**/.env*", ":(glob,exclude)**/*.pem", ":(glob,exclude)**/*.key", ":(glob,exclude)**/id_rsa*", ":(glob,exclude)**/credentials*"];

// ---------- status: { branch, files, untracked, added, removed, ahead, behind }, refreshed every GIT_MS ----------
const GIT_MS = 10_000;
const cache = new Map(); // cwd -> { at, busy, info }
function refresh(cwd) {
  const c = cache.get(cwd) || {};
  if (c.busy || (c.at && Date.now() - c.at < GIT_MS)) return;
  c.busy = true; cache.set(cwd, c);
  (async () => {
    const st = await git(cwd, ["status", "--porcelain=v1", "-b"]);
    if (st == null) return null;
    const [head, ...lines] = st.split("\n").filter(Boolean);
    const m = /^## (?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.\S+)?(?: \[(.+)\])?$/.exec(head || "") || [];
    const info = { branch: m[1] === "HEAD (no branch)" ? "detached" : m[1] || "?", files: lines.length, untracked: lines.filter((f) => f.startsWith("??")).length, added: 0, removed: 0 };
    info.ahead = Number(/ahead (\d+)/.exec(m[2] || "")?.[1]) || 0;
    info.behind = Number(/behind (\d+)/.exec(m[2] || "")?.[1]) || 0;
    const stat = info.files ? await git(cwd, ["diff", "HEAD", "--shortstat"]) : "";
    info.added = Number(/(\d+) insertion/.exec(stat || "")?.[1]) || 0;
    info.removed = Number(/(\d+) deletion/.exec(stat || "")?.[1]) || 0;
    return info;
  })().then((info) => { c.info = info; }, () => { c.info = null; }).finally(() => { c.busy = false; c.at = Date.now(); });
}
// The latest known status of a folder (null until the first refresh lands, or when it isn't a repo)
export function gitInfo(cwd) {
  refresh(cwd);
  return cache.get(cwd)?.info || null;
}

// ---------- diff: uncommitted changes against the last commit, cleaned like any other session output ----------
// Each file is redacted on its own, and very large ones are left out, so nothing is cut blind
const DIFF_FILE_MAX = 60 * 1024, DIFF_MAX = 400 * 1024;
// since: a commit (a turn's start): the working tree against it, so commits made since count too
export async function diffOf(cwd, since) {
  const ok = since && /^[0-9a-f]{7,64}$/.test(since) && (await git(cwd, ["rev-parse", "--verify", "-q", `${since}^{commit}`]));
  const base = ok ? ["diff", since] : (await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"])) ? ["diff", "HEAD"] : ["diff", "--cached"];
  const raw = await git(cwd, [...base, "--no-color", "--no-ext-diff", ...NO_SECRETS], 8 << 20);
  if (raw == null) return { diff: "", untracked: [], error: "Couldn't read the changes: not a git repository, or the diff is too large to show here." };
  let diff = "", truncated = false;
  for (const file of raw.split(/(?=^diff --git )/m)) {
    if (diff.length > DIFF_MAX) { truncated = true; break; }
    diff += file.length > DIFF_FILE_MAX ? `${file.split("\n")[0]}\n(large change left out: ${Math.round(file.length / 1024)} KB, open the session to see it)\n` : safe(file);
  }
  const untracked = ((await git(cwd, ["ls-files", "--others", "--exclude-standard", ...NO_SECRETS])) || "").split("\n").filter(Boolean);
  const out = { diff, truncated, untracked: untracked.slice(0, 200).map(safe), untracked_total: untracked.length };
  if (ok) {
    const head = ((await git(cwd, ["rev-parse", "HEAD"])) || "").trim();
    const log = (await git(cwd, ["log", "--no-color", "--format=%h %s", "-n", "50", `${since}..HEAD`])) || "";
    Object.assign(out, { since, head, commits: log.split("\n").filter(Boolean).map(safe) });
  }
  return out;
}
// The commit a folder is on now (null: not a repository, or no commits yet)
export const headOf = (cwd) => { const r = gitSync(cwd, "rev-parse", "--verify", "-q", "HEAD"); return r.status === 0 ? r.stdout.trim() || null : null; };

// Keep a folder out of the repo's git status, locally (.git/info/exclude; nothing is committed)
export function excludeLocally(repo, pattern) {
  try {
    const common = gitSync(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.trim();
    if (!common) return;
    const file = join(common, "info", "exclude");
    const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (cur.split("\n").includes(pattern)) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + pattern + "\n");
  } catch {}
}

// ---------- worktrees ----------
// <repo>/.claude/worktrees/<name> on branch axa/<name> (the folder Claude Code itself uses), inside the
// repo so the folder trust you gave the repo applies, and hidden from the main checkout's status.
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
export function makeWorktree(dir, want) {
  const name = (typeof want === "string" && want.trim() ? want : `goal-${new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "")}`)
    .toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!name) throw new Error("worktree name must have letters or digits");
  const top = gitSync(dir, "rev-parse", "--show-toplevel");
  if (top.status !== 0) throw new Error(`${dir} isn't a git repository, so it can't have a worktree`);
  const repo = top.stdout.trim();
  if (!inHome(repo)) throw new Error("the repository must be in your home folder");
  const path = join(repo, ".claude", "worktrees", name), branch = `axa/${name}`;
  if (!isDir(path)) {
    const hasBranch = gitSync(repo, "rev-parse", "--verify", "-q", `refs/heads/${branch}`).status === 0;
    const r = hasBranch ? gitSync(repo, "worktree", "add", path, branch) : gitSync(repo, "worktree", "add", "-b", branch, path, "HEAD");
    if (r.status !== 0) throw new Error(`couldn't create the worktree: ${(r.stderr || "").trim()}`);
  }
  excludeLocally(repo, "/.claude/worktrees/");
  return { repo, path, branch, name: `${basename(repo)}:${name}` };
}
// Remove a worktree folder; git refuses when it has uncommitted changes. The branch is always kept.
export function removeWorktree(wt) {
  const r = gitSync(wt.repo, "worktree", "remove", wt.path);
  return { worktree_removed: r.status === 0, branch_kept: wt.branch, ...(r.status !== 0 ? { worktree_error: (r.stderr || "").trim() } : {}) };
}
