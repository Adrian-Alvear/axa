// One status vocabulary for every AXA surface (web cards, lists, tabs, titles, notifications, the
// terminal app, `axa status`): a glyph, a word and a color role, never color alone. Pure, so the
// browser imports it too (served at /shared/look.mjs). Roles name theme tokens (console/theme.mjs).
export const STATUS = {
  waiting: { glyph: "⚠", ascii: "!", word: "needs you", role: "warn", tui: "wait" },
  stuck: { glyph: "◷", ascii: "~", word: "stuck", role: "bad", tui: "stuck" },
  failed: { glyph: "✕", ascii: "x", word: "failed", role: "bad", tui: "stuck" },
  working: { glyph: "●", ascii: "*", word: "working", role: "accent", tui: "work" },
  done: { glyph: "✓", ascii: "+", word: "done", role: "ok", tui: "done" },
  ready: { glyph: "○", ascii: "o", word: "ready", role: "text", tui: "idle" },
  shell: { glyph: "$", ascii: "$", word: "shell", role: "dim", tui: "dim" },
  starting: { glyph: "◌", ascii: ".", word: "starting", role: "dim", tui: "off" },
  exited: { glyph: "–", ascii: "-", word: "exited", role: "dim", tui: "off" },
};
// most urgent first: what needs you, then what's moving, then what's quiet
export const URGENCY = ["waiting", "stuck", "failed", "working", "done", "ready", "shell", "starting", "exited"];
// plain shells report "shell" (older consoles said "starting"/"ready" for them forever), and a session
// that is alive but has sent no traced event for STARTING_MS (hooks missing, or a plain `claude` that
// hasn't been given anything yet) is ready, not "starting" forever
export const STARTING_MS = 45_000;
export const statusOf = (s, now = Date.now()) => {
  if (s?.mode === "shell" && ["starting", "ready"].includes(s.status)) return "shell";
  if (s?.status === "starting" && s.alive === true && s.created && now - s.created > STARTING_MS) return "ready";
  return s?.status;
};
// why a session needs you, in one line, when the server says (stuck_reason / failed_reason, Phase 4)
export const reasonOf = (s) => { const st = statusOf(s); return (st === "stuck" && s?.stuck_reason) || (st === "failed" && s?.failed_reason) || ""; };
export const lookOf = (s) => STATUS[typeof s === "string" ? s : statusOf(s)] || { glyph: "?", ascii: "?", word: String((typeof s === "string" ? s : s?.status) || "unknown"), role: "dim", tui: "off" };
export const byUrgency = (a, b) => URGENCY.indexOf(statusOf(a)) - URGENCY.indexOf(statusOf(b)) || (b.last_event_at || b.created || 0) - (a.last_event_at || a.created || 0);
// "needs you" counts waiting and stuck sessions (and failed ones: a rate limit or billing stop)
export const needsYou = (s) => ["waiting", "stuck", "failed"].includes(statusOf(s));
// "⚠ needs you" / "! needs you"
export const label = (s, { ascii = false } = {}) => { const l = lookOf(s); return `${ascii ? l.ascii : l.glyph} ${l.word}`; };
