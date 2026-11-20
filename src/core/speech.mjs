// A reply made speakable: markdown -> plain sentences any voice can read (Kokoro, macOS say, System.Speech, espeak).
// Pure and engine-neutral: no I/O, no settings. Speech engines read exactly the text they get: a missing full stop runs
// sentences together, symbols are read out or dropped, and Kokoro silently skips tokens its lexicon doesn't know.
// So: every line ends in a stop, glyphs go (or become words), symbols, numbers and units become words, and code-ish
// tokens (commit ids, paths, URLs, settings, commands, key names) become short phrases.

// ---------- pronunciation: one table, applied last ----------
// Words Kokoro's lexicon doesn't have (it drops them silently) are spelled the way they're said. "AXA" is said
// "ax uh", exactly as the table below spells it. Entries are case-insensitive unless marked "cs".
// Checked and left alone (Kokoro says them well): Opus, Sonnet, hub, daemon, repo, git.
export const PRONOUNCE = [
  ["macOS", "mac O S"], ["WSL2", "W S L 2"], ["WSL", "W S L"], ["npm", "N P M"], ["npx", "N P X"], ["git", "git"],
  ["GitHub", "git hub"], ["AXA", "ax uh"], ["JSON", "jason"], ["README(?:\\.md)?", "read me"], ["CLI", "C L I"],
  ["UI", "U I"], ["TUI", "T U I"], ["API", "A P I"], ["URL", "U R L"], ["PRs", "pull requests", "cs"],
  ["PR", "pull request", "cs"], ["ok", "okay"], ["sherpa-onnx", "sherpa onnx"], ["Kokoro", "coco row"],
  ["tmux", "tee mux"], ["MCP", "M C P"], ["TTS", "text to speech"], ["LLM", "L L M"], ["SSH", "S S H"],
  ["HTTPS?", (m) => m.toUpperCase().split("").join(" ")], ["CPU", "C P U"], ["GPU", "G P U"], ["SDK", "S D K"],
  ["CI", "C I", "cs"], ["venv", "vee env"], ["stdin", "standard in"], ["stdout", "standard out"],
  ["stderr", "standard error"], ["Node\\.js", "node J S"], ["Esc", "escape"], ["wav", "wave"],
];
const PRON_RE = PRONOUNCE.map(([w, say, cs]) => [new RegExp(`(?<![\\w~/.-])${w}(?![\\w-])`, cs ? "g" : "gi"), say]);
export function pronounce(t) {
  let x = String(t);
  for (const [re, say] of PRON_RE) x = x.replace(re, say);
  return x.replace(/(^|\s)~\/(?=\s|[.,!?;:]|$)/g, "$1home folder");
}

// ---------- tokens ----------
const HEX = /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}$/;
const URL_RE = /\bhttps?:\/\/[^\s)>\]]+(?<![.,;:!?])|\bwww\.[^\s)>\]]+\.[a-z]{2,}[^\s)>\]]*(?<![.,;:!?])/gi;
const EXT = "mjs|cjs|js|jsx|ts|tsx|md|json|jsonl|py|sh|txt|ya?ml|toml|css|html?|wav|onnx|bin|lock|log|env|conf|cfg|ini|csv|pdf|png|jpe?g|svg|tar|gz|bz2|zip";
// /abs/path, ~/x, ./x, C:\x, src/dir/file.ext, or a bare file name with a known extension (with an optional :line)
const PATH_RE = new RegExp(String.raw`(?:[A-Za-z]:\\[^\s,;)]+|(?:~|\.{1,2})?\/(?:[\w.@-]+\/)+[\w.@-]*|(?:~|\.{1,2})\/[\w.@-]+|\b[\w.-]+\/(?:[\w.@-]+\/)*[\w@-]+\.\w+|(?<![\w/.-])\.?[\w-]+(?:\.[\w-]+)*\.(?:${EXT})\b)(?<!\.)(?::\d+(?::\d+)?)?`, "g");
const NAMED = { readme: "the README", handoff: "the handoff file", claude: "the claude file", changelog: "the changelog",
  license: "the license", todo: "the to do list", agents: "the agents file", credits: "the credits file" };
const words = (s) => s.replace(/[_.-]+/g, " ").trim();

