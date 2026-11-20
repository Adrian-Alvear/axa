// Text -> Kokoro phonemes, so no word is ever silently dropped. sherpa-onnx's Kokoro skips any word missing from its
// lexicon (lexicon-us-en.txt: "word p h o n e m e s", one per line) and every number (the lexicon has no digits).
// Here each word is looked up (case-insensitive); a missing one is made speakable, in this order:
//   numbers -> words ("1.9" -> one point nine); hyphenated/alphanumeric names -> their parts ("v2" -> V two);
//   short all-caps acronyms -> letter by letter; morphology from a known base (plural, -ed, -ing, -er, -est, -ly,
//   -ness, -ment, -able, -ful, -less, 's, un-/re-/pre-...); two known words run together; else a rule-based
//   grapheme-to-phoneme guess. The resident speaker gets the phonemes directly (GenerationConfig.tokens); the CLI
//   gets the missing words as an extra lexicon file. Pure apart from loadLexicon() (reads a file once per path).
import { readFileSync } from "node:fs";

// ---------- the lexicon ----------
const cache = new Map();
export function loadLexicon(file) {
  if (cache.has(file)) return cache.get(file);
  const lex = parseLexicon(readFileSync(file, "utf8"));
  cache.set(file, lex);
  return lex;
}
export function parseLexicon(text) {
  const m = new Map();
  for (const line of String(text).split("\n")) {
    const [w, ...p] = line.trim().split(/\s+/);
    if (w && p.length && !m.has(w.toLowerCase())) m.set(w.toLowerCase(), p.join(""));
  }
  return m;
}

// ---------- numbers ----------
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ORD = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
function under1000(n) {
  const out = [];
  if (n >= 100) { out.push(ONES[Math.floor(n / 100)], "hundred"); n %= 100; if (!n) return out; }
  if (n < 20) out.push(ONES[n]); else { out.push(TENS[Math.floor(n / 10)]); if (n % 10) out.push(ONES[n % 10]); }
  return out;
}
export function intWords(s) {
  s = String(s).replace(/,/g, "");
  if (s.length > 1 && s.startsWith("0")) return [...s].map((d) => (d === "0" ? "oh" : ONES[d]));
  let n = Number(s);
  if (!Number.isSafeInteger(n) || s.length > 12) return [...s].map((d) => ONES[d]);
  if (n === 0) return ["zero"];
  const out = [];
  for (const [v, w] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]]) if (n >= v) { out.push(...under1000(Math.floor(n / v)), w); n %= v; }
  if (n) out.push(...under1000(n));
  return out;
}
// "380", "1.9", "2.0.2", "1,000", "3rd" -> words
export function numberWords(tok) {
  const ord = /^(\d+)(st|nd|rd|th)$/i.exec(tok);
  if (ord) {
    const w = intWords(ord[1]), last = w.pop();
    return [...w, ORD[last] || (last.endsWith("y") ? last.slice(0, -1) + "ieth" : last + "th")];
  }
  if (/^\d{1,3}(?:,\d{3})+$/.test(tok)) return intWords(tok);
  const parts = tok.split(".");
  return parts.flatMap((p, i) => [...(i ? ["point"] : []), ...(i ? (p.length === 1 && p === "0" ? ["oh"] : p.length <= 2 && !p.startsWith("0") ? intWords(p) : [...p].map((d) => (d === "0" ? "oh" : ONES[d]))) : intWords(p))]);
}

// ---------- letters (when the lexicon lacks one) ----------
const LETTER = { a: "ˈA", b: "bˈi", c: "sˈi", d: "dˈi", e: "ˈi", f: "ˈɛf", g: "ʤˈi", h: "ˈAʧ", i: "ˈI", j: "ʤˈA", k: "kˈA", l: "ˈɛl",
  m: "ˈɛm", n: "ˈɛn", o: "ˈO", p: "pˈi", q: "kjˈu", r: "ˈɑɹ", s: "ˈɛs", t: "tˈi", u: "jˈu", v: "vˈi", w: "dˈʌbᵊlju", x: "ˈɛks", y: "wˈI", z: "zˈi" };
const spell = (w) => [...w.toLowerCase()].map((c) => LETTER[c]).filter(Boolean).join(" ");

