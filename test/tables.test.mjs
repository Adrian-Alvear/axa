// src/tui/control.mjs: markdown tables in the Commander panel (grid or cards) and inline markdown cleanup
import { test } from "node:test";
import assert from "node:assert/strict";
import { mdInline, msgLines, wrapMsg } from "../src/tui/control.mjs";
import { width } from "../src/tui/draw.mjs";

const TABLE = [
  "| When | What runs | Cost |",
  "|---|---|---|",
  "| Every worker turn | The cheap checks only: **syntax** of `changed_files`, *fast* lint on src/*.mjs | Almost free |",
  "| Before done | The full test suite plus an independent _reviewer_ pass over the [diff](http://x) | A few cents |",
  "| Nightly | Everything | ~1 min |",
].join("\n");
const WORDS = "When What runs Cost Every worker turn The cheap checks only: syntax of changed_files, fast lint on src/*.mjs Almost free Before done The full test suite plus an independent reviewer pass over the diff A few cents Nightly Everything ~1 min".split(" ");

const words = (lines) => lines.join(" ").replace(/[│┼─]/g, " ").split(/\s+/).filter(Boolean);
const fitsIn = (lines, w) => { for (const l of lines) assert.ok(width(l) <= w, `too wide (${width(l)} > ${w}): ${l}`); };
const clean = (lines) => { const t = lines.join("\n"); assert.ok(!/\*\*|`|\[diff\]|_reviewer_|\*fast\*/.test(t), t); assert.ok(t.includes("changed_files") && t.includes("src/*.mjs"), t); };

for (const w of [60, 120]) {
  test(`3-column table at width ${w}: fits, no word lost, markdown stripped`, () => {
    const out = wrapMsg(TABLE, w);
    fitsIn(out, w);
    clean(out);
    assert.deepEqual(new Set(words(out).join(" ").split(" ")), new Set(WORDS.join(" ").split(" ").map((x) => x.replace(/:$/, ":"))));
  });
}

test("width 120: an aligned grid, header in head role, rule under it, one line per row", () => {
  const out = msgLines(TABLE, 120);
  assert.equal(out[0][1], "head");
  assert.match(out[0][0], /^When +│ What runs +│ Cost$/);
  assert.match(out[1][0], /^─+┼─+┼─+$/);
  assert.equal(out[1][1], "dim");
  assert.equal(out.length, 5);
  const bar = out[0][0].indexOf("│");
  for (const [l] of out.slice(2)) assert.equal(l.indexOf("│"), bar);
});

test("width 60: cells wrap inside their column, blank line between rows", () => {
  const out = wrapMsg(TABLE, 60);
  assert.ok(out.some((l) => /^ +│ /.test(l)), out.join("\n")); // a continuation line
  assert.ok(out.includes(""));
});

test("a narrow panel gets cards: title line in head role, then header: value", () => {
  const out = msgLines(TABLE, 30);
  fitsIn(out.map(([l]) => l), 30);
  assert.deepEqual(out[0], ["Every worker turn", "head"]);
  assert.match(out[1][0], /^  What runs: The cheap/);
  assert.ok(out.some(([l]) => l === "  Cost: Almost free"));
});

test("6 columns at width 60 -> cards", () => {
  const t = "| Name | A | B | C | D | E |\n|---|---|---|---|---|---|\n| first row | alpha value | beta value | gamma value | delta value | epsilon value |\n| second | 1 | 2 | 3 | 4 | 5 |";
  const out = msgLines(t, 60);
  fitsIn(out.map(([l]) => l), 60);
  assert.deepEqual(out[0], ["first row", "head"]);
  assert.equal(out[1][0], "  A: alpha value");
  assert.ok(out.some(([l]) => l === "second"));
  assert.ok(!out.some(([l]) => l.includes("│")));
});

test("a non-table line with | is left alone", () => {
  assert.deepEqual(wrapMsg("pipe it: a | b | c\nnext line", 80), ["pipe it: a | b | c", "next line"]);
});

test("mdInline: emphasis, code and links; snake_case, globs and bullets untouched", () => {
  assert.equal(mdInline("**bold** and __strong__, *it* and _it_ in `a_b *c*` [x](http://y)"), "bold and strong, it and it in a_b *c* x");
  assert.equal(mdInline("snake_case_name and my_var_ and *.mjs and src/*.ts, test/*.mjs"), "snake_case_name and my_var_ and *.mjs and src/*.ts, test/*.mjs");
  assert.equal(mdInline("2 * 3 * 4"), "2 * 3 * 4");
  assert.deepEqual(wrapMsg("* item *one*\n- two", 80), ["• item one", "• two"]);
});

test("text around a table keeps bullets, headings and code fences", () => {
  const out = wrapMsg("## Plan\n- a\n\n" + TABLE + "\n```\ncode | here\n```", 120);
  assert.equal(out[0], "Plan");
  assert.equal(out[1], "• a");
  assert.equal(out.at(-1), "  code | here");
});
