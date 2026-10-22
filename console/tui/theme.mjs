// The terminal app's look: themes (roles -> SGR codes), the status vocabulary, and the text helpers
// that measure and cut strings by display width.
import { THEMES as SHARED_THEMES, TERMINAL_THEME, themeId, tuiRoles, tuiBase, tuiAnsi, colorDepth } from "../theme.mjs";
import { STATUS, URGENCY, statusOf, lookOf, byUrgency, needsYou, label } from "../look.mjs";
import { width, cut, pad, graphemes, graphemeWidth } from "./width.mjs";
import { link as mkLink, linkify as linkifyText, linksOn } from "./output.mjs";
import { homedir } from "node:os";

export const ESC = "\x1b";
export { width, cut, pad, graphemes, graphemeWidth };

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
// toast: a Windows notification as well as the bell (opt-in); icons: "nerd" uses Nerd Font glyphs
// (only when you pick it: a font can't be detected from here)
export const DEFAULTS = { theme: "terminal", themeSync: false, prefix: "C-b", sidebar: "left", sidebarWidth: 34, bell: true, toast: false, icons: "unicode", newSession: "claude", copyOnSelect: true, sidebarStyle: "tree" };
// small glyphs that have a Nerd Font version (Private Use Area code points, one column wide)
export const ICONS = {
  unicode: { branch: "⎇", ws: "▣", axa: "◆", pr: "PR", ci: "CI", cost: "$", clock: "", theme: "◐" },
  nerd: { branch: "", ws: "", axa: "", pr: "", ci: "", cost: "", clock: "", theme: "" },
};
// the braille spinner working sessions show (one frame per shared tick)
export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

// ---------- status: [glyph, word, role] from the shared vocabulary (console/look.mjs) ----------
export { STATUS, URGENCY, statusOf, byUrgency, needsYou, label as statusLabel };
export const look = (s) => { const l = lookOf(s); return [l.glyph, l.word, l.tui]; };

