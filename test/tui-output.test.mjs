// Getting frames out (console/tui/output.mjs): synchronized output and its DECRQM probe, frame
// coalescing, ANSI-aware slicing and splicing, the row-parts diff, and OSC 8 links
import test from "node:test";
import assert from "node:assert/strict";
import { frame, takeReplies, PROBE, SYNC_BEGIN, SYNC_END, createFrames, sliceAnsi, splice, stripAnsi, createScreen, link, linkify, safeUri, fileUrl, linksOn } from "../console/tui/output.mjs";
import { width } from "../console/tui/width.mjs";

test("frames are wrapped in DEC 2026 only when the terminal supports it", () => {
  assert.equal(PROBE, "\x1b[?2026$p\x1b[c");
  assert.equal(SYNC_BEGIN, "\x1b[?2026h");
  assert.equal(SYNC_END, "\x1b[?2026l");
  assert.equal(frame("abc", true), "\x1b[?2026habc\x1b[?2026l");
  assert.equal(frame("abc", false), "abc");
  assert.equal(frame("abc", null), "abc"); // not known yet: plain
  assert.equal(frame("", true), ""); // nothing to show: nothing written
});

test("DECRQM replies: supported, unsupported, and DA1 alone", () => {
  for (const [ps, want] of [["1", true], ["2", true], ["3", true], ["0", false], ["4", false]]) {
    const st = { sync: null };
    assert.equal(takeReplies(`\x1b[?2026;${ps}$y\x1b[?62;22c`, st), "");
    assert.equal(st.sync, want, ps);
  }
  // a terminal that ignores DECRQM still answers DA1: not supported
  const st = { sync: null };
  assert.equal(takeReplies("\x1b[?1;2c", st), "");
  assert.equal(st.sync, false);
  // replies mixed with typing: the keys survive, the replies don't
  const st2 = { sync: null };
  assert.equal(takeReplies("ab\x1b[?2026;2$ycd\x1b[?65;1;9c", st2), "abcd");
  assert.equal(st2.sync, true);
  // a later DA1 doesn't undo a "supported"
  takeReplies("\x1b[?62c", st2);
  assert.equal(st2.sync, true);
  // plain input passes untouched (arrows too)
  assert.equal(takeReplies("hello\x1b[A", { sync: null }), "hello\x1b[A");
});

test("focus reports are taken out of the input", () => {
  const seen = [], st = { focused: null, onFocus: (f) => seen.push(f) };
  assert.equal(takeReplies("x\x1b[Oy\x1b[I", st), "xy");
  assert.deepEqual(seen, [false, true]);
  assert.equal(st.focused, true);
});

test("frame coalescing: many requests, at most one frame per 1/fps", () => {
  let t = 0, draws = 0;
  const timers = [];
  const f = createFrames(() => draws++, { fps: 50, now: () => t, setTimer: (fn, ms) => { timers.push({ fn, at: t + ms }); return timers.length; }, clearTimer: () => {} });
  const run = () => { timers.sort((a, b) => a.at - b.at); const x = timers.shift(); t = Math.max(t, x.at); x.fn(); };
  for (let i = 0; i < 100; i++) f.schedule();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].at, 0); // the first frame after a quiet spell isn't held back
  run();
  assert.equal(draws, 1);
  // a burst right after a frame waits for the rest of the 20 ms
  t = 5;
  for (let i = 0; i < 100; i++) f.schedule();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].at, 20);
  run();
  assert.equal(draws, 2);
  // 1 s of constant requests: no more than 50 frames
  while (t < 1000) { f.schedule(); run(); t += 1; }
  assert.ok(draws <= 2 + 51, `${draws} frames`);
  assert.equal(f.pending, false);
});

