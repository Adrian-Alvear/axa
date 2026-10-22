// AXA's one design system: named themes as color tokens, turned into CSS custom properties (the web
// console), an xterm.js theme (its embedded terminals) and SGR codes for the terminal app (truecolor,
// quantized to 256 or the 16 ANSI colors, or none). Pure: no Node APIs, so the browser imports it too
// (served at /shared/theme.mjs).

// Every role is at least 4.5:1 on bg and on panel (test/theme.test.mjs recomputes this table)
export const THEMES = {
  hud: { label: "AXA HUD", kind: "dark", bg: "#04070b", panel: "#0b1520", text: "#cfe9f3", dim: "#8aa6b4", accent: "#4fd8ff", ok: "#5ef2c2", warn: "#ffb547", bad: "#ff6b7d" },
  graphite: { label: "Graphite", kind: "dark", bg: "#0f1115", panel: "#171a21", text: "#e6e8ec", dim: "#98a0ad", accent: "#7aa2ff", ok: "#4cd694", warn: "#f2b24c", bad: "#ff6b6b" },
  paper: { label: "Paper", kind: "light", bg: "#fbfbfa", panel: "#ffffff", text: "#1b1f24", dim: "#5a6470", accent: "#0b5fd6", ok: "#11713f", warn: "#8a5a00", bad: "#b42318" },
  solar: { label: "Solar Night", kind: "dark", bg: "#14110f", panel: "#1d1915", text: "#efe6dc", dim: "#a89a8b", accent: "#ffa94d", ok: "#8fd18a", warn: "#ffd166", bad: "#ff7a6b" },
  contrast: { label: "High Contrast", kind: "dark", bg: "#000000", panel: "#0a0a0a", text: "#ffffff", dim: "#c8c8c8", accent: "#00e5ff", ok: "#3dff9a", warn: "#ffd400", bad: "#ff5c5c" },
};
export const ROLES = ["text", "dim", "accent", "ok", "warn", "bad"];
export const DEFAULT_THEME = "hud";
// The terminal app also has "terminal": your terminal's own 16-color scheme (its default there)
export const TERMINAL_THEME = "terminal";
// names older settings used
const ALIASES = { light: "paper", "solar-night": "solar", "high-contrast": "contrast" };
export const themeId = (id) => (THEMES[ALIASES[id] || id] ? ALIASES[id] || id : id === TERMINAL_THEME ? id : DEFAULT_THEME);
export const themeOf = (id) => THEMES[themeId(id)] || THEMES[DEFAULT_THEME];
export const themeList = () => Object.entries(THEMES).map(([id, t]) => ({ id, label: t.label, kind: t.kind }));

