// Part 3 of docs/tasks/landscape-build.md: one needs-you, Ctrl+P, Space to next, a footer and help from one keymap,
// a quieter log, empty states, dense map rows, motion only for meaning, grapheme widths, synchronized output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as W from "../src/tui/width.mjs";
import * as D from "../src/tui/draw.mjs";
import { sliceAnsi } from "../src/tui/ansi.mjs";
import { FOOTER_KEYS, KEYMAP, PANEL_NAMES, fuzzyScore, keymapHelp, rankPalette, syncFrame, syncReply, SYNC_PROBE } from "../src/tui/app.mjs";
import { collapseRepeats, controlRows } from "../src/tui/control.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = (f) => readFileSync(join(ROOT, f), "utf8");
const cp = (...c) => String.fromCodePoint(...c);
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

test("one grapheme-aware width for building and cutting lines; untrusted text sanitized", () => {
  assert.equal(D.width("ab"), 2); assert.equal(D.width("日本"), 4);
  assert.equal(D.width("e" + cp(0x301)), 1, "an accent is part of its letter");
  assert.equal(D.width(cp(0x2714, 0xfe0f)), 2, "emoji presentation");
  assert.equal(D.width(cp(0x1f468, 0x200d, 0x1f469)), 2, "a joined emoji is one grapheme");
  // sanitized: zero-width and bidi controls gone, joins and skin tones taken apart, flags as letters
  assert.equal(D.clean(`a${cp(0x200b)}b${cp(0x202e)}c`), "abc");
  assert.equal(D.clean(cp(0x1f1fa, 0x1f1f8)), "US");
  assert.equal(D.clean(cp(0x1f44d, 0x1f3fd)), cp(0x1f44d));
  assert.equal(D.clean(cp(0x1f468, 0x200d, 0x1f469)), cp(0x1f468, 0x1f469));
  // cutting with colors keeps the same measure: a wide glyph that doesn't fit becomes a space
  for (const t of ["ab日本cd", `x${cp(0x1f680)}y`, "e" + cp(0x301) + "fg"]) {
    for (let n = 1; n <= D.width(t) + 1; n++) assert.equal(D.width(plain(sliceAnsi(`\x1b[31m${t}\x1b[0m`, 0, n))), n, `${t} at ${n}`);
  }
  assert.equal(D.width(D.cut("日本語テスト", 7)), 7);
});

