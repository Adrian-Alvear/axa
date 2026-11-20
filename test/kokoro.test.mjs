// Kokoro: the pronunciation map, engine choice and fallback, the WSL temp copy, and the resident speaker protocol
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pickEngine, playScript, pronounce, speakWith, toSpeech, wavMs, winToUnix, wslTempCopy } from "../src/core/voice.mjs";
import { DEFAULT_VOICE, Speaker, VOICES, cliArgs, layout, sidOf, speedOf, state } from "../src/core/kokoro.mjs";
import { cliTarball } from "../src/core/kokoro-install.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "axa-kokoro-test-"));

// ---------- pronunciation ----------
test("pronounce: the word map", () => {
  assert.equal(pronounce("AXA runs on macOS and WSL."), "ax uh runs on mac O S and W S L.");
  assert.equal(pronounce("npm and git, then a PR for the README.md."), "N P M and git, then a P R for the read me.");
  assert.equal(pronounce("The CLI, the TUI and the UI call the API with a URL."), "The C L I, the T U I and the U I call the A P I with a URL.".replace("URL", "U R L"));
  assert.equal(pronounce("It's ok, the JSON is fine. OK?"), "It's okay, the jason is fine. okay?");
  assert.equal(pronounce("Saved in ~/ for you."), "Saved in home folder for you.");
  // whole words only, and running it twice changes nothing
  assert.equal(pronounce("okay, bookkeeping, uiState, prune, apiKey"), "okay, bookkeeping, uiState, prune, apiKey");
  const once = pronounce("AXA on macOS via WSL, ok");
  assert.equal(pronounce(once), once);
});

test("toSpeech applies the word map", () => {
  assert.equal(toSpeech("**AXA** now works on `macOS`."), "ax uh now works on mac O S.");
});

// ---------- engine choice and fallback ----------
test("pickEngine: your choice wins; none means Kokoro only when it's installed", () => {
  assert.equal(pickEngine("", false), "system");
  assert.equal(pickEngine("", true), "kokoro");
  assert.equal(pickEngine("system", true), "system");
  assert.equal(pickEngine("kokoro", true), "kokoro");
  assert.equal(pickEngine("kokoro", false), "kokoro"); // chosen but missing: speak() falls back per reply
});

const fakes = (kokoro) => {
  const calls = { system: [], logs: [] };
  return { calls, deps: { kokoro, system: async (t) => { calls.system.push(t); return 0; }, log: (m) => calls.logs.push(m) } };
};
test("speakWith: Kokoro missing -> the system voice", async () => {
  const { calls, deps } = fakes(async () => { throw new Error("Kokoro is not installed: run axa voice install kokoro"); });
  assert.equal(await speakWith("hello", { engine: "kokoro" }, deps), 0);
  assert.deepEqual(calls.system, ["hello"]);
  assert.match(calls.logs[0], /Kokoro failed \(Kokoro is not installed.*\); using the system voice/);
});
test("speakWith: Kokoro throws -> the system voice; Kokoro works -> no system voice", async () => {
  const a = fakes(async () => { throw new Error("timed out after 8s"); });
  await speakWith("one", { engine: "kokoro" }, a.deps);
  assert.deepEqual(a.calls.system, ["one"]);
  const b = fakes(async () => 0);
  assert.equal(await speakWith("two", { engine: "kokoro" }, b.deps), 0);
  assert.deepEqual(b.calls.system, []);
  const c = fakes(async () => { throw new Error("never called"); });
  await speakWith("three", { engine: "system" }, c.deps);
  assert.deepEqual(c.calls.system, ["three"]);
});
test("speakWith: a reply stopped mid-Kokoro doesn't fall back", async () => {
  const job = { stopped: false, kills: new Set() };
  const { calls, deps } = fakes(async () => { job.stopped = true; throw Object.assign(new Error("stopped"), { stopped: true }); });
  assert.equal(await speakWith("x", { engine: "kokoro" }, { ...deps, job }), null);
  assert.deepEqual(calls.system, []);
  assert.deepEqual(calls.logs, []);
});

// ---------- WSL playback: the copy in the Windows temp folder ----------
test("wslTempCopy: the Windows and WSL names of the copy and its stop flag", () => {
  const c = wslTempCopy({ winTemp: "C:\\Users\\me\\AppData\\Local\\Temp\\", unixTemp: "/mnt/c/Users/me/AppData/Local/Temp/", name: "axa-voice-ab12.wav" });
  assert.deepEqual(c, {
    win: "C:\\Users\\me\\AppData\\Local\\Temp\\axa-voice-ab12.wav", unix: "/mnt/c/Users/me/AppData/Local/Temp/axa-voice-ab12.wav",
    winFlag: "C:\\Users\\me\\AppData\\Local\\Temp\\axa-voice-ab12.wav.playing", unixFlag: "/mnt/c/Users/me/AppData/Local/Temp/axa-voice-ab12.wav.playing",
  });
  // no trailing separators, and no wslpath answer: mapped by hand
  assert.equal(wslTempCopy({ winTemp: "D:\\Tmp", name: "a.wav" }).unix, "/mnt/d/Tmp/a.wav");
  assert.equal(wslTempCopy({ winTemp: "D:\\Tmp", unixTemp: "/win/d/Tmp", name: "a.wav" }).unix, "/win/d/Tmp/a.wav");
  assert.equal(winToUnix("C:\\Users\\me\\AppData\\Local\\Temp\\"), "/mnt/c/Users/me/AppData/Local/Temp/");
});
test("playScript: plays the copy, waits its length, stops when the flag goes; quotes escaped", () => {
  const ps = playScript({ winWav: "C:\\T\\it's.wav", winFlag: "C:\\T\\it's.wav.playing", ms: 2000 });
  assert.match(ps, /SoundPlayer 'C:\\T\\it''s\.wav'/);
  assert.match(ps, /AddMilliseconds\(2250\)/);
  assert.match(ps, /Test-Path -LiteralPath 'C:\\T\\it''s\.wav\.playing'/);
});
test("wavMs: a 24 kHz 16-bit mono wav's length from its header", () => {
  const data = 48000; // 1 s
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0); b.writeUInt32LE(36 + data, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(data, 40);
  assert.equal(wavMs(b), 1000);
  assert.equal(wavMs(Buffer.from("not a wav at all, not at all, not at all, nope")), 0);
});