// a path or file name -> its base name in plain words ("app", "the handoff file", "the kokoro folder"), or "a file path"
export function sayPath(p) {
  if (/^node\.js$/i.test(p)) return p;
  const clean = p.replace(/:\d+(?::\d+)?$/, "");
  if (/^~\/?$/.test(clean)) return "home folder";
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  const dir = /[\\/]$/.test(clean);
  const last = (parts.at(-1) || "").replace(/^\.+/, "");
  if (!last) return "a file path";
  const m = /^(.+?)\.([A-Za-z0-9]{1,5})$/.exec(last);
  const base = m ? m[1] : last;
  if (NAMED[base.toLowerCase()] && (base === base.toUpperCase() || !m)) return NAMED[base.toLowerCase()];
  const w = words(base);
  if (!w || w.length > 24 || w.split(" ").length > 3 || HEX.test(base)) return "a file path";
  return m && !dir ? w : `the ${w} folder`;
}

// inline `code` -> what's worth hearing
const MOD = { ctrl: "control", control: "control", alt: "alt", shift: "shift", cmd: "command", command: "command", option: "option", meta: "meta", super: "super", win: "windows" };
const KEY = { esc: "escape", escape: "escape", tab: "tab", enter: "enter", return: "return", space: "space", del: "delete", delete: "delete",
  backspace: "backspace", pgup: "page up", pgdn: "page down", home: "home", end: "end", up: "up", down: "down", left: "left", right: "right",
  "↑": "up arrow", "↓": "down arrow", "←": "left arrow", "→": "right arrow" };
const keyName = (k) => KEY[k.toLowerCase()] || (k.length === 1 ? k.toUpperCase() : /^f\d{1,2}$/i.test(k) ? k.toUpperCase() : k.toLowerCase());
const CHORD = new RegExp(String.raw`\b(${Object.keys(MOD).join("|")})((?:[-+](?:${Object.keys(MOD).join("|")}))*)[-+]([A-Za-z0-9]+|[↑↓←→])\b(?:\s+([a-z0-9?%"]|${Object.keys(KEY).filter((k) => /^\w+$/.test(k)).join("|")})\b(?![-+]))?`, "gi");
export function sayKeys(t) {
  return t.replace(CHORD, (all, mod, more, key, then) => {
    const mods = [mod, ...more.split(/[-+]/).filter(Boolean)].map((x) => MOD[x.toLowerCase()]);
    return `${mods.join(" ")} ${keyName(key)}${then ? `, ${keyName(then)}` : ""}`;
  });
}

export function sayCode(c) {
  const s = c.trim();
  if (!s) return "";
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(s)) return "a link";
  if (HEX.test(s)) return "a commit";
  if (/^[A-Z][A-Z0-9_]*=\S*$/.test(s) || /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(s)) return "a setting";
  if (/^\S+$/.test(s) && (/[\\/]/.test(s) || new RegExp(`\\.(?:${EXT})(?::\\d+)?$`).test(s))) return sayPath(s);
  const keys = sayKeys(s);
  if (keys !== s && !/[=(){}$|;<>]/.test(keys)) return keys;
  if (/^(?:[a-z]|esc|escape|tab|enter|space)$/i.test(s)) return keyName(s);
  if (/[=(){}$|;<>&]|(?:^|\s)--?[a-z]|^\.\/|\.\w+\(/i.test(s)) return "a command";
  if (/^[\w.-]+$/.test(s) && !/^v?\d+(?:\.\d+)+$/.test(s) && /[_-]/.test(s)) return words(s); // axa-v2-hub, af_heart
  return s;
}

// ---------- numbers and units ----------
const UNIT = { kb: "kilobyte", kib: "kilobyte", mb: "megabyte", mib: "megabyte", gb: "gigabyte", gib: "gigabyte", tb: "terabyte",
  ms: "millisecond", s: "second", sec: "second", secs: "second", min: "minute", mins: "minute", h: "hour", hr: "hour", hrs: "hour" };
