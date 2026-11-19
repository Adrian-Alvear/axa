# AXA

One home for all your [Claude Code](https://code.claude.com) work. Type `axa` and you land on the
**hub**: your running sessions, your past chats, the agents you have and your projects, in one
screen. Pick one and it opens live, full screen. `Ctrl-b h` takes you back to the hub, and the
session keeps running.

AXA also gives you a **commander**: one Claude session that runs the others. Tell it what you want
across projects, and it opens a session per project, hands each one its work, checks the results
and reports back.

```
 ◆ AXA                                                       ⚠ 1 NEEDS YOU   ⠹ 2 WORKING   09:41
 1 ▸ Sessions 3   2 ≡ Chats 24   3 ◇ Agents 6   4 ▣ Projects 3
▌◆ AXA commander                READY │   ▸  feed                                       NEEDS YOU
▌  the commander                      │   ~/feed   ⎇ main 3f +40 -2   Σ 120k tokens
                                      │
 ▸ feed                     NEEDS YOU │   Do you want to make this edit to app.tsx?
   ~/feed  ⎇ main +40 -2         120k │    y  Yes     x  No
                                      │
 ⠹ launches                   WORKING │   AGENTS
   ~/launches  ⎇ v7 +12 -3        48k │   ⠹ axa:builder  Edit · src/app.tsx              12 steps
                                      │   SCREEN ──────────────────────────────────────────────
                                      │   (the session's live screen, in color)
 ⏎ open  d changes  g goal  v checks  r rename  X close       Tab switch  a AXA  n new  ? help  q quit
```

Tabs across the top, the list on the left, and a live preview of whatever is selected on the right:
a session's actual screen (in color) with its prompt, agents and changes; a chat's last messages; an
agent's instructions; a project's sessions and chats. Below 90 columns the preview hides and the list
takes the whole width.

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
| **3 Agents** | The agents Claude can use: AXA's, yours (`~/.claude/agents`), each project's (`.claude/agents`), and Claude's built-ins, with how many are running now. | give it a task (the commander runs it) | `/` filter |
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
and your projects with notes. Settings for the hub are in `,` and saved in `~/.axa/ui.json`: theme (`axa`, the default on
terminals with 24-bit color; `terminal`, your terminal's own 16 colors; `mono`), icons (Nerd Font
glyphs if one is installed, else plain Unicode), prefix key and bell.
