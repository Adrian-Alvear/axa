# Performance baseline (main @ 8bab5e3, before v2)

Measured 2026-10-21 with `node scripts/perf.mjs --json` (8 shell sessions on a private test console,
the session list polled at 1s/2s/2s plus a timed request every 500ms, terminal app at 120x32 in a PTY).

| Run | loop max ms | loop p99 ms | seconds with stall > 50ms | /api/terms median / max ms | terminal app idle bytes/s |
|---|---|---|---|---|---|
| 1 | 50.5 | 8.8 | 1 | 3.0 / 51.9 | 4399 |
| 2 | 40.8 | 6.6 | 0 | 2.8 / 39.2 | 4529 |
| 3 | 35.9 | 9.2 | 0 | 2.9 / 33.8 | 4529 |

## After Phase 0 (background screen refresher, poll guard/backoff)

| Run | loop max ms | loop p99 ms | seconds with stall > 50ms | /api/terms median / max ms | terminal app idle bytes/s |
|---|---|---|---|---|---|
| 1 | 8.9 | 6.9 | 0 | 2.5 / 3.7 | 3188 |
| 2 | 8.6 | 7.1 | 0 | 2.4 / 4.3 | 3320 |
| 3 | 9.4 | 7.5 | 0 | 2.4 / 4.3 | 3188 |

## After v2 (Phases 0–4; Phase 3's frame diffing, synchronized output and no forced redraw)

Measured 2026-10-22 on axa-v2 after merging all phases. The idle bytes left come from the status bar's
clock (hours:minutes, one small write a minute).

| Run | loop max ms | loop p99 ms | seconds with stall > 50ms | /api/terms median / max ms | terminal app idle bytes/s |
|---|---|---|---|---|---|
| 1 | 9.3 | 7.1 | 0 | 2.5 / 5.6 | 14 |
| 2 | 9.3 | 7.0 | 0 | 2.5 / 4.4 | 24 |
| 3 | 9.7 | 7.3 | 0 | 2.4 / 5.1 | 14 |
