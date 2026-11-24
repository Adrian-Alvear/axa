// Fixes from the milestone review of 6634e62..HEAD: the Windows/WSL player never hangs when its PowerShell
// exits, Esc/mute kill a summary being written, the daily brief goes out once a day even after notifications
// are cleared, the README's sample footer, and the hub's plain icons are all single-width.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-fixes-test-")));
process.env.HOME = join(base, "home");
process.env.AXA_HOME = join(base, "axahome");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.AXA_HOME, { recursive: true });
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const V = await import("../src/core/voice.mjs");
const Sm = await import("../src/core/summary.mjs");
const P = await import("../src/core/projects.mjs");
const D = await import("../src/tui/draw.mjs");
const { sliceAnsi } = await import("../src/tui/ansi.mjs");

const job = () => ({ stopped: false, kills: new Set() });
// a fake PowerShell player: answers "done" per line; `script` decides what each child does per line
function fakeChild(script) {
  const c = new EventEmitter();
  c.exitCode = null; c.killed = false; c.lines = [];
  c.stdout = new EventEmitter();
  c.stdin = Object.assign(new EventEmitter(), {
    writable: true, destroyed: false,
    write(line, cb) {
      if (!this.writable) { setImmediate(() => cb?.(new Error("write EPIPE"))); return false; }
      c.lines.push(line); cb?.();
      setImmediate(() => script(c, line));
      return true;
    },
    end() { this.writable = false; },
  });
  c.exit = () => { c.exitCode = 0; c.stdin.writable = false; c.emit("close", 0); };
  c.kill = () => { c.killed = true; c.exit(); };
  return c;
}
const done = (c) => c.stdout.emit("data", "done\n");

test("the player: PowerShell exiting between two chunks -> a new one plays the next; nothing hangs", async () => {
  const children = [];
  const spawnChild = () => { const c = fakeChild((ch) => { done(ch); if (children.length === 1) ch.exit(); }); children.push(c); return c; };
  const lp = V.linePlayer(spawnChild, job());
  await lp.send("a.wav|a.flag|100\n");
  assert.equal(children[0].exitCode, 0, "the first PowerShell exited after chunk 1");
  await lp.send("b.wav|b.flag|100\n");
  assert.equal(children.length, 2, "a new one was started for chunk 2");
  assert.deepEqual(children[1].lines, ["b.wav|b.flag|100\n"]);
});

test("the player: dying during a chunk, or a failed write, rejects at once; too many deaths stop respawning", async () => {
  let n = 0;
  const lp = V.linePlayer(() => { n++; return fakeChild((ch) => ch.exit()); }, job());
  const t0 = Date.now();
  await assert.rejects(lp.send("a|f|1\n"), /the player stopped/);
  await assert.rejects(lp.send("b|f|1\n"), /the player stopped/);
  await assert.rejects(lp.send("c|f|1\n"), /the player stopped/);
  await assert.rejects(lp.send("d|f|1\n"), /keeps stopping/);
  assert.equal(n, 1 + V.RESPAWNS);
  assert.ok(Date.now() - t0 < 1000);
  // stdin closed but no close event yet: the write's error rejects the play
  const c = fakeChild(() => {});
  const lp2 = V.linePlayer(() => c, job());
  const p = lp2.send("x|f|1\n");
  await new Promise((r) => setImmediate(r));
  c.stdin.writable = false;
  c.stdin.emit("error", new Error("EPIPE"));
  await assert.rejects(p, /input closed/);
});

