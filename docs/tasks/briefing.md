# Task: AXA tells the user about every notification, and reviews all projects in progress

Repo /home/adrianwsl/axa, branch axa-v2. Two parts, IN ORDER, each its own local commit (git -c user.name="Adrian Alvear"
-c user.email=adrianalvear09@gmail.com commit, message ending with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>").
Stage only your files; copy this spec to docs/tasks/briefing.md in the first commit. Never push. Don't restart the daemon
(say it needs `axa restart`). Don't modify ~/.axa or ~/.claude.json yourself; tests use temp dirs/HOME.
Run `npm test` and plain `node --test` after each part; both must pass.
Why: the user wants to hear from AXA about everything that happens without watching the screen, and wants one place to see
and drive all their projects (e.g. /home/adrianwsl/feed: a Next.js app with docs/HANDOFF.md listing "Next up").

## Part A: notifications (commit "Notify: every session event reaches the user (chat, voice, desktop)")
1. One notification stream in the daemon (src/core/notify.mjs): session done (with its one-line report), waiting (what it
   wants), failed / limited / exited / stuck / needs trust, milestone review verdicts, fixer rounds, link fired, approver
   decisions that DECLINED something. Each item: { id, at, kind, session, project, title, body, needsUser }. Keep the last 200
   in ~/.axa/notifications.jsonl (the daemon may write ~/.axa). De-duplicate repeats of the same state within 60 s.
2. Commander chat: each notification appears as a compact "⚙ notice" line (role system, like supervisor notes, not "You").
   The supervisor wake to the commander stays as it is; notifications are for the USER and don't cost commander tokens.
3. Voice: when voice is on, speak notifications that need the user or finish work ("feed finished: …", "axa needs you: …"),
   rate-limited (no more than one per 20 s; batch the rest into "3 more updates on screen"). Setting notify.voice
   (all | needs-you | off, default needs-you + done).
4. Desktop notification (setting notify.desktop, default on for needs-you): WSL -> Windows toast via powershell.exe
   (BurntToast not required; use the built-in Windows.UI.Notifications API or a balloon fallback), macOS -> osascript
   `display notification`, Linux -> notify-send if present. Never block the daemon; failures are logged once.
5. Hub: a bell in the title bar with an unread count; `n` opens a Notifications overlay (newest first, click/Enter jumps to the
   session, `c` clears). Mouse clickable like the other overlays. GET /api/notifications for the web console.
Tests: event replays produce the right notifications; dedupe; rate limit; per-OS command builder (pure function, not run).

## Part B: projects review (commit "Projects: review every project in progress, drive it from the hub")
1. src/core/projects.mjs: for each known project (the same list list_sessions prints) collect, cheaply and read-only:
   branch, ahead/behind upstream, uncommitted file count, last commit (age + subject), worktrees, open AXA sessions and their
   status, last milestone review verdict, and the "Next up" / "In progress" sections of docs/HANDOFF.md (or HANDOFF.md,
   TODO.md) if present (first ~8 items). No network, no builds. Cache 60 s.
2. MCP tool for the commander: review_projects() -> a compact per-project summary (so the commander can answer "what's going on
   in my projects" and propose next steps). CLI `axa projects` prints the same. GET /api/projects.
3. Hub Projects tab: one card per project with that data, idle projects marked "idle 7 weeks", and actions by key and mouse:
   Enter opens/attaches its session (opens one if none), `g` asks for a goal text and starts it in that project's session
   (reusing start_goal), `r` runs a milestone review there, `h` shows the full handoff file. Never push or deploy from here.
4. Daily brief: optional setting notify.brief_at ("09:00", default off): once a day the daemon posts one notification
   summarising all projects (what changed since yesterday, what's waiting, top "Next up" per project).
Tests: projects.mjs against temp git repos (ahead/behind, dirty, handoff parsing); review_projects output shape.

## Report (<= 10 lines)
What changed per part, test counts, what needs `axa restart`, anything left undone, anything the user must do once.

## Part C: spoken summaries instead of "read the rest on screen" (commit "Voice: speak a real summary of long replies")
Why: the user often isn't looking at the screen; that's why voice exists. Today a long reply is cut to its first paragraph plus
"You can read the rest on screen", so the important part is lost.
1. When a reply (or notification batch) is longer than the short limit, the daemon makes a SPOKEN SUMMARY with a fast model:
   `claude -p --model claude-haiku-5-5` (read-only: no tools, --allowedTools none / equivalent; hard timeout 10 s; run
   with the reviewer's isolation so it never touches project files). Prompt: "Rewrite this for speaking aloud to the user
   who is not looking at the screen. 2-5 short sentences, conversational. Keep every decision, number that matters, result,
   and especially any question or choice the user must answer (say the options). No markdown, no file paths, no commit ids.
   Don't say 'on screen'." Then the existing speech normalizer runs on it.
2. If the summary fails or times out, fall back to today's behaviour, but end with a natural line only if something was
   left out ("There's more detail in the chat."); never mid-sentence cuts.
3. A reply that asks the user something must always have the question spoken, even when short-cut.
4. Settings voice.summary: model | first-paragraph (today) | full; default model. Cache by reply hash; the summary call must
   not block the hub (speak when ready; Esc still stops). Show "🔊 speaking summary" in the status bar.
5. Same summariser for spoken notifications batches (Part A.3) and the daily brief (Part B.4).
Tests: a fake summariser command (env AXA_SUMMARY_CMD, guarded with NODE_TEST_CONTEXT like the other fixtures): long reply
-> summary spoken; timeout -> fallback with a full sentence end; question always present. Play one real before/after pair
on the Windows speakers through AXA's voice path (the user will hear it).
