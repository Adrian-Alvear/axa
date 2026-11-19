// Drawing helpers for the terminal UI: themes, colors by role, display width, boxes.
export const ESC = "\x1b";

// Themes map roles to SGR codes. "terminal" uses the 16 basic colors so your terminal's theme applies.
export const THEMES = {
  terminal: { title: "1;36", accent: "36", head: "1", wait: "1;33", waitSoft: "33", stuck: "31", work: "36", done: "32", idle: "0", off: "90", dim: "90", sel: "7", selDim: "7;90", frame: "90", frameOn: "36", key: "1;36", add: "32", del: "31", hunk: "36", bar: "7" },
  hud: { title: "1;38;2;79;216;255", accent: "38;2;79;216;255", head: "1;38;2;233;251;255", wait: "1;38;2;255;181;71", waitSoft: "38;2;255;181;71", stuck: "38;2;255;138;92", work: "38;2;79;216;255", done: "38;2;94;242;194", idle: "38;2;200;220;230", off: "38;2;108;138;153", dim: "38;2;108;138;153", sel: "48;2;14;48;66;38;2;233;251;255", selDim: "48;2;14;48;66;38;2;108;138;153", frame: "38;2;34;78;98", frameOn: "38;2;79;216;255", key: "1;38;2;79;216;255", add: "38;2;94;242;194", del: "38;2;255;84;104", hunk: "38;2;79;216;255", bar: "48;2;14;48;66;38;2;233;251;255" },
  mono: { title: "1", accent: "1", head: "1", wait: "1;4", waitSoft: "1", stuck: "1", work: "0", done: "0", idle: "0", off: "2", dim: "2", sel: "7", selDim: "7", frame: "2", frameOn: "1", key: "1", add: "1", del: "2", hunk: "1", bar: "7" },
};
let theme = THEMES.terminal;
export const setTheme = (name) => { theme = process.env.NO_COLOR || process.env.TERM === "dumb" ? THEMES.mono : THEMES[name] || THEMES.terminal; };
export const paint = (role, s) => { const c = theme[role] ?? role; return c && c !== "0" ? `${ESC}[${c}m${s}${ESC}[0m` : s; };

// Status of a session: glyph, word, color role. Never color alone.
const LOOK = { waiting: ["⚠", "needs you", "wait"], stuck: ["◷", "stuck", "stuck"], working: ["●", "working", "work"], done: ["✓", "done", "done"], ready: ["○", "ready", "idle"], starting: ["◌", "starting", "off"], exited: ["–", "exited", "off"] };
export const look = (s) => (s.mode === "shell" && ["starting", "ready"].includes(s.status) ? ["$", "shell", "idle"] : LOOK[s.status] || ["?", s.status, "idle"]);
export const URGENCY = ["waiting", "stuck", "working", "done", "ready", "starting", "exited"];

// ---------- text ----------
export const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
// display width: wide East Asian characters and emoji take two columns
const cw = (ch) => { const c = ch.codePointAt(0); return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1; };
export const width = (s) => { let n = 0; for (const ch of s) n += cw(ch); return n; };
export const cut = (s, n) => { if (n <= 0) return ""; if (width(s) <= n) return s; let o = "", w = 0; for (const ch of s) { if (w + cw(ch) > n - 1) break; o += ch; w += cw(ch); } return o + "…"; };
export const pad = (s, n) => { const c = cut(s, n); return c + " ".repeat(Math.max(0, n - width(c))); };
export const center = (s, n) => { const c = cut(s, n), l = Math.floor((n - width(c)) / 2); return " ".repeat(Math.max(0, l)) + c + " ".repeat(Math.max(0, n - l - width(c))); };

// A line from segments [[text, role], ...], cut/padded to exactly n columns; right segments are right-aligned
export function line(segs, n, right = []) {
  // the right side always ends one column before the edge
  right = right.filter(([t]) => t);
  if (right.length) right = [...right.slice(0, -1), [right.at(-1)[0].trimEnd() + " ", right.at(-1)[1]]];
  const rw = right.reduce((a, [t]) => a + width(t), 0);
  const showRight = rw && rw < n - 4;
  const room = Math.max(0, n - (showRight ? rw + 1 : 0)); // one column between the two sides
  let o = "", used = 0;
  for (const [t, role] of segs) {
    if (!t || used >= room) continue;
    const c = cut(t, room - used);
    o += paint(role, c); used += width(c);
  }
  o += " ".repeat(Math.max(0, room - used));
  if (showRight) { o += " "; for (const [t, role] of right) o += paint(role, t); }
  return o;
}
// The same, the whole line highlighted (a selected row): one style across, so it reads as one bar
export function selLine(segs, n, right = [], role = "sel") {
  const plain = (a) => a.map(([t]) => [t, ""]);
  return paint(role, line(plain(segs), n, plain(right)));
}

export const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const gitText = (g) => (!g ? "" : `⎇ ${g.branch}${g.files ? ` ${g.files}f +${g.added} -${g.removed}` : ""}${g.ahead ? ` ↑${g.ahead}` : ""}`);
export function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}
