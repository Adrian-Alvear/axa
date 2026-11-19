// Cutting a line that holds ANSI colors by screen column, so a dialog can float over the screen while
// the hub or a live session keeps drawing underneath.
const ESCAPE = /^\x1b\[[0-9;:?]*[ -/]*[@-~]/;
const wide = (c) => (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd);

// The columns [from, to) of an ANSI string, with the colors that were active at `from`
export function sliceAnsi(s, from, to) {
  let col = 0, out = "", sgr = "", i = 0, started = false;
  while (i < s.length && col < to) {
    if (s[i] === "\x1b") {
      const m = ESCAPE.exec(s.slice(i));
      const seq = m ? m[0] : s[i];
      if (seq.endsWith("m")) sgr = /^\x1b\[0?m$/.test(seq) ? "" : sgr + seq;
      if (started) out += seq;
      i += seq.length;
      continue;
    }
    const cp = s.codePointAt(i), ch = String.fromCodePoint(cp), w = wide(cp) ? 2 : 1;
    if (col >= from) {
      if (!started) { out += "\x1b[0m" + sgr; started = true; }
      out += col + w > to ? " " : ch; // a wide character cut at the edge
    } else if (col + w > from) { // a wide character cut at the start
      out += "\x1b[0m" + sgr + " "; started = true;
    }
    col += w; i += ch.length;
  }
  if (!started) out += "\x1b[0m";
  if (col < to) out += " ".repeat(to - Math.max(col, from));
  return out + "\x1b[0m";
}
