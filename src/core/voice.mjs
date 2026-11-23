// AXA's voice: the daemon reads the commander's finished replies aloud. Two engines:
//  - "kokoro": the Kokoro neural voice (kokoro.mjs), once `axa voice install kokoro` has put it in place;
//  - "system": the computer's own voices (macOS `say`, Windows/WSL System.Speech through powershell.exe,
//    Linux spd-say or espeak). Any Kokoro failure falls back to these for that reply.
// Off by default; turned on in the hub's settings (~/.axa/ui.json "voice": "on") or with AXA_VOICE=1.
// ui.json "voiceEngine": "kokoro" | "system"; with no choice, Kokoro is used when it's installed.
// ui.json "voiceMoreHint": false stops the closing "You can read the rest on screen." (default: said).
//
// The text never goes on a command line for the system voices: it's written to a private temp file the speaker
// reads, and removed after. Kokoro gets it over the resident speaker's stdin (the CLI fallback: one argv entry, no shell).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { files, isWsl } from "../paths.mjs";
import * as K from "./kokoro.mjs";
import { pronounce } from "./speech.mjs";
import * as P from "./phonemes.mjs";

const has = (c) => spawnSync("which", [c], { stdio: "ignore" }).status === 0;

// ---------- settings: ~/.axa/ui.json (re-read each time: it's tiny) ----------
export function settings() {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(files.ui, "utf8")); } catch {}
  const env = process.env.AXA_VOICE;
  const on = env === "1" ? true : env === "0" ? false : cfg.voice === "on";
  const rate = Math.max(-2, Math.min(2, Number(cfg.voiceRate) || 0));
  const engineChoice = ["kokoro", "system"].includes(cfg.voiceEngine) ? cfg.voiceEngine : "";
  return { on, name: typeof cfg.voiceName === "string" ? cfg.voiceName : "", rate, forced: env === "1" || env === "0",
    moreHint: cfg.voiceMoreHint !== false, // "You can read the rest on screen." after a shortened reply
    engineChoice, engine: pickEngine(engineChoice, K.state().installed) };
}
// your explicit choice wins (a chosen-but-missing Kokoro still falls back, per reply); no choice: Kokoro if installed
export const pickEngine = (choice, kokoroInstalled) =>
  choice === "system" ? "system" : choice === "kokoro" || kokoroInstalled ? "kokoro" : "system";

// ---------- the backend: picked once ----------
let backend;
export function detect() {
  if (backend !== undefined) return backend;
  if (process.platform === "darwin") backend = has("say") ? { name: "say" } : { name: null, why: "macOS `say` not found" };
  else if (has("powershell.exe") && has("wslpath")) backend = { name: "powershell", wsl: true };
  else if (process.platform === "win32") backend = { name: "powershell", wsl: false };
  else if (has("spd-say")) backend = { name: "spd-say" };
  else if (has("espeak")) backend = { name: "espeak" };
  else backend = { name: null, why: "no speech program found (install speech-dispatcher or espeak)" };
  return backend;
}

