// Review capacity (research/landscape.md: "the bottleneck is how fast I can review the results"):
//  - the review queue: finished work waiting for you, per session/branch: commits not pushed or merged, the diff's
//    size, the last checks result, the reviewer's verdict, and "ready to land" (checks pass + reviewer approved)
//  - a worker cap: ui.json "sessions": { "maxWorking": 5 }: the commander can't start more than that many
//    working sessions at once; past it, a send is refused (or queued, and typed in when a slot frees)
// Pure rules + one git helper (branchFacts).
import { gitSync } from "./git.mjs";

// ---------- checks: the session's last check command and whether it passed (from the hook log) ----------
export const CHECK_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(check|test|tests|verify|lint|typecheck|build)\b|\bverify\.mjs\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b|\bmake\s+(test|check)\b|\bvitest\b|\bjest\b|\bnode\s+--test\b/;
export function createCheckTracker() {
  const inflight = new Map(), last = new Map(); // tool_use_id -> { terminal, cmd }; terminal -> { ok, cmd, at }
  return {
    event(e) {
      if (!e?.terminal || e.agent_id) return;
      if (e.event === "PreToolUse" && e.tool === "Bash" && e.tool_use_id && CHECK_RE.test(e.command || "")) inflight.set(e.tool_use_id, { terminal: e.terminal, cmd: String(e.command).slice(0, 120) });
      else if ((e.event === "PostToolUse" || e.event === "PostToolUseFailure") && inflight.has(e.tool_use_id)) {
        const r = inflight.get(e.tool_use_id);
        inflight.delete(e.tool_use_id);
        last.set(r.terminal, { ok: e.event === "PostToolUse", cmd: r.cmd, at: e.ts });
      }
    },
    of: (terminal) => last.get(terminal) || null,
  };
}

// ---------- a branch's unlanded work ----------
// commits not on its upstream (or, without one, not on main/master), and the size of base...HEAD plus what's
// uncommitted
export function branchFacts(cwd) {
  const g = (...a) => { const r = gitSync(cwd, ...a); return r.status === 0 ? r.stdout.trim() : null; };
  const branch = g("rev-parse", "--abbrev-ref", "HEAD");
  if (!branch) return null;
  let base = g("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (!base) base = ["main", "master"].find((b) => b !== branch && g("rev-parse", "--verify", "-q", `refs/heads/${b}`)) || null;
  const commits = base ? (g("log", "--format=%h %s", `${base}..HEAD`) || "").split("\n").filter(Boolean) : [];
  const stat = (args) => { const t = g("diff", "--shortstat", ...args) || ""; return { files: +(/(\d+) files? changed/.exec(t)?.[1] || 0), added: +(/(\d+) insertions?/.exec(t)?.[1] || 0), removed: +(/(\d+) deletions?/.exec(t)?.[1] || 0) }; };
  const landed = base ? stat([`${base}...HEAD`]) : { files: 0, added: 0, removed: 0 }, dirty = stat(["HEAD"]);
  return { branch, base, commits, files: landed.files + dirty.files, added: landed.added + dirty.added, removed: landed.removed + dirty.removed, uncommitted: dirty.files };
}

// One queue row per session with unlanded work. verdict: the reviewer's (per-turn review, or the latest
// milestone review of that repo). Ready to land: commits, checks pass, reviewer approved, nothing uncommitted.
export function queueRow(s, facts, check, verdict) {
  if (!facts || (!facts.commits.length && !facts.uncommitted)) return null;
  const ready = facts.commits.length > 0 && check?.ok === true && verdict === "approve" && !facts.uncommitted;
  const why = ready ? "ready to land" : [!facts.commits.length && "nothing committed yet", facts.uncommitted && `${facts.uncommitted} file(s) uncommitted`, !check ? "no checks run" : !check.ok && "checks failed", verdict !== "approve" && (verdict ? `reviewer: ${verdict}` : "not reviewed")].filter(Boolean).join(", ");
  return { id: s.id, name: s.name, status: s.status, branch: facts.branch, base: facts.base, commits: facts.commits.length, latest: facts.commits[0] || null, files: facts.files, added: facts.added, removed: facts.removed, uncommitted: facts.uncommitted, checks: check ? (check.ok ? "pass" : "fail") : "none", check_cmd: check?.cmd || null, verdict: verdict || null, ready, why };
}
// ready first, then the most commits
export const sortQueue = (rows) => rows.filter(Boolean).sort((a, b) => Number(b.ready) - Number(a.ready) || b.commits - a.commits);
export function queueText(rows) {
  if (!rows.length) return "Nothing waiting for review: no session has unlanded work.";
  return rows.map((r) => `${r.ready ? "✓ READY" : "·"} ${r.name} on ${r.branch}${r.base ? ` (vs ${r.base})` : ""}: ${r.commits} commit${r.commits === 1 ? "" : "s"}, ${r.files} files +${r.added} -${r.removed}; checks ${r.checks}${r.verdict ? `, reviewer ${r.verdict}` : ""}${r.ready ? "" : ` (${r.why})`}`).join("\n");
}

// ---------- the worker cap ----------
export const DEFAULT_MAX_WORKING = 5;
export const maxWorking = (cfg) => { const n = Number(cfg?.sessions?.maxWorking); return Number.isInteger(n) && n >= 1 && n <= 50 ? n : DEFAULT_MAX_WORKING; };
const busy = (s) => s.alive && s.mode !== "axa" && s.mode !== "shell" && ["working", "starting"].includes(s.status);
// null: it may be sent. Otherwise why not. Sending to a session that's already working takes no new slot.
export function capRefusal(sessions, targetId, max) {
  const t = sessions.find((s) => s.id === targetId);
  if (!t || t.mode === "shell" || t.mode === "axa" || busy(t)) return null;
  const n = sessions.filter(busy).length;
  return n >= max ? `Not sent: ${n} sessions are already working (the cap is ${max}, ui.json sessions.maxWorking). Wait for one to finish, or send again with queue: true and AXA types it in when a slot frees.` : null;
}
// Sends waiting for a slot, oldest first: tick() types in what fits now (send(item) -> Promise)
export function createSendQueue({ send, now = Date.now } = {}) {
  let q = [];
  return {
    add(item) { q = q.filter((x) => x.id !== item.id); q.push({ ...item, at: now() }); return q.length; },
    async tick(sessions, max) {
      for (const it of [...q]) {
        if (capRefusal(sessions, it.id, max)) break; // still full
        const t = sessions.find((s) => s.id === it.id);
        if (!t?.alive) { q = q.filter((x) => x !== it); continue; }
        if (!["ready", "done"].includes(t.status)) continue; // it's mid-prompt: later
        q = q.filter((x) => x !== it);
        await send(it);
        t.status = "working"; // counts against the cap for the rest of this tick
      }
    },
    list: () => q.map(({ id, text, at }) => ({ id, text: text.slice(0, 120), at })),
  };
}
