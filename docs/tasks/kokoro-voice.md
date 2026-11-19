# Task: Kokoro voice for AXA (macOS + Windows/WSL), with the built-in voices as fallback

Repo /home/adrianwsl/axa, branch axa-v2. Commit locally at the end (git -c user.name="Adrian Alvear"
-c user.email=adrianalvear09@gmail.com commit; message "Voice: Kokoro neural voice (sherpa-onnx), installer and fallback",
plus "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"). Never push. Don't revert other changes.
Do NOT restart the daemon yourself (an independent review may be running in it); say in your report that it needs a restart.

## What exists
- src/core/voice.mjs: backends powershell (System.Speech), say (mac), spd-say/espeak; speak()/stop()/voices()/toSpeech();
  settings in ~/.axa/ui.json ("voice", "voiceName", "voiceRate"); routes /api/voice, /api/voice/stop, /api/voice/test.
- Trial results (already measured on this laptop, Intel i7-11850H, WSL2): sherpa-onnx v2.0.2 prebuilt CLIs exist:
  Linux x64 `sherpa-onnx-v2.0.2-linux-x64-shared.tar.bz2` (30 MB), macOS `sherpa-onnx-v2.0.2-osx-arm64-shared.tar.bz2`
  and `...-osx-universal2-shared.tar.bz2`, from https://github.com/k2-fsa/sherpa-onnx/releases. Model: use
  `kokoro-multi-lang-v1_0.tar.bz2` from https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/ (~350 MB);
  kokoro-en-v0_19 FAILS on v2.x ("No lexicon available"). Working CLI:
  bin/sherpa-onnx-offline-tts --kokoro-model=M/model.onnx --kokoro-voices=M/voices.bin --kokoro-tokens=M/tokens.txt
    --kokoro-lexicon=M/lexicon-us-en.txt --num-threads=4 --sid=3 --output-filename=out.wav "text"
  Speakers: v1_0 sid 0-53; English 0-27 (af_alloy … bm_lewis); default sid 3 = af_heart (the user liked it).
  Cold CLI per call = ~3.1 s for a short sentence (model load ~2 s) -> too slow. Model kept loaded (Python API,
  `pip install sherpa-onnx` in a venv) = ~0.9-1.0 s at 4-8 threads -> the target.
  Words missing from the lexicon are silently dropped (e.g. "macOS").
  Playback on WSL: Media.SoundPlayer.PlaySync on a \\wsl path returns immediately WITHOUT playing; copying the wav to the
  Windows temp folder ([IO.Path]::GetTempPath(), mapped with wslpath -u) first and playing that works (blocks for the
  clip length). The WAV is PCM 16-bit mono 24 kHz.
- A working trial install (CLI, models, a venv with sherpa-onnx) is in
  /tmp/claude-1000/-home-adrianwsl/8bea01ba-fcd2-4bbd-973a-6447d445c6e1/scratchpad/kokoro-trial/ — reuse it for testing via
  env AXA_KOKORO_DIR=<that dir layout> instead of downloading again.

## Build
1. Install location: <AXA home>/voices/kokoro/ (AXA home = paths.mjs `home`, i.e. ~/.axa or $AXA_HOME) with model/,
   and either venv/ (preferred) or bin/ (CLI fallback). Env AXA_KOKORO_DIR overrides the location.
2. `axa voice install kokoro` (bin/axa CLI subcommand; run by the USER, never by a session): detect OS/arch, create a
   python3 venv and `pip install sherpa-onnx` (if python3 -m venv is unavailable, fall back to downloading the prebuilt CLI
   for that OS), download + extract the kokoro-multi-lang-v1_0 model with progress output, verify by synthesizing one short
   sentence, then set ui.json "voiceEngine": "kokoro", "voiceName": "af_heart". Idempotent; `axa voice uninstall kokoro`
   removes the folder. `axa voice status` prints engine, install state and the test timing. Show sizes before downloading
   and ask y/N (skip the prompt with --yes).
3. A resident Kokoro speaker: src/core/voice-kokoro.py (small Python script run with the venv's python) that loads the
   model once and then reads JSON lines on stdin ({ "text", "sid", "speed", "out" }) and replies a JSON line when the wav is
   written. voice.mjs starts it lazily on the first speak when engine is kokoro, keeps it alive, restarts it if it dies,
   and stops it after 10 minutes idle. Without a venv (CLI-only install), call the CLI per reply (slower, still works).
4. voice.mjs: engine "kokoro" | "system" (default "system"; auto-select kokoro when installed and ui.json has no
   explicit choice). speak(): Kokoro -> wav -> play (mac: afplay; WSL: copy to Windows temp then SoundPlayer.PlaySync;
   Linux: paplay/aplay if present). Any Kokoro failure (not installed, crash, timeout 8 s) falls back to the system voice
   for that reply and logs why. stop() kills playback and any synthesis in flight.
5. Pronunciation: a small word map applied in toSpeech() before Kokoro (also harmless for system voices), e.g. macOS->
   "mac O S", WSL->"W S L", npm->"N P M", git->"git", AXA->"axa", JSON->"jason", README->"read me", CLI->"C L I",
   UI->"U I", TUI->"T U I", API->"A P I", URL->"U R L", PR->"P R", ok->"okay", plus "~/"->"home folder". Keep it in one table.
6. Settings overlay in the hub (src/tui/app.mjs): "Voice engine" (Kokoro / System, Kokoro greyed with "not installed:
   run axa voice install kokoro" when missing), "Voice name" lists Kokoro's 28 English voices (sid 0-27 names) when engine
   is kokoro, speed maps to Kokoro's --speed / length scale. /api/voice returns { engine, installed, voices, … }.
7. README: a "Better voice: Kokoro" section: what it is, Apache-2.0, offline, ~380 MB, the install command for mac and
   Windows/WSL, how to switch back.

## Checks before you finish
- node --check on changed JS files; python3 -m py_compile src/core/voice-kokoro.py; node --test test/*.test.mjs all pass.
- Tests: word map; engine selection/fallback logic (kokoro missing -> system; kokoro throws -> system); the WSL temp-copy
  path building (pure function); the resident speaker protocol with a fake python script.
- Real run with AXA_KOKORO_DIR pointing at the trial install: speak a short sentence through voice.mjs twice and report
  time-to-wav for the first (cold) and second (warm) call; play ONE sample on the Windows speakers (the user will hear it;
  sentence: "Kokoro is installed. This is how AXA will sound."). Don't touch ~/.axa (AXA_HOME to a scratch dir for the
  installer test; you may skip the real 350 MB download in the installer test by pointing it at the trial files).
- Report in <= 8 lines, including cold/warm timings, whether the sample played (PlaySync blocked ~clip length), what
  wasn't verified (mac).
