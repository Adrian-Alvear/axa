// How long things usually take, per project: "npm test" in feed, "next build" in launches, a whole turn.
// The daemon learns it from the hook log (PreToolUse -> PostToolUse of a Bash command; UserPromptSubmit ->
// Stop for a turn) and keeps the last MAX_SAMPLES per key in <AXA home>/durations.json. Used to say ahead of
// time what's coming: "feed is running the tests, usually about a minute"; "feed is taking longer than usual
// on the tests" (once, at 1.5x its p90); and the turn's ETA in "what's up".
// Pure core (the tracker takes a store and a say() callback); the file is the daemon's (server.mjs).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { home } from "../paths.mjs";

export const MAX_SAMPLES = 30, MIN_SAMPLES = 3;
export const HEADS_UP_MS = 20_000; // only things that usually take longer than this get a heads-up
export const LONGER = 1.5; // "taking longer than usual" past LONGER x p90
export const file = () => join(home, "durations.json");

// A command's signature: what identifies the kind of work, not its arguments ("npm test", "npm run build",
// "next build", "pytest", "cargo test"). Leading env assignments and a `cd x &&` are skipped; only the first
// command of a chain counts; flags are dropped.
export function signature(cmd) {
  let c = String(cmd || "").trim().replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, "").replace(/^cd\s+\S+\s*(?:&&|;)\s*/, "");
  c = c.split(/\s*(?:&&|\|\||;|\|)\s*/)[0].trim();
  const w = c.split(/\s+/).filter((x) => x && !x.startsWith("-"));
  if (!w.length) return null;
  const prog = w[0].replace(/^.*\//, "");
  if (["npm", "pnpm", "yarn", "bun"].includes(prog)) {
    if (["run", "run-script"].includes(w[1])) return w[2] ? `${prog} run ${w[2]}` : null;
    return w[1] ? `${prog} ${w[1]}` : prog;
  }
  if (["npx", "bunx", "pnpx"].includes(prog)) return w[1] ? `${w[1].replace(/@[^/]*$/, "")}${w[2] && /^[a-z][\w:-]*$/.test(w[2]) ? ` ${w[2]}` : ""}` : null;
  if (["node", "python", "python3", "deno", "ruby", "bash", "sh"].includes(prog)) return w[1] ? `${prog} ${w[1].replace(/^.*\//, "")}` : prog;
  return w[1] && /^[a-z][\w:-]*$/.test(w[1]) ? `${prog} ${w[1]}` : prog;
}
// what to call it when speaking
export function labelOf(sig) {
  const s = String(sig || "");
  if (/\b(test|tests|jest|vitest|pytest|playwright|mocha)\b/.test(s)) return "the tests";
  if (/\b(build|tsc|compile)\b/.test(s)) return "the build";
  if (/\b(lint|eslint)\b/.test(s)) return "the linter";
  if (/\b(install|ci)\b/.test(s)) return "the install";
  if (/\bcheck\b/.test(s)) return "the checks";
  return s;
}
export const keyOf = (project, sig) => `${project}::${sig}`;

export function stats(samples) {
  if (!samples?.length) return null;
  const s = [...samples].sort((a, b) => a - b), n = s.length;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return { n, median, p90: s[Math.min(n - 1, Math.ceil(0.9 * n) - 1)] };
}
// "about 30 seconds", "about a minute", "about 4 minutes", "about an hour"
export function about(ms) {
  const s = ms / 1000;
  if (s < 50) return `about ${Math.max(5, Math.round(s / 5) * 5)} seconds`;
  if (s < 90) return "about a minute";
  const m = Math.round(s / 60);
  if (m < 55) return `about ${m} minutes`;
  const h = Math.round(m / 60);
  return h <= 1 ? "about an hour" : `about ${h} hours`;
}

