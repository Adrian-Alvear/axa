// Earcons: short tones the voice plays before (or instead of) words, so you know what happened before the
// first word is ready: a rising chime when work finished, two beeps when something needs you, a falling
// tone when something failed. Generated here as 16-bit mono WAVs (no downloaded audio), written to the temp
// folder once when the speaker first needs them. ui.json "voiceEarcons": "off" turns them off (default on).
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// [frequency Hz (0: silence), seconds]
export const EARCONS = {
  done: [[660, 0.09], [990, 0.16]],
  attention: [[880, 0.11], [0, 0.06], [880, 0.11]],
  failed: [[523, 0.14], [392, 0.24]],
};

// notes -> a WAV file's bytes (each note fades in and out over 8 ms: no clicks)
export function toneWav(notes, { rate = 22050, volume = 0.3 } = {}) {
  const n = notes.reduce((a, [, s]) => a + Math.round(s * rate), 0);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  let i = 0;
  const fade = Math.round(0.008 * rate);
  for (const [f, secs] of notes) {
    const len = Math.round(secs * rate);
    for (let k = 0; k < len; k++, i++) {
      const env = Math.min(1, k / fade, (len - 1 - k) / fade);
      const v = f ? Math.sin((2 * Math.PI * f * k) / rate) * volume * Math.max(0, env) : 0;
      buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
    }
  }
  return buf;
}

// which earcon goes with a line: failed > needs you > finished (nothing for progress)
export function earconFor(items) {
  if (items.some((i) => ["failed", "limited", "exited"].includes(i.kind))) return "failed";
  if (items.some((i) => i.priority === 0)) return "attention";
  if (items.some((i) => ["done", "milestone"].includes(i.kind))) return "done";
  return null;
}

let files = null;
// name -> the WAV's path (written once, in the temp folder)
export function earconFile(name, dir = tmpdir()) {
  if (!EARCONS[name]) return null;
  if (!files) {
    files = {};
    for (const [k, notes] of Object.entries(EARCONS)) {
      const f = join(dir, `axa-earcon-${process.pid}-${k}.wav`);
      try { writeFileSync(f, toneWav(notes), { mode: 0o600 }); files[k] = f; } catch {}
    }
  }
  return files[name] || null;
}
