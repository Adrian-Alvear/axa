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
| `bin/axa` | AXA from any terminal: `axa` opens mission control (AXA and every session, live), `axa chat` the plain commander, `axa console` opens the dashboard, `axa status` lists sessions (`--watch` for a live dashboard), `axa attach <name>` takes one over, `axa stop` stops the console (sessions keep running), `axa stop --all` ends them too. |
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

`axa` starts the console in the background (if it isn't running) and opens mission control (below)
with your commander selected. `axa chat` opens the commander as a plain Claude Code session instead.
Tell it what you want across projects ("keep going on v7 in launches, and
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

### Mission control in your terminal: `axa`

```
axa          # AXA and every session, live, in this terminal
axa chat     # the commander as a plain Claude Code session (what `axa` used to open)
```

`axa` opens a full-screen mission control, like a terminal multiplexer for agents, with AXA's brain
built in:

- **Sidebar, a live diagram organized like herdr:** AXA (the commander) is the root at the top, with
  its own helper agents. Below it come **workspaces**, one per project (a worktree session belongs to
  its repo).
  - **Workspace state** rolls up from its sessions: needs you > working > done > idle, so you see which
    project needs attention.
  - **Each session** branches off its workspace, with a dot running along the branch while it works.
    It shows its status, what it's doing or asking, its branch and changes, tokens used, and its links.
  - **Helper agents** are grouped by the work they do (`● builder ×2 · ✓ reviewer`).
  - **Done stays marked (•)** until you've looked at it; then it shows as idle.
  - Click any row to open it. Prefer a compact list? Settings (`Ctrl-b ,`) → Sidebar style → list.
- **Tabs:** the row above the session shows its workspace and the workspace's sessions as tabs. Click
  one, or press `Ctrl-b n` / `Ctrl-b p`. `Ctrl-b r` gives a session your own name (like
  "reviewer").
- **Live session:** the selected session runs right there, fully interactive. Type into it as usual,
  and flip between sessions instantly. If no commander is running, one starts, so you land in AXA.
- **Answer from anywhere:** when another session needs you, a yellow bar shows its question.
  `Ctrl-b y` / `Ctrl-b x` answer with its Yes or No option (the bar names them). `Ctrl-b !` jumps
  to it.
- **Palette:** `Ctrl-b :` opens a searchable list of every action and session ("changes in feed",
  "goal for launches", "answer n2s: Yes", "theme: hud"…). Type a few letters, then press Enter.
- **Browse with previews:** `Ctrl-b s` lists every session next to a live, read-only preview of the
  highlighted one's screen. Enter shows it, `%` opens it in a split, and `d`/`g` show its diff or give
  it a goal.
- **Split and zoom:** `Ctrl-b %` puts a second live session side by side (stacked on narrow
  windows), and `Tab` switches which one you're typing into. `Ctrl-b z` hides the sidebar.
- **Search every session:** `Ctrl-b /` searches what's on each session's screen and its recent
  history, highlighting matches. Enter jumps to that session.
- **Activity at a glance:** each session's name row ends with a sparkline of its activity over the
  last 30 minutes. A strip under the panes shows the latest events across sessions in plain words:
  "AXA approved: …", "policy refused: …", "verify gate: sent back to check its work", "finished: …",
  "you answered: …". `Ctrl-b f` shows or hides the strip.
- **Floating panels:** help, the palette, diffs, checks, settings, search and browse open as panels
  over the live sessions, which keep running underneath.
- **Map (`Ctrl-b m`):** AXA at the center, every session branching off it, each session's helper
  agents hanging below it, and the links between sessions. A dot runs along the branch of each session
  that's working, and each helper shows its tool calls as leaves (`⟶ Read ×3 · Edit ×2`), with the
  one it just used lighting up.
  - **Moving around:** ↑/↓ moves through sessions *and* helpers. Enter opens a session, or a helper's
    details; Space or → shows details.
  - **On a session:** `y`/`x` answer its prompt, `d` diff, `g` goal, `l` link. Esc goes back.
- **Agents and work (`Ctrl-b a`, or click a helper row in the sidebar):** a live panel for the
  session. It shows what it's doing now, its git changes and tokens, its helper agents (each with call
  count, time and tools), its own tool calls with recent files and commands, its links, and its last
  report. Pick a helper (↑/↓, Enter) to see the instruction it was given, every tool it has called,
  updating as it works, failures, and its report, as in the web console.
- **Since you left (`Ctrl-b b`):** when you open `axa`, a briefing shows what happened while mission
  control was closed. It lists what's waiting on you, and for each session the runs that finished,
  verify-gate bounces, approvals, things that asked you, and its latest report.
- **Run history (`Ctrl-b h`):** every instruction a session got, newest first, with how long it took.
  Enter shows the details: steps, helper agents, what AXA approved or declined, policy refusals,
  verify-gate bounces, your answers, and the result.
- **Links (`Ctrl-b l`):** "when launches finishes, tell feed: rebase on it and re-run the tests". AXA
  sends the instruction once, after the first session finishes (and its checks settle) and when the
  second is idle. The commander can make links too (`link_sessions`), so you can just ask it for a
  handoff. Links show on the map, and you can remove them from the palette.
- **Actions:** press **Ctrl-b**, then `j`/`k` (or `0`–`9`) to switch sessions, `c` new session,
  `w` new session in its own worktree, `g` give a goal, `d` its diff, `v` run the project's
  checks, `o` the web console, `X` close it, `q` leave (sessions keep running), `?` for all keys.
  `Ctrl-b Ctrl-b` sends a literal Ctrl-b.
- **Settings and themes:** `Ctrl-b ,` changes them live, and they're saved in `~/.axa/ui.json`.
  - **Theme:** `terminal` (default: your terminal's own colors), `hud` (the console's cyan look),
    `light`, `contrast` and `mono`. `NO_COLOR` always means no colors.
  - **Prefix key:** Ctrl-b, Ctrl-a, Ctrl-g or Ctrl-\.
  - **Sidebar:** left or right, and its width.
  - **Bell** on or off, and whether new sessions start as Claude or a shell.
- **Mouse:** click a session to select it; scrolling inside a session goes to it.
- **Copy on select:** drag across any text in a session and it's copied when you let go (a ✓ copied
  notice confirms it). Double-click copies a word.
  - It uses your terminal's clipboard code (OSC 52: Windows Terminal, iTerm2, kitty, WezTerm…), plus
    the system copy tool where there is one (`clip.exe` on WSL, `pbcopy`, `wl-copy`, `xclip`).
  - Hold Shift while dragging to use your terminal's own selection instead.
  - Turn it off in settings (`Ctrl-b ,`), and drags go to the session again.
