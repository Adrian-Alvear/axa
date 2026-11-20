# Task: make AXA's spoken replies read naturally (speech text cleanup)

Repo /home/adrianwsl/axa, branch axa-v2. Commit locally at the end (git -c user.name="Adrian Alvear"
-c user.email=adrianalvear09@gmail.com commit; message "Voice: speech-friendly text (punctuation, symbols, numbers, code)",
plus "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"). Stage only your files (also copy this spec to
docs/tasks/speech.md). Never push. Restart nothing.
Read first: src/core/voice.mjs (toSpeech(), the pronunciation word map, short-version logic), src/core/kokoro.mjs,
test/voice.test.mjs, test/kokoro.test.mjs. Kokoro (and the system voices) read exactly the text they get: missing full stops
run sentences together, symbols are read out or dropped, unknown tokens are silently skipped by Kokoro.

## Build: a speech normalizer used by toSpeech() before any engine (keep it engine-neutral, pure, well tested)
1. Structure -> sentences: every bullet / numbered item / table card / line break ends with a sentence stop (add "." unless it
   already ends with . ! ? :). Headings and short labels ending in ":" ("Done:", "Next:", "Needs you:") get a pause: turn into
   "Done." style or keep ":" followed by a sentence. Collapse nested bullets into sentences. Drop emoji/status glyphs
   (✓ ✗ ⚠ ⠹ ◆ ▸ ▲ ⏵ ⎇ │ ─ etc.) but keep their meaning where it matters: "✓" at line start -> "Done:", "⚠" -> "Warning:",
   "✗" -> "Failed:".
2. Symbols: "→" / "->" -> " to ", "·" / "|" / " — " / " – " -> ", " (or a pause), "&" -> " and ", "~" before a number ->
   "about ", "≈" -> "about ", "+40 −2" (git stats) -> "40 lines added, 2 removed", "%" -> " percent", "/" between words ->
   " or " (but not in paths, which are handled below), "×"/"x" in "196×66" -> " by ", "…" -> ".", quotes and backticks removed.
3. Numbers and units: "380 MB" -> "380 megabytes", "1.9 s" -> "1.9 seconds", "15 min" -> "15 minutes", "30m"/"2h 5m" in
   status text -> "2 hours 5 minutes", "1M"/"1.0M" tokens -> "1 million", "130k" -> "130 thousand", "3:52 PM" -> "3 52 PM",
   versions "v2.0.2" -> "version 2.0.2", "#123" -> "number 123", ordinals stay as they are.
4. Code-ish tokens: commit ids (7-40 hex chars with a digit) -> "a commit"; file paths and names (~/x/y.mjs, src/tui/app.mjs,
   docs/HANDOFF.md) -> the base name without extension in plain words ("app", "the handoff file" for HANDOFF.md, "the
   README"), or "a file path" when long; URLs -> "a link"; inline `code` with symbols (=, (), {}, $, --flags) -> "a command"
   unless it's a single plain word; env vars (AXA_VOICE=1) -> "a setting"; keys like "Ctrl-b h", "Shift+Tab", "Alt+V",
   "Esc", "q" -> "control B, H", "shift tab", "alt V", "escape", the letter in quotes removed.
5. Keep the existing pronunciation word map (macOS, WSL, npm, JSON, README, CLI, UI, API, URL, PR, AXA…) and extend it with
   what you meet in the sample replies (e.g. sherpa-onnx -> "sherpa onnx", Kokoro, Opus, Sonnet, GitHub, tmux -> "tee mux",
   hub, daemon, repo -> "repo", MCP -> "M C P", TTS -> "text to speech", PR -> "pull request" when it's an abbreviation).
   Fix the review follow-up: the code comment about how "AXA" is pronounced must match the map.
6. Short version: keep speaking the first paragraph (or ~350 chars ending at a sentence) + "The details are on screen." but
   pick the first paragraph AFTER normalization so a leading heading or one-word line doesn't become the whole spoken text.

## Checks before you finish
- node --check; `npm test` and plain `node --test` pass.
- Add test/speech.test.mjs with at least 25 cases taken from realistic AXA replies (status updates with bullets, a table,
  commit ids, paths, sizes/times, git stats, version numbers, key names, URLs, emoji/status glyphs), asserting exact output.
  Include these real snippets and their expected speech:
  "Pushed: GitHub's `axa-v2-hub` is now at `0ba68ea` and includes mouse support."
  "- **Engine:** Kokoro, with the voice **af_heart**.\n- **Mode: resident.** … about a second. The installer's own test sentence took 1.9 s."
  "It shows the download size (about 380 MB) and asks y/N."
  "Restart your hub (`q`, then `axa`) after that to see everything."
- Play ONE before/after pair on the Windows speakers through AXA's own voice path (Kokoro is installed in ~/.axa/voices/kokoro;
  use the daemon's POST /api/voice/test only if it accepts custom text, otherwise call voice.mjs directly with AXA_HOME
  unchanged but DON'T modify ~/.axa): the same reply snippet, old cleanup then new. The user will hear it.
- Report in <= 6 lines with 3 before/after examples of the spoken text.

## Added during the task
7. The closing phrase "The details are on screen." blurred when spoken ("details" isn't in Kokoro's lexicon). Replaced by
   "You can read the rest on screen." (every word in the lexicon, said slower: 1.7 s vs 1.1 s), as its own sentence.
   ui.json "voiceMoreHint": true|false (default true) turns it off; Settings -> Voice: "Say when there's more on screen".
