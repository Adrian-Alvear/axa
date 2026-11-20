// src/core/phonemes.mjs: no word is silently dropped by Kokoro (numbers, names, morphology, spelling, G2P),
// checked on a small fixture lexicon always, and on the installed Kokoro model when there is one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compound, g2p, lexiconText, morph, numberWords, parseLexicon, phonemize, plainWords, wordPhonemes } from "../src/core/phonemes.mjs";
import { logOov, oovLogFile, wavMs } from "../src/core/voice.mjs";
import * as K from "../src/core/kokoro.mjs";

const lex = parseLexicon(`the ð i
detail d ə t ˈ A l
minute m ˈ ɪ n ə t
verify v ˈ ɛ ɹ ə f ˌ I
include ɪ n k l ˈ u d
stop s t ˈ ɑ p
make m ˈ A k
box b ˈ ɑ k s
happy h ˈ æ p i
key k ˈ i
binding b ˈ I n d ɪ ŋ
power p ˈ W ə ɹ
shell ʃ ˈ ɛ l
hub h ˈ ʌ b
v v ˈ i
one w ˈ ʌ n
two t ˈ u
nine n ˈ I n
point p ˈ Y n t
oh ˈ O
three θ ɹ ˈ i
hundred h ˈ ʌ n d ɹ ə d
eighty ˈ A ɾ i
s ˈ ɛ s
p p ˈ i
d d ˈ i`);

// ---------- pure: the fallbacks ----------
test("phonemes: numbers become words (the lexicon has no digits)", () => {
  assert.deepEqual(numberWords("380"), ["three", "hundred", "eighty"]);
  assert.deepEqual(numberWords("1.9"), ["one", "point", "nine"]);
  assert.deepEqual(numberWords("2.0.2"), ["two", "point", "oh", "point", "two"]);
  assert.deepEqual(numberWords("1,000"), ["one", "thousand"]);
  assert.deepEqual(numberWords("1300000"), ["one", "million", "three", "hundred", "thousand"]);
  assert.deepEqual(numberWords("3rd"), ["third"]);
  assert.deepEqual(numberWords("20th"), ["twentieth"]);
  assert.deepEqual(numberWords("05"), ["oh", "five"]);
});

test("phonemes: morphology from a known base", () => {
  assert.equal(morph("details", lex), "dətˈAlz");
  assert.equal(morph("minutes", lex), "mˈɪnəts");
  assert.equal(morph("boxes", lex), "bˈɑksᵻz");
  assert.equal(morph("verified", lex), "vˈɛɹəfˌId");
  assert.equal(morph("includes", lex), "ɪnklˈudz");
  assert.equal(morph("included", lex), "ɪnklˈudᵻd");
  assert.equal(morph("stopped", lex), "stˈɑpt");
  assert.equal(morph("stopping", lex), "stˈɑpɪŋ");
  assert.equal(morph("making", lex), "mˈAkɪŋ");
  assert.equal(morph("happiness", lex), "hˈæpinəs");
  assert.equal(morph("unverified", lex), "ˌʌnvˈɛɹəfˌId");
  assert.equal(morph("remake", lex), "ɹˌimˈAk");
  assert.equal(morph("hub's", lex), "hˈʌbz");
  assert.equal(morph("zorblax", lex), null);
});

test("phonemes: compounds, names, acronyms and the G2P fallback", () => {
  assert.equal(compound("powershell", lex), "pˈWəɹʃˌɛl");
  assert.equal(compound("keybinding", lex), "kˈibˌIndɪŋ");
  assert.deepEqual(plainWords("axa-v2-hub", lex), ["axa", "v", "two", "hub"]); // "v2" in a name is V two, not "version 2"
  assert.deepEqual(plainWords("1.9", lex), ["one", "point", "nine"]);
  assert.deepEqual(wordPhonemes("SPD", lex), { ph: "ˈɛs pˈi dˈi", how: "spell" });
  assert.equal(wordPhonemes("espeak", lex).how, "g2p");
  assert.ok(g2p("zorblax").length > 4 && /ˈ/.test(g2p("zorblax")));
  assert.equal(g2p("sudo")[0], "s");
  for (const w of ["onnx", "af", "q", "xyzzy", "Tmux", "kubectl"]) assert.ok(wordPhonemes(w, lex).ph, w);
});

