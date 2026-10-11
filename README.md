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

- **Terminals:** press **Terminals → +** to launch Claude Code (or a plain shell) in any project, right inside the dashboard. Run several projects side by side; the map follows whichever tab you're in. Terminals keep running if you reload the page.

Env: `AXA_PORT` (default 4747), `AXA_HOME` (default `~/.axa`).

### Security

The console can open terminals, so it is locked down: it listens on `127.0.0.1` only, rejects
requests from other hosts or websites, and needs a secret token (stored in `~/.axa/console-token`)
that the server's unlock link exchanges for a strict same-site cookie. Don't share the unlock link.

## Privacy

Everything stays on your machine. Events are a local JSONL file; prompts and agent
reports are clipped to 2KB each. Delete `~/.axa/events.jsonl` any time.

## License

MIT
