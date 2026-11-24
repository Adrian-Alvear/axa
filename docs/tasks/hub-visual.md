# Task: visual check of the new hub screens (axa)

Repo /home/adrianwsl/axa, branch axa-v2. Read docs/HANDOFF.md first. Commit locally only for fixes (git -c user.name="Adrian Alvear"
-c user.email=adrianalvear09@gmail.com commit, message ending "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"). Stage only
your files; copy this spec to docs/tasks/hub-visual.md. Never push. Don't restart the user's daemon (port 4747) or touch their hub;
don't modify ~/.axa or ~/.claude.json. Run the hub against a SEPARATE test daemon (another port, temp AXA_HOME / HOME with fixture
sessions, notifications and projects), in a throwaway tmux socket.

## Check (screenshots at 100x30, 160x45 and 220x60; save under /tmp/hub-visual/ as text dumps via `tmux capture-pane -e -p` AND
## PNGs if you can render them, e.g. with a small ANSI->HTML->PNG script or aha + a headless browser if present)
1. Title bar ◎ bell with unread count (0, 3, 120); `n` Notifications overlay: newest first, needs-you items marked, Enter/click jumps
   to the session, `c` clears, mouse works, long titles cut cleanly.
2. Projects tab: cards for 3+ projects (one dirty + ahead, one idle for weeks, one with a running session and a handoff "Next up"),
   `g` goal prompt, `r` review, `h` handoff viewer (scrolls), Enter opens/attaches. Don't really start goals/reviews in real projects:
   use the test daemon and fixture repos.
3. Settings: Daily brief row, Voice rows, notify rows; clickable; values persist in the temp ui.json.
4. Switching tabs repeatedly leaves no stray lines or colours (the white-lines bug), at all three sizes, incl. wide glyphs.
5. Status bar "🔊 speaking summary" / "writing summary" states render without shifting columns.
Fix what's broken or ugly (alignment, overflow, colours, cut-off text, mouse targets), with tests where it's logic.

## Before you finish
`npm run check` passes. Report in <= 8 lines: what you looked at, what you fixed (commits), before/after screenshot paths, anything
left that needs the user's eyes.