// ---------- color math ----------
export const rgb = (hex) => { const h = hex.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
export const hex = ([r, g, b]) => "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
export const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
// WCAG 2 relative luminance and contrast ratio
export const luminance = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

// ---------- derived tokens (shared by every output) ----------
// lines, selection and soft fills come from the theme's own colors, so a new theme needs only the table
export function tokens(id) {
  const t = themeOf(id), light = t.kind === "light";
  return {
    ...t,
    line: mix(t.panel, t.accent, light ? 0.18 : 0.16), line2: mix(t.panel, t.accent, light ? 0.34 : 0.3),
    sel: mix(t.panel, t.accent, light ? 0.18 : 0.28), raised: mix(t.panel, t.text, light ? 0.03 : 0.05),
    okSoft: mix(t.panel, t.ok, 0.14), warnSoft: mix(t.panel, t.warn, 0.16), badSoft: mix(t.panel, t.bad, 0.14), accentSoft: mix(t.panel, t.accent, 0.14),
    onAccent: contrast(t.accent, "#000000") >= contrast(t.accent, "#ffffff") ? "#000000" : "#ffffff",
  };
}

// ---------- web: CSS custom properties ----------
const CSS_NAMES = { bg: "bg", panel: "panel", text: "text", dim: "dim", accent: "accent", ok: "ok", warn: "warn", bad: "bad", line: "line", line2: "line2", sel: "sel", raised: "raised", okSoft: "ok-soft", warnSoft: "warn-soft", badSoft: "bad-soft", accentSoft: "accent-soft", onAccent: "on-accent" };
export const cssVars = (id) => Object.fromEntries(Object.entries(CSS_NAMES).map(([k, n]) => [`--${n}`, tokens(id)[k]]));
// one rule per theme: :root[data-theme="paper"] { --bg: ...; }
export const cssText = () => Object.keys(THEMES).map((id) => `:root[data-theme="${id}"]{color-scheme:${THEMES[id].kind};${Object.entries(cssVars(id)).map(([k, v]) => `${k}:${v}`).join(";")}}`).join("\n");

// ---------- the 16 ANSI colors (embedded terminals, Windows Terminal color scheme) ----------
// Normal colors are the roles; bright ones lean toward the text color. Black/white follow light/dark.
export function ansi16(id) {
  const t = themeOf(id), light = t.kind === "light", magenta = mix(t.bad, t.accent, 0.5), blue = mix(t.accent, light ? "#1d4ed8" : "#6b8cff", 0.45);
  const base = { black: light ? "#1b1f24" : mix(t.bg, t.dim, 0.35), red: t.bad, green: t.ok, yellow: t.warn, blue, purple: magenta, cyan: t.accent, white: light ? t.dim : t.text };
  const bright = Object.fromEntries(Object.entries(base).map(([k, v]) => [`bright${k[0].toUpperCase()}${k.slice(1)}`, k === "black" ? t.dim : k === "white" ? (light ? "#000000" : "#ffffff") : mix(v, light ? "#000000" : "#ffffff", 0.18)]));
  return { ...base, ...bright };
}
// xterm.js ITheme; pair it with { minimumContrastRatio: 4.5 } in the Terminal options
export function xtermTheme(id) {
  const t = tokens(id), a = ansi16(id);
  return {
    background: t.bg, foreground: t.text, cursor: t.accent, cursorAccent: t.bg, selectionBackground: t.sel,
    black: a.black, red: a.red, green: a.green, yellow: a.yellow, blue: a.blue, magenta: a.purple, cyan: a.cyan, white: a.white,
    brightBlack: a.brightBlack, brightRed: a.brightRed, brightGreen: a.brightGreen, brightYellow: a.brightYellow, brightBlue: a.brightBlue, brightMagenta: a.brightPurple, brightCyan: a.brightCyan, brightWhite: a.brightWhite,
  };
}
export const XTERM_OPTIONS = { minimumContrastRatio: 4.5 };

// ---------- terminal app: roles -> SGR codes ----------
// depth: "truecolor" | "256" | "16" | "mono". From the environment: NO_COLOR or TERM=dumb = mono;
// COLORTERM truecolor/24bit = truecolor; a 256color TERM = 256; else 16.
export function colorDepth(env = {}) {
  if (env.NO_COLOR || env.TERM === "dumb") return "mono";
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM || "")) return "truecolor";
  if (/256/.test(env.TERM || "")) return "256";
  return "16";
}
// xterm's 256-color cube and gray ramp
const CUBE = [0, 95, 135, 175, 215, 255];
export function to256(c) {
  const [r, g, b] = rgb(c);
  const near = (v) => CUBE.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(CUBE[best] - v) ? i : best), 0);
  const ci = [near(r), near(g), near(b)], cube = ci.map((i) => CUBE[i]);
  const gray = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10))), gv = 8 + gray * 10;
  const d = (x) => (x[0] - r) ** 2 + (x[1] - g) ** 2 + (x[2] - b) ** 2;
  return d(cube) <= d([gv, gv, gv]) ? 16 + 36 * ci[0] + 6 * ci[1] + ci[2] : 232 + gray;
}
// nearest of the 16 basic colors (by the standard xterm values), as an SGR foreground number
const BASIC = [[0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229], [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]];
export function to16(c) {
  const [r, g, b] = rgb(c);
  let best = 0, bd = Infinity;
  BASIC.forEach(([x, y, z], i) => { const dd = (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2; if (dd < bd) { bd = dd; best = i; } });
  return best < 8 ? 30 + best : 90 + best - 8;
}
const fg = (c, depth) => (depth === "truecolor" ? `38;2;${rgb(c).join(";")}` : depth === "256" ? `38;5;${to256(c)}` : String(to16(c)));
const bgc = (c, depth) => (depth === "truecolor" ? `48;2;${rgb(c).join(";")}` : depth === "256" ? `48;5;${to256(c)}` : String(to16(c) + 10));
// The terminal app's roles. "terminal" keeps your own scheme (16 basic colors by name, not value).
const TERMINAL_ROLES = { title: "1;36", accent: "36", wait: "1;33", waitSoft: "33", stuck: "31", work: "36", done: "32", idle: "0", off: "90", dim: "90", sel: "7", rule: "90", tag: "1;7", add: "32", del: "31", hunk: "36", ok: "32", warn: "33", bad: "31", text: "0", focus: "1;36" };
const MONO_ROLES = { title: "1", accent: "1", wait: "1;4", waitSoft: "1", stuck: "1", work: "0", done: "0", idle: "0", off: "2", dim: "2", sel: "7", rule: "2", tag: "7", add: "1", del: "2", hunk: "1", ok: "0", warn: "1", bad: "1", text: "0", focus: "1" };
export function tuiRoles(id, depth = "truecolor") {
  if (depth === "mono") return { ...MONO_ROLES };
  if (themeId(id) === TERMINAL_THEME) return { ...TERMINAL_ROLES };
  const t = tokens(id), f = (c) => fg(c, depth);
  // on 16 colors a theme can't be shown faithfully: the basic named colors read better than a guess
  if (depth === "16") return { ...TERMINAL_ROLES };
  return {
    title: `1;${f(t.accent)}`, accent: f(t.accent), wait: `1;${f(t.warn)}`, waitSoft: f(t.warn), stuck: f(t.bad), work: f(t.accent), done: f(t.ok),
    idle: f(t.text), off: f(t.dim), dim: f(t.dim), sel: `${bgc(t.sel, depth)};${f(t.text)}`, rule: f(t.line2), tag: `1;${bgc(t.accent, depth)};${f(t.onAccent)}`,
    add: f(t.ok), del: f(t.bad), hunk: f(t.accent), ok: f(t.ok), warn: f(t.warn), bad: f(t.bad), text: f(t.text), focus: `1;${f(t.accent)}`,
  };
}
