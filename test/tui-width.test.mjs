// Grapheme-aware display width (console/tui/width.mjs): ZWJ sequences, variation selectors, flags,
// keycaps, combining marks, CJK, and cut/pad never splitting a cluster
import test from "node:test";
import assert from "node:assert/strict";
import { width, cut, pad, graphemeWidth, graphemes, isWide } from "../console/tui/width.mjs";

test("ASCII and controls", () => {
  assert.equal(width("hello"), 5);
  assert.equal(width(""), 0);
  assert.equal(width("a\u0007b"), 2); // BEL takes no column
  assert.equal(width(undefined), 0);
});

test("CJK, Hangul and fullwidth forms are two columns", () => {
  assert.equal(width("界"), 2);
  assert.equal(width("ab界"), 4);
  assert.equal(width("한국"), 4);
  assert.equal(width("ＡＢ"), 4);
  assert.equal(width("　"), 2); // ideographic space
  assert.ok(isWide(0x20000) && !isWide(0x41) && !isWide(0x25cf));
});

test("emoji: ZWJ sequences, skin tones, flags and keycaps are one two-column cluster", () => {
  const family = "👨‍👩‍👧‍👦";
  assert.equal(graphemes(family).length, 1);
  assert.equal(width(family), 2);
  assert.equal(width("🧑‍💻"), 2);
  assert.equal(width("👍🏽"), 2);
  assert.equal(width("🇺🇸"), 2);
  assert.equal(width("1️⃣"), 2);
  assert.equal(width("✅"), 2);
  assert.equal(width(`a${family}b`), 4);
});

test("variation selectors: VS16 makes a text symbol an emoji, VS15 keeps it text", () => {
  assert.equal(width("⚠"), 1); // text by default
  assert.equal(width("⚠️"), 2); // + U+FE0F
  assert.equal(width("❤"), 1);
  assert.equal(width("❤️"), 2);
  assert.equal(width("☺︎"), 1); // + U+FE0E
  assert.equal(width("✅︎"), 1);
  assert.equal(graphemeWidth("️"), 0); // a stray selector takes nothing
});

test("combining marks and zero-width characters", () => {
  assert.equal(width("é"), 1); // é as e + combining acute
  assert.equal(width("a​b"), 2); // zero-width space
  assert.equal(width("‍"), 0);
  assert.equal(width("́"), 0);
});

test("the app's own glyphs are one column", () => {
  for (const g of ["●", "○", "◆", "▶", "⠋", "│", "━", "┏", "╭", "◷", "✓", "✕", "⎇", "…", "", ""]) assert.equal(width(g), 1, g);
});

test("cut and pad measure clusters, never split one", () => {
  assert.equal(cut("abcdef", 4), "abc…");
  assert.equal(pad("ab", 4), "ab  ");
  assert.equal(width(pad("界界界", 5)), 5);
  assert.equal(cut("👨‍👩‍👧x👨‍👩‍👧y", 3), "👨‍👩‍👧…");
  assert.equal(cut("👨‍👩‍👧x👨‍👩‍👧y", 5), "👨‍👩‍👧x…");
  assert.equal(width(pad("🇺🇸🇺🇸🇺🇸", 5)), 5);
  assert.equal(cut("ééé", 2), "é…");
  assert.equal(cut("anything", 0), "");
});
