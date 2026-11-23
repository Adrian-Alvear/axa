# AXA handoff (updated 2026-11-23, work laptop -> home Mac)

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

## Also done (after the first push)
1. Kokoro neural voice (commit e9eeb1e; spec kept in `docs/tasks/kokoro-voice.md`): `axa voice install kokoro` (venv +
   sherpa-onnx + kokoro-multi-lang-v1_0, default voice `af_heart`, ~380 MB), a resident speaker (~1 s per short reply
   once warm), fallback to the system voices, WSL playback via the Windows temp folder, a pronunciation word map.
   Its independent review approved with 2 small follow-ups: the word-map comment for "AXA" doesn't match the code
   ("ax uh"), and a half-finished install (venv exists, sherpa-onnx not importable) isn't detected as broken.
   Not verified yet: macOS (run `axa voice install kokoro` there first), the real 350 MB download, the settings screen.
2. Readable markdown tables + Unicode-safe copy on Windows (commit c8d205b).

## Also done (2026-11-20)
- Milestone reviews (default mode) with a verifier <-> fixer loop: `axa review [path] [--base sha]`, review_changes for the
  commander, a fresh fixer session for confirmed findings, max 3 rounds, 15/30-min limits that really kill the review and
  everything it started. The first milestone review of the batch found 7 issues; all fixed (c0d7d9c).
- Mouse: click the commander box (or conversation) to type, ⏎ send button, clickable footer/chips, approve = two clicks,
  click/✕/outside in popups, wheel scrolls the list under the pointer (0ba68ea).
- Speech: replies normalized for speaking (pauses, symbols, numbers, code, paths, keys) and no word is dropped by Kokoro
  any more (out-of-vocabulary fallback); closing phrase "You can read the rest on screen." (523f3e0, dcbc297).
- Kokoro is installed on the work laptop (`~/.axa/voices/kokoro`, resident mode, voice af_heart).

## Also done (2026-11-23), all pushed to `axa-v2-hub` (last commit ca5956d, 290 tests passing)
- Sessions start unattended: the terminals MCP server is declared in `.claude-plugin/plugin.json` (root `.mcp.json` gone),
  only the commander (AXA_ROLE=commander) gets the tools, a "needs trust" status, `axa trust <project>` (run by the user),
  no typing before a session has started, `open_session` `wait`; a new commander runs in `~/.axa/commander/` (0d1edfe).
- Status detection: exited / failed / limited (with reset time), notification types, AskUserQuestion menus, submit check
  (retype once, then error), permission waits don't count as stuck (7af0581). Fixed after: Claude runs as a child of the
  pane's bash, so "exited" checks the pane pid has no child (6634e62); a "waiting" with nothing on screen for 10 s becomes
  ready, because Esc on a question menu fires no hook (staleWait, b9af9da).
- Safety: no leading "!" and only /goal /compact /clear /context /cost in typed text; workers can't run the axa CLI, read or
  write ~/.claude.json, or start Claude without permission checks (0ab5553). Not done: proving an answer comes from the hub
  (sessions run as the same OS user; needs sandboxing with bubblewrap + socat) -> `docs/tasks/answer-auth.md`.
- Notifications (b9af9da): every session event -> "⚙ notice" lines in the commander chat, the ◎ bell (`n` opens the list,
  `N` is now new session), spoken (rate-limited) when voice is on, desktop toast for needs-you. `GET /api/notifications`.
- Projects review (419c2dc): `axa projects`, the commander's review_projects, `GET /api/projects`, Projects tab cards
  (g goal, r review, h handoff). Daily brief: `axa brief HH:MM|off|now` or the settings row (ca5956d); off until set.
- Spoken summaries (fc41192): long replies are spoken as a 2-5 sentence Haiku summary (10 s limit, falls back to whole
  sentences + "There's more detail in the chat."); a question for the user is always said.
- Mute silences every speaking path; the approver treats the latest /goal as the task and reads the spec .md it cites,
  and no longer reuses decisions across a new goal; `npm run check` (syntax + both suites, PASS/FAIL table) (6cb5a23).
- Kokoro speaks sentence by sentence (starts in ~1 s), new words load once, a slow chunk is retried then skipped, never
  falls back to the Windows voice unless Kokoro can't start (`voiceFallback`: silent default) (1bef559).
- Milestone review of the batch: warn, 4 findings fixed (WSL player hang, Esc cancels summary, brief once a day, README);
  hub white lines fixed (✉ drawn 2 columns wide by Windows Terminal -> ◎; autowrap off; rows cleared to end) (405a3bf).

## Other projects (same day)
- feed (`~/feed`, pushed to GitHub `main`, a5cfba8): QA round 2 phone/UI polish; undated Anthropic items no longer fill
  "Today" (real dates, quiet-day widening, one story per source in Top stories); Refresh froze (a shared feed parser was
  poisoned by a Google sign-in page during source suggestions) -> now ~0.5 s. Its own docs/HANDOFF.md is current.
  The local database on the work laptop was created fresh today (7 default sources); the Mac has its own.

## Waiting on the user
- Make `axa-v2-hub` the main line: GitHub's `main` (8bab5e3) is an ancestor, so it's a clean fast-forward. Only on the
  user's explicit "yes, update main"; optionally rename GitHub's old `axa-v2` to `axa-v2-console-archive`.
- Pick a daily brief time (`,` -> Daily brief, or `axa brief 09:00`); try `axa brief now`.
- On the Mac: `axa voice install kokoro`; optionally `axa trust <project>` per project; the personal Claude Code status
  line isn't in this repo.

## Next up
1. A visual check of the new hub screens with screenshots (bell + Notifications list, Projects tab actions, settings row).
2. Kokoro installer: links for linux-aarch64 / win-x64, detect a half-finished install.
3. Proving answers come from the hub (sandboxed workers): see `docs/tasks/answer-auth.md`.
4. Later (user's call): voice input (talk to AXA instead of typing).

## Decisions to keep
- Reviewer model: Opus 5.5 (the user chose it over Fable/Sonnet). Reviews at milestones, not every turn.
- Never push to main; pushes go to `axa-v2-hub` and only with the user's OK.
- Kokoro (Apache-2.0, offline) over Piper (non-commercial voices) and edge-tts (sends text to Microsoft).
- The user wants minimal input: run work through worker sessions, verify their claims, report briefly.
