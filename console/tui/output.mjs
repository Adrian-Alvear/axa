// Getting frames onto the terminal cheaply and without flicker. Pure (no terminal, no timers of its
// own), so every piece is tested on its own (test/tui-output.test.mjs):
//   - synchronized output (DEC mode 2026): a frame is wrapped in begin/end so the terminal shows it all
//     at once. Used only after the terminal says it supports it: a DECRQM query (CSI ? 2026 $ p) is
//     sent at start, followed by a DA1 query (CSI c) that every terminal answers. A DECRPM reply
//     before the DA1 reply means "supported"; DA1 alone means "not". Replies (and focus reports,
//     CSI I / CSI O) are taken out of the input before it reaches keys or sessions.
//   - frame coalescing: any number of redraw requests become at most one frame per 1/fps second.
//   - the screen as rows of parts ({x, w, s}): only parts that changed since the last frame are
//     written, and floating panels are spliced over the parts underneath (ANSI-aware slicing).
//   - OSC 8 hyperlinks for URLs and file paths in AXA's own panels (AXA_NO_OSC8=1 turns them off).
import { graphemes, graphemeWidth } from "./width.mjs";

export const ESC = "\x1b";
export const SYNC_BEGIN = `${ESC}[?2026h`, SYNC_END = `${ESC}[?2026l`;
export const PROBE = `${ESC}[?2026$p${ESC}[c`;
export const FOCUS_ON = `${ESC}[?1004h`, FOCUS_OFF = `${ESC}[?1004l`;
// one frame: wrapped for the terminal only when it supports mode 2026 (an empty frame stays empty)
export const frame = (s, sync) => (!s ? "" : sync ? SYNC_BEGIN + s + SYNC_END : s);

