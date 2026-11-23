# Task: unattended session start, correct status detection, remaining safety fixes

Repo /home/adrianwsl/axa, branch axa-v2. Three parts, done IN ORDER, each its own local commit (git -c user.name="Adrian Alvear"
-c user.email=adrianalvear09@gmail.com commit, each message ending with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>").
Stage only your files; copy this spec to docs/tasks/reliability.md in the first commit. Never push. Don't restart the daemon
(say in the report that it needs `axa restart`). Don't modify ~/.axa or ~/.claude.json yourself; tests use temp dirs/HOME.
Background: research/functionality.md (sections S5-S9, R1-R6, F1, "Known friction") describes each problem with file:line.
Run `npm test` and plain `node --test` after each part; both must pass.

## Part A — unattended session start (commit "Sessions: start unattended (plugin MCP server, trust status, safe early input)")
1. The MCP server is declared in the repo-root .mcp.json, which makes Claude Code show "New MCP server found in this project:
   terminals" whenever a session's folder is the AXA repo or a worktree of it. Declare it in .claude-plugin/plugin.json
   ("mcpServers", a path or inline map; check the plugin reference with `claude --help` / docs if needed) and remove the root
   .mcp.json. Make sure the commander still gets the terminals tools (it's started with --plugin-dir) and verify by inspecting
   how sessions.mjs launches the commander and workers.
2. The tools must only be exposed to the commander: mcp/axa-terminals.mjs hides them only when AXA_ROLE === "worker"; change to
   expose them only when AXA_ROLE === "commander" (S9), and check the commander is launched with that role.
3. A new session status "needs trust" when the folder-trust dialog is on screen (screen.mjs detection), shown in the hub and
   list_sessions with the hint "the user must answer the trust prompt (or run axa trust <project>)".
4. `axa trust <path>` (bin/axa; run by the USER, never by sessions; workers' policy must deny running it): set
   projects["<git repo root>"].hasTrustDialogAccepted = true in ~/.claude.json via read-modify-write to a temp file + rename,
   refuse the home folder itself, print what it changed. Test it against a temp HOME.
5. Safe early input (S6): sendText refuses input while a session is "starting" or "needs trust" or before its first
   SessionStart event, with a clear error; add an optional `wait` to open_session (MCP) / POST /api/terms that returns once the
   session is ready or waiting (timeout 60 s).
6. Start the commander in its own folder ~/.axa/commander/ (created by the daemon, which may write ~/.axa) instead of ~, because
   trust in ~ is never saved (R21). Keep existing sessions working.

## Part B — correct status detection (commit "Status: exits, failures, limits, questions, submit check, no false stuck")
1. Register SessionEnd in hooks/hooks.json and mark the session "exited" (and fire the documented "exited" supervisor wake);
   before typing into a Claude session, check tmux #{pane_current_command}: if Claude is gone and a shell is left, refuse to
   send natural-language text and report "Claude has exited in this session" (R1).
2. Register StopFailure: an API error or usage limit ends the turn as "failed" or a new "limited" status (with the reset time
   when the payload has it); map Notification types (permission_prompt, idle_prompt, elicitation_dialog, agent_needs_input,
   quota/usage notices) to waiting / ready / limited instead of only /permission/ (R2).
3. AskUserQuestion menus: a PreToolUse for AskUserQuestion marks the session "waiting" with the question; widen the screen
   regex for "Enter to select" menus (R3).
4. Submit check (R6): after sendText, wait up to 5 s for that session's UserPromptSubmit; if none, press Enter once more and
   wait again; if still none, return an error (and links are not marked fired).
5. Stuck detector: time a step spends waiting for the user's or the approver's permission must not count toward "stuck"
   (a 40-min approval wait was reported as "stuck for 83m" while the worker was working again).
Tests: replay event sequences for each case (exit, StopFailure, notification types, AskUserQuestion, permission wait then work).

## Part C — remaining safety fixes (commit "Safety: no shell/slash injection via typed text, workers can't drive AXA")
1. Typed text (send_to_session, links, supervisor) into a Claude session: refuse a leading "!" (bash mode skips hooks) unless
   confirmed_by_user is true; allow only these slash commands: /goal, /compact, /clear, /context, /cost; refuse others; strip
   control characters except newline (S7). Same rules for link text.
2. Workers must not drive AXA: deny workers (AXA_ROLE=worker) running the axa CLI (`axa ...`, `node .../bin/axa ...`) in
   hooks/policy.mjs, because the plugin's bin/ is on their PATH (S8). Keep bin/axa where it is (the user's ~/.local/bin/axa
   symlink points to it).
3. Answering prompts must not be possible for a process that merely has the console token on disk (S5): today the daemon
   accepts an answer from any local process that sends the hub's client header with the token. Make the hub prove it is the
   hub: at startup the hub gets a fresh per-process secret from the daemon over its authenticated connection only after the
   user is at the keyboard (simplest robust option you can find; e.g. the daemon writes a one-time secret into the hub's tmux
   environment or the hub creates it and registers it once on first connect, and the daemon then requires it for answers and
   rejects unregistered clients), and the web console keeps its existing browser-only check. Explain the design in the
   commit message and README, and add tests that a request with only the token and the header is refused. Don't weaken any
   existing check. If you find no robust option inside the time, stop at a clear write-up in docs/tasks/answer-auth.md and
   leave this sub-item undone (say so).
4. Policy: workers may not read ~/.claude.json or write it (trust file), and may not run `claude` with permission-skipping
   flags (--dangerously-skip-permissions, --permission-mode bypassPermissions).

## Report (<= 10 lines)
What changed per part, test counts, what needs `axa restart`, anything left undone, and anything the user must do once
(e.g. answer one trust prompt, or run `axa trust`).
