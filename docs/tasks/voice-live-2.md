# Follow-up: voice ideas from the research (do after voice-live.md parts A-C)

Repo /home/adrianwsl/axa, branch axa-v2. Same rules as docs/tasks/voice-live.md (local commits only, never push, don't restart the
user's daemon, don't modify ~/.axa or ~/.claude.json, `npm run check` passes). First copy
/tmp/claude-1000/-home-adrianwsl/8bea01ba-fcd2-4bbd-973a-6447d445c6e1/scratchpad/voice-research.md to research/voice-narration.md and
this spec to docs/tasks/voice-live-2.md. Read the research file: it lists what other projects and products do (heard, echo.ai,
readless, pchalasani's plugin, speech-dispatcher, NVDA, LiveKit, Claude Code agent view, VS Code signals, Codex) and the gaps.
Where parts A-C already do something below, adjust rather than duplicate. One commit: "Voice: ideas from the research (salience,
session voices, agent-written lines, re-alerts, focus gate)".

1. Tiers like speech-dispatcher: map to important (needs you, blocked) / message (done, failed) / text (summary) / notification
   (tool start) / progress (ticks). Important is never interrupted, cancels queued notification/progress, postpones message/text;
   text is latest-wins; notification only when idle, last one kept; the final item of a progress stream is promoted to message so a
   completion is never lost. Record which sentences were actually heard; after a preemption, don't replay what was heard.
2. Salience across sessions (heard): when several sessions have news at once, speak the strongest (needs you > failed > done) in
   full and the rest as one short project-named line; say the project name only when the speaker changes.
3. Who's talking, by ear: a distinct short earcon per event class (needs you / done / failed), and optionally a distinct Kokoro voice
   per project (setting voice.perProject on|off, default off; pick from installed voices, stable per project).
4. Agent-written spoken line (pchalasani, BMAD): AXA's worker sessions get an instruction (via the plugin's UserPromptSubmit hook
   additionalContext, workers only, never the user's own sessions unless they opt in) to end a finished turn's reply with one line
   "🔊 <= 12 words, the outcome". The daemon speaks that line at once on Stop (and strips it from the chat/notification text). The
   Haiku summary stays as the fallback when the line is missing. Measure time-to-first-audio with and without it.
5. Re-alert blockers (echo.ai): a "needs you" not answered is repeated (short form) after 60 s, then 3 and 10 min, max 3 times, stopped
   the moment it's answered or the user types in that session.
6. Focus gate (Codex unfocused, VS Code): no speech for P2/P3 about the session the user is currently viewing/typing in in the hub.
7. Heartbeat for long work (readless): a <= 10-word status at most once a minute only for work expected > 2 min (from the duration store).
8. "While you were away" recap (Claude Code agent view): when the user returns to the hub after >= 10 min idle (first key/mouse event),
   speak one recap of what happened, from templates (+ Haiku if long).
Tests for each rule (pure). Then play one real demo on the Windows speakers: two sessions finishing and one needing you at the same
time (salience line), then a re-alert. Report in <= 8 lines.

## Added (user's go, from the landscape research: Hashimoto turned notifications off, "context switching is very expensive")
9. The user controls interruptions: a "digest" mode (setting notify.mode live | digest | quiet; default live): in digest, only
   one-way doors (needs you for push/deploy/spend/accounts, failed) interrupt; everything else is held and spoken/shown as one digest
   every N minutes (notify.digestMin, default 15) or when the user presses `w`. Rank "needs you" by blast radius (one-way door >
   question > routine approval). Show the mode in the status bar; toggle from Settings and the commander (`axa notify live|digest|quiet`).