// Take the terminal's replies out of the input. st: { sync: null | true | false, focused: null | bool }
// DECRPM Ps: 1 set, 2 reset, 3 permanently set = supported; 0 unknown mode, 4 permanently reset = not
const DECRPM = /\x1b\[\?2026;(\d)\$y/g, DA1 = /\x1b\[\?[\d;]*c/g, FOCUS = /\x1b\[([IO])/g;
export function takeReplies(d, st) {
  if (!d.includes(ESC)) return d;
  d = d.replace(DECRPM, (_, ps) => { st.sync = ["1", "2", "3"].includes(ps); return ""; });
  d = d.replace(DA1, () => { if (st.sync == null) st.sync = false; return ""; });
  d = d.replace(FOCUS, (_, k) => { st.focused = k === "I"; st.onFocus?.(st.focused); return ""; });
  return d;
}

// At most one frame per 1/fps second, however often a redraw is asked for. The first request after a
// quiet spell draws on the next turn of the event loop (so a burst of output in one tick is one frame).
export function createFrames(draw, { fps = 60, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const gap = 1000 / fps;
  let timer = null, last = -Infinity;
  const run = () => { timer = null; last = now(); draw(); };
  return {
    schedule() { if (!timer) timer = setTimer(run, Math.max(0, Math.ceil(last + gap - now()))); },
    cancel() { if (timer) clearTimer(timer); timer = null; },
    get pending() { return !!timer; },
  };
}

// ---------- ANSI-aware slicing ----------
// SGR and other CSI sequences, OSC 8 links (group 2 = the URI), other OSC strings
const ANSI = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x1b\\|\x07)|\x1b\][^\x07\x1b]*(?:\x1b\\|\x07)/g;
export const stripAnsi = (s) => String(s).replace(ANSI, "");
const isReset = (seq) => /^\x1b\[0?(;|m)/.test(seq);
const osc = (url) => `${ESC}]8;;${url}${ESC}\\`;
// columns [from, to) of a styled string: the styles and link in force at `from` are re-opened, a link
// open at `to` is closed, a wide character cut in half becomes spaces, and a short string is padded
export function sliceAnsi(s, from, to) {
  let col = 0, out = "", sgr = "", url = "", started = false, done = false;
  const start = () => { if (!started) { started = true; out += sgr + (url ? osc(url) : ""); } };
  const text = (t) => {
    for (const g of graphemes(t)) {
      const w = graphemeWidth(g);
      if (col >= to) { done = true; return; }
      if (w === 0) { if (started) out += g; continue; }
      if (col + w <= from) { col += w; continue; }
      start();
      if (col < from) out += " ".repeat(Math.min(to, col + w) - from); // a wide character cut at `from`
      else if (col + w > to) out += " ".repeat(to - col); // ... or at `to`
      else out += g;
      col += w;
    }
  };
  ANSI.lastIndex = 0;
  let last = 0, m;
  while (!done && (m = ANSI.exec(s))) {
    text(s.slice(last, m.index));
    last = ANSI.lastIndex;
    if (done) break;
    const seq = m[0];
    if (seq.startsWith(`${ESC}]8;`)) { url = m[1] || ""; if (started) out += seq; }
    else if (seq.endsWith("m") && seq.startsWith(`${ESC}[`)) { sgr = isReset(seq) ? seq : sgr + seq; if (started) out += seq; }
  }
  if (!done) text(s.slice(last));
  start();
  if (col < to) out += " ".repeat(to - Math.max(col, from));
  if (url) out += osc("");
  return out;
}
// lay s (w columns wide) over a row's parts at column x
export function splice(parts, x, w, s) {
  const out = [];
  for (const q of parts) {
    const a = q.x, b = q.x + q.w;
    if (b <= x || a >= x + w) { out.push(q); continue; }
    if (a < x) out.push({ x: a, w: x - a, s: sliceAnsi(q.s, 0, x - a) });
    if (b > x + w) out.push({ x: x + w, w: b - x - w, s: sliceAnsi(q.s, x + w - a, q.w) });
  }
  out.push({ x, w, s });
  return out.sort((p, q) => p.x - q.x);
}

// The screen as last written: write(rows) returns only what changed. rows[y] = parts [{x, w, s}];
// base = the SGR parameters every part starts from (the theme's background and text color, or "").
export function createScreen() {
  let prev = [], lastBase = null;
  return {
    reset() { prev = []; },
    diff(rows, base = "") {
      if (base !== lastBase) { prev = []; lastBase = base; } // a new ground color repaints everything
      const lead = `${ESC}[0${base ? ";" + base : ""}m`;
      let o = "";
      rows.forEach((parts, y) => {
        const p = prev[y], same = p && p.length === parts.length && p.every((q, i) => q.x === parts[i].x && q.w === parts[i].w);
        for (let i = 0; i < parts.length; i++) if (!same || parts[i].s !== p[i].s) o += `${ESC}[${y + 1};${parts[i].x + 1}H${lead}${parts[i].s}`;
      });
      prev = rows.slice();
      return o;
    },
  };
}

// ---------- OSC 8 hyperlinks ----------
export const linksOn = (env = {}) => !env.AXA_NO_OSC8 && env.TERM !== "dumb";
// a URI safe inside OSC 8: no control characters, non-ASCII and spaces percent-encoded, at most 2083
export function safeUri(u) {
  const s = String(u ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "").replace(/[^\x21-\x7e]/gu, (ch) => encodeURIComponent(ch));
  return s.length <= 2083 ? s : "";
}
export const link = (text, url, on = true) => { const u = on && safeUri(url); return u ? `${osc(u)}${text}${osc("")}` : text; };
// a file path as a URL the terminal can open: on WSL through \\wsl.localhost\<distro>
export const fileUrl = (path, env = {}) => `file://${env.WSL_DISTRO_NAME ? `wsl.localhost/${env.WSL_DISTRO_NAME}` : ""}${path.split("/").map((p) => encodeURIComponent(p)).join("/")}`;
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const PATH_RE = /(^|[\s(["'`=])((?:~|\/(?:home|tmp|mnt|Users|var|etc|opt|usr|srv|root|workspace))\/[\w.@%+~-]+(?:\/[\w.@%+~-]+)*)/g;
// URLs and absolute (or ~/) file paths in plain text become links; the text itself is unchanged
export function linkify(text, { env = {}, home = "" } = {}) {
  if (!linksOn(env) || !/https?:\/\/|\/|~/.test(text)) return text;
  const hits = [];
  for (const m of text.matchAll(URL_RE)) { const u = m[0].replace(/[.,;:!?)\]]+$/, ""); hits.push([m.index, u.length, u]); }
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[2].replace(/[.,;:!?]+$/, ""), at = m.index + m[1].length;
    if (hits.some(([a, n]) => at >= a && at < a + n)) continue; // part of a URL
    hits.push([at, p.length, fileUrl(p.startsWith("~") && home ? home + p.slice(1) : p, env)]);
  }
  if (!hits.length) return text;
  hits.sort((a, b) => a[0] - b[0]);
  let o = "", i = 0;
  for (const [at, n, url] of hits) { if (at < i) continue; o += text.slice(i, at) + link(text.slice(at, at + n), url); i = at + n; }
  return o + text.slice(i);
}
