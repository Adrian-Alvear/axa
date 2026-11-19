# AXA performance research: speed, resources, tokens

Date: 2026-11-19. Scope: render loop, tmux polling, daemon CPU/memory, startup, I/O, hook overhead, MCP latency, scaling to 10-30 sessions, and the token cost of the commander and the worker sessions. This is research only: no existing file was changed. The benchmark scripts used are in `research/perf-bench/`.

Machine: WSL2 (Linux 6.18), Node v22.23.1, tmux on AXA's socket `axa-4747`. The live daemon was running one session, the commander. Synthetic loads (30 tmux sessions, 2,000 transcripts, a 4 MB event log) ran on a separate tmux socket and under a temporary HOME/AXA_HOME. They were removed afterwards.

---

## 1. Current state: findings and measurements

### 1.1 Headline numbers

| Area | Measured | Where |
|---|---|---|
| Daemon, idle with 1 session | 80 MB RSS; 7 s CPU over 26 min uptime (~0.4% of a core) | `ps` |
| API latency, 1 session | `/api/health` 0.8 ms, `/api/terms` 0.9 ms when cached and ~5 ms on a capture miss, `/api/hub?chats=200` 1.5 ms (8.7 KB), `/api/activity` 1.0 ms (16.6 KB) | curl |
| `tmux capture-pane` via `spawnSync` | **2.9 ms per call**, blocking. 30 sessions = **87 ms of event-loop block** per uncached `listSessions()` | `bench-capture.mjs` |
| The same capture through one persistent `tmux -C` (control-mode) client | **0.23 ms per call**; 30 pipelined captures in 2.8 ms; no process spawn | `bench-cc.mjs` |
| 30 async `execFile` captures | 58 ms wall, but the event loop stays free | `bench-capture.mjs` |
| One `list-panes -a` for all 30 panes | 2.8 ms | `bench-capture.mjs` |
| Daemon scrollback `t.buf = (t.buf + d).slice(-256K)` | **~95-100 µs per PTY chunk**, per session, even with no web client. A chunk ring costs <0.1 µs | `bench-buf.mjs` |
| Hook process cost | `log-event.mjs` 27 ms, `policy.mjs` 28-32 ms; bare `node -e 0` is 20 ms. `NODE_COMPILE_CACHE` gives no gain | timed loop |
| A shell guard `[ "$AXA_ROLE" = worker ] \|\| exit 0` | **~1 ms** instead of 28 ms for non-worker sessions | timed loop |
| MCP server (`mcp/axa-terminals.mjs`) | 30 ms spawn + initialize; **~48 MB RSS idle as a worker (0 tools)**; 73 MB in the commander | `ps` |
| TUI Control frame (`controlRows`) | 1.65-2.5 ms per frame (160×45 to 240×70, 1-30 sessions) | `bench-render.mjs` |
| TUI Control output | **12.1 KB per frame and 24 of 55 rows rewritten, but only ~69 cells actually change** | `bench-render.mjs` |
| TUI live view (`rowsAnsi`) | 0.76 ms (120×40) to 1.81 ms (200×55) per frame; at the 16 ms schedule that is up to ~11% of a core while a session streams | `bench-live.mjs` |
| `listChats` with 2,000 transcripts (321 MB) | 144 ms cold; 9-15 ms warm (still a readdir and stat of every file); **`findChat` 993 ms, synchronous** | `bench-chats.mjs` |
| First `usageOf` on a 10 MB transcript | 46 ms, synchronous, in the daemon | `bench-usage.mjs` |
| Event-log replay at daemon start (4 MB) | 67 ms | timed import |
| `/events` history per web-client connect | 48 ms to build, **4.2 MB** sent | timed |
| CLI startup | `axa help` 20-30 ms / 48 MB; `axa status` 60-70 ms / 59 MB; importing `tui/app.mjs` 40 ms | `/usr/bin/time` |

### 1.2 Token figures from this machine's transcripts (`tok.js`)

| Session | API calls | Context, first call → last | Cache-read share | Notes |
|---|---|---|---|---|
| Commander (`8bea01ba…`) | 14 | 40.7k → 58.8k | 95.0% | The baseline before any work is about 40k tokens. AXA tool results were small so far |
| Research subagents (4) | 19-29 each | 28k → 154-168k | 93-95% | 2.0-3.3M cache-read tokens each. Bash and Read results dominate (64-191k chars) |
| A long single session (`3bc30849…`, 10 MB) | 141 | 39k → 405k | 98.9% | **33.6M cache-read tokens.** Read results alone were 2.7M chars. Cost grows roughly quadratically with context length |

