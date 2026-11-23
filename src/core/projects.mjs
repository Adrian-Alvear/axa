// Projects in progress: one read-only look at each known project (the list list_sessions prints), cheap
// enough for the hub: git only (branch, ahead/behind its upstream, uncommitted files, last commit, commits
// in the last day, worktrees), the AXA sessions open there, the last milestone review, and the "Next up" /
// "In progress" sections of its handoff file (docs/HANDOFF.md, HANDOFF.md or TODO.md). No network, no
// builds. Cached 60 s. Used by GET /api/projects, the commander's review_projects, `axa projects`, the
// hub's Projects tab and the daily brief.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { home } from "../paths.mjs";
import { basename, join, relative } from "node:path";
import { gitAsync } from "./git.mjs";
import { clip, safe } from "./text.mjs";

export const CACHE_MS = 60_000;
export const HANDOFF_FILES = ["docs/HANDOFF.md", "HANDOFF.md", "TODO.md"];
const ITEMS = 8;

// ---------- the handoff file: "Next up" and "In progress" (first ITEMS items each) ----------
const plainItem = (t) => safe(t.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "").replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim());
export function parseHandoff(text) {
  const out = { next: [], in_progress: [] };
  let into = null, level = 0;
  for (const line of String(text || "").replace(/\r/g, "").split("\n")) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lv = h[1].length, title = h[2].trim();
      // a sub-heading inside a section keeps it; a heading at the same level or above ends it
      if (into && lv > level) continue;
      into = /\bnext\s*(?:up|steps?)\b/i.test(title) ? "next" : /\bin\s*progress\b/i.test(title) ? "in_progress" : null;
      level = lv;
      continue;
    }
    if (!into) continue;
    // top-level items only (an indented one is a detail of the item above)
    if (/^\s?(?:[-*+]|\d+[.)])\s+\S/.test(line)) {
      if (out[into].length < ITEMS) { const t = plainItem(line); if (t) out[into].push(clip(t, 200)); }
    }
  }
  return out;
}
export function readHandoff(path) {
  for (const f of HANDOFF_FILES) {
    const p = join(path, f);
    try { if (statSync(p).isFile()) { const text = readFileSync(p, "utf8").slice(0, 256 * 1024); return { file: f, ...parseHandoff(text) }; } } catch {}
  }
  return null;
}

