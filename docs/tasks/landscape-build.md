# Task: AXA improvements from the landscape research

Repo /home/adrianwsl/axa, branch axa-v2. First copy
/tmp/claude-1000/-home-adrianwsl/8bea01ba-fcd2-4bbd-973a-6447d445c6e1/scratchpad/axa-landscape.md to research/landscape.md and this spec
to docs/tasks/landscape-build.md (first commit). Read the research file: it is why each part exists (sources named there).
Rules: local commits only, one per part (git -c user.name="Adrian Alvear" -c user.email=adrianalvear09@gmail.com commit, message ending
"Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"), stage only your files, never push, don't restart the user's daemon (4747),
don't modify ~/.axa or ~/.claude.json yourself (tests use temp HOME; the daemon may write ~/.axa at runtime). `npm run check` passes
after each part. UI parts: before/after screenshots against a separate test daemon (like docs/tasks/hub-visual.md) under
/tmp/axa-landscape/. Keep it simple and deterministic where possible (the research's main criticism: too much machinery).

## Part 1: cost and limits ("Usage: per-session tokens and cost, limits, runaway loops")
- Per session: tokens in/out, estimated cost (from the session transcripts/statusline data AXA already reads; label every number
  "official" when it comes from Claude Code itself, else "estimate"), per project per day, and the account's 5-hour / weekly limit
  % when available (Claude Code status line data). Hub: a Usage panel/tab + status bar figure; list_sessions and `axa usage`.
- Warn (notification, needs-you only past the threshold) when one session burns > X tokens in 15 min without a commit or a turn
  end, or a goal/loop keeps spending after its goal is met; the user's budget (if set) still applies.
## Part 2: review queue ("Review queue: finished work waiting for you, and a worker cap")
- A queue of finished work: per session/branch, commits not yet pushed/merged, diff size (+/-, files), checks result, reviewer verdict,
  and a "ready to land" mark when checks pass and the reviewer approved. Hub list + `axa queue`; commander tool review_queue.
- Worker cap: setting sessions.maxWorking (default 5): the commander's start_goal/send that would exceed it gets a clear error
  telling it to wait or queue (the next goal starts when a slot frees, via the existing links mechanism or a simple queue).
## Part 3: design fixes ("Hub: one needs-you, Ctrl+P, Space to next, context footer, quieter log")
- One urgency component: the banner is the single call to action (y/x/go); the other places become small quiet badges.
- Ctrl+P command palette: fuzzy search over sessions, projects, actions and settings, showing each action's key.
- Space: jump to the next session that needs you, with its prompt inline.
- Footer generated from one keymap per screen: at most ~6 keys for the current screen, the rest under `?` (help generated from
  the same keymap so it can't drift).
- Log: collapse repeats ("AXA woke the commander ×4"); short confirmations as 3 s toasts.
- Empty panels collapse or show one line with the action ("No chats yet, N starts one"); the map switches to dense rows when it's
  mostly empty or has > 6 sessions; idle ring animation stops when nothing works (motion only for meaning).
- Glyph widths: one grapheme-aware width function; untrusted text (handoff, chats) sanitized so emoji/ZWJ/CJK can't break columns.
- Synchronized output (mode 2026) frames when the terminal supports it (probe once; tmux passes it only if supported).
## Part 4: approver hardening ("Approver: sees only goal + command, circuit breaker, fail to ask")
- The LLM approver's input: the session's goal/latest prompt + the raw tool call only, no tool output / assistant prose / file
  contents (prompt-injection surface); add tests that injected text in tool output can't reach it.
- Circuit breaker: after 3 consecutive or 20 total declines in a session, stop deciding and ask the user (notification).
- Timeout or error: always ask the user, never approve (verify and test).
- Whole command chains: each part of `a && b | c`, `$(...)`, redirects scored; the most restrictive wins; decline messages say
  what to do instead.
- Audit log of decisions (structure, not secrets) and `axa approver test "<command>"` dry run.
## Part 5: diff comments to the agent ("Review: comment on a diff, the session gets it as its next task")
- In the hub's changes view (d) and the web console: select a line/hunk, add a comment; "send" packs all comments (file:line + text)
  into one message to that session (through the existing safe send path), shown in its chat.

## Report (<= 10 lines)
What changed per part (commits), tests, screenshots, what needs `axa restart`, anything not done.
