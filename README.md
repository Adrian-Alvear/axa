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
| `skills/verify` | Runs the project's own checks (typecheck, lint, tests, build, syntax checks) as one PASS/FAIL table, plus screenshots for UI changes. |
| `agents/` | `axa:builder`, `axa:reviewer` (read-only), `axa:researcher` (web). |
| `bin/axa` | The commander from any terminal: `axa` starts it, `axa console` opens the dashboard, `axa status` lists sessions (`--watch` for a live dashboard), `axa attach <name>` takes one over, `axa stop` stops the console (sessions keep running), `axa stop --all` ends them too. |
| `mcp/` | The commander's session tools: open a session per project, give it a goal, check its status and last report, read its screen and its changes (git diff), close it. |
| `scripts/shot.mjs` | Desktop and phone screenshots of the console (or any page) for a look-then-fix review loop. |
| `hooks/` | Logs every prompt, tool, skill and subagent event to `~/.axa/events.jsonl` (async, never slows Claude down). For project sessions only: the permission policy, the approver, and the verify gate. |
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

Project sessions run in **accept-edits mode** under AXA's permission policy and approver (below), and
load AXA only for tracing (they can't drive other sessions). Routine approvals are handled by AXA;
only one-way doors (shipping to main, deploying, publishing, accounts, spending) wait for you, and the
commander tells you which session and why. The commander never answers prompts itself.

**AXA wakes itself.** When a project session finishes, gets stuck, exits or needs you, the console
sends the commander session an automatic update: it checks the work, verifies the claims, gives the
next step if it's within what you asked, and reports back, without you having to ask. It only types
when the commander is idle and you haven't typed in its tab for 30 seconds, and at most
`AXA_WAKES_PER_HOUR` (default 30) times an hour. `AXA_SUPERVISOR=0` turns it off.

**"Done" means checked.** If a project session edits code and then tries to finish without running any
check after its last edit, AXA's verify gate (`hooks/verify-gate.mjs`) sends it back once to run the
project's checks and report the results. If there's genuinely nothing to run, it says so instead.
Doc-only edits don't trigger it. The `verify` skill does the checking: one script finds and runs the
project's typecheck, lint, tests and build (npm/pnpm/yarn/bun, Cargo, Go, pytest, `make test`) plus a
syntax check of changed scripts, and prints a PASS/FAIL table. For UI changes it also takes desktop
and phone screenshots. Turn the gate off with `"verifyGate": "off"` in `~/.axa/policy.json`, or
`AXA_VERIFY_GATE=0`.

**Parallel work in one project.** The commander can open a session in its own git worktree
(`open_session` with `worktree: "fix-login"`). The session gets its own folder,
`<repo>/.claude/worktrees/fix-login`, on branch `axa/fix-login`, so two sessions in the same repo can't
collide. Your main checkout doesn't show the folder (it's added to `.git/info/exclude`, which is
local only). Closing with `remove_worktree` removes the folder only if it has nothing uncommitted, and
the branch is always kept. Nothing gets merged unless you ask.

**Usage.** Each Claude session shows the tokens its chat has used so far (new input plus output; cheap
cache re-reads are reported separately), helper agents included, read from Claude Code's own
transcript. A resumed chat counts from its start. Set a budget per project, and AXA tells the commander when a
session goes over it, so it stops handing that session work:
`{ "default": { "budget": { "tokens": 5000000 } } }` in `~/.axa/policy.json` (or under
`"projects"`).

### From the terminal

```
axa status            # every session, what needs you first: ⚠ needs you, ◷ stuck, ● working, ✓ done
axa status --watch    # live: rings the bell when a session starts needing you; 1-9 attach, c console, q quit
axa status --json     # the same list for scripts
axa attach launches   # take over a session in this terminal (name, id or a unique prefix); Ctrl-] detaches
```

Each row shows the session's status (glyph, word and color), project, branch and uncommitted changes
(`⎇ v7-polish 3f +40 -2`), tokens used, and what it's doing or last reported. A waiting session also
shows its prompt and options on the next line; answer it with `axa attach`. Colors follow your terminal theme
and turn off when the output isn't a terminal, with `NO_COLOR`, `TERM=dumb` or `--no-color`.
Detaching leaves the session running, and the console keeps its own view of it.

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

- **Sessions list:** every project session, sorted by what needs you: needs you, stuck, working, done,
  idle, ended. Each shows its status as a glyph and a word (never color alone), what it's doing or its
  last report, its branch and uncommitted changes (`⎇ v7-polish · 3 files +40 −2`), and tokens used.
  **A session waiting on you shows the prompt and its options as buttons.** Tap one to arm it and tap
  again to send it (so a stray tap on the phone does nothing). AXA first checks the same prompt is
  still on screen, then picks that option in the session's terminal. Only you can do this, from the
  console page: the commander's tools refuse, and project sessions can't reach the console's controls.
  **Open** jumps to its terminal; **Changes** shows its diff against the last commit, plus new files
  (secret files like `.env` and keys are left out, and secrets in the diff are redacted). The
  commander gets the same diff with its `read_changes` tool, so it checks the work before calling it done.
