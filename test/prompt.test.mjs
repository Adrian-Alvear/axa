// Prompt parsing (console/prompt.mjs) against captured Claude Code screens in test/fixtures/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PERMISSION_RE, awaitingPermission, choicesOf, answerKeys, screenTail } from "../console/prompt.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const screen = (name) => readFileSync(join(dir, `${name}.txt`), "utf8").split("\n");
const labels = (c) => c.options.map((o) => o.label);
// the same screen with the ❯ cursor moved to option k (0-based), as after pressing Down
const moveCursor = (lines, k) => {
  const opts = lines.map((l, i) => [l, i]).filter(([l]) => /^(?:│ )?(?:❯|  )\s?\d\.\s/.test(l));
  return lines.map((l, i) => (i === opts[k][1] ? l.replace(/^(│ )?  /, "$1❯ ") : opts.some(([, j]) => j === i) ? l.replace("❯", " ") : l));
};

test("numbered permission menu", () => {
  const lines = screen("permission-menu");
  assert.ok(awaitingPermission(lines));
  assert.ok(PERMISSION_RE.test(lines.join("\n")));
  const c = choicesOf(lines, 80);
  assert.deepEqual(labels(c), ["Yes", "Yes, and don't ask again for npm test commands in /home/dev/shop", "No, and tell Claude what to do differently (esc)"]);
  assert.deepEqual(c.options.map((o) => o.n), [1, 2, 3]);
  assert.equal(c.cursor, 0);
  assert.match(c.question, /Do you want to proceed\?$/);
  assert.match(c.question, /npm test -- --watch=false/);
  assert.doesNotMatch(c.question, /[│╭╮╰╯]/); // box drawing is stripped
});

test("cursor on another option is found", () => {
  const c = choicesOf(moveCursor(screen("permission-menu"), 2), 80);
  assert.equal(c.cursor, 2);
  assert.equal(c.options.length, 3);
});

test("folder trust dialog", () => {
  const lines = screen("trust-dialog");
  assert.ok(awaitingPermission(lines));
  const c = choicesOf(lines, 80);
  assert.deepEqual(labels(c), ["Yes, proceed", "No, exit"]);
  assert.equal(c.cursor, 0);
  assert.match(c.question, /Do you trust the files in this folder\?/);
});

test("AskUserQuestion: unnumbered options, descriptions left out, a wrapped long label joined", () => {
  const lines = screen("ask-user-question");
  assert.ok(awaitingPermission(lines));
  const c = choicesOf(lines, 80);
  assert.deepEqual(labels(c), ["PostgreSQL", "SQLite", "A managed document store from the cloud provider we already pay for, with automatic backups", "Type something else"]);
  assert.equal(c.cursor, 0);
  assert.match(c.question, /Which database should the new orders service use\?$/);
  // on a wider pane the same second line can't be a wrap of the first (it would have fit): own option
  const wide = choicesOf(lines, 200);
  assert.equal(wide.options.length, 5);
});

test("plain screen: no prompt", () => {
  const lines = screen("plain-screen");
  assert.equal(awaitingPermission(lines), false);
  assert.equal(PERMISSION_RE.test(lines.join("\n")), false);
  assert.equal(choicesOf(lines, 80), null);
  assert.equal(choicesOf([], 80), null);
});

test("only the last 25 lines count for the permission check", () => {
  const lines = [...screen("permission-menu").slice(0, -3), ...Array(30).fill("output line")];
  assert.equal(awaitingPermission(lines), false);
});

test("screenTail trims trailing blanks and keeps the last n", () => {
  assert.deepEqual(screenTail(["a  ", "b", "", "  "], 60), ["a", "b"]);
  assert.deepEqual(screenTail(["a", "b", "c"], 2), ["b", "c"]);
});

test("answer cursor moves", () => {
  assert.deepEqual(answerKeys(0, 3), { moves: 2, key: "Down", keys: ["Down", "Down", "Enter"] });
  assert.deepEqual(answerKeys(2, 1).keys, ["Up", "Up", "Enter"]);
  assert.deepEqual(answerKeys(1, 1).keys, ["Up", "Enter"]);
  assert.deepEqual(answerKeys(0, 1).keys, ["Enter"]);
  assert.equal(answerKeys(0, 1).moves, 0);
});