// ---------- morphology ----------
const STRESS = /[ˈˌ]/g;
const lastPh = (ph) => ph.replace(STRESS, "").slice(-1);
const VOICELESS = new Set([..."ptkfθʧʃs"]), SIBILANT = new Set([..."szʃʒʧʤ"]);
const plural = (ph) => ph + (SIBILANT.has(lastPh(ph)) ? "ᵻz" : VOICELESS.has(lastPh(ph)) ? "s" : "z");
const past = (ph) => ph + ("td".includes(lastPh(ph)) ? "ᵻd" : VOICELESS.has(lastPh(ph)) ? "t" : "d");
const undouble = (s) => (/([bcdfgklmnprstvz])\1$/.test(s) ? s.slice(0, -1) : null);
// [suffix, stems to try, how the suffix sounds]
const SUFFIXES = [
  ["'s", (s) => [s], plural], ["s'", (s) => [s + "s", s], (ph) => ph],
  ["ies", (s) => [s + "y"], plural], ["es", (s) => (/(?:s|x|z|ch|sh)$/.test(s) ? [s] : []), plural], ["s", (s) => (/[^s]$/.test(s) ? [s] : []), plural],
  ["ied", (s) => [s + "y"], past], ["ed", (s) => [s, undouble(s), s + "e"], past], ["d", (s) => (/e$/.test(s) ? [s] : []), past],
  ["ing", (s) => [s, s + "e", undouble(s)], (ph) => ph + "ɪŋ"],
  ["iest", (s) => [s + "y"], (ph) => ph + "ᵻst"], ["est", (s) => [s, s + "e", undouble(s)], (ph) => ph + "ᵻst"],
  ["ier", (s) => [s + "y"], (ph) => ph + "əɹ"], ["er", (s) => [s, s + "e", undouble(s)], (ph) => ph + "əɹ"],
  ["ily", (s) => [s + "y"], (ph) => ph.replace(/i$/, "") + "əli"], ["ly", (s) => [s, s + "le"], (ph) => ph + "li"],
  ["iness", (s) => [s + "y"], (ph) => ph.replace(/i$/, "") + "inəs"], ["ness", (s) => [s], (ph) => ph + "nəs"],
  ["ment", (s) => [s], (ph) => ph + "mᵊnt"], ["able", (s) => [s, s + "e", undouble(s)], (ph) => ph + "əbᵊl"],
  ["ful", (s) => [s], (ph) => ph + "fᵊl"], ["less", (s) => [s], (ph) => ph + "ləs"],
];
const PREFIXES = [["un", "ˌʌn"], ["re", "ɹˌi"], ["pre", "pɹˌi"], ["non", "nˌɑn"], ["dis", "dˌɪs"], ["sub", "sˌʌb"], ["de", "dˌi"],
  ["over", "ˌOvəɹ"], ["auto", "ˌɔɾO"], ["multi", "mˌʌlti"], ["mis", "mˌɪs"]];
const soften = (ph) => ph.replace(/ˈ/g, "ˌ");

function known(w, lex, depth) {
  const hit = lex.get(w);
  if (hit) return hit;
  return depth > 0 ? morph(w, lex, depth - 1) : null;
}
export function morph(w, lex, depth = 2) {
  for (const [suf, stems, sound] of SUFFIXES) {
    if (!w.endsWith(suf) || w.length - suf.length < 2) continue;
    const s = w.slice(0, -suf.length);
    for (const st of stems(s)) {
      if (!st || st.length < 2) continue;
      const ph = known(st, lex, depth);
      if (ph) return sound(ph);
    }
  }
  for (const [pre, ph] of PREFIXES) {
    if (!w.startsWith(pre) || w.length - pre.length < 3) continue;
    const rest = known(w.slice(pre.length), lex, depth);
    if (rest) return ph + rest;
  }
  return null;
}
// two known words run together ("statusline", "keybindings")
// the most even split wins ("power" + "shell", not "powers" + "hell")
export function compound(w, lex) {
  let best = null, bestMin = 0;
  for (let i = 3; i <= w.length - 3; i++) {
    const min = Math.min(i, w.length - i);
    if (min <= bestMin) continue;
    const a = lex.get(w.slice(0, i)) || morph(w.slice(0, i), lex, 0);
    const b = a && (lex.get(w.slice(i)) || morph(w.slice(i), lex, 1));
    if (b) { best = a + soften(b); bestMin = min; }
  }
  return best;
}

