# Performance baseline (main @ 8bab5e3, before v2)

Measured 2026-10-21 with `node scripts/perf.mjs --json` (8 shell sessions on a private test console,
the session list polled at 1s/2s/2s plus a timed request every 500ms, terminal app at 120x32 in a PTY).

| Run | loop max ms | loop p99 ms | seconds with stall > 50ms | /api/terms median / max ms | terminal app idle bytes/s |
|---|---|---|---|---|---|
| 1 | 50.5 | 8.8 | 1 | 3.0 / 51.9 | 4399 |
| 2 | 40.8 | 6.6 | 0 | 2.8 / 39.2 | 4529 |
| 3 | 35.9 | 9.2 | 0 | 2.9 / 33.8 | 4529 |
