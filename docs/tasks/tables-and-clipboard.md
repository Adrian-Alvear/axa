# Task: readable markdown tables in the Commander panel + correct Unicode when copying on Windows

Repo /home/adrianwsl/axa, branch axa-v2. Commit locally at the end (git -c user.name="Adrian Alvear"
-c user.email=adrianalvear09@gmail.com commit; message "Commander chat: render tables and emphasis; copy keeps Unicode on
Windows", plus "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"). Never push. Don't revert other changes; another
worker is editing src/tui/app.mjs settings, src/core/voice.mjs and bin/axa at the same time: avoid those files except
where strictly needed (keep any app.mjs change minimal and re-read before editing). Don't restart the daemon.

## 1. Tables (src/tui/control.mjs wrapMsg(), used by the Commander panel; also the chat preview in app.mjs if it uses
wrapMsg)
Today a markdown table comes out as raw text, e.g.
  | When | What runs | Cost | |---|---|---| | Every worker turn | The cheap checks only: … | Almost free | …
(the user saw exactly this). Render GitHub-style tables (a header row, a |---| separator row, body rows; cells may contain
**bold**, `code`, *italics*, links):
- Wide enough (the natural column widths fit, or can be shrunk so every column gets >= 8 chars): an aligned grid with
  light box drawing: header row in bold/"head" role, a ─ rule under it, columns separated by " │ ", cell text word-wrapped
  inside its column (multi-line rows), a blank line between rows only if any cell wrapped. Column widths: start from the
  content max, shrink the widest columns first until it fits the panel width.
- Too narrow (more than ~4 columns at the panel width, or a column would go under 8): stacked "cards": for each body row,
  first cell in head style as a title line, then "  <header>: <value>" lines for the other cells (wrapped with a hanging
  indent), a blank line between rows.
- Markdown inside cells and in normal text: remove ** and __ (render bold as the head role where the line builder allows
  segments; otherwise just strip), remove single *x* / _x_ italics markers (careful: not in snake_case words, file globs
  like *.mjs, or bullets), keep `code` text without backticks, links -> their text.
- Keep the existing behaviour for bullets, numbered lists, code fences and headings.
## 2. Copy keeps Unicode on Windows/WSL (src/tui/clipboard.mjs copyToClipboard)
clip.exe reads stdin in the console code page, so UTF-8 like "–", "✓", "é" becomes "ΓÇô" (the user saw "2ΓÇô3" for "2–3").
Fix: on WSL write the text as UTF-16LE with a BOM to clip.exe (Buffer.from("﻿" + text, "utf16le")), or use
powershell.exe Set-Clipboard reading UTF-8 from stdin; pick the one that verifiably round-trips. Keep OSC 52 and the
other platforms as they are, and keep the AXA_CLIPBOARD_FILE test hook (UTF-8).
## Checks before you finish
- node --check; node --test test/*.test.mjs all pass.
- Unit tests for the table renderer: the exact 3-column table above at panel widths 60 (cards or a tight grid) and 120
  (grid); every output line's display width <= the width; cells wrap without losing words; italics/bold/code stripped;
  snake_case and *.mjs untouched; a table with 6 columns at width 60 -> cards; a non-table line containing "|" untouched.
- Offscreen render: the mock /tmp/claude-1000/-home-adrianwsl/8bea01ba-fcd2-4bbd-973a-6447d445c6e1/scratchpad/maptest/m.mjs
  already has a cmdMsgs entry with a small table: confirm it renders as a grid and rows are exactly W wide at 196x66 and
  110x30. Paste one rendered panel excerpt in your report.
- Clipboard round trip on this WSL machine: copy "2–3 ✓ é ⚠" with copyToClipboard (no AXA_CLIPBOARD_FILE), read it back
  with powershell.exe -NoProfile -Command "Get-Clipboard" (decode its output as UTF-8 via
  [Console]::OutputEncoding=[Text.Encoding]::UTF8), and confirm it matches. Restore nothing else.
- Report in <= 6 lines.
