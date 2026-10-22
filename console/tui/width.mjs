// Display width of text in a terminal, one grapheme cluster at a time (Intl.Segmenter): a family emoji
// joined with ZWJ, a flag, a keycap or a letter with combining marks is one cluster, drawn as one
// character. Rules (what Windows Terminal, kitty, WezTerm and recent xterm.js agree on):
//   - controls, combining marks and default-ignorable code points: 0 columns
//   - an RGI emoji sequence (👍🏽, 👨‍👩‍👧, 🇺🇸, 1️⃣, ❤️): 2; an emoji forced to text with VS15 (U+FE0E): 1
//   - East Asian Wide / Fullwidth (CJK, Hangul, kana, fullwidth forms, emoji presentation): 2
//   - everything else: 1
// The wide ranges follow Unicode's EastAsianWidth.txt (W and F) as packaged by get-east-asian-width
// (MIT, Sindre Sorhus); see CREDITS.md. Pure, no dependencies.

// [start, end] inclusive, sorted
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x2e99],
  [0x2e9b, 0x2ef3], [0x2f00, 0x2fd5], [0x2ff0, 0x2fff], [0x3000, 0x303e], [0x3041, 0x3096], [0x3099, 0x30ff],
  [0x3105, 0x312f], [0x3131, 0x318e], [0x3190, 0x31e3], [0x31ef, 0x321e], [0x3220, 0x3247], [0x3250, 0x4dbf],
  [0x4e00, 0xa48c], [0xa490, 0xa4c6], [0xa960, 0xa97c], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe52], [0xfe54, 0xfe66], [0xfe68, 0xfe6b], [0xff01, 0xff60], [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4], [0x16ff0, 0x16ff1], [0x17000, 0x187f7], [0x18800, 0x18cd5], [0x18d00, 0x18d08],
  [0x1aff0, 0x1aff3], [0x1aff5, 0x1affb], [0x1affd, 0x1affe], [0x1b000, 0x1b122], [0x1b132, 0x1b132],
  [0x1b150, 0x1b152], [0x1b155, 0x1b155], [0x1b164, 0x1b167], [0x1b170, 0x1b2fb], [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f202], [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248], [0x1f250, 0x1f251], [0x1f260, 0x1f265], [0x1f300, 0x1f320], [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff], [0x1fa70, 0x1fa7c], [0x1fa80, 0x1fa88],
  [0x1fa90, 0x1fabd], [0x1fabf, 0x1fac5], [0x1face, 0x1fadb], [0x1fae0, 0x1fae8], [0x1faf0, 0x1faf8],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];
export function isWide(cp) {
  if (cp < 0x1100) return false;
  let lo = 0, hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, [a, b] = WIDE[mid];
    if (cp < a) hi = mid - 1; else if (cp > b) lo = mid + 1; else return true;
  }
  return false;
}

const RGI = /^\p{RGI_Emoji}$/v;
const PICTO = /^\p{Extended_Pictographic}/u;
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const memo = new Map();

// the width of one grapheme cluster
export function graphemeWidth(g) {
  if (!g) return 0;
  const cp = g.codePointAt(0);
  if (g.length === 1) {
    if (cp >= 0x20 && cp < 0x7f) return 1;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  }
  let w = memo.get(g);
  if (w !== undefined) return w;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) w = 0;
  else if (g.includes("︎") && PICTO.test(g)) w = 1; // VS15: text presentation
  else if (RGI.test(g)) w = 2;
  else if (g.includes("️") && PICTO.test(g)) w = 2; // VS16 on a pictograph RGI doesn't list
  else if (ZERO.test(g)) w = 0; // a lone combining mark, ZWJ, variation selector, BOM…
  else w = isWide(cp) ? 2 : 1;
  if (memo.size > 4096) memo.clear();
  memo.set(g, w);
  return w;
}

const ASCII = /^[\x20-\x7e]*$/;
export const graphemes = (s) => (ASCII.test(s) ? s.split("") : Array.from(seg.segment(s), (x) => x.segment));
export const width = (s) => { s = String(s ?? ""); if (ASCII.test(s)) return s.length; let n = 0; for (const { segment } of seg.segment(s)) n += graphemeWidth(segment); return n; };
// cut to n columns, with … when something was cut off (never splits a cluster)
export function cut(s, n) {
  s = String(s ?? "");
  if (n <= 0) return "";
  if (width(s) <= n) return s;
  let o = "", w = 0;
  for (const g of graphemes(s)) { const gw = graphemeWidth(g); if (w + gw > n - 1) break; o += g; w += gw; }
  return o + "…";
}
// cut, then pad with spaces to exactly n columns
export const pad = (s, n) => { const c = cut(s, n); return c + " ".repeat(Math.max(0, n - width(c))); };