// ---------- text helpers ----------
export const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
// (display width, cut and pad are grapheme-aware: ./width.mjs)
export const clip = (s, n) => cut(clean(s), n);
// the question of a prompt: its last line that asks something (not a link like "Security guide")
export const question = (c) => { const ls = c.question.split("\n").map(clean).filter(Boolean); return [...ls].reverse().find((l) => l.includes("?")) || ls[0] || "a prompt"; };
// y = the first "Yes…" option, x = the "No…" option (menus differ: the trust prompt starts with "No, exit")
export const yesOpt = (c) => c.options.find((o) => /^yes\b/i.test(o.label)) || c.options[0];
export const noOpt = (c) => c.options.find((o) => /^no\b/i.test(o.label)) || c.options.at(-1);
export const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const gitText = (g) => (!g ? "" : `${g.branch}${g.files ? ` ${g.files}f +${g.added} -${g.removed}` : " clean"}${g.ahead ? ` ↑${g.ahead}` : ""}`);
// why a session is stuck or failed, when the console says (Phase 4 fields; older consoles don't)
export const reasonOf = (s) => clean((s?.status === "failed" && s.failed_reason) || (s?.status === "stuck" && s.stuck_reason) || "");
export const what = (s) => reasonOf(s) || clean(s.status === "done" ? s.last_report || "finished" : s.doing || s.last_report || (s.mode === "shell" ? "shell" : s.mode === "axa" ? "select it and type to talk" : ""));
// cost from Claude Code's statusLine: "$1.24 · 38% ctx" ("" when the console has none)
export const costText = (cost) => {
  if (!cost || typeof cost !== "object") return "";
  const usd = typeof cost.usd === "number" && Number.isFinite(cost.usd) ? `$${cost.usd < 10 ? cost.usd.toFixed(2) : Math.round(cost.usd)}` : "";
  const ctx = typeof cost.context_pct === "number" && Number.isFinite(cost.context_pct) ? `${Math.round(cost.context_pct)}% ctx` : "";
  return [usd, ctx].filter(Boolean).join(" · ");
};
// GitHub, read-only: [{ text, role, url }] for the PR and the latest CI run ([] when there's none)
export function githubBits(gh, icons = ICONS.unicode) {
  const bits = [];
  const pr = gh?.pr, ci = gh?.ci;
  if (pr && typeof pr.number === "number") {
    const checks = pr.checks === "passing" ? " ✓" : pr.checks === "failing" ? " ✗" : pr.checks === "pending" ? " …" : "";
    const state = pr.state === "merged" ? " merged" : pr.state === "closed" ? " closed" : pr.draft ? " draft" : pr.review === "approved" ? " approved" : pr.review === "changes_requested" ? " changes asked" : "";
    bits.push({ text: `${icons.pr} #${pr.number}${state}${checks}`, role: pr.checks === "failing" || pr.review === "changes_requested" ? "bad" : pr.checks === "passing" || pr.state === "merged" ? "ok" : "dim", url: pr.url });
  }
  if (ci && ci.status) {
    const done = ci.status === "completed", ok = ci.conclusion === "success";
    const t = !done ? "running" : ok ? "passed" : clean(ci.conclusion || "done").replace(/_/g, " ");
    bits.push({ text: `${icons.ci} ${done ? (ok ? "✓" : "✗") : "…"} ${t}`, role: !done ? "work" : ok ? "ok" : "bad", url: ci.url });
  }
  return bits;
}
export const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`; };

// Colors that follow the live settings: c.cfg.theme at the terminal's color depth (c.depth, from the
// environment: mono when NO_COLOR or TERM=dumb)
export function theme(c) {
  c.depth ||= colorDepth(process.env);
  let memo = null;
  const M = () => {
    const key = `${c.cfg.theme}|${c.depth}`;
    if (memo?.key !== key) {
      const name = appTheme(c.cfg.theme), d = name === "mono" ? "mono" : c.depth, base = tuiBase(name, d);
      memo = { key, roles: rolesFor(c.cfg.theme, c.depth), base, reset: `${ESC}[0${base ? ";" + base : ""}m`, ansi: tuiAnsi(name, d) };
    }
    return memo;
  };
  const T = () => M().roles;
  // base: the theme's background and text color (every cell starts from it); reset goes back to it
  const base = () => M().base, reset = () => M().reset, ansiMap = () => M().ansi;
  const sgr = (role, s) => { const code = T()[role] ?? role; return code && code !== "0" ? `${ESC}[${code}m${s}${M().reset}` : s; };
  // [text, role, url?] segments cut to w columns, padded to exactly w (a url makes the text a link)
  const renderSegs = (segs, w) => { let o = "", n = 0; for (const [t, r, url] of segs) { if (!t) continue; if (n >= w) break; const s0 = cut(t, w - n), s = url ? c.link(s0, url) : s0; o += r ? sgr(r, s) : s; n += width(s0); } return o + " ".repeat(Math.max(0, w - n)); };
  const keyName = () => c.cfg.prefix.replace("C-", "Ctrl-");
  const PREFIX = () => PREFIXES[c.cfg.prefix] ?? 0x02;
  const icon = (k) => (ICONS[c.cfg.icons] || ICONS.unicode)[k] ?? ICONS.unicode[k];
  const icons = () => ICONS[c.cfg.icons] || ICONS.unicode;
  // OSC 8 links in AXA's own panels (AXA_NO_OSC8 turns them off)
  const env = c.linkEnv || process.env, linksEnabled = linksOn(env), home = homedir();
  const link = (text, url) => mkLink(text, url, linksEnabled);
  const linkify = (text) => (linksEnabled ? linkifyText(text, { env, home }) : text);
  return { link, linkify, T, sgr, base, reset, ansiMap, renderSegs, keyName, PREFIX, icon, icons };
}
