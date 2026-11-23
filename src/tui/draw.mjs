import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
// Drawing helpers for the terminal UI: themes, colors by role, display width, boxes.
export const ESC = "\x1b";

// Themes map roles to SGR codes. "axa" (the default on terminals with 24-bit color) is a dark, filled
// look; "terminal" uses the 16 basic colors so your terminal's own theme applies; "mono" has no color.
const rgb = (r, g, b) => `38;2;${r};${g};${b}`, bg = (r, g, b) => `48;2;${r};${g};${b}`;
const C = { cyan: [79, 216, 255], amber: [255, 186, 82], green: [94, 230, 170], red: [255, 110, 92], violet: [180, 150, 255], text: [222, 232, 238], dim: [122, 142, 158], faint: [58, 72, 86], ink: [10, 14, 18], bar: [26, 33, 43], sel: [28, 62, 82], pv: [19, 25, 33] };
const chip = (c) => `1;${bg(...c)};${rgb(...C.ink)}`;
export const THEMES = {
  axa: {
    title: `1;${rgb(...C.cyan)}`, accent: rgb(...C.cyan), head: `1;${rgb(...C.text)}`, text: rgb(...C.text), wait: `1;${rgb(...C.amber)}`, waitSoft: rgb(...C.amber), stuck: rgb(...C.red), work: rgb(...C.cyan), done: rgb(...C.green), idle: rgb(...C.text), off: rgb(...C.dim), dim: rgb(...C.dim), violet: rgb(...C.violet),
    sel: `${bg(...C.sel)};${rgb(255, 255, 255)}`, selDim: `${bg(...C.bar)};${rgb(...C.text)}`, frame: rgb(...C.faint), frameOn: rgb(...C.cyan), key: `1;${rgb(...C.cyan)}`, add: rgb(...C.green), del: rgb(...C.red), hunk: rgb(...C.cyan),
    bar: `${bg(...C.bar)};${rgb(...C.text)}`, barDim: `${bg(...C.bar)};${rgb(...C.dim)}`, barTitle: `1;${bg(...C.bar)};${rgb(...C.cyan)}`, pv: `${bg(...C.pv)};${rgb(...C.text)}`, pvDim: `${bg(...C.pv)};${rgb(...C.dim)}`, pvHead: `1;${bg(...C.bar)};${rgb(255, 255, 255)}`,
    tabOn: `1;${bg(...C.cyan)};${rgb(...C.ink)}`, tabOff: `${bg(...C.bar)};${rgb(...C.dim)}`, keycap: `1;${bg(...C.faint)};${rgb(...C.text)}`,
    chipWait: chip(C.amber), chipWork: chip(C.cyan), chipDone: chip(C.green), chipStuck: chip(C.red), chipIdle: `1;${bg(...C.faint)};${rgb(...C.text)}`, chipOff: `${bg(...C.bar)};${rgb(...C.dim)}`,
    you: `1;${rgb(...C.amber)}`, claude: `1;${rgb(...C.cyan)}`,
  },
  terminal: { title: "1;36", accent: "36", head: "1", text: "0", wait: "1;33", waitSoft: "33", stuck: "31", work: "36", done: "32", idle: "0", off: "90", dim: "90", violet: "35", sel: "7", selDim: "2;7", frame: "90", frameOn: "36", key: "1;36", add: "32", del: "31", hunk: "36", bar: "0", barDim: "90", barTitle: "1;36", pv: "0", pvDim: "90", pvHead: "1", tabOn: "1;7;36", tabOff: "90", keycap: "7", chipWait: "1;30;43", chipWork: "30;46", chipDone: "30;42", chipStuck: "30;41", chipIdle: "7", chipOff: "2;7", you: "1;33", claude: "1;36" },
  mono: { title: "1", accent: "1", head: "1", text: "0", wait: "1;4", waitSoft: "1", stuck: "1", work: "0", done: "0", idle: "0", off: "2", dim: "2", violet: "0", sel: "7", selDim: "7", frame: "2", frameOn: "1", key: "1", add: "1", del: "2", hunk: "1", bar: "0", barDim: "2", barTitle: "1", pv: "0", pvDim: "2", pvHead: "1", tabOn: "7", tabOff: "2", keycap: "7", chipWait: "7", chipWork: "7", chipDone: "7", chipStuck: "7", chipIdle: "7", chipOff: "2", you: "1", claude: "1" },
};
export const THEME_NAMES = Object.keys(THEMES);
export const truecolor = () => /truecolor|24bit/i.test(process.env.COLORTERM || "") || !!process.env.WT_SESSION || /iTerm|WezTerm|vscode/i.test(process.env.TERM_PROGRAM || "");
let theme = THEMES.terminal;
export const setTheme = (name) => { theme = process.env.NO_COLOR || process.env.TERM === "dumb" ? THEMES.mono : THEMES[name] || THEMES.terminal; };
export const paint = (role, s) => { const c = theme[role] ?? role; return c && c !== "0" ? `${ESC}[${c}m${s}${ESC}[0m` : s; };
// a role's raw SGR (to color a background run that contains other colors)
export const sgrOf = (role) => theme[role] ?? "";

