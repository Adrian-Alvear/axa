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
`AXA_WAKES_PER_HOUR` (default 30) times an hour. When that limit holds updates back, the web console
and the terminal app say so ("AXA wake limit reached (30/h) · 3 updates waiting · resumes 14:05").
`AXA_SUPERVISOR=0` turns it off.

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
  - **Theme:** `terminal` (default: your terminal's own colors), or one of the console's themes:
    `hud` (cyan), `graphite`, `paper` (light), `solar` and `contrast`; plus `mono`. They're exact on
    truecolor terminals and quantized on 256- and 16-color ones. `NO_COLOR` always means no colors.
  - **Sync with the web console:** with it on, a theme picked here or in the web console shows up in
    both; turned off on either side, it's off for both, and each keeps its own theme.
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
axa status            # every session, what needs you first: ⚠ needs you, ◷ stuck, ● working, ✓ done, ○ shell
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

The console opens on **Home**. Five views sit along the top: **Home, Sessions, Map, Runs, Settings**
(on a phone they're bottom tabs instead: Home, Sessions, Terminal, More). The page remembers the last
view, and the address works too (`/#runs`).

- **Home: "Needs you", then "While you were away".** First come the sessions waiting on you:
  a prompt with its question and options, a stuck session with the reason, a failed one with why it
  stopped. **Tap an option to arm it, tap again to send it**, so a stray tap does nothing. AXA first
  checks the same prompt is still on screen, then picks that option in the session's terminal. Only
  you can do this, from the console page: the commander's tools refuse, and project sessions can't
  reach the console's controls. Below that is a timeline of what happened since you last looked in
  this browser (`lastSeen` is kept per browser): finished runs with a one-line outcome, verify-gate
  bounces, AXA's approvals (routine ones folded into one line per session), refusals and questions,
  failures and links that fired. A row opens its run, its session or its diff. **Mark seen** starts
  the timeline over. When nothing needs you, Home says so: *All quiet · 3 idle · last event 4m ago*.
- **Sessions:** every project session, sorted by what needs you: needs you, stuck, failed, working,
  done, idle, ended. Each card shows its status as a glyph and a word (never color alone), what it's
  doing or its last report (or the stuck or failed reason), its branch and uncommitted changes
  (`⎇ v7-polish · 3 files +40 −2`), and its spend: USD, context use and model when the console knows
  them, otherwise tokens. When GitHub data is available it also shows the branch's pull request with
  its checks and review, or the latest CI run, linked. **Open** jumps to its terminal; **Changes**
  shows its diff against the last commit, plus new files (secret files like `.env` and keys are left
  out, and secrets in the diff are redacted). The commander gets the same diff with its
  `read_changes` tool, so it checks the work before calling it done.
- **Map:** AXA's mission map: AXA's reactor in the center, each session around it, and helpers
  appearing as they're dispatched. Beside it are the selected node (the prompt it was given and what
  it reported back) and the activity feed. **Detail** shows every tool call, **Center** fits the view,
  and you can drag cards to move them. The orb in the header shows AXA's state from any view; click
  it to open the map.
- **Runs:** every instruction a session got, newest first. Each run has a timeline: steps (folded
  into stretches like `5 steps: Read ×2, Edit, Bash`), helpers started and reporting back, AXA's
  approvals and refusals, verify-gate checks, your answers, and the result. It's the same history as
  the terminal app's (`/api/runs`; one run's events come from the read-only `/api/runs/:id`).
- **Cost meter:** the header shows today's spend in USD when the console tracks cost (`/api/cost`),
  otherwise the open sessions' USD or tokens. Click it for spend per day and per session. Set a daily
  budget in **Settings**: the meter turns amber at 80% and red past it. A session over its token
  budget (`policy.json`) is flagged too.
