# Voice narration research (2026-11-24, four research agents; verified = page read)

## 1-repos
GitHub repos (READMEs read):
- heardlabs/heard (1.2k stars): hooks Stop/PreToolUse/PostToolUse/UserPromptSubmit; modes co-pilot/companion/focus; multi-session SALIENCE ARBITRATION: voice the strongest-signal session (blocked/decision/failure), others as short project-named lines, name prefix only when speaker changes; narration pass knows "what you've already heard"; fast LLM or local templates; hooks return immediately; quiet during calls; global pause hotkey.
- echo.ai: time-window batching (3 edits in 500 ms -> "Edited 3 files"); blocker tone + options, re-alert every 30 s up to 5x until resolved; Ollama qwen2.5:0.5b 5 s timeout, truncation fallback; voice answers via tmux send-keys.
- readless (MCP): speak_summary <=50 words, speak_blocker <=20 words interrupts + bypasses quiet hours, speak_status heartbeat for work >2 min <=10 words max 1/min; JSONL log.
- pchalasani voice plugin / cc-vox / BMAD: agent-authored marker line (📢 or COMPLETED: <=12 words) = near-zero latency, headless summarizer only as fallback; instructions via UserPromptSubmit additionalContext; just_disabled flag.
- jvosloo/claude-voice: fixed phrases "Permission needed", "Over to you", question cue on AskUserQuestion; hotkey interrupt.
- cc-hooks: sound effects for tool events, speech only for start/end/stop; TTS cache.
- BMAD/heard: per-agent voice identity.
- AgentVibes: per-project opt-in, introduces itself once.
- mcp-voice-hooks: background-agent completions don't fire hooks (unverified).
Gaps: nobody cancels stale speech, sentence streaming, or anticipates.

## 2-devs
Developers (blogs/issues verified; Reddit blocked for the search tool, HN none found):
- chatty "all" vs "dm" misses things -> tunable tiers; caps ~600 chars; strip code/URLs; transcript format unstable.
- AgentVoices: COMPLETED lines <=12 words, distinct voice per agent role, voice off for routine; wishes: "phase 2 of 5", error tones, interactive prompts.
- codeshrew: blocking playback stalls; overlap fixed by flock; per-session opt-in; stale state reset at SessionStart.
- Classmethod Kokoro: multiple sessions overlap; proper-noun dictionary.
- claude-code issue #36885: "no way to know which session is blocked waiting for input" (closed not planned); distinct sounds for permission vs finished; manual permission rejections fire no hook -> tail transcript.
- engineered.at: async hooks; Notification matchers permission_prompt + elicitation_dialog.
- pchalasani plugin: short summary, lock, per-session state, headless Claude fills missing summary.
- Imankulov: removed idle_prompt (fires after 60 s, all agents "bored").
- punt-vox: voice pool per session, chimes for needs-input.
Lessons: identity first (which session needs me: voice/earcon per session + project name), priority not per turn, freshness > completeness, earcons for state/voice for content, speak from structured state not raw text, anticipation is unmet.

## 3-products
Commercial tools (official docs read where marked):
- Claude Code (verified): Notification matchers permission_prompt, idle_prompt, agent_needs_input, agent_completed, quota_auto_resume_*; preferredNotifChannel; agent view alerts needs-input/finished/failed; Haiku row summaries refreshed max every 15 s + turn end; `claude agents --json` exposes state and waitingFor; attaching posts a recap of what happened while away. /voice is dictation only. No spoken output, ETA or heads-up.
- VS Code signals: separate sound + announcement per signal (chatRequestSent, chatResponseReceived, progress, chatUserActionRequired); no overlapping replay of the same sound; playSignalLoop repeats a cue until disposed (progress).
- Cursor (inferred): completion chime, system notification for needs-input; users ask for ETA and per-chat sound.
- Codex (verified): notify program on agent-turn-complete with last-assistant-message; notifications only when terminal unfocused option.
- Aider: --notifications / --notifications-command. Roo: manual TTS button. Jules: browser notification done/needs input. Replit, Q CLI: little.
Takeaways: needs-input/done/failed model; earcon + spoken line; silent when user is already looking at that session; nobody ships spoken summaries or anticipation.

## 4-priorart
Prior art (verified): speech-dispatcher SSIP 5 tiers important>message>text>notification>progress; important never interrupted, cancels notification/progress, postpones message/text; text latest-wins; notification only if idle, last kept; progress dropped while speaking but FINAL progress promoted to message. NVDA NORMAL/NEXT/NOW (resume after NOW). LiveKit SpeechHandle interrupt(), allow_interruptions=False, interrupt walks queue to first uninterruptible, history truncated to what was heard, resume after false interruption. Spearcons (time-compressed speech) beat single-tone earcons in identification; alarm fatigue from false alarms. Calm tech. Progress pacing changes perceived duration.
Rules: 5 tiers mapping; preempt downward only; coalesce by (session,kind) latest-wins + TTL; promote terminal event; uninterruptible only short important; record spoken sentences, resume/re-summarize after preempt; earcon per session/class, distinct timbre per session; rate limit per session + burst collapse; ETA only when quantile band tight; defer low tiers while typing.