- **Paste an image (`Ctrl-b i`):** copy an image (on Windows: Win+Shift+S for a screenshot), then press
  `Ctrl-b i`. AXA takes it from your clipboard (on WSL through Windows PowerShell; also macOS and
  Linux). It saves it as a PNG in the project's `.claude/axa-pastes/`, which is kept out of git status,
  and types its path into the session, where Claude Code can read it.
- **Updates:** if AXA's code changes while mission control is open, the status bar says so. Press
  `Ctrl-b q`, then run `axa` again; your sessions keep running.
- It rings the bell and puts ⚠ in the window title when something starts needing you.

It shares one backend with the web console, so the terminal, the browser and your phone always show
the same thing.

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
- **Terminal comfort:** **A− / A+** set the text size (remembered per browser, a little larger on
  phones). **⌕** or Ctrl+Shift+F searches the terminal's history. Links are clickable. On desktop the
  terminal draws with the GPU, so long output stays fast (`localStorage["axa.webgl"]` = `"0"` turns that
  off, `"1"` turns it on for phones too). On a phone or tablet a key bar under the terminal has what
  the on-screen keyboard lacks: Esc (stop Claude), Ctrl (then a letter), ^C, Tab, ⇧Tab (Claude's mode
  switch), the arrows and Enter. The terminal also takes the size of whichever screen you're using, so
  switching between phone, desktop and `axa attach` no longer leaves it mis-sized.
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
  and anything touching AXA's own files (`~/.axa`, the console token), the console's address or AXA's own tmux server (tmux on a private socket is fine).
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
