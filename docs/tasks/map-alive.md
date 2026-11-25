# Task: make the live lanes feel alive (motion that shows real work)

Repo /home/adrianwsl/axa, branch axa-v2 (lanes just merged: src/tui/lanes.mjs, test/lanes.test.mjs, docs/tasks/map-lanes.md).
Commit locally in small logical commits (git -c user.name="Adrian Alvear" -c user.email=adrianalvear09@gmail.com commit,
message ending "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"). Copy this spec to docs/tasks/map-alive.md in the
first commit. Never push. Don't restart the user's daemon (4747); don't touch ~/.axa or ~/.claude.json.

## Why
The user saw the lanes with 14 sessions / 25 agents (demo below) and wants the map to feel LIVE: lines moving, agents
visibly working, interactions you can see happen. "Use imagination." Motion must still MEAN something (every movement is
a real event), stay calm when nothing happens, and never cost much CPU.

## Build (each item small and pure where possible; motion "reduced" keeps only colour changes, "off" keeps all still)
1. Step packets: each tool call (session or agent) launches a small glyph (•) that travels along that lane's row (or the
   agent's branch line) from the name toward the "doing" text over ~600 ms, coloured by tool kind (read/search = blue,
   edit/write = green, bash = amber, web = violet, agent spawn = white). Several packets can be in flight; cap ~3 per row.
2. Agent branches that grow and fold: agents hang off their session as a small tree (├─ / └─ connectors). A new agent's
   branch draws itself out over a few frames (─ grows, then the name types in); a finished agent flashes ✓ and its branch
   folds back. Show up to ~3 agents per session as branch lines (each: spinner, type, current step), then "+N more".
   Selected lane shows all its agents.
3. Breathing status glyphs (Claude Code style): working uses the ping-pong spinner · ✢ ✳ ✶ ✻ ✽ ✻ ✶ ✳ ✢ (~100 ms);
   needs-you pulses (colour eased between amber and bright amber with a cosine ease); stuck flickers slowly; done flashes
   once then fades to dim over ~2 s; failed stays solid red.
4. Shimmer: on a working lane the "doing" text has a brighter band sliding across it (colour lerp per character); when the
   doing text changes it types in (a few characters per frame) instead of jumping.
5. Live strip: the activity strip's newest cell pulses on each event, and a thin playhead (▏) marks "now".
6. Commander pulse: the AXA lane's strip becomes a heartbeat line (─ with a ╱╲ spike on each commander event). When the
   commander sends to a session (send_to_session / start_goal / open_session events), a dot travels down the gutter from
   the AXA lane to that session's lane.
7. Row moves: when a lane changes group (e.g. working -> needs you), it slides to its new place over a few frames instead
   of jumping; a lane that just started fades in.
8. Colour: blend between theme tokens (RGB lerp) with a fallback to plain named colours when the terminal or theme has no
   truecolor; respect the existing Motion setting and AXA_REDUCED_MOTION.
9. Terminal safety: only glyphs already proven single-width in this hub (src/tui/width.mjs; remember ✉ was two wide in
   Windows Terminal); a plain fallback set if a glyph is risky. Mode 2026 frames as today.
10. Cost: one animation clock (~12 fps) that only runs while something is in motion; redraw only when a frame differs;
   measure the hub's CPU with the demo running (target: under ~5% of one core at 200x55) and report the number.

## Demo and checks
- Demo harness (not in the repo, keep it that way): /tmp/axa-map/harness/fixture.mjs + ticker.mjs + shoot.mjs.
  `node /tmp/axa-map/harness/fixture.mjs <src> /tmp/axa-map/<run> demo` starts a private daemon on 4858 (temp HOME and
  AXA_HOME under /tmp/axa-map) with 14 sessions, many agents and a ticker adding live events; shoot.mjs screenshots it.
  The user may be running the demo hub on 4858 right now: run yours on another port (copy the harness and change PORT,
  e.g. 4859, socket axa-4859) so you don't kill theirs.
- Pure tests for packets (position over time, cap), branch grow/fold states, spinner/pulse frames, shimmer colours,
  row-slide interpolation, the reduced/off modes.
- `npm run check` passes.
- Screenshots: a burst of 6 frames ~150 ms apart at 200x55 from the demo (so motion can be seen across them), plus 100x30,
  under /tmp/axa-map/alive/. Then update /tmp/axa-map/demo/hub.sh is NOT needed (it runs ~/axa directly).
- Report (<= 8 lines): what moves and why, CPU number, anything left out, and that the user needs `q` + `axa` to see it.
