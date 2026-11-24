// Usage: what each session costs, per project per day, the account's limits, and runaway spending.
// Every number says where it comes from: "official" when Claude Code itself reported it (the tokens in its
// transcripts; the 5-hour / weekly limit % its status line receives), "estimate" when AXA worked it out (the
// cost: tokens x list prices below, which can drift from what Anthropic bills).
// Pure, except readLimits (one small file read).
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// $ per million tokens: [input, output, cache write, cache read]. List prices as AXA knows them: an estimate.
export const PRICES = { opus: [5, 25, 6.25, 0.5], sonnet: [3, 15, 3.75, 0.3], haiku: [1, 5, 1.25, 0.1], fable: [3, 15, 3.75, 0.3] };
export const familyOf = (model) => /opus/i.test(model || "") ? "opus" : /haiku/i.test(model || "") ? "haiku" : /fable/i.test(model || "") ? "fable" : "sonnet";
// u: { input (new input incl. cache writes), written (cache writes), cached (cache reads), output }
export function costOf(u, model) {
  if (!u) return null;
  const [i, o, w, r] = PRICES[familyOf(model)], M = 1e6;
  const written = u.written || 0, fresh = Math.max(0, (u.input || 0) - written);
  return Math.round(((fresh * i + written * w + (u.cached || 0) * r + (u.output || 0) * o) / M) * 100) / 100;
}
export const usd = (n) => (n == null ? "?" : n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);

// Per project per day, over the sessions' usage ({ days: { "2026-11-24": {input, written, cached, output} }, model })
export function byProjectDay(sessions) {
  const out = {};
  for (const s of sessions || []) {
    const u = s.usage;
    if (!u?.days) continue;
    const p = basename(s.worktree?.repo || s.cwd || "") || s.name;
    for (const [day, d] of Object.entries(u.days)) {
      const row = ((out[p] ||= {})[day] ||= { tokens: 0, cost: 0 });
      row.tokens += (d.input || 0) + (d.output || 0);
      row.cost = Math.round((row.cost + costOf(d, u.model)) * 100) / 100;
    }
  }
  return out;
}

// The account's 5-hour / weekly limits, as Claude Code's status line last received them (official), with how old
// that is. file: AXA_STATUSLINE_FILE, else ~/.claude/statusline-last-input.json (written by a status line script
// that saves its input; absent: null).
export const limitsFile = (env = process.env) => env.AXA_STATUSLINE_FILE || join(homedir(), ".claude", "statusline-last-input.json");
export function readLimits(file = limitsFile(), now = Date.now()) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")), r = j.rate_limits;
    if (!r) return null;
    const one = (x) => (x && Number.isFinite(x.used_percentage) ? { pct: x.used_percentage, resets_at: x.resets_at ? x.resets_at * 1000 : null } : null);
    return { five_hour: one(r.five_hour), seven_day: one(r.seven_day), age_ms: now - statSync(file).mtimeMs, label: "official" };
  } catch { return null; }
}
// "5h 29% · wk 39%" (null when unknown or older than 6 h)
export function limitsText(l) {
  if (!l || l.age_ms > 6 * 3600_000) return null;
  return [l.five_hour && `5h ${l.five_hour.pct}%`, l.seven_day && `wk ${l.seven_day.pct}%`].filter(Boolean).join(" · ") || null;
}

// ---------- runaway spending ----------
// policy.json "runaway": { "tokens15m": 1500000 } (default). A session that spends more than that in 15 min with no
// commit and no turn end, or that keeps spending (half that) after it reported done, is flagged (needs you).
export const RUNAWAY = { windowMs: 15 * 60_000, tokens: 1_500_000 };
// samples: [{ at, tokens }] oldest first; lastCommitAt, lastStopAt, doneAt: ms (0 = never)
export function runawayCheck(samples, { now, limit = RUNAWAY.tokens, windowMs = RUNAWAY.windowMs, lastCommitAt = 0, lastStopAt = 0, doneAt = 0 } = {}) {
  if (!samples?.length) return null;
  const from = samples.find((x) => x.at >= now - windowMs) || samples[0];
  const latest = samples.at(-1), spent = latest.tokens - from.tokens;
  if (latest.at - from.at < windowMs * 0.8) return null; // not enough history yet
  if (doneAt && doneAt > from.at && !(lastCommitAt > doneAt)) {
    const after = latest.tokens - (samples.find((x) => x.at >= doneAt)?.tokens ?? latest.tokens);
    if (after > limit / 2) return { kind: "after_done", spent: after };
  }
  if (spent > limit && !(lastCommitAt > from.at) && !(lastStopAt > from.at)) return { kind: "burn", spent };
  return null;
}
export const runawayText = (name, r) => r.kind === "burn"
  ? `${name} spent ${Math.round(r.spent / 1000)}k tokens in 15 min with no commit and no finished turn: check it isn't looping`
  : `${name} kept spending (${Math.round(r.spent / 1000)}k tokens) after it said it was done: check its goal`;
