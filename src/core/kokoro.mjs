// Kokoro: an offline neural voice (Apache-2.0, ~380 MB) run through sherpa-onnx, installed by
// `axa voice install kokoro` into <AXA home>/voices/kokoro/ (AXA_KOKORO_DIR overrides):
//   model/kokoro-multi-lang-v1_0/   the model (model.onnx, voices.bin, tokens.txt, lexicon-us-en.txt)
//   venv/                           a Python venv with sherpa-onnx (preferred: the model stays loaded)
//   bin/sherpa-onnx-*/bin/          or the prebuilt CLI (slower: loads the model on every reply)
// The resident speaker (voice-kokoro.py) loads the model once and answers JSON lines; it's started on the first
// reply, restarted if it dies, and stopped after 10 minutes idle.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { home, srcDir } from "../paths.mjs";

export const MODEL = "kokoro-multi-lang-v1_0";
export const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${MODEL}.tar.bz2`;
export const SHERPA_VERSION = "2.0.2";
// speaker ids 0-27 of kokoro v1.0 are the English voices (a = American, b = British; f/m = female/male)
export const VOICES = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];
export const DEFAULT_VOICE = "af_heart";
export const SCRIPT = join(srcDir, "core", "voice-kokoro.py");
export const THREADS = 4;

export const kokoroDir = () => process.env.AXA_KOKORO_DIR || join(home, "voices", "kokoro");

// ---------- pure helpers (unit-tested) ----------
export const sidOf = (name) => { const i = VOICES.indexOf(name); return i < 0 ? VOICES.indexOf(DEFAULT_VOICE) : i; };
// AXA's neutral rate -2..2 -> Kokoro's speed (CLI: --kokoro-length-scale = 1 / speed)
export const speedOf = (rate = 0) => Math.round((1 + Math.max(-2, Math.min(2, Number(rate) || 0)) * 0.15) * 100) / 100;
// extraLexicon: a second lexicon file (the reply's out-of-lexicon words), read before the model's own
export function cliArgs({ model, sid, speed = 1, out, text, threads = THREADS, extraLexicon }) {
  return [
    `--kokoro-model=${join(model, "model.onnx")}`, `--kokoro-voices=${join(model, "voices.bin")}`,
    `--kokoro-tokens=${join(model, "tokens.txt")}`, `--kokoro-lexicon=${extraLexicon ? extraLexicon + "," : ""}${join(model, "lexicon-us-en.txt")}`,
    `--kokoro-length-scale=${Math.round((1 / speed) * 1000) / 1000}`,
    `--num-threads=${threads}`, `--sid=${sid}`, `--output-filename=${out}`, text,
  ];
}

// ---------- what's installed ----------
const MODEL_FILES = ["model.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt"];
export function layout(dir = kokoroDir()) {
  const win = process.platform === "win32";
  const model = [join(dir, "model", MODEL), join(dir, "model")].find((m) => MODEL_FILES.every((f) => existsSync(join(m, f)))) || null;
  const py = join(dir, "venv", win ? "Scripts" : "bin", win ? "python.exe" : "python");
  const exe = win ? "sherpa-onnx-offline-tts.exe" : "sherpa-onnx-offline-tts";
  let cli = [join(dir, "bin", exe)].find(existsSync) || null;
  if (!cli) try {
    for (const d of readdirSync(join(dir, "bin"))) if (existsSync(join(dir, "bin", d, "bin", exe))) { cli = join(dir, "bin", d, "bin", exe); break; }
  } catch {}
  return { dir, model, python: existsSync(py) ? py : null, cli };
}
// { installed, mode: "resident" | "cli", why } — cheap (a few stats), checked on every reply
export function state(dir = kokoroDir()) {
  const l = layout(dir);
  if (!l.model) return { ...l, installed: false, why: "not installed: run axa voice install kokoro" };
  if (!l.python && !l.cli) return { ...l, installed: false, why: "the model is there but sherpa-onnx isn't: run axa voice install kokoro" };
  return { ...l, installed: true, mode: l.python ? "resident" : "cli" };
}
export function lastTest(dir = kokoroDir()) {
  try { return JSON.parse(readFileSync(join(dir, "status.json"), "utf8")); } catch { return null; }
}

// ---------- the resident speaker ----------
// One Python process that keeps the model loaded. synth() resolves { out, secs } when the wav is written.
// Requests go one at a time (the speaker is single-threaded); cancel() drops the one in flight.
export class Speaker {
  constructor({ python, model, script = SCRIPT, threads = THREADS, idleMs = 10 * 60 * 1000, spawnFn = spawn, log = () => {} }) {
    Object.assign(this, { python, model, script, threads, idleMs, spawnFn, log });
    this.child = null; this.pending = new Map(); this.seq = 0; this.idle = null; this.buf = "";
  }
  get alive() { return !!this.child; }
  start() {
    if (this.child) return this.child;
    const c = this.spawnFn(this.python, ["-I", this.script, "--model", this.model, "--threads", String(this.threads)], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = c; this.buf = "";
    let err = "";
    c.stdout.setEncoding?.("utf8");
    c.stdout.on("data", (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) { const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); this.onLine(l); }
    });
    c.stderr?.on("data", (d) => { err = (err + d).slice(-2000); });
    c.stdin.on("error", () => {});
    const gone = (why) => {
      if (this.child !== c) return;
      this.child = null; clearTimeout(this.idle);
      const msg = `the Kokoro speaker stopped (${why})${err.trim() ? ": " + err.trim().split("\n").pop() : ""}`;
      for (const p of this.pending.values()) p.reject(new Error(msg));
      this.pending.clear();
    };
    c.on("error", (e) => gone(e.message));
    c.on("exit", (code, sig) => gone(sig || `exit ${code}`));
    return c;
  }
  onLine(l) {
    let m; try { m = JSON.parse(l); } catch { return; }
    if (m.ready) { this.log(`kokoro speaker ready (model loaded in ${m.load}s)`); return; }
    if (m.lexicon !== undefined) { this.log(m.error ? `kokoro extra lexicon failed: ${m.error}` : `kokoro extra lexicon: ${m.lexicon} words (loaded in ${m.load}s)`); return; }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m.preloaded !== undefined ? { preloaded: m.preloaded, load: m.load } : { out: m.out, secs: m.secs, audio: m.audio }); else p.reject(new Error(m.error || "synthesis failed"));
  }
  synth({ text, phonemes, extra, sid = 3, speed = 1, out }, timeoutMs = 8000) {
    clearTimeout(this.idle);
    this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { if (this.pending.delete(id)) { this.send({ cancel: id }); this.armIdle(); reject(new Error(`timed out after ${timeoutMs / 1000}s`)); } }, timeoutMs);
      const fin = (f) => (v) => { clearTimeout(t); this.armIdle(); f(v); };
      this.pending.set(id, { resolve: fin(resolve), reject: fin(reject) });
      if (!this.send({ id, text, ...(extra && Object.keys(extra).length ? { extra, phonemes } : {}), sid, speed, out }) && this.pending.delete(id)) fin(reject)(new Error("couldn't reach the Kokoro speaker"));
    });
  }
  // Loads a reply's out-of-lexicon words ({ word: phonemes }) before its first sentence; resolves
  // { preloaded, load }. Its own (generous) timeout: a model reload never counts against a sentence's.
  preload(words, timeoutMs = 30_000) {
    clearTimeout(this.idle);
    this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { if (this.pending.delete(id)) { this.armIdle(); reject(new Error(`loading new words timed out after ${timeoutMs / 1000}s`)); } }, timeoutMs);
      const fin = (f) => (v) => { clearTimeout(t); this.armIdle(); f(v); };
      this.pending.set(id, { resolve: fin(resolve), reject: fin(reject) });
      if (!this.send({ id, preload: words }) && this.pending.delete(id)) fin(reject)(new Error("couldn't reach the Kokoro speaker"));
    });
  }
  send(o) { try { return this.child ? (this.child.stdin.write(JSON.stringify(o) + "\n"), true) : false; } catch { return false; } }
  // drop whatever's in flight (its wav is never played); the model stays loaded
  cancel() {
    for (const [id, p] of this.pending) { this.send({ cancel: id }); p.reject(Object.assign(new Error("stopped"), { stopped: true })); }
    this.pending.clear();
  }
  armIdle() {
    clearTimeout(this.idle);
    if (this.pending.size) return;
    this.idle = setTimeout(() => { this.log("kokoro speaker idle for 10 minutes: stopping it"); this.kill(); }, this.idleMs);
    this.idle.unref?.();
  }
  kill() { const c = this.child; if (c) { try { c.stdin.end(); } catch {} try { c.kill(); } catch {} } }
}

// ---------- the CLI, one process per reply (no venv) ----------
export function cliSynth({ cli, model, text, sid, speed, out, extraLexicon }, timeoutMs = 15000, spawnFn = spawn) {
  let child;
  const p = new Promise((resolve, reject) => {
    const t0 = Date.now();
    child = spawnFn(cli, cliArgs({ model, sid, speed, out, text, extraLexicon }), { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => { err = (err + d).slice(-2000); });
    const t = setTimeout(() => { try { child.kill(); } catch {} reject(new Error(`timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(t); reject(e); });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code === 0 && existsSync(out)) resolve({ out, secs: (Date.now() - t0) / 1000 });
      else reject(new Error(`sherpa-onnx-offline-tts failed (exit ${code})${err.trim() ? ": " + err.trim().split("\n").pop() : ""}`));
    });
  });
  p.kill = () => { try { child?.kill(); } catch {} };
  return p;
}