// ---------- the command for each backend (pure: unit-tested) ----------
// rate is neutral -2..2; each backend gets its own scale
const psq = (s) => String(s).replace(/'/g, "''");
export function sayArgs({ name = "", rate = 0, file }) {
  return [...(name ? ["-v", name] : []), "-r", String(Math.round(190 + rate * 40)), "-f", file];
}
// Speaks the file's text; stops early if the file disappears (that's how stop() reaches the Windows side)
export function psScript({ name = "", rate = 0, winFile }) {
  const f = psq(winFile);
  return [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    name ? `try { $s.SelectVoice('${psq(name)}') } catch {}` : "",
    `$s.Rate = ${Math.round(rate * 3)}`,
    `$p = $s.SpeakAsync([IO.File]::ReadAllText('${f}', [Text.Encoding]::UTF8))`,
    `while (-not $p.IsCompleted) { if (-not (Test-Path -LiteralPath '${f}')) { $s.SpeakAsyncCancelAll(); break }; Start-Sleep -Milliseconds 150 }`,
  ].filter(Boolean).join("; ");
}
export function command(b, { name, rate, file, winFile }) {
  switch (b.name) {
    case "say": return ["say", sayArgs({ name, rate, file })];
    case "powershell": return [b.wsl ? "powershell.exe" : "powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript({ name, rate, winFile: winFile || file })]];
    case "spd-say": return ["spd-say", [...(name ? ["-y", name] : []), "-r", String(rate * 30), "-w", "-e"]]; // -e: text on stdin
    case "espeak": return ["espeak", [...(name ? ["-v", name] : []), "-s", String(175 + rate * 35), "-f", file]];
    default: return null;
  }
}

// ---------- speak / stop ----------
// `current` is the reply being said: stop() runs every kill it registered (synthesis in flight, playback)
let current = null;
// something is being said now (notifications wait for it rather than cut it off)
export const speaking = () => !!current;
const newJob = () => ({ stopped: false, kills: new Set(), kill() { this.stopped = true; for (const k of this.kills) try { k(); } catch {} this.kills.clear(); } });
export function stop() {
  const c = current;
  current = null;
  if (c) c.kill();
}
const log = (m) => console.log(`[${new Date().toISOString()}] voice: ${m}`);

// Speaks `text` (stopping anything already speaking). Resolves to the exit code, or null if it couldn't start.
export function speak(text, opts = {}) {
  stop();
  const s = { ...settings(), ...opts };
  if (!String(text || "").trim()) return Promise.resolve(null);
  const me = newJob();
  current = me;
  return speakWith(String(text), s, { kokoro: kokoroSpeak, system: systemSpeak, log, job: me })
    .catch(() => null).finally(() => { if (current === me) current = null; });
}

// The engine choice and the fallback (deps injected: unit-tested). A stopped reply never falls back.
export async function speakWith(text, s, { kokoro, system, log = () => {}, job = newJob() }) {
  if (s.engine === "kokoro") {
    try { return await kokoro(text, s, job); } catch (e) {
      if (job.stopped || e.stopped) return null;
      log(`Kokoro failed (${e.message}); using the system voice for this reply`);
    }
  }
  if (job.stopped) return null;
  return system(text, s, job);
}

// The computer's own voice
function systemSpeak(text, s, job) {
  return new Promise((done) => {
    try {
      const b = detect();
      if (!b.name) return done(null);
      const file = join(tmpdir(), `axa-voice-${randomBytes(6).toString("hex")}.txt`);
      writeFileSync(file, String(text), { mode: 0o600, flag: "wx" });
      let winFile;
      if (b.name === "powershell" && b.wsl) winFile = spawnSync("wslpath", ["-w", file], { encoding: "utf8" }).stdout.trim();
      const [cmd, args] = command(b, { name: s.name, rate: s.rate, file, winFile });
      const child = spawn(cmd, args, { stdio: [b.name === "spd-say" ? "pipe" : "ignore", "ignore", "ignore"] });
      if (b.name === "spd-say") { child.stdin.on("error", () => {}); child.stdin.end(String(text)); }
      // removing the file is how the Windows side learns to stop
      const kill = () => { try { unlinkSync(file); } catch {} try { child.kill(); } catch {} if (b.name === "spd-say") spawnSync("spd-say", ["-C"], { stdio: "ignore" }); };
      job.kills.add(kill);
      const end = (code) => { job.kills.delete(kill); try { unlinkSync(file); } catch {} done(code); };
      child.on("error", () => end(null));
      child.on("close", (code) => end(code));
    } catch { done(null); }
  });
}

// ---------- Kokoro: text -> wav (resident speaker, or the CLI) -> play ----------
let speaker = null;
function residentSpeaker(st) {
  if (speaker && (speaker.python !== st.python || speaker.model !== st.model)) { speaker.kill(); speaker = null; }
  return (speaker ||= new K.Speaker({ python: st.python, model: st.model, log }));
}
export const SYNTH_TIMEOUT = 8000;
// Makes the wav for `text`; resolves { out, secs } (secs: time to wav). Exported for timing it by hand.
export async function kokoroWav(text, s, job = newJob(), out = join(tmpdir(), `axa-voice-${randomBytes(6).toString("hex")}.wav`)) {
  const st = K.state();
  if (!st.installed) throw new Error(`Kokoro is ${st.why}`);
  const said = pronounce(text);
  // every word made speakable (Kokoro skips words its lexicon lacks, and all numbers): phonemes.mjs
  let ph = { text: said, chunks: [], oov: [], extra: {} };
  try { ph = P.phonemize(said, P.loadLexicon(join(st.model, "lexicon-us-en.txt"))); } catch (e) { log(`phonemes skipped (${e.message})`); }
  logOov(oovLogFile(st.dir), ph.oov);
  const req = { text: ph.text, extra: ph.extra, phonemes: ph.chunks, sid: K.sidOf(s.name), speed: K.speedOf(s.rate), out };
  const t0 = Date.now();
  if (st.mode === "resident") {
    const sp = residentSpeaker(st), cancel = () => sp.cancel();
    job.kills.add(cancel);
    try { await sp.synth(req, SYNTH_TIMEOUT); } finally { job.kills.delete(cancel); }
  } else {
    // the CLI loads the model for each reply: the missing words go in a second lexicon file
    const extraLexicon = Object.keys(ph.extra).length ? out.replace(/\.wav$/, "") + ".lexicon.txt" : undefined;
    if (extraLexicon) writeFileSync(extraLexicon, P.lexiconText(ph.extra), { mode: 0o600 });
    const p = K.cliSynth({ cli: st.cli, model: st.model, text: ph.text, sid: req.sid, speed: req.speed, out, extraLexicon }, SYNTH_TIMEOUT), kill = () => p.kill();
    job.kills.add(kill);
    try { await p; } finally { job.kills.delete(kill); if (extraLexicon) try { unlinkSync(extraLexicon); } catch {} }
  }
  return { out, secs: (Date.now() - t0) / 1000 };
}
// Out-of-lexicon words, counted for later tuning: <kokoro dir>/oov.json {"word": {"n": 3, "how": "morph"}}.
// AXA_OOV_LOG names another file, or "0" for none. Best effort: a failed write never stops a reply.
export const oovLogFile = (dir, env = process.env.AXA_OOV_LOG) => (env === "0" ? null : env || join(dir, "oov.json"));
export function logOov(file, oov) {
  if (!file || !oov?.length) return;
  let db = {};
  try { db = JSON.parse(readFileSync(file, "utf8")) || {}; } catch {}
  for (const { word, how } of oov) { const k = String(word).toLowerCase(); db[k] = { n: (Number(db[k]?.n) || 0) + 1, how }; }
  const keep = Object.entries(db).sort((a, b) => b[1].n - a[1].n).slice(0, 2000);
  const tmp = `${file}.${process.pid}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep), null, 1) + "\n"); renameSync(tmp, file); } catch { try { unlinkSync(tmp); } catch {} }
}
async function kokoroSpeak(text, s, job) {
  const temp = wslNow() ? windowsTemp() : null; // looked up while the wav is made
  let out;
  try {
    ({ out } = await kokoroWav(text, s, job));
    if (job.stopped) return null;
    return await playWav(out, job, temp && (await temp));
  } finally { if (out) try { unlinkSync(out); } catch {} }
}
const wslNow = () => process.platform === "linux" && isWsl() && has("powershell.exe");

// ---------- playing a wav ----------
// a wav's length in ms from its header (PCM: the "data" chunk's size / bytes per second)
export function wavMs(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return 0;
  let byteRate = 0;
  for (let i = 12; i + 8 <= buf.length;) {
    const id = buf.toString("ascii", i, i + 4), size = buf.readUInt32LE(i + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(i + 16);
    if (id === "data") return byteRate ? Math.round((Math.min(size, buf.length - i - 8) / byteRate) * 1000) : 0;
    i += 8 + size + (size & 1);
  }
  return 0;
}
// C:\Users\me\AppData\Local\Temp\ -> /mnt/c/Users/me/AppData/Local/Temp/ (when wslpath isn't there to ask)
export const winToUnix = (p) => String(p).replace(/^([A-Za-z]):[\\/]?/, (m, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");
// On WSL a wav on the Linux side (\\wsl.localhost\...) doesn't play: it's copied to the Windows temp folder first.
// The copy's two names: `unix` to write it from WSL, `win` for powershell; `flag` is removed to stop playback.
export function wslTempCopy({ winTemp, unixTemp = winToUnix(winTemp), name }) {
  const w = String(winTemp).replace(/[\\/]*$/, "\\"), u = String(unixTemp).replace(/\/*$/, "/");
  return { win: w + name, unix: u + name, winFlag: w + name + ".playing", unixFlag: u + name + ".playing" };
}
let winTempP = null;
function windowsTemp() {
  return (winTempP ||= new Promise((ok) => {
    let o = "";
    const c = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[IO.Path]::GetTempPath()"], { stdio: ["ignore", "pipe", "ignore"] });
    c.stdout.on("data", (d) => (o += d));
    c.on("error", () => ok(null));
    c.on("close", () => {
      const winTemp = o.trim();
      if (!winTemp) return ok(null);
      const r = spawnSync("wslpath", ["-u", winTemp], { encoding: "utf8" });
      ok({ winTemp, unixTemp: r.status === 0 && r.stdout.trim() ? r.stdout.trim() : winToUnix(winTemp) });
    });
  }).then((v) => { if (!v) winTempP = null; return v; }));
}
// Plays the wav, blocking for its length; stops early when the flag file disappears (how stop() reaches Windows)
export function playScript({ winWav, winFlag, ms }) {
  const q = (s) => `'${psq(s)}'`;
  return [
    `$p = New-Object System.Media.SoundPlayer ${q(winWav)}`,
    "$p.Load()",
    "$p.Play()",
    `$end = (Get-Date).AddMilliseconds(${Math.max(0, Math.round(ms)) + 250})`,
    `while ((Get-Date) -lt $end) { if (-not (Test-Path -LiteralPath ${q(winFlag)})) { break }; Start-Sleep -Milliseconds 100 }`,
    "$p.Stop()",
  ].join("; ");
}
function playWav(out, job, temp) {
  return new Promise((done, fail) => {
    const ms = Math.min(5 * 60 * 1000, wavMs(readFileSync(out)) || 60000);
    let cmd, args, cleanup = () => {}, flag = null;
    if (process.platform === "darwin") [cmd, args] = ["afplay", [out]];
    else if (process.platform === "win32" || wslNow()) {
      let winWav = out, winFlag = out + ".playing";
      flag = winFlag;
      if (process.platform !== "win32") {
        if (!temp) return fail(new Error("couldn't find the Windows temp folder"));
        const c = wslTempCopy({ ...temp, name: basename(out) });
        copyFileSync(out, c.unix);
        winWav = c.win; winFlag = c.winFlag; flag = c.unixFlag;
        cleanup = () => { try { unlinkSync(c.unix); } catch {} };
      }
      writeFileSync(flag, "", { mode: 0o600 });
      [cmd, args] = [process.platform === "win32" ? "powershell" : "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", playScript({ winWav, winFlag, ms })]];
    } else if (has("paplay")) [cmd, args] = ["paplay", [out]];
    else if (has("aplay")) [cmd, args] = ["aplay", ["-q", out]];
    else return fail(new Error("no wav player (install pulseaudio-utils or alsa-utils)"));
    const rm = () => { if (flag) try { unlinkSync(flag); } catch {} };
    const child = spawn(cmd, args, { stdio: "ignore" });
    const kill = () => { rm(); try { child.kill(); } catch {} };
    job.kills.add(kill);
    const end = () => { job.kills.delete(kill); rm(); cleanup(); };
    child.on("error", (e) => { end(); fail(e); });
    child.on("close", (code) => { end(); done(code); });
  });
}

// ---------- the voices installed (for the settings picker; best effort, cached) ----------
let voiceList = null;
export function voices() {
  if (voiceList) return Promise.resolve(voiceList);
  const b = detect();
  const run = (cmd, args) => new Promise((ok) => {
    let o = "";
    try {
      const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
      const t = setTimeout(() => { try { c.kill(); } catch {} }, 15000);
      c.stdout.on("data", (d) => (o += d));
      c.on("error", () => { clearTimeout(t); ok(""); });
      c.on("close", () => { clearTimeout(t); ok(o); });
    } catch { ok(""); }
  });
  const parse = {
    say: async () => (await run("say", ["-v", "?"])).split("\n").map((l) => /^(.+?)\s{2,}[a-z]{2,3}[_-]/i.exec(l)?.[1].trim()).filter(Boolean),
    powershell: async () => (await run(b.wsl ? "powershell.exe" : "powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }"]))
      .split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    "spd-say": async () => (await run("spd-say", ["-L"])).split("\n").slice(1).map((l) => l.trim().split(/\s{2,}/)[0]).filter(Boolean),
    espeak: async () => (await run("espeak", ["--voices"])).split("\n").slice(1).map((l) => l.trim().split(/\s+/)[3]).filter(Boolean),
  }[b.name];
  if (!parse) return Promise.resolve([]);
  return parse().then((v) => { if (v.length) voiceList = [...new Set(v)]; return v; }, () => []);
}

// What GET /api/voice answers. `voices` are the current engine's; `backend` is "kokoro" or the system backend.
export async function info() {
  const b = detect(), s = settings(), k = K.state();
  const kokoro = s.engine === "kokoro";
  return {
    on: s.on && (kokoro || !!b.name), setting: s.on ? "on" : "off", forced: s.forced,
    engine: s.engine, engineChoice: s.engineChoice, installed: k.installed,
    kokoro: { installed: k.installed, mode: k.mode || null, why: k.why || null, dir: k.dir, lastTest: K.lastTest(k.dir), voices: K.VOICES, defaultVoice: K.DEFAULT_VOICE },
    backend: kokoro ? "kokoro" : b.name, system: b.name, why: kokoro ? undefined : b.why, name: s.name, rate: s.rate,
    voices: kokoro ? K.VOICES : b.name ? await voices() : [],
  };
}

// ---------- a reply, made speakable: the pure normalizer and the pronunciation map live in speech.mjs ----------
export { PRONOUNCE, pronounce, toSpeech } from "./speech.mjs";
