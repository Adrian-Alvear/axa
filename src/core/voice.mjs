// AXA's voice: the daemon reads the commander's finished replies aloud with the computer's own voices
// (macOS `say`, Windows/WSL System.Speech through powershell.exe, Linux spd-say or espeak). Off by default;
// turned on in the hub's settings (~/.axa/ui.json "voice": "on") or with AXA_VOICE=1.
//
// The text never goes on a command line: it's written to a private temp file the speaker reads, and removed after.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { files } from "../paths.mjs";

const has = (c) => spawnSync("which", [c], { stdio: "ignore" }).status === 0;

// ---------- settings: ~/.axa/ui.json (re-read each time: it's tiny) ----------
export function settings() {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(files.ui, "utf8")); } catch {}
  const env = process.env.AXA_VOICE;
  const on = env === "1" ? true : env === "0" ? false : cfg.voice === "on";
  const rate = Math.max(-2, Math.min(2, Number(cfg.voiceRate) || 0));
  return { on, name: typeof cfg.voiceName === "string" ? cfg.voiceName : "", rate, forced: env === "1" || env === "0" };
}

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
let current = null; // { child, file }
export function stop() {
  const c = current;
  current = null;
  if (!c) return;
  try { unlinkSync(c.file); } catch {}
  try { c.child.kill(); } catch {}
  if (c.cancel) try { c.cancel(); } catch {}
}

// Speaks `text` (stopping anything already speaking). Resolves to the exit code, or null if it couldn't start.
export function speak(text, opts = {}) {
  return new Promise((done) => {
    try {
      stop();
      const b = detect(), s = { ...settings(), ...opts };
      if (!b.name || !String(text || "").trim()) return done(null);
      const file = join(tmpdir(), `axa-voice-${randomBytes(6).toString("hex")}.txt`);
      writeFileSync(file, String(text), { mode: 0o600, flag: "wx" });
      let winFile;
      if (b.name === "powershell" && b.wsl) winFile = spawnSync("wslpath", ["-w", file], { encoding: "utf8" }).stdout.trim();
      const [cmd, args] = command(b, { name: s.name, rate: s.rate, file, winFile });
      const child = spawn(cmd, args, { stdio: [b.name === "spd-say" ? "pipe" : "ignore", "ignore", "ignore"] });
      if (b.name === "spd-say") { child.stdin.on("error", () => {}); child.stdin.end(String(text)); }
      const me = { child, file, cancel: b.name === "spd-say" ? () => spawnSync("spd-say", ["-C"], { stdio: "ignore" }) : null };
      current = me;
      const end = (code) => { try { unlinkSync(file); } catch {} if (current === me) current = null; done(code); };
      child.on("error", () => end(null));
      child.on("close", (code) => end(code));
    } catch { done(null); }
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

// What GET /api/voice answers
export async function info() {
  const b = detect(), s = settings();
  return { on: s.on && !!b.name, setting: s.on ? "on" : "off", forced: s.forced, backend: b.name, why: b.why, name: s.name, rate: s.rate, voices: b.name ? await voices() : [] };
}

// ---------- a reply, made speakable ----------
const SHORT = 350;
export function toSpeech(md) {
  let t = String(md || "").replace(/\r\n?/g, "\n");
  let saidCode = false, saidTable = false;
  const mark = (kind) => {
    if (kind === "code") { if (saidCode) return "\n\n"; saidCode = true; return "\n\nThere's code on screen.\n\n"; }
    if (saidTable) return "\n\n"; saidTable = true; return "\n\nThere's a table on screen.\n\n";
  };
  // fenced code blocks (an unclosed one runs to the end)
  t = t.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?(?:^\s*\1[^\n]*$|(?![\s\S]))/gm, () => mark("code"));
  // tables: two or more lines of | cells |
  t = t.replace(/(?:^[ \t]*\|.*\|[ \t]*(?:\n|$)){2,}/gm, () => mark("table"));
  const lines = t.split("\n").map((l) => {
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) return ""; // a rule
    let x = l.replace(/^\s*>+\s?/, "");
    const heading = /^\s*#{1,6}\s+/.test(x), bullet = /^\s*(?:[-*+•]|\d+[.)])\s+/.test(x);
    x = x.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "");
    x = inline(x).trim();
    // headings and bullets become sentences
    if ((heading || bullet) && x && !/[.!?:;]$/.test(x)) x += ".";
    return x;
  });
  const paras = lines.join("\n").split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim()).filter((p) => p && /[\p{L}\p{N}]/u.test(p));
  if (!paras.length) return "";
  // the short version: the first paragraph (with the next ones while it's still very short), cut at a sentence
  let said = "", used = 0;
  while (used < paras.length && said.length < 40) said = (said ? said + " " : "") + paras[used++];
  let cut = used < paras.length;
  if (said.length > SHORT) {
    const head = said.slice(0, SHORT + 1);
    const end = Math.max(...[". ", "! ", "? "].map((p) => head.lastIndexOf(p)));
    said = end > 40 ? head.slice(0, end + 1) : head.slice(0, head.lastIndexOf(" ")).replace(/[,;:\s-]+$/, "") + ".";
    cut = true;
  }
  return (cut ? `${said} The details are on screen.` : said).trim();
}

function inline(x) {
  return x
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images -> their alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> their text
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/\bhttps?:\/\/[^\s)>\]]+/g, "a link")
    .replace(/\bwww\.[^\s)>\]]+\.[a-z]{2,}[^\s)>\]]*/gi, "a link")
    .replace(/`+([^`]*)`+/g, "$1") // inline code -> its text
    .replace(/(?:\*\*|__)(.+?)(?:\*\*|__)/g, "$1")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "") // stray html tags
    // file paths: /abs/path, ~/x, ./x, C:\x, src/dir/file.ext (with an optional :line)
    .replace(/(?:[A-Za-z]:\\[^\s,;)]+|(?:~|\.{1,2})?\/(?:[\w.@-]+\/)+[\w.@-]*|(?:~|\.{1,2})\/[\w.@-]+|\b[\w.-]+\/(?:[\w.@-]+\/)*[\w@-]+\.\w+)(?<!\.)(?::\d+(?::\d+)?)?/g, "a file path")
    .replace(/\ba file path(?:(?:,\s*|\s+and\s+|\s+)a file path)+/g, "some file paths")
    .replace(/\s*(?:→|->|=>)\s*/g, " to ")
    .replace(/[*#|`]/g, " ");
}