- **On your phone:** the sessions list comes first, with big buttons, and a bottom bar jumps to
  Sessions (with a needs-you badge), Terminal, Map and Activity. Animations stop if your system asks
  for reduced motion.
- **Terminals:** press **Terminals → +** to launch Claude Code (or a plain shell) in any project, right inside the dashboard. Sessions started here are traced and run in auto mode. Run several projects side by side; the map follows whichever tab you're in. Terminals keep running if you reload the page.
- **Sessions survive restarts:** each session runs in tmux (on AXA's own socket, `tmux -L axa-<port>`, so your tmux setup is untouched). Stopping or restarting the console (`axa stop`) leaves them running, and the next start shows them again with the same ids. After a machine restart, Claude sessions are relaunched resuming their chat (marked `recovered`); plain shells are dropped. `axa stop --all` ends every session. Without tmux (e.g. a Mac without it installed), sessions end with the console as before; `AXA_NO_TMUX=1` forces that.

**Checking how it looks:** `node scripts/shot.mjs [url] [outdir]` saves `desktop.png` (1440×900)
and `phone.png` (390×844) of the console, already unlocked. It drives any installed Chrome or
Chromium headless (Node 22+, no dependencies; set `AXA_CHROME` to choose the binary).
`--eval='js'` runs code in the page first, for example to open a dialog. Agents can read the PNGs
and fix what they see.

Env: `AXA_PORT` (default 4747), `AXA_HOME` (default `~/.axa`). The event log is capped at 50MB
(the previous one is kept as `events.1.jsonl`).

### Security

The console can open terminals, so it is locked down: it listens on `127.0.0.1` only, rejects
requests from other hosts or websites, and needs a secret token (stored in `~/.axa/console-token`)
that the server's unlock link exchanges for a strict same-site cookie. Don't share the unlock link.

AXA also protects you while it works:

- **Secrets stay out of the log.** Tokens, keys, passwords and auth headers are replaced with
  `[REDACTED]` before anything is written, and `~/.axa` is readable only by you. Set
  `AXA_LOG_PROMPTS=0` to leave prompt and reply text out of the log entirely.
- **Other sessions can't give orders.** Text from a session's screen or report reaches the
  commander cleaned of hidden characters and marked as untrusted data, never instructions.
- **Dangerous shell commands need your OK.** The commander won't type recursive deletes,
  force-pushes, `reset --hard`, piped installers, or anything touching `.env`/keys into a shell
  session unless you approved that exact command.
- **Stuck sessions are flagged.** A session with a step running and no activity for 20 minutes
  (`AXA_STUCK_MINUTES`) shows as stuck and counts toward "needs you".

### Permission policy (so project sessions don't keep stopping for you)

Project sessions that AXA starts check every tool call against a policy before running it:

- **Auto-approved:** reading, searching and editing inside the project; builds, tests and installs
  (`npm test`, `npm run build`, `npx tsc`, `pytest`, `cargo test`…); everyday git (`status`, `diff`,
  `log`, `add`, `commit`, new branches, pushing a branch that isn't `main`/`master`).
- **Refused, with a reason the agent can act on:** the dangerous-command list above, editing files
  outside the project, `.git` internals, or secret files (`.env*`, keys, credentials), reading secrets,
  and anything touching AXA's own files (`~/.axa`, the console token), the console's address or tmux.
  Sessions also start without `$TMUX`, so they can't reach AXA's terminals and answer their own (or
  another session's) prompts. These are pattern checks, a strong speed bump rather than a sandbox: a
  session runs as you.
- **Everything else goes to AXA's approver** (`hooks/approver.mjs`), so you aren't asked:
  - **One-way doors always come to you:** pushing to `main`/production, deploying, publishing
    packages, changing things on GitHub or in cloud/payment accounts, sending data to websites,
    `sudo`/system changes, connecting to other machines, global installs.
  - **The rest is decided by AXA:** a quick, tool-less Claude call (~3 seconds) weighs the request
    against the session's goal and approves it, declines it with a reason the session sees (it then
    finds another way), or passes it to you if unsure. Each decision shows in the console feed.

It only applies to project sessions AXA starts, never to the commander or your own Claude sessions.
Every decision is logged. To tune it, create `~/.axa/policy.json`:

```json
{
  "default": { "allowBash": ["make test", "docker compose up -d"], "denyBash": ["terraform apply"] },
  "projects": { "launches": { "mode": "strict" }, "~/experiments/sandbox": { "mode": "off" } }
}
```

`allowBash` entries must match the whole command; `denyBash` matches anywhere. `mode`: `normal`
(default), `strict` (only refuses, never auto-approves) or `off`. Projects are matched by folder
name or full path. Approver settings go in the same places: `"approver": { "mode": "off" }` sends
every leftover prompt to you, `"approver": { "model": "haiku" }` picks its model (default `sonnet`),
`"rules": "never add new dependencies"` gives it standing instructions, and `"escalate": ["regex"]`
always asks you for matching requests.

Some of these patterns are adapted from ECC (MIT); see [CREDITS.md](CREDITS.md).

## Privacy

Everything stays on your machine. Events are a local JSONL file; prompts and agent
reports are clipped to 2KB each. Delete `~/.axa/events.jsonl` any time.

## License

MIT
