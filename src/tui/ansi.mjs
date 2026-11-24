// Cutting a line that holds ANSI colors by screen column, so a dialog can float over the screen while
// the hub or a live session keeps drawing underneath.
const ESCAPE = /^\x1b\[[0-9;:?]*[ -/]*[@-~]/;
import { graphemes, gw } from "./width.mjs";

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
    // the next grapheme of this text run (up to the next escape), measured like draw.mjs measures it
    const esc = s.indexOf("\x1b", i), ch = graphemes(s.slice(i, esc < 0 ? undefined : esc))[0], w = gw(ch);
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
