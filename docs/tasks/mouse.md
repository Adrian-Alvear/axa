# Task: make the hub fully usable with the mouse (click to talk to the commander, clickable buttons)

Repo /home/adrianwsl/axa, branch axa-v2. Commit locally at the end (git -c user.name="Adrian Alvear"
-c user.email=adrianalvear09@gmail.com commit; message "Hub: click to talk to AXA, clickable buttons, mouse in popups",
plus "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"). Stage only your files (also add this spec as
docs/tasks/mouse.md). Never push. Don't restart the daemon.
Why: the user forgets that ":" starts typing to the commander; clicking should just work. The keyboard stays as it is.

Read first: src/tui/app.mjs (onMouse(b, x, y, up); hits/tabHits; ctl.mapHits/chatHits/cmdTop/cmdBottom/cmdText; the drag-to-copy
selection; overlay + drawOverlay + overlayKey; footer(); controlKey focusInput/cmdInput; how the y/x keys answer a waiting
prompt), src/tui/control.mjs (controlRows: Approvals panel buttons, Commander panel input line, ctx.* hit info), src/tui/draw.mjs.

## Build
1. Commander input by mouse (Control screen): a click (press+release, no drag) on the "› Ask anything…" input line, or anywhere
   on the commander conversation that isn't a drag, focuses the input (focusInput = true; caret shown). A click outside the
   Commander panel, or Esc, unfocuses. Keep drag-to-copy and double-click-to-copy exactly as they are (a press that turns into
   a drag is a selection, not a focus click). Add a small clickable "⏎ send" button at the right end of the input line
   (sends like Enter; dim when empty).
2. Clickable footer: every key hint in the footer becomes a button that runs the same action as the key (build hit boxes while
   rendering footer(); a click runs the action as if the key was pressed). Same for the title bar's "needs you" chip (jumps to
   the first waiting session).
3. Approvals by mouse: the Approvals panel's "x Decline" / "y Approve" buttons and the yellow alert bar's options are clickable.
   Approve needs TWO clicks: the first arms it (the button reads "click again to approve", disarms after 4 s or on any other
   click/key); the second sends. Decline is one click. Before sending, check the same prompt is still the one shown. Reuse
   exactly the code path the y/x keys use today; don't add a new way of answering.
4. Popups/overlays: list overlays (settings, new session project picker, voice list, any pick list) select an item on click and
   choose it on double-click (or a click on the already-selected item); a click outside the box, or on a "✕" drawn in the
   top-right corner, closes it (like Esc); the wheel scrolls (already) and a click on "↓ N more" scrolls down a page.
   Text-input overlays keep keyboard input; clicking inside does nothing harmful.
5. Lists: on the Sessions/Chats/Agents/Projects tabs, a click selects a row and a double-click opens it (check what exists and
   fill gaps); the wheel scrolls the list under the mouse (not only the focused one).
6. Discoverability: when not typing on Control, the input placeholder reads "› Click here or press : to talk to AXA…", and the
   help page gets a short "Mouse" section (click to talk, drag to copy, double-click to copy a message, click buttons, approve
   needs two clicks, Shift+drag for the terminal's own selection).
7. Never let a click type into a live session by accident: in the live screen, mouse events keep going to the session as today.

## Checks before you finish
- node --check on changed files; `npm test` and plain `node --test` both finish and pass.
- Unit-test the pure parts you add (hit-testing helpers, the approve arm/disarm state machine).
- Real hub in a throwaway tmux server (never touch sessions on socket axa-4747): tmux -L axamouse new -d -x 196 -y 66
  "node /home/adrianwsl/axa/bin/axa"; wait 5 s; send SGR mouse clicks with send-keys -l ($'\e[<0;X;YM' then $'\e[<0;X;Ym'):
  (a) click the input line -> the typing state shows, type "hello" via send-keys, confirm it appears in the box, press Escape;
  (b) click a footer button (e.g. "? help") -> the help overlay opens; click outside -> it closes; (c) open settings with ","
  and click an item -> it's selected. Don't approve or decline anything real. Kill the server after.
- Report in <= 8 lines.
