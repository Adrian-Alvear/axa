# AXA

One home for all your [Claude Code](https://code.claude.com) work. Type `axa` and you land on the
**hub**: your running sessions, your past chats, the agents you have and your projects, in one
screen. Pick one and it opens live, full screen. `Ctrl-b h` takes you back to the hub, and the
session keeps running.

AXA also gives you a **commander**: one Claude session that runs the others. Tell it what you want
across projects, and it opens a session per project, hands each one its work, checks the results
and reports back.

```
 ◆ AXA  hub                                                        ⚠ 1 needs you · 2 working  09:41
 ⚠ feed needs you: Do you want to proceed?                    y Yes   x No   ! go there
╭─ 1 Sessions (3) ─────────────────────────╮╭─ 2 Chats (24) ───────────────────────────────────╮
│ ◆ AXA commander                  ○ ready ││ ● Fix the phone layout                 feed · 2m │
│   ready: open it and tell it what you…   ││   Onerec DEV02 proxy routes               ~ · 1h │
│ ⚠ feed  ~/feed               ⚠ needs you ││   Conformance scenarios V1 sync check     ~ · 3d │
│   Do you want to proceed?                │╰──────────────────────────────────────────────────╯
│ ● launches  ~/launches         ● working │╭─ 3 Agents (6) ───────────────────────────────────╮
│   Edit · src/app.tsx   ⎇ v7 3f +40 -2    ││ ● axa:builder  Code builder…       1 running · axa │
╰──────────────────────────────────────────╯│   axa:reviewer  Code reviewer…              axa │
╭─ 4 Projects (3) ─────────────────────────╮│   Explore  Fast read-only search…      built-in │
│ ▣ feed      ⎇ main                1 open ││   Plan  Designs an implementation plan…  built-in │
│ ▣ launches  ⎇ v7 3f +40 -2        1 open │╰──────────────────────────────────────────────────╯
 Tab panels  ⏎ open · d diff · g goal · r rename · X close  │  n new  a AXA  / filter  ? help  q quit
```

## Install

```
git clone git@github.com:Adrian-Alvear/axa.git ~/axa
cd ~/axa && npm install
ln -s ~/axa/bin/axa ~/.local/bin/axa
axa
```

Needs Node 18+, tmux (`sudo apt install tmux` / `brew install tmux`) and Claude Code. As a Claude Code
plugin (for the `axa` skill, agents and tracing hooks in your own sessions):

```
/plugin marketplace add Adrian-Alvear/axa
/plugin install axa@axa
```

## The hub

| Panel | What's in it | Enter | Other keys |
|---|---|---|---|
| **1 Sessions** | The AXA commander, then every session AXA runs, by what needs you: needs you, stuck, working, done, ready. Each shows what it's doing or last said, its branch and changes, tokens, and helper agents at work. | open it live | `d` changes · `g` give a goal · `v` run checks · `r` rename · `X` close |
| **2 Chats** | Every past Claude Code conversation, newest first, with its title (your `/rename`, else Claude's). `●` = open in a session right now. | resume it (or jump to it) | `/` filter |
| **3 Agents** | The agents Claude can use: AXA's, yours (`~/.claude/agents`), each project's (`.claude/agents`), and Claude's built-ins. `●` = running somewhere now. | details | `u` give it a task (the commander runs it) |
| **4 Projects** | Your repos (from the roster, `~/projects`, and git repos in `~`). | its session, or a new one | `n` new · `w` new in its own worktree · `s` shell |

Everywhere: `Tab` / `1`-`4` switch panels, `a` the commander, `n` new session, `/` filter, `y` / `x`
answer the prompt in the yellow bar, `!` go to it, `o` web console, `,` settings, `?` all keys,
`q` quit (sessions keep running). The mouse works too: click to select, click again to open, scroll.

### Inside a session

Everything you type goes to the session. The prefix key (`Ctrl-b`, changeable in settings) then a key
is for AXA:

| Keys | |
|---|---|
| `Ctrl-b h` | back to the hub |
| `Ctrl-b n` / `p`, `1`-`9` | next / previous session, or by number |
| `Ctrl-b a` | the commander |
| `Ctrl-b y` / `x` / `!` | answer another session's prompt from here, or go to it |
| `Ctrl-b d` `g` `v` `r` `X` | changes, goal, checks, rename, close |
| `Ctrl-b i`, or `Ctrl+V` | paste an image from your clipboard (saved to `.claude/axa-pastes/`, its path typed in) |
| `Ctrl-b Ctrl-b` | a literal Ctrl-b |

Scrolling goes to the session's history; dragging selects and copies (Shift+drag uses your
terminal's own selection).

## Commands

```
axa                  the hub
axa chat             talk to the commander here, as a plain Claude Code session
axa web              the web console in your browser (same sessions, also works on your phone)
axa status [--json]  what's running, what needs you first
axa attach <name>    one session in this terminal, no hub around it (Ctrl-] detaches)
axa stop [--all]     stop the background daemon (--all also ends every session)
axa restart          restart the daemon; sessions keep running
```

## How it works

```
bin/axa              the CLI
src/
  paths.mjs          where AXA keeps things (~/.axa) and its port (4747)
  daemon.mjs         starts the daemon in the background, and talks to it
  core/              the daemon
    server.mjs         HTTP API, web console, live event stream (127.0.0.1 only, token required)
    sessions.mjs       sessions in tmux: start, resume, read the screen, type, answer, close
    events.mjs         status of each session from the hook events; helper agents; run history
    supervisor.mjs     wakes the commander when a session finishes, gets stuck or needs you; links
    claude-data.mjs    your past chats and token usage, read from ~/.claude/projects
    catalog.mjs        projects and agents
    git.mjs            branch and changes, diffs, worktrees
    screen.mjs         reading Claude's prompts off the screen
  tui/               the hub: app.mjs (screens, keys), live.mjs (a session view), draw.mjs, ...
  web/index.html     the web console
mcp/                 the commander's session tools (list, read, send, goal, open, close, link)
hooks/               event log, permission policy, approver, verify gate
agents/ skills/      axa:builder / reviewer / researcher; the axa, verify and web skills
```

- **Sessions survive everything.** Each runs in tmux on AXA's own socket (`tmux -L axa-4747`; your
  tmux is untouched). Quitting the hub or restarting the daemon leaves them running. After a machine
  restart, Claude sessions come back resuming their chat.
- **Project sessions run in accept-edits mode** under AXA's permission policy: safe actions are
  approved, dangerous ones refused, the rest goes to AXA's approver. Only one-way doors (shipping to
  main, deploying, publishing, accounts, spending) wait for you, in the yellow bar.
- **"Done" means checked.** If a session edits code and tries to finish without running a check,
  AXA's verify gate sends it back once. `"verifyGate": "off"` in `~/.axa/policy.json` turns it off.
- **AXA wakes itself.** When a session finishes, gets stuck or needs you, the daemon tells the
  commander (only when it's idle and you aren't typing in it), so it can check the work and report.
  `AXA_SUPERVISOR=0` turns it off.
- **Budgets.** `{ "default": { "budget": { "tokens": 5000000 } } }` in `~/.axa/policy.json`: a
  session over budget is flagged and gets no more work from the commander.

## Make it yours

```
cp roster.example.md ~/.axa/roster.md
```

The roster holds the roles AXA uses (which agent, which model), house rules every agent follows,
and your projects with notes. Settings for the hub (theme, prefix key, bell) are in `,` and saved in
`~/.axa/ui.json`.
