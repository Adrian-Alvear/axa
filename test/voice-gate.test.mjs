// Mute silences everything: every speaking path goes through voice.mjs speak(), which says nothing while the
// voice is off (only the settings screen's voice test is forced); stopping clears what's queued. Also: the
// `npm run check` script and the standing instruction that points workers at it. Temp AXA_HOME only; nothing
// here makes a sound.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNarrator } from "../src/core/narrator.mjs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-voicegate-test-")));
process.env.HOME = join(base, "home");
process.env.AXA_HOME = join(base, "axahome");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.AXA_HOME, { recursive: true });
delete process.env.AXA_VOICE;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const V = await import("../src/core/voice.mjs");
const N = await import("../src/core/notify.mjs");
const src = (f) => readFileSync(join(ROOT, f), "utf8");

test("the gate: nothing is said while the voice is off, unless it's the forced voice test", async () => {
  assert.deepEqual([V.maySpeak(true, false), V.maySpeak(false, false), V.maySpeak(false, true), V.maySpeak(undefined, undefined)], [true, false, true, false]);
  // off by default (no ui.json): speak() returns at once, nothing starts
  assert.equal(await V.speak("This must not be heard."), null);
  assert.equal(V.speaking(), false);
  // off in ui.json, and AXA_VOICE=0: the same; a caller can't pass { on: true } around it
  writeFileSync(join(process.env.AXA_HOME, "ui.json"), JSON.stringify({ voice: "off" }));
  assert.equal(await V.speak("Nor this.", { on: true }), null);
  writeFileSync(join(process.env.AXA_HOME, "ui.json"), JSON.stringify({ voice: "on" }));
  process.env.AXA_VOICE = "0";
  assert.equal(await V.speak("Nor this."), null);
  assert.equal(V.speaking(), false);
  delete process.env.AXA_VOICE;
  // nothing speaking: nothing to silence
  assert.equal(V.silenceIfMuted(), false);
});

test("every speaking path goes through speak(); only the voice test forces it", () => {
  const files = ["src/core", "src/tui", "hooks", "mcp", "bin", "scripts"].flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => /\.mjs$|^axa$/.test(f)).map((f) => `${d}/${f}`));
  for (const f of files.filter((f) => f !== "src/core/voice.mjs")) {
    const t = src(f).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"); // code, not comments
    // no other module plays audio or runs a speech program itself
    assert.ok(!/SoundPlayer|SpeechSynthesizer|\bafplay\b|\bpaplay\b|\baplay\b|spd-say|\bespeak\b|"say"/.test(t), f);
    assert.ok(!/playWav|systemSpeak|kokoroSpeak/.test(t), f);
  }
  const forced = files.flatMap((f) => (src(f).match(/speak\([^)]*force: true/g) || []).map(() => f));
  assert.deepEqual(forced, ["src/core/server.mjs"]);
  assert.match(src("src/core/server.mjs"), /\["POST", \/\^\\\/api\\\/voice\\\/test\$\/[\s\S]{0,200}V\.speak\("AXA voice check\.", \{ force: true \}\)/);
});

test("stop and mute clear everything: the player, a summary being written, queued notifications", () => {
  const s = src("src/core/server.mjs");
  assert.match(s, /function hush\(\) \{ cancelSummaries\(\); voiceGen\+\+; voiceNow = null; narrator\.clear\(\); V\.stop\(\); \}/);
  assert.match(s, /\["POST", \/\^\\\/api\\\/voice\\\/stop\$\/, \(\) => \{ hush\(\);/);
  // muted however it's done (ui.json edited too): checked while anything speaks, is written or queued
  assert.match(s, /if \(!\(V\.speaking\(\) \|\| summarizing > 0 \|\| narrator\.pending\(\) > 0\) \|\| V\.settings\(\)\.on\) return;/);
  // the hub's m and the settings switch stop it first
  assert.match(src("src/tui/app.mjs"), /function toggleVoice\(\) \{\n\s*stopVoice\(\);/);
  // a cleared queue says nothing later
  let t = 0; const said = [], timers = [];
  const q = createNarrator({ now: () => t, speak: (x) => { said.push(x); return new Promise(() => {}); }, setTimer: (fn) => { timers.push(fn); return 1; }, clearTimer: () => {} });
  q.add({ kind: "done", session: "a", text: "a" }); q.add({ kind: "done", session: "b", text: "b" });
  assert.equal(q.pending(), 2);
  q.clear();
  assert.equal(q.pending(), 0);
  t = 30_000; timers.shift()();
  assert.deepEqual(said, []);
});

test("npm run check: every source file, both suites, a PASS/FAIL table; workers are pointed at it", async () => {
  const pkg = JSON.parse(src("package.json"));
  assert.equal(pkg.scripts.check, "node scripts/check.mjs");
  const { sourceFiles } = await import("../scripts/check.mjs");
  const files = sourceFiles(ROOT).map((f) => f.slice(ROOT.length).replace(/^\//, ""));
  for (const f of ["src/core/server.mjs", "hooks/approver.mjs", "mcp/axa-terminals.mjs", "lib/safety.mjs", "bin/axa", "scripts/check.mjs", "skills/verify/verify.mjs", "test/voice-gate.test.mjs"]) assert.ok(files.includes(f), f);
  assert.ok(!files.some((f) => f.startsWith("node_modules/")));
  const c = src("scripts/check.mjs");
  assert.match(c, /\["npm test \(node --test test\/\*\.test\.mjs\)", \["--test", \.\.\.tests\]\], \["node --test", \["--test"\]\]/);
  assert.match(c, /PASS  " : "FAIL  /);
  const { WORKER_NOTE } = await import("../src/core/sessions.mjs");
  assert.match(WORKER_NOTE, /npm run check/);
  assert.match(WORKER_NOTE, /Don't write shell for-loops/);
  assert.match(src("src/core/sessions.mjs"), /--permission-mode acceptEdits --append-system-prompt \$\{shq\(WORKER_NOTE\)\}/);
  assert.match(src("skills/verify/SKILL.md"), /npm run check[\s\S]*Never write\s+shell `for` loops/);
});