Static AXA prompt payload, at roughly 4 chars per token:

- `commander.md`: 4,375 chars, about 1.1k tokens.
- The MCP tool list: 9 tools, 4,897 chars of JSON, about 1.2k tokens. In this session Claude Code defers it behind ToolSearch.
- Skill and agent descriptions: about 2k chars, about 0.5k tokens. The `axa` skill body (6.7k chars) loads only when invoked.

That is about 3k of the 40k baseline. **What AXA can actually control is the size of its tool results, how often the commander is woken, and how much work it repeats.**

### 1.3 Findings by subsystem (file:line)

**F1. Status reads the screen on every list (daemon hot path).**
- `summary()` (`src/core/sessions.mjs:92-113`) runs for every session on every `/api/terms`, `/api/hub`, supervisor tick and `list_sessions`.
- It calls `promptOpen` → `screenLines()` → `spawnSync tmux capture-pane` (`sessions.mjs:69-80, 85, 95`), with only a 500 ms cache (`:73`).
- A waiting session also gets `display-message` for the pane width (`:81-84`).
- Callers:
  - TUI: `pollSessions` every 1 s (`src/tui/app.mjs:886`) and `pollHub` every 5 s (`:908`).
  - Web: every 2 s (`src/web/index.html:1270`).
  - Supervisor: every 3 s (`src/core/supervisor.mjs:102-108`).
- At 30 sessions: about 87 ms of blocking, 1-2 times a second, so **~9-17% of the daemon event loop is blocked**. Web streaming and API calls stall meanwhile.
- The hook events already supply status. The screen read is only a backup (`src/core/screen.mjs:1-4`).

**F2. A daemon PTY client per session, with an O(n) scrollback.**
- `attachStream` keeps a tmux client in node-pty for every session, all the time (`sessions.mjs:214-229`), even when no web socket is watching.
- Each chunk runs `t.buf = (t.buf + d).slice(-SCROLLBACK)` (`:218`, `SCROLLBACK` 256 KB at `:65`), about 100 µs.
- tmux also renders every session to this extra client.
- Example: 30 working sessions at about 20 chunks/s is about 60 ms/s of CPU, plus about 15 MB of strings, for a buffer nobody reads.

**F3. Hooks spawn Node for every tool call, in every session that has the plugin.**
- `hooks/hooks.json`: `policy.mjs` runs synchronously on PreToolUse, and `log-event.mjs` (async) runs on 10 events. Each script starts Node first and only then checks `AXA_ROLE` (`hooks/policy.mjs:35`, `hooks/approver.mjs:16`).
- Per tool call in a worker: about 28 ms on the critical path plus 2 × 27 ms async, so **~80 ms of CPU and 3 processes**.
- Example load: 30 workers at one call every 5 s is about half a core.
- Non-AXA sessions pay the 28 ms synchronous hook for nothing. They also log events the daemon ignores, because they have no `terminal` (`src/core/events.mjs:81`).

**F4. Workers start an MCP server that exposes no tools.**
- `.mcp.json` starts `axa-terminals.mjs` in every session.
- Workers get `tools: []` (`mcp/axa-terminals.mjs:168`) but still cost about **48 MB each**: **~1.4 GB at 30 workers**.

**F5. Commander tool results are unbounded or large.**
- `read_changes` returns up to `DIFF_MAX = 400 KB` (`src/core/git.mjs:48`), about 100k tokens, which then stays in context (`mcp/axa-terminals.mjs:82-91`).
- `list_sessions` returns up to about 900 chars per session (report clipped at 600, `:38`), and appends every project in `~` and `~/projects` on every call (`:53`).
- `read_session` defaults to 60 raw screen lines (`:59-62`).

**F6. Supervisor wakes are full commander turns.**
- Each wake (cap 30 per hour, `supervisor.mjs:22`) leads to `read_session`, then `read_changes`, then "build, tests, screenshots" (`commander.md`). That repeats the verify gate's checks (`hooks/verify-gate.mjs`).
- Each step re-reads the full commander context. Gaps of more than 5 minutes mean a 1.25× cache write on the whole context.
- Wakes are only coalesced within one 3 s tick (`supervisor.mjs:85-93`).