// ---------- the last resort: graphemes -> phonemes, by rule ----------
const G2P = [
  [/^kn/, "n"], [/^wr/, "ɹ"], [/^ps/, "s"], [/tch/, "ʧ"], [/dge/, "ʤ"], [/tion/, "ʃən"], [/sion/, "ʒən"], [/ture/, "ʧəɹ"],
  [/igh/, "I"], [/ough/, "O"], [/augh/, "ɔ"], [/ch/, "ʧ"], [/sh/, "ʃ"], [/th/, "θ"], [/ph/, "f"], [/wh/, "w"], [/ck/, "k"],
  [/ng/, "ŋ"], [/qu/, "kw"], [/gh/, ""], [/x/, "ks"],
  [/ee|ea/, "i"], [/oo/, "u"], [/ai|ay/, "A"], [/oa/, "O"], [/ou|ow/, "W"], [/oi|oy/, "Y"], [/au|aw/, "ɔ"], [/ie/, "I"], [/ei|ey/, "A"],
  [/ew/, "ju"], [/ar/, "ɑɹ"], [/or/, "ɔɹ"], [/er|ir|ur/, "ɜɹ"],
  [/c(?=[eiy])/, "s"], [/c/, "k"], [/g(?=[eiy])/, "ʤ"], [/g/, "ɡ"], [/j/, "ʤ"], [/^y(?=[aeiou])/, "j"], [/r/, "ɹ"],
  [/a(?=[^aeiou]e$)/, "A"], [/e(?=[^aeiou]e$)/, "i"], [/i(?=[^aeiou]e$)/, "I"], [/o(?=[^aeiou]e$)/, "O"], [/u(?=[^aeiou]e$)/, "u"],
  [/y$/, "i"], [/a/, "æ"], [/e/, "ɛ"], [/i|y/, "ɪ"], [/o/, "ɑ"], [/u/, "ʌ"],
  [/([bdfklmnpstvz])\1/, "$1"], [/[bdfhklmnpstvwz]/, "$&"],
];
const VOWEL_PH = /[AIOWYiuæɛɪɑʌɔəɜ]/;
export function g2p(word) {
  let w = word.toLowerCase().replace(/[^a-z]/g, ""), out = "";
  while (w) {
    if (w === "e" && out) break; // a silent final e
    let hit = false;
    for (const [re, ph] of G2P) {
      const src = new RegExp("^(?:" + re.source + ")");
      const m = src.exec(w);
      if (!m) continue;
      out += m[0].replace(src, ph);
      w = w.slice(m[0].length) || "";
      hit = true;
      break;
    }
    if (!hit) w = w.slice(1);
  }
  const v = out.search(VOWEL_PH);
  return v < 0 ? out : out.slice(0, v) + "ˈ" + out.slice(v);
}

