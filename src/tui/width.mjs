// One width function for the whole terminal UI (draw.mjs and ansi.mjs both use it, so a line is measured the same
// way when it's built and when it's cut): text is split into graphemes (what you see as one character: a letter
// with its accents, an emoji with its modifiers), and each grapheme is 0, 1 or 2 columns.
// Untrusted text (handoff files, chats, session output shown in lists) goes through sanitize() first: joined emoji,
// skin tones, flags, variation selectors and bidi/zero-width controls are what terminals disagree about (Windows
// Terminal draws a ZWJ family as several glyphs), so they're taken apart or removed before they can shift columns.
const seg = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;
export const graphemes = (s) => (seg ? Array.from(seg.segment(s), (x) => x.segment) : Array.from(s));

const WIDE = (c) => (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd);
// (character classes built from code points: [from, to] ranges)
const cls = (ranges) => ranges.map(([a, b = a]) => (a === b ? String.fromCodePoint(a) : `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`)).join("");
const ZERO_RANGES = [[0x300, 0x36f], [0x483, 0x489], [0x591, 0x5bd], [0x610, 0x61a], [0x64b, 0x65f], [0xe31], [0xe34, 0xe3a], [0xe47, 0xe4e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfe00, 0xfe0f], [0xfeff]];
const ZERO = new RegExp(`^[${cls(ZERO_RANGES)}]+$`, "u");
const VS16 = String.fromCodePoint(0xfe0f);
// one grapheme's columns
export function gw(g) {
  if (!g || ZERO.test(g)) return 0;
  const c = g.codePointAt(0);
  if (c < 0x20 || (c >= 0x7f && c < 0xa0)) return 0;
  if (WIDE(c)) return 2;
  if (g.includes("\ufe0f") && /\p{Extended_Pictographic}/u.test(g)) return 2; // emoji presentation (✔️)
  return 1;
}
export const strWidth = (s) => { let n = 0; for (const g of graphemes(String(s))) n += gw(g); return n; };

// Untrusted text -> safe to lay out: no control, bidi or zero-width characters, no variation selectors, no
// skin-tone modifiers or tag characters, joined emoji split into their parts (each then 2 columns), flags as
// their two letters ("🇺🇸" -> "US")
const CONTROL = new RegExp(`[${cls([[0x0, 0x8], [0xb, 0x1f], [0x7f, 0x9f]])}]`, "g");
const INVISIBLE = new RegExp(`[${cls([[0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff], [0xfe00, 0xfe0f]])}]`, "g");
const MODIFIERS = new RegExp(`[${cls([[0x1f3fb, 0x1f3ff], [0xe0000, 0xe007f]])}]`, "gu");
const FLAGS = new RegExp(`[${cls([[0x1f1e6, 0x1f1ff]])}]`, "gu");
export function sanitize(s) {
  return String(s ?? "").replace(CONTROL, " ").replace(INVISIBLE, "").replace(MODIFIERS, "").replace(FLAGS, (r) => String.fromCharCode(r.codePointAt(0) - 0x1f1e6 + 65));
}