- **Command palette:** **Ctrl-K** (**⌘K** on a Mac; inside a terminal, ⌘K or Ctrl-Shift-K) jumps to
  a session, answers a prompt, opens a diff, gives a session a goal, links two sessions ("when this
  one finishes, tell that one…"), switches theme, opens settings, and more. The keys match the
  terminal app's: **j/k** move through a list, **Enter** opens, **a** answers, **d** shows the diff,
  **g** then **h s m r ,** switches views, **t** shows the terminals, **!** jumps to whatever needs
  you, **?** lists every key.
- **Themes:** AXA HUD (default), Graphite, Paper (light), Solar Night and High Contrast, in
  **Settings** or the palette. Every text color meets 4.5:1 contrast, embedded terminals included.
  Settings also has *follow system* (Paper when your system is light, your chosen dark theme when
  it's dark), *sync with the terminal app*, compact or comfortable density, desktop notifications and
  the daily budget. Status always uses the same glyph and word in the web console, the terminal app
  and `axa status`. Icons are inline SVG, with no emoji. Animation is kept for changes of state: short
  crossfades, one flash when something newly needs you, and a slow pulse only on working sessions.
  If your system asks for reduced motion, it all stops, the map's reactor included.
- **On your phone:** bottom tabs: Home (with the needs-you badge), Sessions, Terminal, and More (Map,
  Runs, Settings). An approval opens in a bottom sheet with big buttons within thumb reach; it's
  still tap to arm, tap again to send. The terminal gets the whole screen, and its key bar stays just
  above the on-screen keyboard. The layout keeps clear of the notch and the home indicator (safe-area
  insets).
- **Works like an app, and offline:** the console is a PWA. Add it to your home screen and it opens
  without the browser's toolbars. A service worker keeps the page shell (never `/api/` or the event
  stream), so the console still opens when the server is down and says
  *Console unreachable · last seen 14:06*.
- **Terminal comfort:** **A− / A+** set the text size (remembered per browser, a little larger on
  phones). **⌕** or Ctrl+Shift+F searches the terminal's history. Links are clickable. On desktop the
  terminal draws with the GPU, so long output stays fast (`localStorage["axa.webgl"]` = `"0"` turns that
  off, `"1"` turns it on for phones too). On a phone or tablet a key bar under the terminal has what
  the on-screen keyboard lacks: Esc (stop Claude), Ctrl (then a letter), ^C, Tab, ⇧Tab (Claude's mode
  switch), the arrows and Enter. The terminal also takes the size of whichever screen you're using, so
  switching between phone, desktop and `axa attach` no longer leaves it mis-sized.
- **Terminals:** press **Terminal → +** (or **New session**) to launch Claude Code (or a plain shell) in any project, right inside the dashboard. Sessions started here are traced and run in auto mode. Run several projects side by side; the map follows whichever tab you're in. Terminals keep running if you reload the page.
- **Sessions survive restarts:** each session runs in tmux (on AXA's own socket, `tmux -L axa-<port>`, so your tmux setup is untouched). Stopping or restarting the console (`axa stop`) leaves them running, and the next start shows them again with the same ids. After a machine restart, Claude sessions are relaunched resuming their chat (marked `recovered`); plain shells are dropped. `axa stop --all` ends every session. Without tmux (e.g. a Mac without it installed), sessions end with the console as before; `AXA_NO_TMUX=1` forces that.

**Checking how it looks:** `node scripts/shot.mjs [url] [outdir]` saves `desktop.png` (1440×900)
and `phone.png` (390×844) of the console, already unlocked. It drives any installed Chrome or
Chromium headless (Node 22+, no dependencies; set `AXA_CHROME` to choose the binary).
`--eval='js'` runs code in the page first, for example to open a dialog. Agents can read the PNGs
and fix what they see.

### From your phone, over Tailscale (optional)

The console only listens on `127.0.0.1`. To reach it from your phone without opening it to your
network, put [Tailscale Serve](https://tailscale.com/kb/1312/serve) in front of it. Serve gives the
console an HTTPS address that only devices on your tailnet can reach. HTTPS is also what the PWA
install and the service worker need. AXA doesn't set this up for you. In outline:

1. Install Tailscale on the computer and the phone, signed in to the same tailnet, with HTTPS
   certificates turned on for the tailnet (admin console → DNS → HTTPS).
2. Tell the console the name it will be reached by. Without this it refuses the request, because it
   checks the Host header to block DNS rebinding:
   `AXA_ALLOWED_HOSTS=mybox.your-tailnet.ts.net` (comma-separated; it adds that host and its
   `https://` origin, nothing else). Restart the console with it set.
3. `tailscale serve --bg 4747` proxies `https://mybox.your-tailnet.ts.net` to the console.
   `tailscale serve status` shows it, and `tailscale serve reset` removes it.
4. On the phone, open the unlock link once, with the tailnet name in place of `localhost:4747`:
   `https://mybox.your-tailnet.ts.net/?t=<token>` (the token is in the link `axa console` prints).
   That sets the cookie, and from then on `https://mybox.your-tailnet.ts.net/` works. Use **Add to
   Home Screen** to install it.

Anyone who can open that address and has the token can drive your sessions, so keep it on your own
tailnet. Don't use `tailscale funnel`, which publishes to the internet.

Env: `AXA_PORT` (default 4747), `AXA_HOME` (default `~/.axa`), `AXA_ALLOWED_HOSTS` (extra host
names the console answers to, for an HTTPS proxy such as Tailscale Serve; see above). The event log is capped at 50MB
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
  - **No model call when none is needed:** reading and searching inside the project (or its scratch
    folder) is approved at once, and an approval or refusal for the same command in the same project
    and session is reused (logged with `cached: true`). One-way doors and anything AXA passed to
    you are never remembered.
  - **Test data isn't a command:** when a one-way-door pattern (say `npm publish`) only appears in
    text a heredoc or a small Python script writes into a project file (`cat > test/x.mjs <<'EOF'`,
    `python3 - <<'EOF'` that only opens project files), AXA's model judges it, told the match is file
    data. Piped into a shell, run afterwards, or written outside the project: still yours.
  - **When the model can't be reached** (usage limit, network, timeout): requests that are local and
    reversible inside the project (edits, `mkdir`/`cp`/`mv`, deleting build output or temp files,
    non-rewriting git, read-only curl to localhost) are still approved, logged with `fallback: "local-rules"`;
    everything else comes to you (`fallback: "escalated"`). Never remembered.
- **Claude Code's own settings are off limits:** sessions can't edit `.claude/settings*.json` (that
  could switch AXA's checks off), and commands that write files (`sort -o`, `tee`, `cp`…) are never
  auto-approved.

**The commander** (the AXA session itself) gets its own, narrower rules:

- **Auto-approved:** reading and searching anywhere in your home folder except secrets and private
  folders (`~/.ssh`, `~/.aws`, `~/.config`…); read-only shell (`cat`, `grep`, `rg`, `ls`, `git
  log/status/diff/show`, `node --check`, `node --test` in a project); GET-only curl to localhost (reading
  the console API; anything that sends data to it goes to the approver); edits only inside a project folder it was started in. From `~/.axa` it only reads the event
  log, session list and console token.
- **Refused:** the dangerous-command list, writing anything in `~/.axa`, and answering prompts: a
  request to the console's `/answer` route or with its page/TUI headers. Answering is always yours.
- **Everything else goes to the approver**, which reads your latest messages to the commander as
  its goal. One-way doors and the rest of `~/.axa` always come to you.

It never applies to your own Claude sessions.
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

## Development

Zero dependencies outside the console's terminal packages. `npm test` (or `node --test`) runs the
tests in `test/`: the safety patterns, the permission policy and approver, the session status state
machine, prompt parsing against captured screens, the server's access checks, and the terminal app's
event replay. They start throwaway consoles on private ports and homes, never your own.
`node scripts/perf.mjs` measures the console's event-loop delay and the terminal app's idle output
with 8 shell sessions (numbers in `docs/perf/baseline.md`).

## Privacy

Everything stays on your machine. Events are a local JSONL file; prompts and agent
reports are clipped to 2KB each. Delete `~/.axa/events.jsonl` any time.

## License

MIT
