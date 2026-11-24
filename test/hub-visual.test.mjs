// Fixes from the hub visual check (docs/tasks/hub-visual.md): every row keeps its last column, footer hints
// are left out whole instead of cut mid-word, a project card's chip uses the session list's words, and the
// voice states don't move the rest of the status bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fitHints, projectChip, rowsOut } from "../src/tui/app.mjs";
import { VOICE_STATES, axaStatusLine } from "../src/tui/control.mjs";
import * as D from "../src/tui/draw.mjs";
const { width } = D;

const plain = (s) => s.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "");
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

test("rowsOut: a changed row is erased first, then written; an unchanged one isn't sent", () => {
  const o = rowsOut(["0123456789", "same"], ["old", "same"]);
  assert.equal(o, "\x1b[1;1H\x1b[0m\x1b[2K0123456789\x1b[0m");
  assert.ok(!/\x1b\[0?K/.test(o), "no erase after the row (it would wipe the last column with autowrap off)");
  assert.equal(rowsOut(["a"], ["a"]), "");
});

test("in a real terminal (tmux, autowrap off): full-width rows keep their last column, a shorter redraw leaves nothing behind", { skip: !hasTmux && "tmux not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "axa-rows-")), sock = `axa-rows-test-${process.pid}`;
  const f1 = join(dir, "f1"), f2 = join(dir, "f2");
  writeFileSync(f1, "\x1b[?7l" + rowsOut(["0123456789", "abcdefghij"]));
  // the second frame's first row is shorter, as when a glyph is counted wider than the terminal draws it
  writeFileSync(f2, rowsOut(["xyz", "abcdefghij"], ["0123456789", "abcdefghij"]));
  const t = (...a) => spawnSync("tmux", ["-L", sock, "-f", "/dev/null", ...a], { encoding: "utf8" });
  try {
    assert.equal(t("new-session", "-d", "-x", "10", "-y", "3", `cat ${f1}; sleep 0.4; cat ${f2}; sleep 30`).status, 0);
    const shot = () => t("capture-pane", "-p").stdout.split("\n");
    spawnSync("sleep", ["0.25"]);
    assert.deepEqual(shot().slice(0, 2), ["0123456789", "abcdefghij"]);
    spawnSync("sleep", ["0.6"]);
    assert.deepEqual(shot().slice(0, 2), ["xyz", "abcdefghij"]);
  } finally { t("kill-server"); }
});

test("a chip on a colored row keeps its color: no SGR sequence longer than terminals take (tmux drops 22+ params)", () => {
  D.setTheme("axa");
  try {
    const l = D.line([["alpha", "head"]], 40, [[" STUCK ", "chipStuck"]], "pvHead");
    const seqs = [...l.matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1].split(";").length);
    assert.ok(Math.max(...seqs) <= 16, `longest: ${Math.max(...seqs)} params`);
    // the chip's own colors come after the row's, so they win
    assert.ok(l.includes(`\x1b[${D.sgrOf("pvHead")}m\x1b[${D.sgrOf("chipStuck")}m STUCK `));
  } finally { D.setTheme("terminal"); }
});

test("footer hints: whole ones only, in order, in the room there is", () => {
  const per = [["⏎", "open"], ["g", "goal"], ["r", "review"], ["h", "handoff"]];
  const w = (hs) => hs.reduce((a, [k, t]) => a + width(` ${k} `) + width(` ${t}  `), 0);
  assert.deepEqual(fitHints(per, 200), per);
  assert.deepEqual(fitHints(per, w(per.slice(0, 2)) + 5), per.slice(0, 2), "review would be cut: it's left out");
  assert.deepEqual(fitHints(per, 3), []);
});

test("a project card's chip: the most urgent session in the session list's words and colors", () => {
  assert.deepEqual(projectChip([{ status: "working" }, { status: "waiting" }], 2), [" NEEDS YOU ", "chipWait"]);
  assert.deepEqual(projectChip([{ status: "failed" }, { status: "stuck" }], 2), [" STUCK ", "chipStuck"]);
  assert.deepEqual(projectChip([{ status: "needs_trust" }], 1), [" NEEDS TRUST ", "chipWait"]);
  assert.deepEqual(projectChip([{ status: "working" }], 1), [" 1 OPEN ", "chipIdle"]);
  assert.deepEqual(projectChip([], 0, "5 weeks"), [" idle 5 weeks ", "chipOff"]);
  assert.deepEqual(projectChip(undefined, 0, ""), ["", ""]);
});

test("the status bar counts what needs you like the title bar does (a stuck session too)", () => {
  const ss = [{ alive: true, status: "waiting" }, { alive: true, status: "stuck" }, { alive: true, status: "working" }];
  assert.match(plain(axaStatusLine({}, ss, 160, 1)[0]), /3 sessions · 1 working · 2 need you/);
});

test("the status bar's voice states keep everything after them in place, at every width", () => {
  const cmd = { created: Date.now() - 3 * 60_000, usage: { model: "claude-opus-5-5", context: 50_000, tokens: 120_000 } };
  for (const w of [100, 160, 220]) {
    const at = (voice) => { const l = plain(axaStatusLine(cmd, [], w, 1, { mode: "auto mode", voice })[0]); assert.equal(width(l), w); return l.indexOf("⏵⏵"); };
    const base = at(true);
    assert.ok(base > 0);
    for (const st of VOICE_STATES) assert.equal(at(st), base, `${w}: ${st}`);
  }
});