**F7. TUI timers and row-level diffs.**
- Timers: map 150 ms (`app.mjs:907`), spinner 120 ms (`:911`), preview 500 ms (`:913`), clock 15 s (`:909`). The schedule debounce is only 16 ms (`:291`), so Control runs at about 15 frames per second.
- `draw()` diffs whole rows (`app.mjs:366-377`): 12.1 KB per frame for 69 changed cells, about 180 KB/s through ConPTY on WSL.
- No DECSET 2026 synchronized-output markers are used.

**F8. The live view re-encodes every cell on every update.**
- `rowsAnsi()` re-encodes all cols × rows cells (`src/tui/live.mjs:55-84`) after every PTY chunk (`:32`).
- Terminal emulation happens twice: once in tmux, once in xterm-headless.

**F9. Hub endpoints rescan the disk.**
- `hub()` (`src/core/server.mjs:106-117`) runs every 5 s from the TUI with `chats=200`:
  - `listChats` stats every transcript (`src/core/claude-data.mjs:57-80`).
  - `listProjects` runs twice, because `listAgents` calls it again (`src/core/catalog.mjs:68-70`).
  - Agent files are re-read each time.
- `findChat` takes about 1 s at 2,000 chats (`claude-data.mjs:82`).
- `budgetFor` re-reads `policy.json` for each session in each summary (`claude-data.mjs:129-135`).

**F10. Event ingest and history.**
- The log is tailed by a 250 ms `statSync` poll (`src/core/events.mjs:193-211`).
- Each web connect parses and re-stringifies 4 MB of history (`server.mjs:145`).
- `approver.goalOf()` reads 4 MB of log on every permission request (`hooks/approver.mjs:78-91`).

**F11. The approver is a full CLI run per decision.**
- `claude -p … --model sonnet` (`hooks/approver.mjs:133`) uses the default Claude Code system prompt, adds a git spawn (`:94`), and caches nothing.

**F12. git status runs on a timer.**
- Every 10 s per session and per project (`src/core/git.mjs:20-39`, `catalog.mjs:31`), changed or not.

**F13. The web console redraws continuously.**
- A rAF loop runs at 60 fps even when idle (`src/web/index.html:1011-1018`).

---

## 2. Recommendations (prioritized)

Effort: S (< half a day), M (1-3 days), L (> 3 days).

### R1 (P0). Take status off the screen read; batch whatever capture remains
- **Problem:** F1.
- **Change:**
  - Compute `awaiting_permission` from events first (PermissionRequest, Notification, AxaDecision). Read the screen only when a session is `working`, has `asking`, and has been quiet for more than N seconds, or on `/screen` and `answer`.
  - Run the remaining captures through **one persistent `tmux -C` client** with pipelined commands, or at least async `execFile`.
  - Raise the cache to about 2 s while `last_event_at` hasn't moved.