// ---------- git, read-only ----------
const lines = (s) => String(s || "").split("\n").filter(Boolean);
export async function gitFacts(path) {
  const top = (await gitAsync(path, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!top) return null;
  const [branch, counts, status, last, day, wts] = await Promise.all([
    gitAsync(path, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitAsync(path, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
    gitAsync(path, ["status", "--porcelain=v1"]),
    gitAsync(path, ["log", "-1", "--format=%ct%x09%s"]),
    gitAsync(path, ["rev-list", "--count", "--since=24 hours ago", "HEAD"]),
    gitAsync(path, ["worktree", "list", "--porcelain"]),
  ]);
  const [behind, ahead] = counts ? counts.trim().split(/\s+/).map(Number) : [null, null];
  const [ct, ...subject] = (last || "").trim().split("\t");
  const worktrees = [];
  let cur = null;
  for (const l of lines(wts)) {
    if (l.startsWith("worktree ")) { cur = { path: l.slice(9) }; if (cur.path !== top) worktrees.push(cur); }
    else if (cur && l.startsWith("branch ")) cur.branch = l.slice(7).replace(/^refs\/heads\//, "");
  }
  return {
    branch: (branch || "").trim() || "?", upstream: counts != null, ahead, behind,
    dirty: lines(status).length,
    last_commit: ct ? { at: Number(ct) * 1000, subject: clip(safe(subject.join("\t")), 120) } : null,
    commits_24h: Number(day) || 0,
    worktrees: worktrees.map((w) => ({ path: w.path, branch: w.branch || "detached" })),
  };
}

// ---------- one project ----------
const inProject = (s, path) => { const c = s.worktree?.repo || s.cwd || ""; return c === path || c.startsWith(path + "/"); };
// the last milestone review of this repo: one that ran since the daemon started, else the stored approve
function milestoneOf(path, reviews = [], stored = {}) {
  const r = reviews.find((x) => x.repo === path && ["done", "failed"].includes(x.state));
  if (r) return { verdict: r.verdict || r.state, at: r.ended || r.started || null, branch: r.branch, line: clip(safe(r.line || ""), 200) };
  const keys = Object.keys(stored).filter((k) => k.startsWith(path + "#")).sort((a, b) => (stored[b].at || 0) - (stored[a].at || 0));
  return keys.length ? { verdict: stored[keys[0]].verdict, at: stored[keys[0]].at, branch: keys[0].slice(path.length + 1) } : null;
}
export async function reviewProject(p, { sessions = [], reviews = [], stored = {}, now = Date.now() } = {}) {
  const git = await gitFacts(p.path).catch(() => null);
  const open = sessions.filter((s) => s.mode !== "axa" && s.alive && inProject(s, p.path)).map((s) => ({ id: s.id, name: s.name, status: s.status, doing: clip(safe(s.doing || ""), 120) || undefined }));
  const lastAt = git?.last_commit?.at || 0;
  return {
    name: p.name, path: p.path, git, sessions: open,
    milestone: milestoneOf(p.path, reviews, stored),
    handoff: readHandoff(p.path),
    idle_days: lastAt ? Math.floor((now - lastAt) / 86_400_000) : null,
  };
}

// all of them, cached CACHE_MS (sessions change faster: they're filled in fresh each time)
let cache = { at: 0, key: "", data: null, busy: null };
export async function reviewProjects({ projects, sessions = [], reviews = [], stored = {}, now = Date.now(), fresh = false }) {
  const key = projects.map((p) => p.path).join("\n");
  if (!fresh && cache.data && cache.key === key && now - cache.at < CACHE_MS) return withSessions(cache.data, sessions);
  if (!cache.busy || cache.key !== key) {
    cache.key = key;
    cache.busy = Promise.all(projects.map((p) => reviewProject(p, { sessions, reviews, stored, now }))).then((data) => { cache = { at: Date.now(), key, data, busy: null }; return data; }, (e) => { cache.busy = null; throw e; });
  }
  return withSessions(await cache.busy, sessions);
}
const withSessions = (data, sessions) => data.map((d) => ({ ...d, sessions: sessions.filter((s) => s.mode !== "axa" && s.alive && inProject(s, d.path)).map((s) => ({ id: s.id, name: s.name, status: s.status, doing: clip(safe(s.doing || ""), 120) || undefined })) }));

// ---------- in words ----------
export function ageText(ms) {
  const d = Math.floor(ms / 86_400_000);
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (d < 1) return `${Math.round(ms / 3_600_000)} h`;
  if (d < 14) return `${d} day${d === 1 ? "" : "s"}`;
  if (d < 60) return `${Math.round(d / 7)} weeks`;
  return `${Math.round(d / 30)} months`;
}
export const IDLE_DAYS = 7;
export function gitLine(g) {
  if (!g) return "not a git repo";
  const up = !g.upstream ? "no upstream" : g.ahead || g.behind ? [g.ahead ? `${g.ahead} ahead` : "", g.behind ? `${g.behind} behind` : ""].filter(Boolean).join(", ") : "up to date";
  return `${g.branch} (${up})${g.dirty ? `, ${g.dirty} uncommitted` : ""}${g.worktrees.length ? `, ${g.worktrees.length} worktree${g.worktrees.length > 1 ? "s" : ""}` : ""}`;
}
// One project as a few lines (the commander's review_projects and `axa projects`)
export function projectText(r, now = Date.now()) {
  const g = r.git, lc = g?.last_commit;
  const idle = r.idle_days != null && r.idle_days >= IDLE_DAYS ? ` · idle ${ageText(now - lc.at)}` : "";
  const out = [`${r.name} (${r.path})${idle}`, `  git: ${gitLine(g)}${lc ? `; last commit ${ageText(now - lc.at)} ago: ${lc.subject}` : ""}${g?.commits_24h ? `; ${g.commits_24h} commit${g.commits_24h > 1 ? "s" : ""} in the last day` : ""}`];
  out.push(`  sessions: ${r.sessions.length ? r.sessions.map((s) => `[${s.id}] ${s.name} ${s.status}${s.doing ? ` (${s.doing})` : ""}`).join("; ") : "none open"}`);
  if (r.milestone) out.push(`  last milestone review: ${r.milestone.verdict}${r.milestone.at ? `, ${ageText(now - r.milestone.at)} ago` : ""}${r.milestone.branch ? ` on ${r.milestone.branch}` : ""}`);
  if (r.handoff) {
    if (r.handoff.in_progress.length) out.push(`  in progress (${r.handoff.file}): ${r.handoff.in_progress.join(" | ")}`);
    if (r.handoff.next.length) out.push(`  next up (${r.handoff.file}): ${r.handoff.next.join(" | ")}`);
    if (!r.handoff.in_progress.length && !r.handoff.next.length) out.push(`  ${r.handoff.file}: no "Next up" or "In progress" section`);
  }
  return out.join("\n");
}
export const projectsText = (list, now = Date.now()) => (list.length ? list.map((r) => projectText(r, now)).join("\n\n") : "No projects found (the roster, ~/projects, and git repos in your home folder).");

// ---------- the daily brief ----------
// Due when the clock has passed brief_at ("09:00") today and no brief went out today yet
export function briefDue(brief_at, now, lastBriefAt) {
  if (!brief_at) return false;
  const [h, m] = brief_at.split(":").map(Number), d = new Date(now), at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  return now >= at && !(lastBriefAt && lastBriefAt >= at);
}
// Once a day, kept in the daemon's own state (<AXA home>/brief.json: { "last_at": ms }), not derived from the
// notification list, which you can clear and which rolls past 200: neither may bring a second brief that day.
// fallbackLast(): the last brief's time from before this file existed (the notification list), read only when
// the file is missing. Resolves true when a brief went out.
export const briefFile = () => join(home, "brief.json");
export function lastBriefAt(file = briefFile()) {
  try { return Number(JSON.parse(readFileSync(file, "utf8")).last_at) || 0; } catch { return null; }
}
export async function briefTick({ brief_at, now = Date.now(), file = briefFile(), review, push, fallbackLast = () => 0 }) {
  if (!brief_at) return false;
  const last = lastBriefAt(file) ?? (fallbackLast() || 0);
  if (!briefDue(brief_at, now, last)) return false;
  // recorded first: a slow or failing review can't send it twice
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ last_at: now }) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  push({ kind: "brief", session: null, project: "", title: "Daily brief", body: briefText(await review()), needsUser: false });
  return true;
}
// One notification's text: what changed in the last day, what's waiting on you, the top "Next up" per project
export function briefText(list) {
  const changed = list.filter((r) => r.git?.commits_24h || r.git?.dirty).map((r) => `${r.name}: ${[r.git.commits_24h ? `${r.git.commits_24h} new commit${r.git.commits_24h > 1 ? "s" : ""}` : "", r.git.dirty ? `${r.git.dirty} uncommitted` : ""].filter(Boolean).join(", ")}`);
  const waiting = list.flatMap((r) => r.sessions.filter((s) => ["waiting", "needs_trust", "stuck", "failed", "limited"].includes(s.status)).map((s) => `${r.name} (${s.name}) ${s.status.replace("_", " ")}`));
  const next = list.filter((r) => r.handoff?.next.length).map((r) => `${r.name}: ${r.handoff.next[0]}`);
  return [
    changed.length ? `Since yesterday: ${changed.join("; ")}.` : "Nothing changed since yesterday.",
    waiting.length ? `Waiting on you: ${waiting.join("; ")}.` : "Nothing is waiting on you.",
    next.length ? `Next up: ${next.join("; ")}.` : "",
  ].filter(Boolean).join(" ");
}
export const relPath = (p, base) => relative(base, p) || basename(p);
export const handoffPath = (path) => HANDOFF_FILES.map((f) => join(path, f)).find((f) => existsSync(f)) || null;
