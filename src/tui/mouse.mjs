// Mouse helpers for the hub: where line() puts each segment (so a drawn hint can be a button), the
// two-click approve, and what a click on a popup hit. Pure: no state outside what's passed in.
import { cut, width } from "./draw.mjs";

// Where line(segs, n, right) draws each segment, for a line starting at screen column x0 (1-based).
// Returns { left: [{ i, x0, x1 }], right: [{ i, x0, x1 }] }, i the index in the array passed in,
// columns inclusive; segments line() drops (empty, cut off, a right side that doesn't fit) are left out.
// Mirrors line() in draw.mjs.
export function segSpans(segs, n, right = [], x0 = 1) {
  const r = right.map(([t], i) => [t, i]).filter(([t]) => t);
  if (r.length) r[r.length - 1] = [r.at(-1)[0].trimEnd() + " ", r.at(-1)[1]];
  const rw = r.reduce((a, [t]) => a + width(t), 0);
  const showRight = rw && rw < n - 4;
  const room = Math.max(0, n - (showRight ? rw + 1 : 0));
  const out = { left: [], right: [] };
  let used = 0;
  segs.forEach(([t], i) => {
    if (!t || used >= room) return;
    const w = width(cut(t, room - used));
    if (w) out.left.push({ i, x0: x0 + used, x1: x0 + used + w - 1 });
    used += w;
  });
  if (showRight) {
    let at = n - rw;
    for (const [t, i] of r) { const w = width(t); out.right.push({ i, x0: x0 + at, x1: x0 + at + w - 1 }); at += w; }
  }
  return out;
}

// the first hit box { x0, x1, y? } containing (x, y); a box without y matches any row
export const hitAt = (hits, x, y) => hits.find((h) => (h.y === undefined || h.y === y) && x >= h.x0 && x <= h.x1) || null;

// Approve by mouse takes two clicks: the first arms it (for `ms`), a second on the same thing fires.
// key names what would be approved (the session and its prompt), so a different prompt never fires.
export function makeArm(ms = 4000, now = Date.now) {
  let st = null;
  return {
    // "fire" (second click in time, on the same key) or "armed" (first click, or a new key)
    press(key) {
      const t = now();
      if (st && st.key === key && t - st.at < ms) { st = null; return "fire"; }
      st = { key, at: t };
      return "armed";
    },
    armed: (key) => !!st && (key === undefined || st.key === key) && now() - st.at < ms,
    disarm() { st = null; },
  };
}

// A click on a popup drawn by drawOverlay. g: { x, y, w, h, listTop, listH, scroll, n, more: [x0, x1] | null }
// (x, y 0-based screen cell of the top-left corner; listTop the first list row, 0-based; n content lines).
// Mouse x/y are 1-based. Returns { kind: "outside" | "close" | "more" | "item" | "inside", i? }.
export function overlayHit(g, mx, my) {
  const x = mx - 1, y = my - 1;
  if (x < g.x || x >= g.x + g.w || y < g.y || y >= g.y + g.h) return { kind: "outside" };
  if (y === g.y && x >= g.x + g.w - 4) return { kind: "close" };
  if (y === g.y + g.h - 1 && g.more && mx >= g.more[0] && mx <= g.more[1]) return { kind: "more" };
  if (y >= g.listTop && y < g.listTop + g.listH && x > g.x && x < g.x + g.w - 1) {
    const i = g.scroll + (y - g.listTop);
    if (i < g.n) return { kind: "item", i };
  }
  return { kind: "inside" };
}

// The key a footer hint stands for ("⏎" -> Enter, "PgUp" -> its escape...); null when it isn't a key
const KEYS = { "⏎": "\r", Esc: "\x1b", Tab: "\t", "↑↓": "\x1b[B", "→": "\x1b[C", "←": "\x1b[D", PgUp: "\x1b[5~", PgDn: "\x1b[6~" };
export const hintKey = (k) => KEYS[k] ?? ([...k].length === 1 ? k : null);
