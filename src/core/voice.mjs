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
import { earconFile } from "./earcons.mjs";
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
  const installed = K.state().installed;
  return { on, name: typeof cfg.voiceName === "string" ? cfg.voiceName : "", rate, forced: env === "1" || env === "0",
    moreHint: cfg.voiceMoreHint !== false, // "You can read the rest on screen." after a shortened reply
    // earcons (earcons.mjs): a tone before a line, or alone for routine things; "voiceEarcons": "off" stops them
    earcons: cfg.voiceEarcons !== "off",
    // "voicePerProject": "on": each project's lines in its own Kokoro voice (attention.voiceFor); default off
    perProject: cfg.voicePerProject === "on",
    // how much is said (narrator.mjs): "quiet" (only what needs you) | "normal" (default) | "chatty" (all progress)
    verbosity: VERBOSITY.includes(cfg.voiceVerbosity) ? cfg.voiceVerbosity : "normal",
    // quiet hours ("22:00-07:00"): nothing is said; what needs you becomes a desktop toast. Default off.
    quiet: /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(cfg.voiceQuiet || "") ? cfg.voiceQuiet : null,
    engineChoice, engine: pickEngine(engineChoice, installed),
    // ui.json "voiceFallback": what speaks when Kokoro can't start at all: "system" or "silent" (default: silent
    // when Kokoro is installed, the system voice when it isn't). Never used for a slow sentence.
    fallback: ["system", "silent"].includes(cfg.voiceFallback) ? cfg.voiceFallback : installed ? "silent" : "system" };
}
export const VERBOSITY = ["quiet", "normal", "chatty"];
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

// THE gate: every voice path (commander replies, notifications, the daily brief, summaries, any demo or helper)
// speaks through speak(), which says nothing while the voice is off. Only the settings screen's explicit voice
// test passes { force: true } to speak while off.
export const maySpeak = (on, force) => on === true || force === true;
// Muted while something speaks (the toggle, or ui.json edited): stops it, unless it's that forced voice test
export function silenceIfMuted() {
  if (current && !current.forced && !settings().on) { stop(); return true; }
  return false;
}
// Speaks `text` (stopping anything already speaking). Resolves to the exit code, or null if it couldn't start
// (or the voice is off).
export function speak(text, opts = {}) {
  const { force, ...rest } = opts;
  if (!maySpeak(settings().on, force)) return Promise.resolve(null);
  stop();
  const s = { ...settings(), ...rest };
  if (!String(text || "").trim()) return Promise.resolve(null);
  const me = newJob();
  me.forced = force === true;
  // between(): asked between sentences, true = stop there (the narrator: a P0 is waiting, or this went stale);
  // onStart(what): when the first audio starts ("sound") and the first words ("words"), once each (time to
  // first audio); intro: an earcon's WAV, played while the first sentence is being made
  me.between = typeof rest.between === "function" ? rest.between : null;
  me.onStart = typeof rest.onStart === "function" ? rest.onStart : null;
  me.intro = rest.intro || null;
  me.onHeard = typeof rest.onHeard === "function" ? rest.onHeard : null;
  current = me;
  return speakWith(String(text), s, { kokoro: kokoroSpeak, system: systemSpeak, log, job: me })
    .catch(() => null).finally(() => { if (current === me) current = null; });
}

// An earcon alone (a routine event: no words). Never over speech, never while the voice is off or earcons are.
export async function playEarcon(name) {
  const s = settings();
  if (!maySpeak(s.on) || !s.earcons || current) return null;
  const f = earconFile(name);
  if (!f) return null;
  const me = newJob();
  current = me;
  try {
    const temp = process.platform !== "win32" && wslNow() ? windowsTemp() : null;
    const p = await wavPlayer(me, temp);
    try { return await p.play(f); } finally { p.close(); }
  } catch (e) { log(`earcon ${name} not played (${e.message})`); return null; } finally { if (current === me) current = null; }
}