const plural = (n, w) => `${n} ${w}${Number(n) === 1 ? "" : "s"}`;
export function sayNumbers(t) {
  return t
    // "2h 5m", "30m", "45s" (status text); bare seconds only below 1000 so "1990s" stays a decade
    .replace(/\b(\d+)h\s*(\d+)m\b/g, (a, h, m) => `${plural(h, "hour")} ${plural(m, "minute")}`)
    .replace(/\b(\d+)m\s*(\d+)s\b/g, (a, m, s) => `${plural(m, "minute")} ${plural(s, "second")}`)
    .replace(/\b(\d+(?:\.\d+)?)(h|m|d)\b/g, (a, n, u) => plural(n, { h: "hour", m: "minute", d: "day" }[u]))
    .replace(/\b(\d{1,3}(?:\.\d+)?)s\b/g, (a, n) => plural(n, "second"))
    .replace(/\b(\d+(?:\.\d+)?)\s?(KiB|MiB|GiB|KB|MB|GB|TB|kB|ms|secs?|mins?|hrs?|s|h)\b(?![-'])/g, (a, n, u) => plural(n, UNIT[u.toLowerCase()]))
    .replace(/\b(\d+(?:\.\d+)?)([kKMB])\b(?![-'])/g, (a, n, u) => `${n.replace(/\.0+$/, "")} ${{ k: "thousand", K: "thousand", M: "million", B: "billion" }[u]}`)
    .replace(/\b(\d+)x\b/g, "$1 times")
    .replace(/(\d)\s?[×x]\s?(\d)/g, "$1 by $2")
    .replace(/\b(\d{1,2}):(\d{2})(?!\d|:\d)/g, (a, h, m) => `${h} ${m.startsWith("0") ? `oh ${m[1]}` : m}`)
    .replace(/(^|[^\w.-])v(\d+(?:\.\d+)*)\b/g, "$1version $2")
    .replace(/(^|[\s(])#(\d+)\b/g, "$1number $2")
    .replace(/(\d)\s?%/g, "$1 percent");
}

// ---------- one line, made plain ----------
const DONE = "✓✔✅☑", FAIL = "✗✘❌✖", WARN = "⚠";
const STATUS = { ...Object.fromEntries([...DONE].map((g) => [g, "done"])), ...Object.fromEntries([...FAIL].map((g) => [g, "failed"])), [WARN]: "warning" };
const GLYPH_AT_START = new RegExp(`^([${DONE}${FAIL}${WARN}])\\uFE0F?\\s*`, "u");
const GLYPHS = /[\u2800-\u28FF◆◇▲△▼▽◀⏴⏸⏹⏺⎇─━═┄┈•●○◦■□▪▫★☆♦✦✧]|\p{Extended_Pictographic}|\uFE0F|\u200D/gu;

export function inline(x) {
  let t = x
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images -> their alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> their text
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/`+([^`]*)`+/g, (a, c) => sayCode(c)) // inline code -> what's worth hearing
    .replace(URL_RE, "a link")
    .replace(/(?:\*\*|__)(.+?)(?:\*\*|__)/g, "$1")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, ""); // stray html tags
  // status glyphs keep their meaning, other glyphs and emoji go
  t = t.replace(GLYPH_AT_START, (a, g) => `${STATUS[g][0].toUpperCase()}${STATUS[g].slice(1)}: `)
    .replace(new RegExp(`\\s*([${DONE}${FAIL}${WARN}])\\uFE0F?`, "gu"), (a, g) => ` ${STATUS[g]}`)
    .replace(/\s*[│┃║▸▹►▶⏵❯›»]\s*/g, ", ") // separators and pointers: a pause
    .replace(GLYPHS, " ");
  t = t
    // git stats before anything eats the + and -
    .replace(/(^|[\s(])\+(\d+)\s*[/,]?\s*[−-](\d+)(?=[\s),.;]|$)/g, (a, p, add, del) => `${p}${plural(add, "line")} added, ${del} removed`)
    .replace(/\s*\([+-]\)/g, "")
    // settings, commits, keys, paths
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]*=\S+|\b[A-Z][A-Z0-9]*=\S+/g, "a setting")
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g, "a setting")
    .replace(/\b[0-9a-f]{7,40}\b/g, (h) => (HEX.test(h) ? "a commit" : h))
    .replace(/\bcommits? (a commit)\b/gi, "$1")
    .replace(/\ba commit(?:(?:,\s*|\s+and\s+|\s*\.\.\.?\s*|\s+to\s+)a commit)+/g, "some commits")
    .replace(/\b[yY]\/[nN]\b/g, "yes or no")
    .replace(/\band\/or\b/g, "and or");
  t = sayKeys(t)
    .replace(PATH_RE, (p) => sayPath(p))
    .replace(/\ba file path(?:(?:,\s*|\s+and\s+|\s+)a file path)+/g, "some file paths")
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, words) // snake_case names: af_heart -> af heart
    .replace(/\b[a-z]+(?:-[a-z][a-z0-9]*)+\b/gi, (w) => (/\d/.test(w) ? w.replace(/-/g, " ") : w)) // axa-v2 -> axa v2
    .replace(/\b(\d+)\/(\d+)\b/g, "$1 of $2");
  t = sayNumbers(t)
    // symbols
    .replace(/\s*(?:→|->|=>|⟶)\s*/g, " to ")
    .replace(/\s*(?:·|\||—|–|\s-\s)\s*/g, ", ")
    .replace(/\s*&&?\s*/g, " and ")
    .replace(/[~≈](?=\s?\d)\s?/g, "about ")
    .replace(/\s\+\s/g, " plus ")
    .replace(/\b([A-Za-z]{2,})\/([A-Za-z]{2,})\b/g, "$1 or $2")
    .replace(/(?:…|\.{3})/g, ".")
    .replace(/\be\.g\.,?/gi, "for example,").replace(/\bi\.e\.,?/gi, "that is,").replace(/\betc\./gi, "et cetera.").replace(/\bvs\.?(?=\s)/gi, "versus")
    .replace(/(\p{L})[’'](\p{L})/gu, "$1\u0001$2") // keep apostrophes (it's, GitHub's)
    .replace(/["“”„‘’'`]/g, "").replace(/\u0001/g, "'")
    .replace(/\(s\)/g, "s")
    .replace(/\s*\(([^()]*)\)/g, ", $1,")
    .replace(/[\[\]{}<>*#|=^$\\]/g, " ")
    .replace(/[−]/g, "-");
  return t;
}

// ---------- a reply, made speakable ----------
export const SHORT = 350;
export const MORE = "You can read the rest on screen.";
const tidy = (p) => p.replace(/\s+/g, " ")
  .replace(/\s+([.,!?;:])/g, "$1")
  .replace(/([.!?:;])(?:\s*[.,;])+/g, "$1") // "resident.." and "done:." -> one stop
  .replace(/,(\s*,)+/g, ",").replace(/,\s*([.!?:;])/g, "$1")
  .replace(/^[\s,.;:]+/, "").trim();

// opts.more: false drops the closing "there's more on screen" sentence (ui.json "voiceMoreHint": false)
export function toSpeech(md, { more = true } = {}) {
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
  // each line -> a sentence (or a short label with a pause); a paragraph remembers if it's only a heading
  const paras = [];
  let cur = null;
  for (const raw of t.split("\n")) {
    if (!raw.trim()) { cur = null; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw) || /^\s*[─━═-]{3,}\s*$/.test(raw)) { cur = null; continue; } // a rule
    let x = raw.replace(/^\s*>+\s?/, "");
    const heading = /^\s*#{1,6}\s+/.test(x);
    x = x.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*(?:[-*+•▸◆]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "");
    x = tidy(inline(x));
    if (!/[\p{L}\p{N}]/u.test(x)) continue;
    // a short label on its own line ("Done:", "Next:", "Needs you:") gets a full pause
    const label = /^[\p{L}][\p{L}' ]{0,24}:$/u.test(x) && x.split(" ").length <= 3;
    if (label) x = x.slice(0, -1) + ".";
    x = x.replace(/[,;]$/, "");
    if (!/[.!?:]$/.test(x)) x += ".";
    if (!cur) paras.push((cur = { text: x, head: heading || label }));
    else { cur.text += " " + x; cur.head = cur.head && (heading || label); }
  }
  if (!paras.length) return "";
  // the short version: the first paragraph (with the next ones while it's very short or only a heading), cut at a sentence
  let said = "", used = 0, last = null;
  while (used < paras.length && (!last || said.length < 40 || last.head)) { last = paras[used++]; said = (said ? said + " " : "") + last.text; }
  said = tidy(said);
  let cut = used < paras.length;
  if (said.length > SHORT) {
    const head = said.slice(0, SHORT + 1);
    const end = Math.max(...[". ", "! ", "? "].map((p) => head.lastIndexOf(p)));
    said = end > 40 ? head.slice(0, end + 1) : head.slice(0, head.lastIndexOf(" ")).replace(/[,;:\s-]+$/, "") + ".";
    cut = true;
  }
  return pronounce(cut && more ? `${said} ${MORE}` : said).trim();
}