// ---------- Kokoro's pieces ----------
test("voices, speed and the CLI arguments", () => {
  assert.equal(VOICES.length, 28);
  assert.equal(VOICES[3], DEFAULT_VOICE);
  assert.equal(sidOf("bm_lewis"), 27);
  assert.equal(sidOf("Microsoft Zira Desktop"), 3); // a system voice's name -> Kokoro's default
  assert.deepEqual([-2, -1, 0, 1, 2].map(speedOf), [0.7, 0.85, 1, 1.15, 1.3]);
  const a = cliArgs({ model: "/m", sid: 3, speed: 1.25, out: "/o.wav", text: "hi; rm -rf /" });
  assert.ok(a.includes("--kokoro-length-scale=0.8") && a.includes("--sid=3") && a.includes("--kokoro-lexicon=/m/lexicon-us-en.txt"));
  assert.equal(a.at(-1), "hi; rm -rf /"); // one argv entry, never a shell
  assert.equal(cliTarball("linux", "x64").name, "sherpa-onnx-v2.0.2-linux-x64-shared");
  assert.equal(cliTarball("darwin", "arm64").name, "sherpa-onnx-v2.0.2-osx-arm64-shared");
  assert.equal(cliTarball("darwin", "x64").name, "sherpa-onnx-v2.0.2-osx-universal2-shared");
  assert.equal(cliTarball("freebsd", "x64"), null);
});
test("state: what counts as installed", () => {
  const d = tmp();
  assert.equal(state(d).installed, false);
  const m = join(d, "model", "kokoro-multi-lang-v1_0");
  mkdirSync(m, { recursive: true });
  for (const f of ["model.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt"]) writeFileSync(join(m, f), "");
  assert.match(state(d).why, /sherpa-onnx isn't/);
  mkdirSync(join(d, "bin", "sherpa-onnx-v2.0.2-linux-x64-shared", "bin"), { recursive: true });
  writeFileSync(join(d, "bin", "sherpa-onnx-v2.0.2-linux-x64-shared", "bin", "sherpa-onnx-offline-tts"), "");
  assert.deepEqual([state(d).installed, state(d).mode], [true, "cli"]);
  mkdirSync(join(d, "venv", "bin"), { recursive: true });
  writeFileSync(join(d, "venv", "bin", "python"), "");
  assert.deepEqual([state(d).installed, state(d).mode, layout(d).model], [true, "resident", m]);
});

// ---------- the resident speaker, with a fake python script ----------
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const speaker = (o = {}) => new Speaker({ python: "python3", model: "/nowhere", script: join(here, "fixtures", "fake-kokoro.py"), ...o });
test("speaker: one process, JSON lines in and out; errors don't kill it; a crash restarts it", { skip: !hasPython && "no python3" }, async () => {
  const d = tmp(), sp = speaker();
  try {
    const r = await sp.synth({ text: "hello there", sid: 5, speed: 1.15, out: join(d, "a.wav") });
    assert.equal(r.out, join(d, "a.wav"));
    const [text, sid, speed, pid1] = readFileSync(r.out, "utf8").split("|");
    assert.deepEqual([text, sid, speed], ["hello there", "5", "1.15"]);
    await sp.synth({ text: "again", out: join(d, "b.wav") });
    assert.equal(readFileSync(join(d, "b.wav"), "utf8").split("|")[3], pid1, "the same process (the model stays loaded)");
    await assert.rejects(sp.synth({ text: "bad", out: join(d, "c.wav") }), /no audio/);
    assert.ok(sp.alive);
    await assert.rejects(sp.synth({ text: "crash", out: join(d, "d.wav") }), /speaker stopped \(exit 3\): boom/);
    assert.equal(sp.alive, false);
    await sp.synth({ text: "back", out: join(d, "e.wav") });
    assert.notEqual(readFileSync(join(d, "e.wav"), "utf8").split("|")[3], pid1, "restarted");
  } finally { sp.kill(); }
});
test("speaker: timeout, cancel (stop) and the idle stop", { skip: !hasPython && "no python3" }, async () => {
  const d = tmp(), sp = speaker({ idleMs: 300 });
  try {
    await assert.rejects(sp.synth({ text: "slow", out: join(d, "a.wav") }, 300), /timed out/);
    const p = sp.synth({ text: "slow", out: join(d, "b.wav") }, 5000);
    sp.cancel();
    await assert.rejects(p, (e) => e.stopped === true);
    await sp.synth({ text: "quick", out: join(d, "c.wav") }, 5000); // still usable after a cancel
    assert.ok(sp.alive);
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(sp.alive, false, "stopped after being idle");
  } finally { sp.kill(); }
});
