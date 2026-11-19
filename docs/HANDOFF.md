# AXA handoff (2026-11-19, work laptop -> home Mac)

Branch: `axa-v2-hub` on GitHub (pushed from the local `axa-v2`). GitHub's own `axa-v2` is a separate, older line of work
(33 commits under `console/`) and was left untouched on purpose: the two branches rebuilt AXA differently.
Only its safety commits (`dd73931`, `e989c17`) were brought over.

To continue on the Mac:
```
git clone git@github.com:Adrian-Alvear/axa.git ~/axa   # or: cd ~/axa && git fetch
cd ~/axa && git checkout axa-v2-hub && npm install
axa                                                     # then tell the commander: "read docs/HANDOFF.md and continue"
```

## Done today (all committed, 108 tests passing at the last check)
- Control screen: the commander's agents on the live map (click one for a live popup); a full-width status bar (mode,
  model, context, tokens, uptime, agents, sessions); Claude Code's status lines mirrored in the Commander panel; idle
  sessions leave the map after 20 min; the commander gets the wide column when the map is empty; Approvals collapses to
  a strip; map animation (comets, sweep tail, breathing core, waiting ring, stuck flicker, done flash, slide-ins) with a
  Motion setting.
- Paste: bracketed paste; Alt+V attaches a clipboard image (saved in ~/.axa/pastes) to the commander's box or a session.
- Drag to copy in the Commander panel; double-click copies a message.
- Supervisor notes show as a dim "⚙ supervisor" line instead of "You".
- Voice (system voices): `m` on Control toggles it; Esc stops; Settings -> Voice. AXA reads the commander's replies.
- Safety: GitHub's hardened approval rules + tests restored, and the remaining bypasses closed (pushes to main in any
  spelling, tag pushes, migrate deploy, runner deploys; workers can't edit .mcp.json, git hooks, .claude settings/hooks).
- Independent reviewer (read-only `claude -p`, Opus 5.5, high effort): evidence rule, strict JSON verdict, daemon-side
  confirmation of block findings, block -> back to the worker (max 2 rounds); reviews the whole turn incl. commits.
  Known: a review can exceed the 10-min timeout (fix is in the milestone task below).
- Research reports in `research/` (design, performance, innovation, functionality). A personal Claude Code status line
  (`~/.claude/statusline.mjs`) is NOT in this repo: it lives in the work laptop's ~/.claude.

## In progress when I left (may or may not be in this branch; check `git log`)
1. Kokoro neural voice: `docs/tasks/kokoro-voice.md`. The user listened to a sample and liked it (voice `af_heart`).
   Trial facts are in the spec (sherpa-onnx v2.0.2 prebuilts for Linux x64 and macOS; use kokoro-multi-lang-v1_0, the
   en-v0_19 model fails on v2.x; keep the model loaded = ~1 s per short reply; on WSL play via a copy in the Windows temp
   folder). The spec's AXA_KOKORO_DIR trial path only exists on the work laptop: on the Mac use `axa voice install kokoro`.
2. Readable markdown tables in the Commander panel + clipboard keeping Unicode on Windows: `docs/tasks/tables-and-clipboard.md`.

## Next (agreed with the user)
3. Milestone reviews with a verifier <-> fixer loop: `docs/tasks/milestone-review.md` (milestone mode becomes the default;
   per-turn reviews only cheap checks; one Opus review per batch, a fresh fixer session fixes confirmed findings, re-check,
   max 3 rounds; longer timeouts).
4. Run the first milestone review over everything since the last push, fix what it confirms, then push again.
5. Later, from the research (recommended order): unattended session start (no trust/MCP prompts: move the MCP server into
   plugin.json, launch workers with --settings), correct status detection (SessionEnd, StopFailure, AskUserQuestion,
   exited Claude), then the approval card / safer approving, cheaper status polling and hooks, desktop notifications.

## Decisions to keep
- Reviewer model: Opus 5.5 (the user chose it over Fable/Sonnet). Reviews at milestones, not every turn.
- Never push to main; pushes go to `axa-v2-hub` and only with the user's OK.
- Kokoro (Apache-2.0, offline) over Piper (non-commercial voices) and edge-tts (sends text to Microsoft).
- The user wants minimal input: run work through worker sessions, verify their claims, report briefly.