// The store: { key: [ms, ...] }, the last MAX_SAMPLES each. load/save injected (tests); daemon: the file.
export function createStore({ load = () => ({}), save = () => {} } = {}) {
  let data = {};
  try { data = load() || {}; } catch {}
  return {
    record(key, ms) {
      if (!(ms > 0) || ms > 6 * 3600_000) return;
      (data[key] ||= []).push(Math.round(ms));
      if (data[key].length > MAX_SAMPLES) data[key] = data[key].slice(-MAX_SAMPLES);
      try { save(data); } catch {}
    },
    stats: (key) => stats(data[key]),
    data: () => data,
  };
}
export const fileStore = (f = file()) => createStore({
  load: () => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}),
  save: (d) => { const tmp = `${f}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 }); renameSync(tmp, f); },
});

// The tracker: hook events in; heads-ups out through say(item) (narrator items, P2). nameOf(terminal) -> a
// session's name; projectOf(event) -> its project (the folder's name by default).
export function createTracker({ store, now = Date.now, nameOf = (t) => t, projectOf = (e) => basename(e.cwd || ""), say = () => {} }) {
  const inflight = new Map(); // tool_use_id -> { key, sig, start, terminal, st, warned }
  const turns = new Map(); // terminal -> { key, start }
  const known = (st) => st && st.n >= MIN_SAMPLES;
  function event(e) {
    if (!e?.terminal || e.agent_id) return;
    if (e.event === "PreToolUse" && e.tool === "Bash" && e.tool_use_id) {
      const sig = signature(e.command);
      if (!sig) return;
      const key = keyOf(projectOf(e), sig), st = store.stats(key);
      inflight.set(e.tool_use_id, { key, sig, start: e.ts, terminal: e.terminal, st, warned: false });
      if (known(st) && st.median > HEADS_UP_MS) say({ kind: "eta", key: "tool", session: e.terminal, toolUse: e.tool_use_id, text: `${nameOf(e.terminal)} is running ${labelOf(sig)}, usually ${about(st.median)}.` });
    } else if ((e.event === "PostToolUse" || e.event === "PostToolUseFailure") && inflight.has(e.tool_use_id)) {
      const r = inflight.get(e.tool_use_id);
      inflight.delete(e.tool_use_id);
      if (e.event === "PostToolUse") store.record(r.key, e.ts - r.start);
    } else if (e.event === "UserPromptSubmit") turns.set(e.terminal, { key: keyOf(projectOf(e), "turn"), start: e.ts });
    else if (e.event === "Stop" && turns.has(e.terminal)) { const t = turns.get(e.terminal); turns.delete(e.terminal); store.record(t.key, e.ts - t.start); }
    else if (["StopFailure", "SessionEnd"].includes(e.event)) { turns.delete(e.terminal); for (const [id, r] of inflight) if (r.terminal === e.terminal) inflight.delete(id); }
  }
  // every few seconds: a command running past 1.5x its usual p90 is said once
  function tick(t = now()) {
    for (const [id, r] of inflight) {
      if (t - r.start > 6 * 3600_000) { inflight.delete(id); continue; }
      if (!r.warned && known(r.st) && r.st.median > HEADS_UP_MS && t - r.start > LONGER * r.st.p90) {
        r.warned = true;
        say({ kind: "longer", key: "tool", session: r.terminal, toolUse: id, text: `${nameOf(r.terminal)} is taking longer than usual on ${labelOf(r.sig)}.` });
      }
    }
  }
  // the turn's ETA for "what's up": "usually done in about 4 minutes" / "taking longer than usual" / null
  function eta(terminal, t = now()) {
    const turn = turns.get(terminal);
    if (!turn) return null;
    const st = store.stats(turn.key), el = t - turn.start;
    if (!known(st)) return null;
    if (el > LONGER * st.p90) return "taking longer than usual";
    return el < st.median ? `usually done in ${about(st.median - el)}` : null;
  }
  // how long the work in this session usually takes in all (the turn's median, or a running command's): for
  // heartbeats (only work expected over 2 min gets one)
  function expected(terminal) {
    const ms = [];
    const turn = turns.get(terminal), st = turn && store.stats(turn.key);
    if (known(st)) ms.push(st.median);
    for (const r of inflight.values()) if (r.terminal === terminal && known(r.st)) ms.push(r.st.median);
    return ms.length ? Math.max(...ms) : null;
  }
  return { event, tick, eta, expected, running: (id) => inflight.has(id) };
}
