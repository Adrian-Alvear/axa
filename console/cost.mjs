// ---------- cost: what each Claude session has spent, from Claude Code's own statusLine data ----------
// `axa statusline` (console/statusline.mjs) records each session's cost.total_cost_usd and context %
// into $AXA_HOME/cost.json; the console reads it back (cached by mtime) for the session list and
// per-day totals. The file only holds numbers, ids and the model name, never prompt or screen text.
import { readFileSync, writeFileSync, renameSync, statSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";

const KEEP_SESSION_MS = 30 * 24 * 3600_000; // sessions not seen for a month are dropped
const KEEP_DAYS = 90;
const CHECK_MS = 2000; // the console looks at the file's mtime at most this often
const CHAT_ID = /^[\w-]{1,80}$/;
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
// Local calendar day, YYYY-MM-DD ("sv" formats dates that way)
export const dayOf = (ms) => new Date(ms).toLocaleDateString("sv");
export const costPath = (home) => join(home, "cost.json");

export function readCost(home) {
  try {
    const c = JSON.parse(readFileSync(costPath(home), "utf8"));
    return { sessions: c?.sessions && typeof c.sessions === "object" ? c.sessions : {}, days: c?.days && typeof c.days === "object" ? c.days : {} };
  } catch { return { sessions: {}, days: {} }; }
}

// Pure: the file's contents with one statusLine reading added. total_cost_usd is the session's running
// total, so a day's spend is what each session added that day: the first reading on a new day sets
// that day's baseline at the session's previous total.
export function addReading(c, { session, usd, context_pct, model, terminal, cwd }, at = Date.now()) {
  if (!CHAT_ID.test(String(session || ""))) return c;
  const day = dayOf(at), prev = c.sessions[session];
  const total = num(usd) ?? prev?.usd ?? 0;
  const base = !prev ? 0 : prev.day === day ? prev.base ?? 0 : prev.usd ?? 0;
  c.sessions[session] = {
    usd: total, context_pct: num(context_pct) ?? prev?.context_pct, model: typeof model === "string" ? model.slice(0, 60) : prev?.model,
    at, day, base, terminal: /^[\w-]{1,40}$/.test(terminal || "") ? terminal : prev?.terminal, cwd: typeof cwd === "string" ? cwd.slice(0, 500) : prev?.cwd,
  };
  (c.days[day] ||= {})[session] = Math.max(0, total - base);
  for (const [id, s] of Object.entries(c.sessions)) if (at - (s.at || 0) > KEEP_SESSION_MS) delete c.sessions[id];
  for (const d of Object.keys(c.days).sort().slice(0, -KEEP_DAYS)) delete c.days[d];
  return c;
}

// Atomic (temp file + rename), readable only by you. Several sessions can write at once: the last
// one wins, and the next statusLine refresh (every few seconds while a session is active) catches up.
export function recordCost(home, reading, at = Date.now()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const c = addReading(readCost(home), reading, at), p = costPath(home), tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
  renameSync(tmp, p);
  try { chmodSync(p, 0o600); } catch {}
  return c;
}

// ---------- the console's side: cached reads ----------
export function createCostReader(home) {
  let cache = { sessions: {}, days: {} }, mtime = 0, checked = 0;
  const load = () => {
    const t = Date.now();
    if (t - checked < CHECK_MS) return cache;
    checked = t;
    try { const m = statSync(costPath(home)).mtimeMs; if (m !== mtime) { mtime = m; cache = readCost(home); } } catch { cache = { sessions: {}, days: {} }; mtime = 0; }
    return cache;
  };
  // { usd, context_pct, model, at } for a session: by its Claude chat id, else the newest reading
  // recorded from inside that console terminal (AXA_TERMINAL_ID)
  function costOf(chatId, terminalId) {
    const { sessions } = load();
    let s = chatId && sessions[chatId];
    if (!s && terminalId) for (const x of Object.values(sessions)) if (x.terminal === terminalId && (!s || x.at > s.at)) s = x;
    return s ? { usd: s.usd, context_pct: s.context_pct, model: s.model, at: s.at } : null;
  }
  // GET /api/cost: { days: [{ date, usd, sessions }] newest first, today_usd, total_usd }
  function totals() {
    const { days } = load();
    const list = Object.entries(days).sort(([a], [b]) => (a < b ? 1 : -1)).map(([date, per]) => ({ date, usd: round(Object.values(per).reduce((a, b) => a + (num(b) || 0), 0)), sessions: Object.keys(per).length }));
    return { days: list, today_usd: list.find((d) => d.date === dayOf(Date.now()))?.usd ?? 0, total_usd: round(list.reduce((a, d) => a + d.usd, 0)) };
  }
  return { costOf, totals };
}
const round = (v) => Math.round(v * 10000) / 10000;