test("phonemes: a reply -> plain text, an extra lexicon for the missing words, and phonemes per sentence", () => {
  const r = phonemize("The details: 1.9 minutes, on axa-v2-hub. Verified!", lex);
  assert.equal(r.text, "The details: one point nine minutes, on axa v two hub. Verified!");
  assert.deepEqual(Object.keys(r.extra).sort(), ["axa", "details", "minutes", "on", "verified"]);
  assert.equal(r.chunks.length, 2);
  assert.ok(r.chunks[0].startsWith("ði dətˈAlz:wˈʌn pˈYnt nˈIn mˈɪnəts,"), r.chunks[0]);
  assert.deepEqual(r.oov.map((o) => o.how), ["morph", "morph", "g2p", "g2p", "morph"]);
  assert.equal(lexiconText({ details: "dətˈAlz" }), "details d ə t ˈ A l z\n");
  // the CLI (no venv): the missing words go in a second lexicon file, read before the model's own
  assert.ok(K.cliArgs({ model: "/m", sid: 3, out: "/o.wav", text: "hi", extraLexicon: "/t/x.txt" }).includes("--kokoro-lexicon=/t/x.txt,/m/lexicon-us-en.txt"));
  assert.ok(K.cliArgs({ model: "/m", sid: 3, out: "/o.wav", text: "hi" }).includes("--kokoro-lexicon=/m/lexicon-us-en.txt"));
});

test("phonemes: OOV words are counted in a small log (AXA_OOV_LOG overrides, 0 turns it off)", () => {
  const f = join(mkdtempSync(join(tmpdir(), "axa-oov-")), "oov.json");
  logOov(f, [{ word: "Details", how: "morph" }, { word: "onnx", how: "g2p" }]);
  logOov(f, [{ word: "details", how: "morph" }]);
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { details: { n: 2, how: "morph" }, onnx: { n: 1, how: "g2p" } });
  assert.equal(oovLogFile("/v", undefined), join("/v", "oov.json"));
  assert.equal(oovLogFile("/v", "0"), null);
  assert.equal(oovLogFile("/v", "/tmp/x.json"), "/tmp/x.json");
});

// ---------- the installed model: real OOV words from AXA replies (speech tests + README), none dropped ----------
// found by running the speech test inputs and the README through toSpeech and checking each word in lexicon-us-en.txt
const OOV = ["minutes", "agents", "session's", "af", "onnx", "hub's", "includes", "verified", "details", "tokens", "opens",
  "terminal's", "installer's", "elapsed", "that's", "results", "reports", "selected", "chat's", "agent's", "columns", "sudo",
  "plugin", "commander's", "computer's", "spd", "espeak", "onnx's", "prebuilt", "multi", "lang", "makes", "selects", "copies",
  "daemon's", "what's", "effects", "terminals", "icons", "reviewers", "worktrees", "statusline", "milestones", "subagents",
  "keybindings", "repos", "rebased", "deduped", "checksums", "popups"];
const L = K.layout();
const installed = !!(L.model && L.python);

test("phonemes: every OOV word from AXA replies gets phonemes (installed lexicon)", { skip: !installed && "Kokoro isn't installed" }, () => {
  const real = parseLexicon(readFileSync(join(L.model, "lexicon-us-en.txt"), "utf8"));
  assert.ok(OOV.length >= 40);
  for (const w of OOV) {
    assert.ok(!real.has(w), `${w} is in the lexicon now: drop it from the list`);
    const r = wordPhonemes(w, real);
    assert.ok(r.ph && r.how !== "lexicon", `${w}: ${JSON.stringify(r)}`);
  }
});

test("phonemes: Kokoro says every one of them (the wav grows when the word is added)", { skip: !installed && "Kokoro isn't installed", timeout: 180000 }, async () => {
  const real = parseLexicon(readFileSync(join(L.model, "lexicon-us-en.txt"), "utf8"));
  const logs = [];
  const sp = new K.Speaker({ python: L.python, model: L.model, log: (m) => logs.push(m) });
  const d = mkdtempSync(join(tmpdir(), "axa-oov-wav-"));
  let n = 0;
  const say = async (t) => {
    const p = phonemize(t, real), out = join(d, `${n++}.wav`);
    await sp.synth({ text: p.text, extra: p.extra, phonemes: p.chunks, sid: 3, out }, 60000);
    return wavMs(readFileSync(out));
  };
  try {
    const base = await say("Say now.");
    // first sight: said from phonemes while the extra lexicon loads
    const all = await say(`Say ${OOV.join(", ")} now.`);
    assert.ok(all > base + 10000, `all words: ${all} ms vs ${base} ms`);
    for (let i = 0; i < 300 && !logs.some((l) => /extra lexicon: \d+ words/.test(l)); i++) await new Promise((r) => setTimeout(r, 100));
    const loaded = Math.max(0, ...logs.map((l) => Number(/extra lexicon: (\d+) words/.exec(l)?.[1] || 0)));
    assert.ok(loaded >= OOV.length, logs.join("\n"));
    // then each word on the native text path, with the extra lexicon
    for (const w of OOV) {
      const ms = await say(`Say ${w} now.`);
      assert.ok(ms > base + 150, `${w}: ${ms} ms vs ${base} ms without it`);
    }
  } finally { sp.kill(); }
});
