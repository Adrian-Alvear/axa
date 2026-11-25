# Task: redesign the Control screen's live map as "lanes"

Repo: the AXA repo (this worktree, branch axa/map-lanes, based on axa-v2 c9846a6). Read docs/HANDOFF.md, README.md (Control section),
src/tui/app.mjs / draw.mjs and whatever draws the live map today, plus research/landscape.md (design critique: the map is mostly empty
ring; animate only for meaning). Copy this spec to docs/tasks/map-lanes.md. Local commits only (git -c user.name="Adrian Alvear"
-c user.email=adrianalvear09@gmail.com commit, message ending "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"), never push,
don't restart the user's daemon (4747), don't modify ~/.axa or ~/.claude.json. `npm run check` passes.

The user chose this direction (keep it close to it):
```
LIVE  3 sessions · 1 needs you

◆ AXA      ▁▁▂▂▁▁▁▁▁▁▃▂▁  standing by
▲ charlie  ▃▅▇▇▅▃▁▁▁▁▁▁▁  NEEDS YOU  deploy:preview?   2m
⠹ alpha    ▂▃▅▆▇▆▅▆▇▅▆▇▆  WORKING  npm test  ~1 min left
✓ delta    ▅▃▂▁▁           DONE  README updated     5m ago
```
## Build
1. Replace the orbit map with one lane per session (commander first, then needs you > failed/stuck > working > done/idle; stable order
   within a group so rows don't jump): status glyph + name, an activity strip (events per time bucket over the last ~15 min, width
   adapts to the panel; the newest bucket at the right), status word in its colour, what it's doing now (current tool/step or the
   question it waits on), and a right column with time info (waiting 2m / ~1 min left from the duration store / 5m ago). Its running
   subagents as a dim second line or a count ("+2 agents"), only when present.
2. Selection and mouse like today: ↑/↓ or click picks a lane, Enter / second click opens the session; the needs-you lane gets y/x
   inline hints when selected. Space (next that needs you) keeps working.
3. Motion only with meaning: the working glyph spins, the newest strip bucket fills live, a needs-you lane gently pulses its glyph;
   nothing moves when all is idle. Respect the Motion setting (full / reduced / off).
4. Scales: 1 session to 15+ (scroll with a "+N more" line), any panel width from ~40 to 200 columns (drop columns in this order:
   subagents, time, doing; never cut mid-glyph; use the grapheme width helper), short heights.
5. Idle sessions older than 20 min still leave the lanes (as today), with the "N idle hidden · Sessions tab" line.
6. Empty state: "No sessions yet · N starts one · : talk to AXA".
7. Remove the orbit/ring code that's no longer used (keep the AXA identity in the commander lane, e.g. ◆ and its colour).
Tests for the pure parts: lane ordering, strip bucketing, column dropping by width, time text.
## Checks
Screenshots before (c9846a6) / after against a separate test daemon (port 4858, temp HOME/AXA_HOME, fixture sessions in all states incl.
one with subagents, and a 12-session case) at 100x30, 160x45, 220x60 under /tmp/axa-map/. Report in <= 8 lines with the screenshot paths.