- **Gain:** a list of 30 sessions drops from 87 ms blocking to about 3-7 ms, or about 0.
- **Evidence:** benchmarks above; [tmux Control Mode](https://github.com/tmux/tmux/wiki/Control-Mode).
- **Effort:** M. **Risk:** low-medium. Keep the screen fallback for trust and MCP dialogs.

### R2 (P0). Ring-buffer scrollback, and attach the daemon's PTY lazily
- **Problem:** F2.
- **Change:**
  - Use a chunk array trimmed by length, joined only on connect.
  - Attach the daemon client on the first `/pty/<id>` connect and detach about 30 s after the last socket closes; seed the browser from `capture-pane -e -p -S -n`.
  - Detect exits via tmux `pane-exited` or control-mode notifications.
- **Gain:** about 1000× cheaper per chunk (935 ms vs 1.3 ms per 10k chunks). With lazy attach, unwatched sessions cost nothing, and about 15 MB plus 30 PTYs are freed.
- **Effort:** S (ring) / M (lazy). **Risk:** low / medium (exit detection, window sizing).

### R3 (P0). Make hooks nearly free
- **Problem:** F3.
- **Change:**
  - (a) Put a shell guard `[ "$AXA_ROLE" = worker ] || exit 0;` before policy, approver and verify-gate.
  - (b) Replace `log-event.mjs` with a `"type": "http"` hook that POSTs to an append-only daemon `/api/hook` endpoint, keeping the file as a fallback.
  - (c) Combine policy and log into one process where a command hook remains.
  - (d) Use `matcher` and `if` to narrow which tool calls run each hook.
- **Gain:** non-AXA sessions go from 28 ms to about 1 ms per tool call. Workers go from about 80 ms CPU and 3 processes to about 30 ms and 1 process, or about 2 ms. That saves about 0.4 of a core at 30 busy workers.
- **Evidence:** [Claude Code hooks reference](https://code.claude.com/docs/en/hooks).
- **Effort:** S / M. **Risk:** low / medium. The endpoint needs Host and Origin checks, and `terminal` must be bound to the header so workers cannot forge other sessions' events.

### R4 (P0). Give workers a hooks-only plugin
- **Problem:** F4.
- **Change:** launch workers with `--plugin-dir <root>/plugins/worker`, containing hooks and the verify skill but no MCP server (`sessions.mjs:171-174`).
- **Gain:** about 48 MB × N, about 1.4 GB at 30 workers.
- **Effort:** S-M. **Risk:** low.

### R5 (P0). Commander token diet
- **Problem:** F5.
- **Change:**
  - `read_changes`: return the diffstat plus about 12 KB by default, and page with `file`/`offset`.
  - `list_sessions`: compact lines, deltas via `changed_since`, and projects only with `include_projects`.
  - `read_session`: default to about 25 lines with chrome stripped, plus `mode:"report"` using `chatMessages` (`claude-data.mjs:148`).
- **Gain:** worst-case `read_changes` drops from about 100k tokens to about 3-4k; `list_sessions` at 30 sessions drops from about 7k tokens to about 1.5k. This compounds on every later turn, roughly 10-30% of commander input spend.
- **Evidence:** measured context growth; [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents); prompt-caching economics.
- **Effort:** S-M. **Risk:** low.

### R6 (P1). Cell-level diff, one frame clock, DECSET 2026 in the TUI
- **Problem:** F7.
- **Change:** keep a previous-frame cell grid and emit only changed runs; wrap frames in `ESC[?2026h/l`; use one animation clock at 8-10 fps, only while something animates, paused on focus loss.
- **Gain:** about 80-90% fewer bytes and about 40% fewer frames.
- **Evidence:** [xenoatom rendering](https://xenoatom.github.io/terminal/docs/rendering), [ink-terminal](https://cdn.jsdelivr.net/npm/ink-terminal@0.1.0-alpha.1/README.md).
- **Effort:** M. **Risk:** medium (wide characters).

### R7 (P1). Push instead of poll
- **Problem:** F1 and F7.
- **Change:** a summary cache invalidated by events, with deltas pushed over SSE or WebSocket. Polls become 30 s safety nets, and the supervisor subscribes to the same feed.
- **Gain:** cost scales with events instead of clients × sessions × poll rate; status in under 50 ms.
- **Effort:** M-L. **Risk:** medium.

### R8 (P1). Index chats and projects
- **Problem:** F9.
- **Change:** an in-memory chat index updated by `fs.watch` or directory mtimes; `findChat` as a map lookup; `listProjects` and `listAgents` cached for 30 s; `chats=50` with paging; `policy.json` cached by mtime.
- **Gain:** `/api/hub` about 1 ms; no 1 s resume stall.
- **Effort:** S-M. **Risk:** low.

### R9 (P1). Event ingest and history without polling or re-serializing
- **Problem:** F10.
- **Change:** HTTP ingest or `fs.watch`; history sent as pre-serialized lines capped per session or by `since`; a daemon goal endpoint for the approver.
- **Gain:** status latency from up to 250 ms to under 10 ms; a web connect from 48 ms and 4.2 MB to about 3 ms and under 300 KB.
- **Effort:** S-M. **Risk:** low.

### R10 (P1). Coalesce supervisor wakes and send a digest
- **Problem:** F6.
- **Change:**
  - Coalesce wakes over 20-45 s, except for `waiting`.
  - Put a digest in the wake prompt: status, clipped report, diffstat, and which verify-gate checks ran.
  - Change `commander.md` to spot-check rather than always rebuilding.
- **Gain:** about 2-4 fewer full-context requests per wake, and fewer wakes.
- **Evidence:** [Anthropic multi-agent system](https://www.anthropic.com/engineering/multi-agent-research-system) (about 15× the tokens of chat).
- **Effort:** S-M. **Risk:** medium.

### R11 (P1). Live view: render dirty rows only, capped at 30 fps
- **Problem:** F8.
- **Change:** a 33 ms throttle, `onWriteParsed`, and a per-line cache.
- **Gain:** 50-90%.
- **Effort:** S-M. **Risk:** low.

### R12 (P2). Event-driven git status
- **Problem:** F12.
- **Change:** refresh after edit or Bash events (at most every 3 s), and every 60 s when idle.
- **Gain:** 80-95% fewer git spawns.
- **Effort:** S. **Risk:** low.

### R13 (P2). A cheaper, faster approver
- **Problem:** F11.
- **Change:** `--system-prompt` with a short judge prompt; Haiku by default, escalating to Sonnet; a verdict cache; the goal fetched from the daemon. Alternatively, try the native `"type": "prompt"` hook.
- **Gain:** lower latency and far fewer tokens per decision. Measure before and after; billed calls were not run.
- **Effort:** S-M. **Risk:** medium; needs an eval on past `AxaDecision` events.

### R14 (P2). Usage accounting off the event loop
- **Change:** async 512 KB slices or a worker thread; persist offsets and totals.
- **Gain:** no 50 ms+ stalls after a restart.
- **Effort:** S. **Risk:** low.

### R15 (P2). Web console: draw on change only
- **Change:** run rAF only while animating, and respect `document.hidden`.
- **Gain:** near-zero idle CPU.
- **Effort:** S. **Risk:** low.

### R16 (P2, measure first). Commander and worker model, effort and context hygiene
- **Change:** a roster setting for the commander's model and effort (Sonnet 5.5 is half Opus 5.5's input price); `/compact` at worker milestones; restart the commander chat when it passes about 150k tokens.
- **Evidence:** [Claude Code costs](https://code.claude.com/docs/en/costs).
- **Effort:** S-M. **Risk:** medium.

---

## 3. Do first (top 5)

1. **R1:** status from events and batched capture. It removes up to 87 ms of daemon blocking per list at 30 sessions.
2. **R2:** ring buffer, then lazy PTY attach. About 1000× cheaper per chunk.
3. **R3a + R3b:** hook shell guards, then HTTP logging. The guards save 27 ms per tool call in non-AXA sessions; HTTP logging removes 2 of 3 Node spawns per worker call.
4. **R4:** hooks-only worker plugin. It saves about 1.4 GB of RAM at 30 workers.
5. **R5:** bounded commander tool results. The cheapest token win, and it compounds.

---

## 4. Benchmark plan

Run each step before and after the change, 3 runs each, and report the median. Scripts are in `research/perf-bench/`.

1. **Daemon scaling (R1/R2/R7).**
   - Run 10 and 30 noisy sessions on `AXA_PORT=4848 AXA_HOME=/tmp/axa-bench`.
   - Measure `/api/terms` p50/p99, event-loop delay (`monitorEventLoopDelay` behind `AXA_PERF=1`), and `pidstat` CPU and RSS.
   - Targets: p99 under 10 ms; loop delay under 20 ms; under 5% of a core.
2. **Scrollback.** `bench-buf.mjs`, plus daemon CPU with no browser open. Target: at least a 90% drop.
3. **Hooks.** Time 50 payloads per hook command; run a 100-tool-call worker task; `pgrep -fa axa-terminals`. Targets: under 2 ms for non-worker sessions; no MCP process per worker.
4. **TUI.** `bench-render.mjs`; `script -c axa` for 60 s, then `wc -c` the capture. Targets: at least 80% fewer bytes; TUI under 3% CPU.
5. **Hub and history.** `bench-chats.mjs` on 2,000 synthetic transcripts; `/events` size. Targets: hub under 3 ms; history under 300 KB.
6. **Tokens.** A fixed commander scenario repeated 3 times, then `node tok.js <transcript>`. Targets: at least 50% fewer AXA tool-result characters per wake; fewer API calls per wake; cache-hit share of at least 95%.
7. **Approver.** Replay 50 logged decisions through the old and new judges and compare agreement, latency and tokens. This is billed, so get the user's OK first.

## Sources
- https://github.com/tmux/tmux/wiki/Control-Mode
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/agent-sdk/tool-search
- https://code.claude.com/docs/en/costs
- https://www.anthropic.com/engineering/multi-agent-research-system
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching (5-minute write 1.25×, 1-hour write 2×, reads 0.05-0.1×)
- https://xenoatom.github.io/terminal/docs/rendering
- https://cdn.jsdelivr.net/npm/ink-terminal@0.1.0-alpha.1/README.md
