# AXA

A JARVIS-style orchestrator for [Claude Code](https://code.claude.com).
You talk to AXA; AXA breaks the work down, hands each piece to the right agent
and skill, runs them in parallel, checks the results, and reports back — and a
live console shows you every agent, skill and tool call as it happens.

```
                ┌──────────── researcher ── WebSearch, WebFetch
     you ──▶  AXA ─────────── builder ──── Read, Edit, Bash, ⚡cloudflare
                └──────────── reviewer ─── Bash: build ✓
```

## What's inside

| Piece | What it does |
|---|---|
| `skills/axa` | The orchestrator playbook: decompose → assign from your roster → run in parallel → verify → short report. Triggers on `/axa`, "split this up", "use agents", etc. |
| `agents/` | `axa:builder`, `axa:reviewer` (read-only), `axa:researcher` (web). |
| `bin/axa` | The commander from any terminal: `axa` starts it, `axa console` opens the dashboard, `axa status` lists sessions, `axa stop` stops everything. |
| `mcp/` | The commander's session tools: open a session per project, give it a goal, check its status and last report, read its screen, close it. |
| `hooks/` | Logs every prompt, tool, skill and subagent event to `~/.axa/events.jsonl`. Async — never slows Claude down. |
| `console/` | Local web UI: AXA in the center, agents appearing as they're dispatched, a live progress dock, and embedded Claude Code terminals for any project. |
| `roster.example.md` | The config you customize: roles, models, house rules, your projects. |

## Install

```
/plugin marketplace add Adrian-Alvear/axa
/plugin install axa@axa
```

Or try it from a local clone without installing: `claude --plugin-dir ./axa`.

Needs Node 18+. The console installs its own dependencies (`node-pty`, `xterm`) on first launch.

## The commander (one place to run every project)

```
ln -s ~/path/to/axa/bin/axa ~/.local/bin/axa   # once
axa                                             # in any terminal
```

`axa` starts the console in the background (if it isn't running) and opens a Claude Code session
that is your commander. Tell it what you want across projects ("keep going on v7 in launches, and
have the feed fix its phone layout"): it opens a session per project in the console, hands each its
work (`/goal` for long runs), tracks their status, and reports back. The same commander is in the
console under **Terminals → AXA commander**, and every session shows up there live.

Project sessions run in Claude Code's **auto mode** and load AXA only for tracing (they can't drive
other sessions). When one needs your approval, the commander tells you which; you answer it in that
session's tab. The commander never answers permission, trust, or setup prompts itself.

## Make it yours

```
mkdir -p ~/.axa && cp roster.example.md ~/.axa/roster.md
```

Edit `~/.axa/roster.md`:

- **Roles** — add a row per agent you want AXA to use (built-ins, `axa:*`, or your own from `~/.claude/agents/`), and pick its model.
- **House rules** — things every agent must follow ("never push to main", "tests after the feature").
- **Projects** — paths and stack notes AXA pastes into agent prompts so they don't start blind.

Your roster lives outside the plugin, so updates never overwrite it.

### Make AXA always on (optional)

By default AXA runs when you ask for it. To have it route *every* request — just do it,
use a skill, or delegate — add this to `~/.claude/CLAUDE.md`:

```markdown
# AXA mode
For every request, pick the cheapest route: small stuff inline; load a matching skill
when one fits; for multi-part or large work load the `axa` skill and delegate
(standing permission to spawn subagents). Confirm before pushing, deploying, deleting
or writing to databases. Keep replies short.
```

## The console

```
/axa:console
```

or run it yourself: `node console/server.mjs --open` → http://localhost:4747

- **Center:** AXA (your main session). **Orbit:** each subagent, glowing while it works.
- **Satellites:** the tools (grey), skills (⚡ violet) and agent spawns (➜ amber) each node has called, sized by count, flashing on use, red on failure.
- **Click a node** to see the prompt it was given and what it reported back.
- **Session picker** follows your most recent session automatically.

- **Terminals:** press **Terminals → +** to launch Claude Code (or a plain shell) in any project, right inside the dashboard. Sessions started here are traced and run in auto mode. Run several projects side by side; the map follows whichever tab you're in. Terminals keep running if you reload the page.

Env: `AXA_PORT` (default 4747), `AXA_HOME` (default `~/.axa`). The event log is capped at 50MB
(the previous one is kept as `events.1.jsonl`).

### Security

The console can open terminals, so it is locked down: it listens on `127.0.0.1` only, rejects
requests from other hosts or websites, and needs a secret token (stored in `~/.axa/console-token`)
that the server's unlock link exchanges for a strict same-site cookie. Don't share the unlock link.

## Privacy

Everything stays on your machine. Events are a local JSONL file; prompts and agent
reports are clipped to 2KB each. Delete `~/.axa/events.jsonl` any time.

## License

MIT