test("footer and help from one keymap: at most 6 keys per screen; help lists every key", () => {
  for (const p of Object.keys(PANEL_NAMES)) assert.ok(KEYMAP[p].length >= 1, p);
  assert.equal(FOOTER_KEYS, 6);
  const help = keymapHelp().map((l) => l.text).join("\n");
  for (const [p, name] of Object.entries(PANEL_NAMES)) { assert.match(help, new RegExp(`^${name}$`, "m")); for (const [k, t] of KEYMAP[p]) assert.ok(help.includes(`${k} ${t}`), `${p}: ${k}`); }
  for (const [k] of KEYMAP.global) assert.ok(help.includes(k), k);
  const app = src("src/tui/app.mjs");
  assert.match(app, /: KEYMAP\[PANELS\[focus\]\]\.slice\(0, FOOTER_KEYS\);/);
  assert.match(app, /const all = \[\["\^P", "commands"\], \["\?", "all keys"\]\];/);
  assert.match(app, /viewer\("AXA keys", \[\n\s*\.\.\.keymapHelp\(\),/);
});

test("Ctrl+P: fuzzy search ranks consecutive letters and word starts first", () => {
  assert.equal(fuzzyScore("", "x"), 0);
  assert.equal(fuzzyScore("zz", "review queue"), null);
  assert.ok(fuzzyScore("rq", "review queue") > fuzzyScore("rq", "the arq thing") - 5);
  const entries = [{ kind: "action", label: "usage" }, { kind: "action", label: "review queue", key: "L" }, { kind: "session", label: "feed" }, { kind: "setting", label: "Quiet hours" }];
  assert.equal(rankPalette(entries, "rev")[0].label, "review queue");
  assert.equal(rankPalette(entries, "fe")[0].label, "feed");
  assert.equal(rankPalette(entries, "").length, 4);
  const app = src("src/tui/app.mjs");
  assert.match(app, /case "\\x10": return openPalette\(\);/);
  assert.match(app, /\.\.\.settingsOpts\(\)\.map\(\(o, i\) => \(\{ kind: "setting"/);
});

test("Space: the next session that needs you, its prompt inline (y / x / Enter / Space)", () => {
  const app = src("src/tui/app.mjs");
  assert.match(app, /case " ": return nextNeedsYou\(\);/);
  assert.match(app, /if \(c && \(k === "y" \|\| k === "x"\)\) \{ closeOverlay\(\); answerAlert\(k === "y" \? "yes" : "no", s\); return true; \}/);
  assert.doesNotMatch(app, /case "\\r": case " ":\n\s*if \(zone === "chats"\)/, "Space no longer opens on Control");
});

test("one urgency component: the yellow bar is the call to action; elsewhere a quiet badge", () => {
  assert.deepEqual(D.chipOf({ status: "waiting", mode: "claude" }), [" NEEDS YOU ", "wait"]);
  assert.deepEqual(D.chipOf({ status: "failed", mode: "claude" }), [" FAILED ", "chipStuck"]);
  const app = src("src/tui/app.mjs");
  assert.match(app, /\[needs \? ` \$\{I\.wait\} \$\{needs\} ` : "", "wait"\]/);
  assert.match(app, /\[\[` \$\{I\.wait\} NEEDS YOU `, "chipWait"\]/, "the bar keeps the strong chip");
});

test("the log collapses repeats; empty panels are one line with the action; toasts are 3 s", () => {
  const c = collapseRepeats([{ t: "woke" }, { t: "woke" }, { t: "woke" }, { t: "done" }, { t: "woke" }], (x) => x.t);
  assert.deepEqual(c.map((x) => [x.t, x.n]), [["woke", 3], ["done", 1], ["woke", 1]]);
  const s = src("src/tui/control.mjs");
  assert.match(s, /\[n > 1 \? ` ×\$\{n\}` : "", "dim"\]/);
  assert.match(s, /No chats yet · N starts a session/);
  assert.match(src("src/tui/app.mjs"), /const flash = \(text, ms = 3000\)/);
});

test("the live lanes: one row (and hit) per session; nothing moves when nothing works", () => {
  const now = Date.now();
  const cmd = { id: "c", mode: "axa", alive: true, status: "ready", name: "axa", cwd: "/tmp", created: now };
  const ss = (n, status = "ready") => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, mode: "claude", alive: true, status, name: `proj${i}`, cwd: `/tmp/p${i}`, created: now, doing: "editing" }));
  const ctx = (sessions) => ({ motion: "full", sessions: [cmd, ...sessions], act: null, selId: null, focusInput: false, input: "", nameOf: (s) => s.name, question: () => "", yesOpt: () => ({}), noOpt: () => ({}), waiting: null, waitingCount: 0, armed: false, order: [], chats: [], zone: "map", chatSel: 0, cmdStatus: null, mapHits: [], chatHits: [], apHits: [], cmdMsgs: [], cmdScroll: 0 });
  const few = ctx(ss(2, "working")), rows = controlRows(few, 160, 45).map(plain).join("\n");
  assert.match(rows, /proj0 .*WORKING\s+editing/); assert.equal(few.mapHits.length, 3, "the commander and two sessions");
  const many = ctx(ss(7, "working"));
  controlRows(many, 160, 45);
  assert.equal(many.mapHits.filter((h) => !h.agent).length, 8);
  const idle = ctx(ss(3));
  controlRows(idle, 160, 45);
  assert.equal(idle.anim, false, "nothing working: nothing moves");
  const busy = ctx(ss(3, "working"));
  controlRows(busy, 160, 45);
  assert.equal(busy.anim, true);
  const still = { ...ctx(ss(3, "working")), motion: "off" };
  controlRows(still, 160, 45);
  assert.equal(still.anim, false, "Motion off: nothing moves");
});

test("synchronized output: probed once, frames wrapped only when the terminal said yes", () => {
  assert.equal(SYNC_PROBE, "\x1b[?2026$p");
  assert.deepEqual(syncReply("\x1b[?2026;2$yq"), { supported: true, rest: "q" });
  assert.deepEqual(syncReply("\x1b[?2026;0$y"), { supported: false, rest: "" });
  assert.deepEqual(syncReply("abc"), { supported: null, rest: "abc" });
  assert.equal(syncFrame("X", true), "\x1b[?2026hX\x1b[?2026l");
  assert.equal(syncFrame("X", false), "X");
  assert.match(src("src/tui/app.mjs"), /out\.write\(syncFrame\(o, syncOutput\)\);/);
});