// ---------- one word ----------
// -> { ph, how }; how: "lexicon" | "number" | "parts" | "spell" | "morph" | "compound" | "g2p" (the last five are OOV)
export function wordPhonemes(raw, lex) {
  const w = String(raw).replace(/’/g, "'").toLowerCase();
  if (lex.has(w)) return { ph: lex.get(w), how: "lexicon" };
  if (/^\d[\d,.]*(?:st|nd|rd|th)?$/i.test(w)) return { ph: numberWords(w.replace(/\.$/, "")).map((x) => lex.get(x) || g2p(x)).join(" "), how: "number" };
  // names: hyphenated parts, then letter/digit runs ("v2" -> V two)
  const parts = w.split(/[-_]+/).filter(Boolean);
  if (parts.length > 1) return { ph: parts.map((p) => wordPhonemes(p, lex).ph).join(" "), how: "parts" };
  const runs = w.match(/[a-z']+|\d+/g) || [];
  if (runs.length > 1) return { ph: runs.map((p) => (/^[a-z]$/.test(p) ? lex.get(p) || LETTER[p] : wordPhonemes(p, lex).ph)).join(" "), how: "parts" };
  // a possessive of an unknown word: the word's fallback + the 's sound
  if (/^[a-z]{2,}'s$/.test(w) && !lex.has(w.slice(0, -2)) && !/^[A-Z]+['’]s$/.test(String(raw))) {
    const base = wordPhonemes(w.slice(0, -2), lex);
    if (base.ph) return { ph: plural(base.ph), how: base.how };
  }
  const caps = String(raw).replace(/['’]s$/, "");
  if ((/^[A-Z]{2,6}$/.test(caps) && !lex.has(caps.toLowerCase())) || (/^[a-z]{2,5}$/.test(w) && !/[aeiouy]/.test(w)))
    return { ph: [...caps.toLowerCase()].map((c) => lex.get(c) || LETTER[c]).join(" ") + (caps !== String(raw) ? "z" : ""), how: "spell" };
  if (w.length === 1) return { ph: LETTER[w] || "", how: "spell" };
  const m = morph(w, lex);
  if (m) return { ph: m, how: "morph" };
  const c = compound(w, lex);
  if (c) return { ph: c, how: "compound" };
  return { ph: g2p(w) || spell(w), how: "g2p" };
}

// ---------- a whole text ----------
const PUNCT = new Set([..."; : , . ! ? — … \" ( ) “ ”".replace(/ /g, "")]);
const TOKEN = /[A-Za-z0-9]+(?:['’\-_.,][A-Za-z0-9]+)*|[;:,.!?—…"()“”]/g;
const MAX = 400; // phoneme characters per chunk (the model's limit is 510 tokens)

// a token -> plain words sherpa's text path can look up: numbers spelled out, names split into parts
// ("1.9" -> one point nine, "axa-v2-hub" -> axa v two hub, "24-bit" -> twenty four bit)
export function plainWords(tok, lex) {
  const w = String(tok).replace(/’/g, "'");
  if (lex.has(w.toLowerCase())) return [w];
  if (/^\d[\d,.]*(?:st|nd|rd|th)?$/i.test(w)) return numberWords(w);
  const parts = w.split(/[-_.,]+/).filter(Boolean);
  if (parts.length > 1) return parts.flatMap((p) => plainWords(p, lex));
  const runs = w.match(/[A-Za-z']+|\d+/g) || [];
  if (runs.length > 1) return runs.flatMap((p) => plainWords(p, lex));
  return [w];
}

// A reply for Kokoro -> {
//   text:   the same reply in plain words (numbers spelled out, names split): what sherpa's text path reads, with
//   extra:  { word: "phonemes" } for each word its lexicon lacks (loaded as a second lexicon, before the model's);
//   chunks: ["ð i ...", ...] the whole reply as phonemes, one string per sentence (said directly while a new extra
//           lexicon loads: sherpa pauses at every punctuation mark on that path, so it's the fallback, not the default);
//   oov:    [{ word, how }] for the log }
export function phonemize(text, lex) {
  const chunks = [], oov = [], extra = {}, plain = [];
  let cur = "";
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };
  for (const tok of String(text).match(TOKEN) || []) {
    if (PUNCT.has(tok)) {
      plain.push(tok);
      // no space after punctuation, like sherpa's text path
      cur = cur.replace(/ $/, "") + tok;
      if (".!?".includes(tok) || (cur.length > MAX && ",;:".includes(tok))) flush();
      continue;
    }
    for (const word of plainWords(tok, lex)) {
      const { ph, how } = wordPhonemes(word, lex);
      if (!ph) continue;
      plain.push(word);
      if (how !== "lexicon") { oov.push({ word, how }); extra[word.toLowerCase()] = ph.replace(/\s+/g, ""); }
      if (cur.length + ph.length > MAX) flush();
      cur += ph + " ";
    }
  }
  flush();
  const said = plain.reduce((s, t) => (PUNCT.has(t) && !"(“\"".includes(t) ? s + t : s ? `${s} ${t}` : t), "");
  return { text: said, extra, chunks, oov };
}
// the extra lexicon file's text: "word p h o n e m e s"
export const lexiconText = (extra) => Object.entries(extra).map(([w, ph]) => `${w} ${[...ph].join(" ")}`).join("\n") + "\n";
