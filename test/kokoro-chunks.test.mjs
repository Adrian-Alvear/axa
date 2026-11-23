// Kokoro speaks long replies sentence by sentence: chunking at sentence ends, a queue that plays chunk i while
// chunk i+1 is made, a timed-out chunk retried once then skipped, no switch to the system voice, and stop
// (Esc, mute) clearing the queue. Fake synth and player only: nothing here makes a sound.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-chunks-test-")));
process.env.HOME = join(base, "home");
process.env.AXA_HOME = join(base, "axahome");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.AXA_HOME, { recursive: true });
const V = await import("../src/core/voice.mjs");
const { Speaker } = await import("../src/core/kokoro.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const job = () => ({ stopped: false, kills: new Set(), kill() { this.stopped = true; for (const k of this.kills) k(); this.kills.clear(); } });

test("chunks end at sentences, about 200 characters each; a very long sentence is cut at a comma", () => {
  const s = (n, w = "word") => `${Array(n).fill(w).join(" ")}.`;
  const text = `${s(10)} ${s(12)} ${s(30)} Is it done? Yes! ${s(5)}`;
  const c = V.chunkText(text);
  assert.ok(c.length >= 2);
  for (const x of c) { assert.match(x, /[.!?]$/, x); assert.ok(x.length <= 200 || !/[.!?] /.test(x), x.length); }
  assert.equal(c.join(" "), text.replace(/\s+/g, " "), "nothing lost or reordered");
  assert.deepEqual(V.chunkText("Short one."), ["Short one."]);
  assert.deepEqual(V.chunkText(""), []);
  const long = `${Array(30).fill("alpha beta gamma").join(", ")}.`;
  const lc = V.chunkText(long);
  assert.ok(lc.length > 1 && lc.every((x) => x.length <= 300), lc.map((x) => x.length).join(","));
  assert.equal(lc.join(" ").replace(/\s+/g, " "), long);
  // the timeout grows with the chunk: 4 s + 40 ms per character (the CLI also loads the model)
  assert.equal(V.chunkTimeout("x".repeat(100)), 8000);
  assert.equal(V.chunkTimeout("x".repeat(100), true), 16000);
});

test("the queue: in order, and chunk 2 is made while chunk 1 plays", async () => {
  const events = [];
  const synth = async (c, i) => { events.push(`synth ${i} start`); await sleep(20); events.push(`synth ${i} end`); return { out: `w${i}` }; };
  const play = async (w, i) => { events.push(`play ${i} start`); await sleep(60); events.push(`play ${i} end`); };
  const n = await V.speakChunks(["a.", "b.", "c."], { synth, play, job: job() });
  assert.equal(n, 3);
  assert.deepEqual(events.filter((e) => e.startsWith("play") && e.endsWith("start")), ["play 0 start", "play 1 start", "play 2 start"]);
  // synth 1 starts before play 0 ends: audio overlaps the next synthesis
  assert.ok(events.indexOf("synth 1 start") < events.indexOf("play 0 end"));
  assert.ok(events.indexOf("synth 1 end") < events.indexOf("play 0 end"));
  // and audio starts after the first chunk only, not the whole reply
  assert.ok(events.indexOf("play 0 start") < events.indexOf("synth 2 start") || events.indexOf("play 0 start") < events.indexOf("synth 2 end"));
});

test("a timed-out chunk is retried once, then skipped with a log line; the rest still plays", async () => {
  const tries = {}, played = [], logs = [];
  const synth = async (c, i) => { tries[i] = (tries[i] || 0) + 1; if (i === 1) throw new Error("timed out after 6s"); if (i === 2 && tries[i] === 1) throw new Error("timed out after 6s"); return { out: `w${i}` }; };
  const n = await V.speakChunks(["a.", "b.", "c.", "d."], { synth, play: async (w) => { played.push(w.out); }, log: (m) => logs.push(m), job: job() });
  assert.deepEqual(tries, { 0: 1, 1: 2, 2: 2, 3: 1 });
  assert.deepEqual(played, ["w0", "w2", "w3"]);
  assert.equal(n, 3);
  assert.match(logs.join("\n"), /sentence 2\/4 failed \(timed out after 6s\); trying it once more[\s\S]*sentence 2\/4 failed again \(timed out after 6s\); skipped/);
});

test("no switch to the system voice: a slow Kokoro skips, it never hands the reply over", async () => {
  const system = [];
  const kokoro = (text, s, j) => V.speakChunks(V.chunkText(text), { synth: async () => { throw new Error("timed out after 9s"); }, play: async () => {}, job: j });
  const r = await V.speakWith("One sentence. Two sentences.", { engine: "kokoro", fallback: "system" }, { kokoro, system: async (t) => { system.push(t); return 0; }, job: job() });
  assert.equal(r, 0, "nothing played, nothing thrown");
  assert.deepEqual(system, []);
  // only "can't start at all" (on the first chunk) may fall back, and only with voiceFallback "system"
  const cant = (text, s, j) => V.speakChunks(V.chunkText(text), { synth: async () => { throw Object.assign(new Error("the Kokoro speaker stopped (spawn ENOENT)"), { cantStart: true }); }, play: async () => {}, job: j });
  await V.speakWith("Hello there.", { engine: "kokoro", fallback: "system" }, { kokoro: cant, system: async (t) => { system.push(t); return 0; }, job: job() });
  assert.deepEqual(system, ["Hello there."]);
  assert.equal(await V.speakWith("Hello there.", { engine: "kokoro", fallback: "silent" }, { kokoro: cant, system: async (t) => { system.push(t); return 0; }, job: job() }), null);
  assert.equal(system.length, 1);
});

test("stop (Esc, mute) clears the queue: nothing more is made or played", async () => {
  const j = job(), made = [], played = [], cleaned = [];
  const synth = async (c, i) => { made.push(i); await sleep(10); return { out: `w${i}` }; };
  const play = async (w, i) => { played.push(i); if (i === 1) j.kill(); await sleep(10); };
  const n = await V.speakChunks(["a.", "b.", "c.", "d.", "e."], { synth, play, job: j, cleanup: (w) => cleaned.push(w.out) });
  assert.deepEqual(played, [0, 1]);
  assert.ok(made.length <= 3, `made ${made}`);
  assert.equal(n, 1);
  // every wav that was made is removed, the one being made when it stopped too
  await sleep(30);
  assert.deepEqual([...new Set(cleaned)].sort(), made.map((i) => `w${i}`).sort());
});

test("the speaker preloads a reply's new words on their own request (not a sentence's timeout)", async () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const sp = new Speaker({ python: "python3", model: "/nowhere", script: join(here, "fixtures", "fake-kokoro.py"), spawnFn: spawn });
  try {
    assert.deepEqual(await sp.preload({ axa: "æ k s ə" }), { preloaded: 1, load: 0.01 });
    const r = await sp.synth({ text: "hello", out: join(base, "a.wav") }, 5000);
    assert.equal(r.out, join(base, "a.wav"));
  } finally { sp.kill(); }
});

test("the Windows player: one PowerShell per reply reads wav|flag|ms lines and stops when the flag goes", () => {
  const s = V.residentPlayScript();
  assert.match(s, /\[Console\]::In\.ReadLine\(\)/);
  assert.match(s, /\$w, \$f, \$ms = \$l\.Split\('\|'\)/);
  assert.match(s, /if \(-not \(Test-Path -LiteralPath \$f\)\) \{ break \}/);
  assert.match(s, /\[Console\]::Out\.WriteLine\('done'\)/);
});

test("voiceFallback: silent by default when Kokoro is installed, the system voice when it isn't", () => {
  // (no Kokoro in this temp home)
  assert.equal(V.settings().fallback, "system");
});