// ---------- icons: Nerd Font glyphs, or plain Unicode that every font has ----------
const NERD = { axa: "\uf0e7", session: "\uf120", shell: "\uf489", chat: "\uf086", agent: "\uf0c0", project: "\uf07b", home: "\uf015", branch: "\ue725", wait: "\uf071", stuck: "\uf017", done: "\uf00c", ready: "\uf10c", off: "\uf068", open: "\uf111", you: "\uf007", claude: "\uf0e7", tokens: "\uf080", worktree: "\uf126", plus: "\uf067", search: "\uf002" };
const PLAIN = { axa: "◆", session: "▸", shell: "$", chat: "≡", agent: "◇", project: "▣", home: "~", branch: "⎇", wait: "▲", stuck: "◷", done: "✓", ready: "○", off: "–", open: "●", you: "›", claude: "◆", tokens: "Σ", worktree: "⑂", plus: "+", search: "/" };
export let I = PLAIN;
// Is a Nerd Font installed? (Windows fonts on WSL, fc-list elsewhere.) Used only to pick the default.
export function nerdFontInstalled() {
  const nerd = /nerd|\bNF[MP]?\b|NerdFont/i;
  try {
    if (process.platform === "darwin") return readdirSafe(`${process.env.HOME}/Library/Fonts`).some((f) => nerd.test(f));
    const dirs = ["/mnt/c/Windows/Fonts", ...readdirSafe("/mnt/c/Users").map((u) => `/mnt/c/Users/${u}/AppData/Local/Microsoft/Windows/Fonts`)];
    if (dirs.some((d) => readdirSafe(d).some((f) => nerd.test(f)))) return true;
    const r = spawnSync("fc-list", [], { encoding: "utf8", timeout: 3000 });
    return r.status === 0 && nerd.test(r.stdout);
  } catch { return false; }
}
function readdirSafe(d) { try { return readdirSync(d); } catch { return []; } }
export const setIcons = (kind) => { I = kind === "nerd" ? NERD : PLAIN; };
// the spinner for working sessions
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
// motion: "full" | "reduced" | "off" (Settings, ui.json, AXA_REDUCED_MOTION); with "off" nothing turns
let motion = "full";
export const setMotion = (m) => { motion = ["full", "reduced", "off"].includes(m) ? m : "full"; };
export const getMotion = () => motion;
export const spinner = () => (motion === "off" ? SPIN[0] : SPIN[Math.floor(Date.now() / 100) % SPIN.length]);

// Status of a session: glyph, word, color role. Never color alone.
// [glyph, word, color role, chip role]
const LOOK = () => ({ waiting: [I.wait, "needs you", "wait", "chipWait"], needs_trust: [I.wait, "needs trust", "wait", "chipWait"], stuck: [I.stuck, "stuck", "stuck", "chipStuck"], working: [spinner(), "working", "work", "chipWork"], limited: [I.stuck, "limited", "waitSoft", "chipWait"], failed: [I.off, "failed", "stuck", "chipStuck"], done: [I.done, "done", "done", "chipDone"], ready: [I.ready, "ready", "idle", "chipIdle"], starting: [spinner(), "starting", "off", "chipOff"], exited: [I.off, "exited", "off", "chipOff"] });
export const look = (s) => (s.mode === "shell" && ["starting", "ready"].includes(s.status) ? [I.shell, "shell", "idle", "chipIdle"] : LOOK()[s.status] || ["?", s.status, "idle", "chipIdle"]);
// a status chip: " NEEDS YOU "
export const chipOf = (s) => { const [, word, , role] = look(s); return [` ${word.toUpperCase()} `, role]; };
// the independent reviewer's verdict on a session's last turn, as a small badge
const REVIEW_BADGE = { reviewing: "… reviewing", approve: "✓ reviewed", warn: "⚠ review", block: "✗ blocked", error: "? unreviewed" };
export const reviewBadge = (s) => REVIEW_BADGE[s?.review?.verdict] || (s?.fixer ? "fixer (milestone review)" : "");
export const URGENCY = ["waiting", "needs_trust", "stuck", "failed", "limited", "working", "done", "ready", "starting", "exited"];

// ---------- text ----------
export const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
// display width: wide East Asian characters and emoji take two columns
const cw = (ch) => { const c = ch.codePointAt(0); return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1; };
export const width = (s) => { let n = 0; for (const ch of s) n += cw(ch); return n; };
export const cut = (s, n) => { if (n <= 0) return ""; if (width(s) <= n) return s; let o = "", w = 0; for (const ch of s) { if (w + cw(ch) > n - 1) break; o += ch; w += cw(ch); } return o + "…"; };
export const pad = (s, n) => { const c = cut(s, n); return c + " ".repeat(Math.max(0, n - width(c))); };
export const center = (s, n) => { const c = cut(s, n), l = Math.floor((n - width(c)) / 2); return " ".repeat(Math.max(0, l)) + c + " ".repeat(Math.max(0, n - l - width(c))); };

// A line from segments [[text, role], ...], cut/padded to exactly n columns; right segments are
// right-aligned. on: a background role laid under the whole line (a selected row, a bar), keeping
// each segment's own color on top of it.
export function line(segs, n, right = [], on = null) {
  const base = on ? sgrOf(on) : "";
  const p = (role, t) => { const c = [base, sgrOf(role) || (role && !theme[role] ? role : "")].filter(Boolean).join(";"); return c ? `${ESC}[${c}m${t}${ESC}[0m` : t; };
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
    o += p(role, c); used += width(c);
  }
  o += p("", " ".repeat(Math.max(0, room - used)));
  if (showRight) { o += p("", " "); for (const [t, role] of right) o += p(role, t); }
  return o;
}
// The whole line highlighted in one style (plain segments)
export function selLine(segs, n, right = [], role = "sel") {
  return line(segs.map(([t]) => [t, ""]), n, right.map(([t]) => [t, ""]), role);
}

export const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const gitText = (g) => (!g ? "" : `${I.branch} ${g.branch}${g.files ? ` ${g.files}f +${g.added} -${g.removed}` : ""}${g.ahead ? ` ↑${g.ahead}` : ""}`);
export function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}
