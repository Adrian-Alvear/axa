// The terminal app's look: themes (roles -> SGR codes), the status vocabulary, and the text helpers
// that measure and cut strings by display width.
export const ESC = "\x1b";

// ---------- themes: roles -> SGR codes ----------
// "terminal" uses the 16 basic colors, so your terminal's own theme applies (the default)
export const THEMES = {
  terminal: { title: "1;36", accent: "36", wait: "1;33", waitSoft: "33", stuck: "31", work: "36", done: "32", idle: "0", off: "90", dim: "90", sel: "7", rule: "90", tag: "1;7", add: "32", del: "31", hunk: "36" },
  hud: { title: "1;38;2;79;216;255", accent: "38;2;79;216;255", wait: "1;38;2;255;181;71", waitSoft: "38;2;255;181;71", stuck: "38;2;255;138;92", work: "38;2;79;216;255", done: "38;2;94;242;194", idle: "38;2;143;179;196", off: "38;2;108;138;153", dim: "38;2;108;138;153", sel: "48;2;14;48;66;38;2;233;251;255", rule: "38;2;34;78;98", tag: "1;48;2;79;216;255;38;2;3;16;24", add: "38;2;94;242;194", del: "38;2;255;84;104", hunk: "38;2;79;216;255" },
  light: { title: "1;38;5;25", accent: "38;5;25", wait: "1;38;5;130", waitSoft: "38;5;130", stuck: "38;5;160", work: "38;5;25", done: "38;5;28", idle: "0", off: "38;5;245", dim: "38;5;242", sel: "48;5;153;38;5;16", rule: "38;5;250", tag: "1;7", add: "38;5;28", del: "38;5;160", hunk: "38;5;25" },
  contrast: { title: "1;97", accent: "1;96", wait: "1;93", waitSoft: "93", stuck: "1;91", work: "1;96", done: "1;92", idle: "97", off: "37", dim: "37", sel: "1;7", rule: "97", tag: "1;7", add: "1;92", del: "1;91", hunk: "1;96" },
  mono: { title: "1", accent: "1", wait: "1;4", waitSoft: "1", stuck: "1", work: "0", done: "0", idle: "0", off: "2", dim: "2", sel: "7", rule: "2", tag: "7", add: "1", del: "2", hunk: "1" },
};
export const PREFIXES = { "C-b": 0x02, "C-a": 0x01, "C-g": 0x07, "C-\\": 0x1c };
export const DEFAULTS = { theme: "terminal", prefix: "C-b", sidebar: "left", sidebarWidth: 34, bell: true, newSession: "claude", copyOnSelect: true, sidebarStyle: "tree" };

// ---------- status: [glyph, word, role] ----------
export const LOOK = { waiting: ["⚠", "needs you", "wait"], stuck: ["◷", "stuck", "stuck"], working: ["●", "working", "work"], done: ["✓", "done", "done"], ready: ["○", "ready", "idle"], shell: ["○", "shell", "dim"], starting: ["◌", "starting", "off"], exited: ["–", "exited", "off"] };
// plain shells report "shell" (older consoles said "starting"/"ready" for them forever)
export const statusOf = (s) => (s.mode === "shell" && ["starting", "ready"].includes(s.status) ? "shell" : s.status);
export const look = (s) => LOOK[statusOf(s)] || ["?", s.status, "idle"];
export const URGENCY = ["waiting", "stuck", "working", "done", "ready", "shell", "starting", "exited"];
export const byUrgency = (a, b) => URGENCY.indexOf(statusOf(a)) - URGENCY.indexOf(statusOf(b)) || (b.last_event_at || b.created) - (a.last_event_at || a.created);

// ---------- text helpers ----------
export const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
// display width: wide East Asian characters and emoji take two columns
export const cw = (ch) => { const c = ch.codePointAt(0); return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1; };
export const width = (s) => [...s].reduce((n, ch) => n + cw(ch), 0);
export const cut = (s, n) => { if (n <= 0) return ""; if (width(s) <= n) return s; let o = "", w = 0; for (const ch of s) { if (w + cw(ch) > n - 1) break; o += ch; w += cw(ch); } return o + "…"; };
export const pad = (s, n) => { const c = cut(s, n); return c + " ".repeat(Math.max(0, n - width(c))); };
export const clip = (s, n) => cut(clean(s), n);
// the question of a prompt: its last line that asks something (not a link like "Security guide")
export const question = (c) => { const ls = c.question.split("\n").map(clean).filter(Boolean); return [...ls].reverse().find((l) => l.includes("?")) || ls[0] || "a prompt"; };
// y = the first "Yes…" option, x = the "No…" option (menus differ: the trust prompt starts with "No, exit")
export const yesOpt = (c) => c.options.find((o) => /^yes\b/i.test(o.label)) || c.options[0];
export const noOpt = (c) => c.options.find((o) => /^no\b/i.test(o.label)) || c.options.at(-1);
export const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const gitText = (g) => (!g ? "" : `${g.branch}${g.files ? ` ${g.files}f +${g.added} -${g.removed}` : " clean"}${g.ahead ? ` ↑${g.ahead}` : ""}`);
export const what = (s) => clean(s.status === "done" ? s.last_report || "finished" : s.doing || s.last_report || (s.mode === "shell" ? "shell" : s.mode === "axa" ? "select it and type to talk" : ""));
export const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`; };

// Colors that follow the live settings: c.cfg.theme (and NO_COLOR)
export function theme(c) {
  const T = () => THEMES[c.noColor ? "mono" : c.cfg.theme] || THEMES.terminal;
  const sgr = (role, s) => { const code = T()[role] ?? role; return code && code !== "0" ? `${ESC}[${code}m${s}${ESC}[0m` : s; };
  // [text, role] segments cut to w columns, padded to exactly w
  const renderSegs = (segs, w) => { let o = "", n = 0; for (const [t, r] of segs) { if (!t) continue; if (n >= w) break; const s = cut(t, w - n); o += r ? sgr(r, s) : s; n += width(s); } return o + " ".repeat(Math.max(0, w - n)); };
  const keyName = () => c.cfg.prefix.replace("C-", "Ctrl-");
  const PREFIX = () => PREFIXES[c.cfg.prefix] ?? 0x02;
  return { T, sgr, renderSegs, keyName, PREFIX };
}