test("speakChunks finishes when the player fails mid-reply (no hang, the next chunk still plays)", async () => {
  const children = [];
  const lp = V.linePlayer(() => { const c = fakeChild((ch) => { if (children.length === 1 && ch.lines.length === 2) return ch.exit(); done(ch); }); children.push(c); return c; }, job());
  const logs = [];
  const n = await Promise.race([
    V.speakChunks(["a.", "b.", "c."], { synth: async (c, i) => ({ out: `w${i}` }), play: (w) => lp.send(`${w.out}|f|1\n`), log: (m) => logs.push(m), job: job() }),
    new Promise((_, no) => setTimeout(() => no(new Error("hung")), 3000)),
  ]);
  assert.equal(n, 2);
  assert.match(logs.join("\n"), /couldn't play sentence 2 \(the player stopped\)/);
});

test("Esc/mute: the summary being written is killed at once and nothing is said", async () => {
  const FAKE = fileURLToPath(new URL("./fixtures/fake-summary.mjs", import.meta.url));
  const env = { ...process.env, AXA_SUMMARY_CMD: `${process.execPath} ${FAKE}`, FAKE_SUMMARY_MODE: "hang" };
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 150);
  const long = "This reply is long enough to be summarised. ".repeat(20);
  const r = await Sm.spokenReply(long, { mode: "model", summarize: (md, o) => Sm.runSummary(md, { env, ...o }) , signal: ac.signal });
  assert.deepEqual(r, { text: "", how: "stopped" });
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms (the 10 s limit wasn't what ended it)`);
  // already aborted: no process at all
  assert.equal(await Sm.runSummary("x", { env, signal: AbortSignal.abort() }), null);
  // the daemon: Esc (hush) and mute abort it
  const s = readFileSync(join(ROOT, "src/core/server.mjs"), "utf8");
  assert.match(s, /function hush\(\) \{ cancelSummaries\(\);/);
  assert.match(s, /cancelSummaries\(\); voiceGen\+\+; voiceNow = null; clearVoiceQueue\(\);\n\}, 500\)/);
  assert.match(s, /planned\(\(signal\) => spokenReply\(safe\(message\), \{ more: vs\.moreHint, signal \}\)\)/);
});

test("the daily brief: once a day, even after the notifications are cleared", async () => {
  const file = join(base, "brief.json"), sent = [];
  const at = (h, m, day = 23) => new Date(2026, 10, day, h, m).getTime();
  const tick = (now, fallbackLast = () => 0) => P.briefTick({ brief_at: "09:00", now, file, review: async () => [], push: (n) => sent.push(n), fallbackLast });
  assert.equal(await tick(at(8, 59)), false);
  assert.equal(await tick(at(9, 1)), true);
  assert.equal(sent[0].kind, "brief");
  // the notification list was cleared (its last brief is gone): still no second brief today
  assert.equal(await tick(at(9, 5), () => 0), false);
  assert.equal(await tick(at(18, 0)), false);
  assert.equal(await tick(at(9, 1, 24)), true, "the next day");
  assert.equal(sent.length, 2);
  // before brief.json existed: the notification list's last brief counts once
  const file2 = join(base, "brief2.json");
  assert.equal(await P.briefTick({ brief_at: "09:00", now: at(10, 0), file: file2, review: async () => [], push: (n) => sent.push(n), fallbackLast: () => at(9, 0) }), false);
  assert.equal(await P.briefTick({ brief_at: null, now: at(10, 0), file: file2, review: async () => [], push: () => {} }), false);
});

test("README's sample footer matches the hub: n notifications, N new", () => {
  const r = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.match(r, /a AXA {2}n notifications {2}N new {2}\? help/);
  assert.ok(!/\bn new\b/.test(r));
});

test("the hub's plain icons are all single-width (the bell too)", () => {
  D.setIcons("plain");
  const icons = Object.entries(D.I);
  assert.ok(icons.length > 15);
  for (const [k, g] of icons) {
    assert.equal([...g].length, 1, k);
    // ansi.mjs's width: one column (a two-column glyph would come back as a space)
    assert.equal(sliceAnsi(g, 0, 1).replace(/\x1b\[[0-9;]*m/g, ""), g, k);
    // and no emoji-capable glyph, which terminals like Windows Terminal draw two columns wide (✉ was)
    assert.ok(!/\p{Extended_Pictographic}/u.test(g), `${k}: ${g}`);
  }
  assert.equal(D.I.bell, "◎");
  const app = readFileSync(join(ROOT, "src/tui/app.mjs"), "utf8");
  assert.match(app, /\$\{ESC\}\[\?7l/);
  // each changed row is erased before it's written (not after: see test/hub-visual.test.mjs)
  assert.match(app, /o \+= rowsOut\(rows, prevRows\);/);
});
