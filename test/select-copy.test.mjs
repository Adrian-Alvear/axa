// src/tui/control.mjs: selectedText (drag-to-copy in the Commander panel) and msgText
import { test } from "node:test";
import assert from "node:assert/strict";
import { msgText, selectedText, selRange } from "../src/tui/control.mjs";

// three lines on screen rows 10-12, text starting at column 5
const lines = [
  { row: 10, col0: 5, text: "hello world", msg: 0 },
  { row: 11, col0: 5, text: "second line", msg: 0 },
  { row: 12, col0: 5, text: "third", msg: 1 },
];
const sel = (startRow, startCol, endRow, endCol) => ({ startRow, startCol, endRow, endCol });

test("selectedText: part of one line, end column included", () => {
  assert.equal(selectedText(lines, sel(10, 5, 10, 9)), "hello");
  assert.equal(selectedText(lines, sel(10, 11, 10, 15)), "world");
});

test("selectedText: several lines (first from startCol, middle whole, last up to endCol)", () => {
  assert.equal(selectedText(lines, sel(10, 11, 12, 7)), "world\nsecond line\nthi");
});

test("selectedText: reversed drags (up, or left) give the same text", () => {
  assert.equal(selectedText(lines, sel(12, 7, 10, 11)), "world\nsecond line\nthi");
  assert.equal(selectedText(lines, sel(10, 9, 10, 5)), "hello");
});

test("selectedText: out of range is clamped", () => {
  assert.equal(selectedText(lines, sel(2, 1, 40, 200)), "hello world\nsecond line\nthird");
  assert.equal(selectedText(lines, sel(10, 1, 10, 200)), "hello world");
  assert.equal(selectedText(lines, sel(10, 30, 10, 40)), "");
  assert.equal(selectedText(lines, sel(20, 1, 30, 9)), "");
  assert.equal(selectedText(lines, null), "");
});

test("selectedText: trailing spaces trimmed per line", () => {
  assert.equal(selectedText([{ row: 1, col0: 1, text: "ab   " }, { row: 2, col0: 1, text: "cd" }], sel(1, 1, 2, 2)), "ab\ncd");
});

test("selRange: the selected character span on a line", () => {
  assert.deepEqual(selRange(lines[0], sel(10, 7, 11, 5)), [2, 11]);
  assert.deepEqual(selRange(lines[1], sel(10, 7, 11, 5)), [0, 1]);
  assert.equal(selRange(lines[2], sel(10, 7, 11, 5)), null);
});

test("msgText: markdown cleaned, not wrapped", () => {
  assert.equal(msgText("## Title\n\nSome **bold** `code` and a [link](http://x) that is quite long indeed"), "Title\n\nSome bold code and a link that is quite long indeed");
});
