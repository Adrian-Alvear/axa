# Task: Workspace tab, several live chats side by side (herdr-style), as an experiment

Repo /home/adrianwsl/axa. You are in your own worktree on branch axa/workspace (based on axa-v2). Commit locally in small
commits (git -c user.name="Adrian Alvear" -c user.email=adrianalvear09@gmail.com commit, message ending
"Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"). Copy this spec to docs/tasks/workspace.md in the first commit.
Never push, never merge. Don't restart the user's daemon (4747); don't touch ~/.axa or ~/.claude.json.

## Why
The user runs several Claude chats at work in herdr (a terminal multiplexer for agents): a "spaces" sidebar (one per
project/branch, status dot), an "agents" list grouped by project with working/idle/blocked state, a tab bar of layouts
(1, +), and 2+ full Claude Code chats side by side, each live and typeable with its own status line. They want the same in
AXA, with the AXA commander as one of the panes. KEEP EVERYTHING THAT EXISTS: the Control screen with the lanes stays the
home screen and must look and behave exactly as today. This is a NEW tab ("Workspace"), opt-in.

## Build
1. A "Workspace" tab in the hub (next number after Projects; also in the Ctrl+P palette).
   Layout: left sidebar ~22 cols, main area split into 1-4 panes (1 = full, 2 = side by side, 3 = one big + two stacked,
   4 = 2x2), chosen automatically from how many panes are open; `|` / `-` toggle vertical/horizontal for 2.
2. Sidebar: SPACES = one row per project with an open session (status glyph + name + branch, from the data the hub already
   has), AXA first; AGENTS = running helper agents grouped by session (glyph, type, current step). Click / Enter on a
   space puts that session in the focused pane (or adds a pane if fewer than 4). The waiting ones show amber.
3. Panes: each one is a real live session view, reusing LiveView (src/tui) at the pane's size (the same machinery as
   opening a session full screen; resize the view when the layout changes). Each pane: a title bar (name, status, branch,
   context %, "needs you" in amber) and a border that is bright for the focused pane. Keys go to the focused pane only;
   focus moves by mouse click, Ctrl-b + arrow, or Ctrl-b o (next). Ctrl-b z zooms the focused pane to full size and back.
   Ctrl-b x removes a pane from the layout (never closes the session). The commander (AXA) can be a pane like any other.
   A pane may also be the mini live map (the lanes renderer at that size) instead of a session.
4. Layout tabs: a thin tab bar at the top of the workspace (1 2 3 +): each tab remembers its panes and layout; `+` makes a
   new one; saved in the hub's ui settings (ui.json, written by the hub as other settings are) so they come back after
   quitting. Keep the hub's escape key to leave the workspace back to Control.
5. Needs-you: a pane whose session waits on a prompt gets an amber border and title; y / x in that pane's title-bar
   answer it the same way the yellow bar does today (same checks: two clicks to approve).
6. Cost: only visible panes are live; hidden tabs pause their views. Measure the hub's CPU with 4 panes on the demo and
   report it (the lanes work got the hub to ~4.5% of a core; stay in that range).

## Demo and checks
- Demo harness (not in the repo): /tmp/axa-map/harness/fixture.mjs + ticker.mjs + shoot.mjs. Copy it and run your own demo
  on port 4860 (socket axa-4860): the user's demo on 4858 must keep running. Notifications are already off in the fixture.
  The fake sessions' panes only show `sleep`/a prompt file, so for the panes also start 2 sessions that print moving text
  (e.g. a loop printing lines) to show live panes; use real Claude only if it costs nothing extra (don't).
- Pure tests: layout math for 1-4 panes and both splits at several sizes, focus movement, zoom, tab save/restore, sidebar
  rows.
- `npm run check` passes. Control screen unchanged: compare a before/after screenshot of Control at 200x55 on the demo.
- Screenshots under /tmp/axa-map/workspace/: Workspace with 1, 2, 3, 4 panes at 200x55, one with a needs-you pane, one
  zoomed, and 100x30.
- Report (<= 8 lines): what works, keys, CPU, what's left, and that it lives on branch axa/workspace (not merged).
