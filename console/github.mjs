// ---------- GitHub, read-only: each session's pull request and latest CI run (via the gh CLI) ----------
// Only when `gh auth status` succeeds (checked once every AUTH_MS). Refreshed in the background, one gh
// call at a time, at most once per folder+branch every GH_MS: the session list only reads the cache,
// so it never waits on GitHub. Only read commands (`gh pr view`, `gh run list`), never anything that
// writes. Missing or signed-out gh = no GitHub info, quietly. AXA_GITHUB=0 turns it off.
import { execFile } from "node:child_process";

export const GH_MS = 60_000, AUTH_MS = 10 * 60_000;
const FORGET_MS = 10 * 60_000; // a folder+branch nobody asked about for this long is dropped
const PR_FIELDS = "number,state,url,isDraft,reviewDecision,statusCheckRollup";
const RUN_FIELDS = "status,conclusion,name,url,headBranch,createdAt";

// gh must never prompt, update-check, or pick up the parent Claude Code session's identity
const ghEnv = () => {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  return env;
};
// { ok, out }: ok false when gh is missing, failed or timed out
const gh = (cwd, args, timeout = 8000) => new Promise((done) => {
  try { execFile("gh", args, { cwd, env: ghEnv(), timeout, maxBuffer: 1 << 20, encoding: "utf8" }, (err, out) => done({ ok: !err, out: out || "" })); }
  catch { done({ ok: false, out: "" }); }
});
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const str = (v, n = 300) => (typeof v === "string" ? v.slice(0, n) : undefined);

// Pure: "passing" | "failing" | "pending" from a PR's statusCheckRollup (check runs and commit
// statuses), or null when it has no checks
export function checksOf(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return null;
  let pending = false;
  for (const c of rollup) {
    const state = String(c?.conclusion || c?.state || "").toUpperCase(), status = String(c?.status || "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(state)) return "failing";
    if ((status && status !== "COMPLETED") || ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", ""].includes(state)) pending = true;
  }
  return pending ? "pending" : "passing";
}
// Pure: gh's JSON to AXA's shape
export function prOf(p) {
  if (!p || typeof p.number !== "number") return null;
  return { number: p.number, state: str(p.state, 20)?.toLowerCase(), url: str(p.url), draft: !!p.isDraft, review: str(p.reviewDecision, 40)?.toLowerCase() || null, checks: checksOf(p.statusCheckRollup) };
}
export function ciOf(runs) {
  const r = Array.isArray(runs) ? runs[0] : null;
  return r ? { status: str(r.status, 20), conclusion: str(r.conclusion, 20) || null, name: str(r.name, 120), url: str(r.url) } : null;
}

export function createGithub({ enabled = process.env.AXA_GITHUB !== "0", now = Date.now } = {}) {
  const cache = new Map(); // cwd \0 branch -> { at, asked, info }
  const auth = { ok: false, at: 0, busy: false };
  const queue = [];
  let running = false;
  async function pump() {
    if (running) return;
    running = true;
    try { while (queue.length) await queue.shift()(); } finally { running = false; }
  }
  const later = (job) => { queue.push(job); pump(); };
  function checkAuth() {
    if (auth.busy || (auth.at && now() - auth.at < AUTH_MS)) return;
    auth.busy = true;
    later(async () => { const r = await gh(undefined, ["auth", "status"], 5000); auth.ok = r.ok; auth.at = now(); auth.busy = false; });
  }
  function refresh(key, cwd, branch) {
    const c = cache.get(key);
    c.busy = true;
    later(async () => {
      try {
        if (!auth.ok) return;
        const pr = await gh(cwd, ["pr", "view", "--json", PR_FIELDS]);
        const runs = await gh(cwd, ["run", "list", "--branch", branch, "--limit", "1", "--json", RUN_FIELDS]);
        // no PR for the branch is a normal answer (gh exits 1); no CI run either
        const info = { pr: pr.ok ? prOf(parse(pr.out)) : null, ci: runs.ok ? ciOf(parse(runs.out)) : null };
        c.info = info.pr || info.ci ? info : null;
      } finally { c.at = now(); c.busy = false; }
    });
  }
  // The cached { pr, ci } for a folder on a branch (or null), refreshing it in the background when stale
  function githubOf(cwd, branch) {
    if (!enabled || !cwd || !branch || ["detached", "?"].includes(branch)) return null;
    checkAuth();
    const key = `${cwd}\u0000${branch}`, t = now();
    let c = cache.get(key);
    if (!c) cache.set(key, (c = { at: 0, info: null }));
    c.asked = t;
    if (auth.ok && !c.busy && t - c.at >= GH_MS) refresh(key, cwd, branch);
    for (const [k, x] of cache) if (t - (x.asked || 0) > FORGET_MS && !x.busy) cache.delete(k);
    return auth.ok ? c.info : null;
  }
  return { githubOf, idle: () => !running && !queue.length, get authed() { return auth.ok; } };
}
