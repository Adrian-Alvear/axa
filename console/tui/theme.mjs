// The terminal app's look: themes (roles -> SGR codes), the status vocabulary, and the text helpers
// that measure and cut strings by display width.
import { THEMES as SHARED_THEMES, TERMINAL_THEME, themeId, tuiRoles, colorDepth } from "../theme.mjs";
import { STATUS, URGENCY, statusOf, lookOf, byUrgency, needsYou, label } from "../look.mjs";

export const ESC = "\x1b";

// ---------- themes: roles -> SGR codes (console/theme.mjs, shared with the web console) ----------
// "terminal" uses the 16 basic colors, so your terminal's own theme applies (the default); the others
// are AXA's named themes: exact colors on a truecolor terminal, quantized on 256, the basic named
// colors on 16. "mono" is an explicit no-colors choice (NO_COLOR or TERM=dumb force it).
export const THEME_NAMES = [TERMINAL_THEME, ...Object.keys(SHARED_THEMES), "mono"];
// a saved name -> one the app offers: aliases (light -> paper) resolve, unknown -> terminal
export const appTheme = (name) => (name === "mono" || name === TERMINAL_THEME ? name : SHARED_THEMES[themeId(name)] && (themeId(name) !== "hud" || name === "hud") ? themeId(name) : TERMINAL_THEME);
export const themeLabel = (name) => { const n = appTheme(name); return n === TERMINAL_THEME ? "Terminal colors" : n === "mono" ? "Mono" : SHARED_THEMES[n].label; };
export const DEPTH_TEXT = { truecolor: "truecolor", 256: "256 colors", 16: "16 colors", mono: "no colors" };
// roles for a theme at a depth (the app's own picks: mono is mono at any depth)
export const rolesFor = (name, depth) => tuiRoles(appTheme(name), appTheme(name) === "mono" ? "mono" : depth);
export const PREFIXES = { "C-b": 0x02, "C-a": 0x01, "C-g": 0x07, "C-\\": 0x1c };
export const DEFAULTS = { theme: "terminal", themeSync: false, prefix: "C-b", sidebar: "left", sidebarWidth: 34, bell: true, newSession: "claude", copyOnSelect: true, sidebarStyle: "tree" };

// ---------- status: [glyph, word, role] from the shared vocabulary (console/look.mjs) ----------
export { STATUS, URGENCY, statusOf, byUrgency, needsYou, label as statusLabel };
export const look = (s) => { const l = lookOf(s); return [l.glyph, l.word, l.tui]; };

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

// Colors that follow the live settings: c.cfg.theme at the terminal's color depth (c.depth, from the
// environment: mono when NO_COLOR or TERM=dumb)
export function theme(c) {
  c.depth ||= colorDepth(process.env);
  let memo = null;
  const T = () => { const key = `${c.cfg.theme}|${c.depth}`; if (memo?.key !== key) memo = { key, roles: rolesFor(c.cfg.theme, c.depth) }; return memo.roles; };
  const sgr = (role, s) => { const code = T()[role] ?? role; return code && code !== "0" ? `${ESC}[${code}m${s}${ESC}[0m` : s; };
  // [text, role] segments cut to w columns, padded to exactly w
  const renderSegs = (segs, w) => { let o = "", n = 0; for (const [t, r] of segs) { if (!t) continue; if (n >= w) break; const s = cut(t, w - n); o += r ? sgr(r, s) : s; n += width(s); } return o + " ".repeat(Math.max(0, w - n)); };
  const keyName = () => c.cfg.prefix.replace("C-", "Ctrl-");
  const PREFIX = () => PREFIXES[c.cfg.prefix] ?? 0x02;
  return { T, sgr, renderSegs, keyName, PREFIX };
}
