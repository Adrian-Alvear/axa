# Task: Workspace, a calmer, cleaner look (the user finds it cluttered / cramped)

Same worktree and branch (axa/workspace). Same rules: small local commits (git -c user.name="Adrian Alvear"
-c user.email=adrianalvear09@gmail.com commit, message ending "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"),
never push or merge, don't touch the user's daemon (4747), ~/.axa or ~/.claude.json. Copy this spec to
docs/tasks/workspace-clean.md in the first commit. Keep all behaviour and keys (and the 16 mouse checks in
/tmp/axa-map/workspace/harness/mouse-e2e.mjs passing; update the script's coordinates if the layout moves).

## What's wrong today (see /tmp/axa-map/workspace/ws-4-panes.png and ws-needs-you.png)
- 4 rows of chrome on top (title, hub tabs, yellow needs-you bar, workspace tab bar) + a key footer: the panes get squeezed.
- Every pane is a full box, next to other boxes: double borders, little air.
- The sidebar lists every space AND a long AGENTS list with truncated names ("general-purpose…"), all at the same
  weight; glyph noise everywhere.
- Too many colours at full strength; numbers and icons (□ ✕ 1 2 3) on every title.

## Direction (the user's reference: herdr, a calm agent multiplexer)
1. Chrome: ONE top line on the Workspace: layout tabs on the left (1 2 +), a compact "▲ 2 need you" chip (click/Space jumps)
   and the clock on the right. The hub's tab row stays reachable (Esc / number keys) but isn't drawn on this screen, or is
   folded into the same line if it fits. No key footer; a dim "Ctrl-b ? keys" at the far right of the top line is enough.
2. Panes: no boxes. Panes are separated by a single thin divider (│ between, ─ above a lower pane) in a dim colour.
   Each pane has a one-line header: name in normal weight, status as a small coloured dot + word, branch dim; the
   focused pane gets an accent left bar (▎) on its header and a brighter header; the others are dim. Zoom/close icons
   only appear on the focused pane's header (mouse still works). One column of padding inside each pane.
3. Needs-you pane: the header turns amber with "needs you · y approve · x decline"; no amber box around the whole pane.
4. Sidebar (~22 cols, separated by one dim │): SPACES only by default: status dot, name, a dim agent count ("·3").
   Agents show nested under the FOCUSED pane's space only (up to 4, short names: researcher, reviewer, builder, explore,
   general -> "helper", plan; current step dim), "+N" for the rest. A finished space is dim. Section labels small and dim.
5. Colour discipline: one accent (the theme's) for focus, amber only for needs-you, red only for failed/stuck, green only
   for done; everything else normal or dim. No bold except the focused pane's name.
6. A per-pane footer like Claude Code's / herdr's is NOT needed (the session draws its own status line inside the pane).
7. Narrow windows (< 120 cols): sidebar collapses to dots + 3-letter names; at < 90 it hides (Ctrl-b s toggles it).

## Checks
- Pure tests updated/added for the new header/sidebar rows and layout math; `npm run check` passes.
- Mouse e2e script passes all checks.
- Before/after screenshots at 200x55 (1, 2, 4 panes, needs-you) and 100x30 under /tmp/axa-map/workspace/clean/, named
  before-*/after-*. Control screen unchanged (compare).
- Report in <= 6 lines.