test("sliceAnsi keeps styles and links, and splits wide characters safely", () => {
  const s = "ab\x1b[31mcd\x1b[0mef";
  assert.equal(stripAnsi(sliceAnsi(s, 3, 5)), "de");
  assert.ok(sliceAnsi(s, 3, 5).startsWith("\x1b[31md")); // the style in force at the cut comes along
  assert.equal(stripAnsi(sliceAnsi(s, 0, 8)), "abcdef  "); // padded to the width asked for
  assert.equal(stripAnsi(sliceAnsi("界界", 1, 3)), "  "); // a wide character cut in half: spaces
  assert.equal(width(stripAnsi(sliceAnsi("a界b", 0, 2))), 2);
  const l = link("site", "https://x.test/");
  const mid = sliceAnsi(`xx${l}yy`, 3, 5);
  assert.ok(mid.startsWith("\x1b]8;;https://x.test/\x1b\\")); // the link is reopened ...
  assert.ok(mid.endsWith("\x1b]8;;\x1b\\")); // ... and closed at the cut
  assert.equal(stripAnsi(mid), "it");
});

test("splice lays a panel over a row's parts", () => {
  const row = [{ x: 0, w: 10, s: "0123456789" }, { x: 10, w: 1, s: "|" }, { x: 11, w: 9, s: "abcdefghi" }];
  const out = splice(row, 8, 5, "XXXXX");
  assert.deepEqual(out.map((p) => [p.x, p.w]), [[0, 8], [8, 5], [13, 7]]);
  assert.equal(out.map((p) => stripAnsi(p.s)).join(""), "01234567XXXXXcdefghi");
});

test("the screen writes only parts that changed, and nothing when nothing did", () => {
  const sc = createScreen();
  const rows = (status) => [[{ x: 0, w: 5, s: "side " }, { x: 5, w: 5, s: "main " }], [{ x: 0, w: 10, s: status }]];
  const first = sc.diff(rows("12:00     "));
  assert.ok(first.includes("\x1b[1;1H") && first.includes("\x1b[1;6H") && first.includes("\x1b[2;1H"));
  assert.equal(sc.diff(rows("12:00     ")), ""); // idle: zero bytes
  const next = sc.diff(rows("12:01     "));
  assert.ok(next.includes("\x1b[2;1H") && !next.includes("\x1b[1;"));
  // a new ground color (theme) repaints everything
  assert.ok(sc.diff(rows("12:01     "), "48;5;255").includes("\x1b[1;1H"));
  sc.reset();
  assert.ok(sc.diff(rows("12:01     "), "48;5;255").includes("\x1b[1;6H"));
});

test("OSC 8: URLs and file paths become links; AXA_NO_OSC8 turns them off", () => {
  assert.equal(link("t", "https://a.test/x"), "\x1b]8;;https://a.test/x\x1b\\t\x1b]8;;\x1b\\");
  assert.equal(safeUri("https://a.test/\x1b]evil\x07 x"), "https://a.test/]evil%20x"); // no escapes inside
  assert.equal(safeUri("https://a.test/é"), "https://a.test/%C3%A9");
  assert.equal(safeUri("https://a.test/" + "a".repeat(3000)), "");
  assert.equal(link("t", "https://a.test/" + "a".repeat(3000)), "t");
  assert.equal(fileUrl("/home/me/a b.txt", {}), "file:///home/me/a%20b.txt");
  assert.equal(fileUrl("/home/me/x", { WSL_DISTRO_NAME: "Ubuntu" }), "file://wsl.localhost/Ubuntu/home/me/x");
  const t = "see https://github.com/x/y/pull/4. and /home/me/proj/a.js, ok";
  const out = linkify(t, { env: {} });
  assert.equal(stripAnsi(out), t); // same text, same width
  assert.ok(out.includes("\x1b]8;;https://github.com/x/y/pull/4\x1b\\"));
  assert.ok(out.includes("\x1b]8;;file:///home/me/proj/a.js\x1b\\"));
  assert.ok(linkify("~/notes.md", { env: {}, home: "/home/me" }).includes("file:///home/me/notes.md"));
  assert.equal(linkify("1/2 and a/b", { env: {} }), "1/2 and a/b"); // not paths
  assert.equal(linkify(t, { env: { AXA_NO_OSC8: "1" } }), t);
  assert.equal(linksOn({ AXA_NO_OSC8: "1" }), false);
  assert.equal(linksOn({}), true);
});
