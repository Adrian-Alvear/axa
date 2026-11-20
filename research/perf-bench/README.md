Rough performance probes for AXA (not tests). Run them from anywhere, e.g. `node research/perf-bench/bench-render.mjs`; they load the AXA checkout this folder is in, or the one in `AXA_ROOT`.
`bench-usage.mjs <session id> [cwd]` times the first usage read of one Claude Code transcript (cwd: your home folder by default); `tok.js <transcript.jsonl>...` sums a transcript's token use.
`bench-capture.mjs` and `bench-cc.mjs` need a tmux server (`-L axa-perftest`) with sessions axa-p1 to axa-p30; the others need nothing set up.