// The engine choice and the fallback (deps injected: unit-tested). One reply, one voice: with Kokoro as the
// engine, a slow or failed sentence is retried, then skipped (kokoroSpeak), never handed to another voice. The
// system voice speaks only when Kokoro can't start at all (not installed, its speaker won't run: e.cantStart)
// and s.fallback is "system". A stopped reply never falls back.
export async function speakWith(text, s, { kokoro, system, log = () => {}, job = newJob() }) {
  if (s.engine === "kokoro") {
    try { return await kokoro(text, s, job); } catch (e) {
      if (job.stopped || e.stopped) return null;
      if (!e.cantStart || s.fallback !== "system") { log(`Kokoro failed (${e.message}); ${e.cantStart ? "voiceFallback is silent: nothing said" : "the rest of this reply is skipped (no other voice)"}`); return null; }
      log(`Kokoro can't start (${e.message}); using the system voice for this reply`);
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
      // no sentences to wait for here: asked to yield (a P0 is waiting), it stops where it is
      const poll = job.between ? setInterval(() => { if (job.between()) kill(); }, 250) : null;
      try { job.onStart?.("sound"); job.onStart?.("words"); } catch {}
      const end = (code) => { if (poll) clearInterval(poll); job.kills.delete(kill); try { unlinkSync(file); } catch {} done(code); };
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
// ---------- Kokoro, sentence by sentence ----------
// A long reply is cut into chunks of whole sentences (about CHUNK chars; a longer sentence is cut at a comma or
// a space). Chunk 1 plays while chunk 2 is made, so the voice starts in about a second and no single synthesis
// is long. Each chunk gets its own timeout, scaled to its length.
export const CHUNK = 200;
// the first chunk is its first sentence alone (it's what you wait for, and its end is the first point where a
// P0 can cut in); only a very short one ("Done.", under FIRST_ALONE characters) takes the next with it, up to
// FIRST_CHUNK in all
export const FIRST_CHUNK = 80, FIRST_ALONE = 25;
export function chunkText(text, max = CHUNK, first = max) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const sentences = t.match(/[^.!?]+(?:[.!?]+["')\]]*|$)(?=\s|$)/g)?.map((x) => x.trim()).filter(Boolean) || [t];
  const parts = [];
  for (let s of sentences) {
    // a sentence too long for one chunk: cut at the last comma (else space) before the limit
    while (s.length > max * 1.5) {
      const head = s.slice(0, max);
      const at = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; ")) > max / 3 ? Math.max(head.lastIndexOf(", "), head.lastIndexOf("; ")) + 1 : head.lastIndexOf(" ") > max / 3 ? head.lastIndexOf(" ") : max;
      parts.push(s.slice(0, at).trim()); s = s.slice(at).trim();
    }
    parts.push(s);
  }
  const out = [];
  for (const p of parts) {
    if (out.length && out[out.length - 1].length + 1 + p.length <= (out.length === 1 ? (first < max && out[0].length >= FIRST_ALONE ? 0 : first) : max)) out[out.length - 1] += " " + p;
    else out.push(p);
  }
  return out;
}
export const chunkTimeout = (chunk, cli = false) => 4000 + 40 * String(chunk).length + (cli ? 8000 : 0); // (the CLI loads the model each time)

// The queue, deps injected (unit-tested with a fake synth and player):
//   synth(chunk, i, timeoutMs) -> Promise<{ out }> (rejects with { timedOut } or other errors)
//   play({ out }, i) -> Promise (resolves when that chunk has been heard)
// Chunk i+1 is made while chunk i plays. A chunk that fails is tried once more, then skipped with a log line.
// job.stopped (Esc, mute) ends it: nothing more is made or played. Resolves to the number of chunks played.
// between() (optional) is asked after each sentence: true stops there, cleanly (nothing is cut mid-word).
// intro (optional): a WAV played first, while the first sentence is being made (an earcon). onStart(what) is
// called as the first sound plays ("sound") and as the first words play ("words").
// onHeard(i): sentence chunk i has been played in full (the narrator keeps what was heard, never replays it).
export async function speakChunks(chunks, { synth, play, log = () => {}, job = newJob(), timeoutOf = chunkTimeout, cleanup = () => {}, between = null, onStart = null, intro = null, onHeard = null }) {
  const make = async (i) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (job.stopped) return null;
      try { return await synth(chunks[i], i, timeoutOf(chunks[i])); } catch (e) {
        if (job.stopped || e.stopped) return null;
        if (e.cantStart && i === 0) throw e; // nothing said yet and Kokoro won't run at all
        log(attempt === 0 ? `Kokoro: sentence ${i + 1}/${chunks.length} failed (${e.message}); trying it once more` : `Kokoro: sentence ${i + 1}/${chunks.length} failed again (${e.message}); skipped`);
      }
    }
    return null;
  };
  let played = 0, next = chunks.length ? make(0) : null, sound = false;
  const started = (what) => { if (what === "words" && !sound) started("sound"); if (what === "sound") sound = true; try { onStart?.(what); } catch {} };
  if (intro && next && !job.stopped) { started("sound"); try { await play({ out: intro }, -1); } catch {} }
  for (let i = 0; i < chunks.length; i++) {
    const wav = await next;
    if (job.stopped) { if (wav) cleanup(wav); return played; }
    next = i + 1 < chunks.length ? make(i + 1) : null;
    if (!wav) continue;
    if (!played && onStart) { started("words"); onStart = null; }
    try { await play(wav, i); if (!job.stopped) { played++; try { onHeard?.(i); } catch {} } } catch (e) { if (job.stopped) { cleanup(wav); return played; } log(`Kokoro: couldn't play sentence ${i + 1} (${e.message})`); }
    cleanup(wav);
    if (job.stopped) { const w = await next?.catch(() => null); if (w) cleanup(w); return played; }
    // a sentence boundary: give way if asked (the rest isn't made or played)
    let yieldNow = false;
    if (next && between) { try { yieldNow = !!between(); } catch {} }
    if (yieldNow) { job.yielded = true; const w = await next.catch(() => null); if (w) cleanup(w); return played; }
  }
  return played;
}

// Can't start at all: not installed, or the speaker process won't run (marked so speakWith may fall back)
const cantStart = (e) => Object.assign(e instanceof Error ? e : new Error(String(e)), { cantStart: true });
async function kokoroSpeak(text, s, job) {
  const st = K.state();
  if (!st.installed) throw cantStart(new Error(`Kokoro is ${st.why}`));
  const temp = wslNow() ? windowsTemp() : null; // looked up while the first chunk is made
  let lexicon = null;
  try { lexicon = P.loadLexicon(join(st.model, "lexicon-us-en.txt")); } catch (e) { log(`phonemes skipped (${e.message})`); }
  // each chunk made speakable (every word: phonemes.mjs), and the reply's new words loaded once, up front
  // chunked on the text as given (so "heard" is an exact prefix of it), each chunk then made speakable
  const chunks = chunkText(text, CHUNK, FIRST_CHUNK).map((c) => pronounce(c)).map((c) => { try { return lexicon ? P.phonemize(c, lexicon) : { text: c, chunks: [], oov: [], extra: {} }; } catch { return { text: c, chunks: [], oov: [], extra: {} }; } });
  logOov(oovLogFile(st.dir), chunks.flatMap((c) => c.oov));
  const words = Object.assign({}, ...chunks.map((c) => c.extra));
  const sid = K.sidOf(s.name), speed = K.speedOf(s.rate);
  let synth, preloaded = false, extraLexicon = null;
  if (st.mode === "resident") {
    const sp = residentSpeaker(st);
    if (Object.keys(words).length) {
      const cancel = () => sp.cancel();
      job.kills.add(cancel);
      try { const r = await sp.preload(words); preloaded = true; if (r.preloaded) log(`kokoro: ${r.preloaded} new words loaded in ${r.load}s`); }
      catch (e) { if (job.stopped || e.stopped) return null; if (/couldn't reach|stopped \(/.test(e.message)) throw cantStart(e); log(`kokoro: new words not preloaded (${e.message}); said from their phonemes`); }
      finally { job.kills.delete(cancel); }
    } else preloaded = true;
    synth = async (c, i, ms) => {
      const out = join(tmpdir(), `axa-voice-${randomBytes(6).toString("hex")}.wav`), cancel = () => sp.cancel();
      job.kills.add(cancel);
      try {
        // words already loaded: plain text; otherwise this chunk's own phonemes (nothing dropped)
        await sp.synth({ text: c.text, ...(preloaded ? {} : { extra: c.extra, phonemes: c.chunks }), sid, speed, out }, ms);
        return { out };
      } catch (e) { if (i === 0 && /couldn't reach|speaker stopped/.test(e.message) && !sp.alive) throw cantStart(e); throw e; }
      finally { job.kills.delete(cancel); }
    };
  } else {
    // the CLI loads the model per process: one extra lexicon file for the whole reply
    if (Object.keys(words).length) { extraLexicon = join(tmpdir(), `axa-voice-${randomBytes(6).toString("hex")}.lexicon.txt`); writeFileSync(extraLexicon, P.lexiconText(words), { mode: 0o600 }); }
    synth = async (c, i, ms) => {
      const out = join(tmpdir(), `axa-voice-${randomBytes(6).toString("hex")}.wav`);
      const p = K.cliSynth({ cli: st.cli, model: st.model, text: c.text, sid, speed, out, extraLexicon }, ms), kill = () => p.kill();
      job.kills.add(kill);
      try { await p; return { out }; } catch (e) { if (i === 0 && e.code === "ENOENT") throw cantStart(e); throw e; } finally { job.kills.delete(kill); }
    };
  }
  const player = await wavPlayer(job, temp);
  try {
    return await speakChunks(chunks, { synth, play: (w) => player.play(w.out), log, job, timeoutOf: (c) => chunkTimeout(c.text, st.mode !== "resident"), cleanup: (w) => { try { unlinkSync(w.out); } catch {} }, between: job.between, onStart: job.onStart, intro: job.intro, onHeard: job.onHeard });
  } finally {
    player.close();
    if (extraLexicon) try { unlinkSync(extraLexicon); } catch {}
  }
}

// ---------- one player per reply ----------
// On Windows/WSL a single PowerShell plays the reply's wavs one after another (starting PowerShell for each
// sentence would leave gaps); elsewhere each wav gets the platform's player. play(out) resolves once heard.
async function wavPlayer(job, temp) {
  if (!(process.platform === "win32" || wslNow())) return { play: (out) => playWav(out, job, null), close() {} };
  const t = process.platform === "win32" ? null : await temp;
  if (process.platform !== "win32" && !t) throw new Error("couldn't find the Windows temp folder");
  const lp = linePlayer(() => spawn(process.platform === "win32" ? "powershell" : "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", residentPlayScript()], { stdio: ["pipe", "pipe", "ignore"] }), job);
  const flags = new Set(), copies = new Set();
  const rmAll = () => { for (const f of [...flags, ...copies]) try { unlinkSync(f); } catch {} flags.clear(); copies.clear(); };
  // stopping: the flag files go (the Windows side stops at once), then the player ends
  const kill = () => { rmAll(); lp.kill(); };
  job.kills.add(kill);
  return {
    play(out) {
      const ms = Math.min(5 * 60 * 1000, wavMs(readFileSync(out)) || 60000);
      let winWav = out, winFlag = out + ".playing", flag = winFlag, copy = null;
      if (process.platform !== "win32") {
        const c = wslTempCopy({ ...t, name: basename(out) });
        copyFileSync(out, c.unix); copy = c.unix; copies.add(copy);
        winWav = c.win; winFlag = c.winFlag; flag = c.unixFlag;
      }
      writeFileSync(flag, "", { mode: 0o600 }); flags.add(flag);
      return lp.send(`${winWav}|${winFlag}|${Math.round(ms)}\n`)
        .finally(() => { try { unlinkSync(flag); } catch {} flags.delete(flag); if (copy) { try { unlinkSync(copy); } catch {} copies.delete(copy); } });
    },
    close() { job.kills.delete(kill); lp.close(); rmAll(); },
  };
}
// The resident player's line protocol (spawnChild injected: tested with a fake child). send(line) writes one
// "wav|flag|ms" line and resolves on its "done". Every play settles: a child that exited (between chunks or
// during one), errored, or whose stdin write failed rejects at once; the next send starts a new child (at most
// RESPAWNS times per reply), so a dead PowerShell never leaves the queue hanging.
export const RESPAWNS = 2;
export function linePlayer(spawnChild, job) {
  let child = null, buf = "", waiting = null, spawned = 0;
  const fail = (c, why) => {
    if (c && child !== c) return;
    child = null;
    const w = waiting; waiting = null;
    w?.reject(Object.assign(new Error(job.stopped ? "stopped" : why), { stopped: job.stopped }));
  };
  const alive = (c) => !!c && c.exitCode == null && c.signalCode == null && !c.killed && c.stdin?.writable !== false && !c.stdin?.destroyed;
  const start = () => {
    const c = spawnChild();
    child = c; buf = ""; spawned++;
    c.stdin?.on?.("error", () => fail(c, "the player's input closed"));
    c.stdout?.on?.("data", (d) => { if (child !== c) return; buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { buf = buf.slice(i + 1); const w = waiting; waiting = null; w?.resolve(); } });
    c.on?.("close", () => fail(c, "the player stopped"));
    c.on?.("error", (e) => fail(c, `the player failed: ${e?.message || e}`));
    return c;
  };
  return {
    send(line) {
      if (job.stopped) return Promise.reject(Object.assign(new Error("stopped"), { stopped: true }));
      if (!alive(child)) {
        if (spawned > RESPAWNS) return Promise.reject(new Error("the player keeps stopping"));
        start();
      }
      const c = child;
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        try { c.stdin.write(line, (err) => { if (err) fail(c, `couldn't reach the player (${err.message})`); }); }
        catch (e) { fail(c, `couldn't reach the player (${e.message})`); }
      });
    },
    get alive() { return alive(child); },
    close() { try { child?.stdin.end(); } catch {} },
    kill() { const c = child; try { c?.stdin.end(); } catch {} setTimeout(() => { try { c?.kill(); } catch {} }, 1500).unref?.(); fail(c, "stopped"); },
  };
}
// Reads "wav|flag|ms" lines; plays each to its end (or until its flag file disappears); answers "done" per line
export function residentPlayScript() {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "while ($true) {",
    "  $l = [Console]::In.ReadLine(); if ($l -eq $null -or $l -eq '') { break }",
    "  $w, $f, $ms = $l.Split('|')",
    "  $p = New-Object System.Media.SoundPlayer $w; $p.Load(); $p.Play()",
    "  $end = (Get-Date).AddMilliseconds([int]$ms + 150)",
    "  while ((Get-Date) -lt $end) { if (-not (Test-Path -LiteralPath $f)) { break }; Start-Sleep -Milliseconds 50 }",
    "  $p.Stop(); [Console]::Out.WriteLine('done'); [Console]::Out.Flush()",
    "}",
  ].join("\n");
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
