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

## Control (the home screen)

Mission control for everything AXA runs, in one screen:

- **Live map** in the middle: the AXA core (the commander) in a ring with a turning sweep and a ripple while it works, every session as a card
  on its orbit, framed in its status color. Links light up while a session works (with pulses running
  along them) or waits on you; a session's running agents are tagged under its card. `↑`/`↓` or a click
  picks a session, Enter (or a second click) opens it.
- **Global status**: active, working, needs you, done today, each with a small bar. **Activity**: events per
  minute over the last hour.
- **Requires approval**: the prompt a session is waiting on, with `x` decline / `y` approve.
- **Commander**: what AXA last said, and a box to talk to it (`:` to type, Enter sends; it starts the
  commander if it isn't running).
- **Recent chats** (`→` to pick one, Enter resumes it), **Agents at work** (every running helper: its
  session, what it's doing, steps, time) and a live **log** in plain words.

It needs a window of about 100×26 or more; smaller, it shows the sessions list instead.

### Voice

AXA can read the commander's finished replies aloud, Jarvis-style, with your computer's own voices: `say` on
macOS, Windows' built-in voices (System.Speech through `powershell.exe`) on Windows and WSL, `spd-say` or
`espeak` on Linux. It's off by default: press `m` on Control (or turn on **Voice** in `,` settings, where you
also pick the voice and speed and can test it). `AXA_VOICE=1` / `AXA_VOICE=0` forces it on or off. It says the
short version (the first paragraph, code and tables replaced by "code on screen", paths and links by "a file
path" / "a link") and ends with "The details are on screen." when there's more. `Esc` on Control stops it.
The daemon does the speaking, so it works from the hub or the web console, and only the commander ever talks:
never a worker session. To talk back, turn on Claude Code's own hold-to-talk dictation (`/config`,
`"voiceEnabled": true`) in the commander's session.

### Better voice: Kokoro

[Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) is a small neural text-to-speech model that sounds far more
natural than the built-in voices. It's Apache-2.0, runs fully offline on the CPU (through
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)), and takes about 380 MB on disk. Install it yourself, from
a terminal (macOS, or Windows through WSL; Linux works too):

```sh
axa voice install kokoro      # shows the sizes and asks first; --yes skips the question
axa voice status              # engine in use, install state, how long the test sentence took
```

It goes into `~/.axa/voices/kokoro/` (`AXA_KOKORO_DIR` moves it): a Python venv with sherpa-onnx (or, without
`python3 -m venv`, sherpa-onnx's prebuilt CLI, which is slower) and the `kokoro-multi-lang-v1_0` model. The
installer checks it by saying one sentence, then makes Kokoro AXA's voice with the `af_heart` voice. The daemon
keeps the model loaded in a small resident speaker, so a reply takes about a second to start (the first one after
a start or 10 idle minutes takes about two). On WSL the audio is played on the Windows speakers. Pick one of
Kokoro's 28 English voices (`af_` / `am_` American, `bf_` / `bm_` British) under **Voice name** in `,` settings.

If Kokoro fails for a reply (missing, crashed, slower than 8 s), AXA says that reply with the system voice and
notes why in `~/.axa/console.log`. To go back to the built-in voices, set **Voice engine** to System in `,`
settings, or remove Kokoro with `axa voice uninstall kokoro`. Words the model doesn't know (like "macOS") are
spelled out by a small pronunciation table in `src/core/voice.mjs`.

## The other tabs

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
axa review [path] [--base <sha>]   a milestone review of a repo's recent work
axa review --reset-milestone [path]   forget the repo's stored milestone (the next review's base)
axa attach <name>    one session in this terminal, no hub around it (Ctrl-] detaches)
axa stop [--all]     stop the background daemon (--all also ends every session)
axa restart          restart the daemon; sessions keep running
axa trust <path>     trust a project (its git repo root) in ~/.claude.json, so sessions AXA starts
                     there don't stop on Claude Code's folder-trust prompt. Never the home folder.
```

`axa trust` is yours to run: trusting a folder is your decision, so AXA's sessions (the commander
included) are never allowed to run it.

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
    reviewer.mjs       the independent reviewer: runs it, reads its verdict, confirms block findings
    milestone.mjs      milestone reviews: the range, the base, the verifier/fixer loop
    claude-data.mjs    your past chats and token usage, read from ~/.claude/projects
    catalog.mjs        projects and agents
    git.mjs            branch and changes, diffs, worktrees
    screen.mjs         reading Claude's prompts off the screen
  tui/               the hub: app.mjs (screens, keys), live.mjs (a session view), draw.mjs, ...
  web/index.html     the web console
mcp/                 the commander's session tools (list, read, send, goal, open, close, link, review)
hooks/               event log, permission policy, approver, verify gate
agents/ skills/      axa:builder / reviewer / researcher, the review gate's prompt; the axa, verify and web skills
```

- **Sessions survive everything.** Each runs in tmux on AXA's own socket (`tmux -L axa-4747`; your
  tmux is untouched). Quitting the hub or restarting the daemon leaves them running. After a machine
  restart, Claude sessions come back resuming their chat.
- **Sessions start unattended.** The commander's session tools come from the plugin itself
  (`.claude-plugin/plugin.json`), so no session shows a "New MCP server found" prompt, and only the
  commander (`AXA_ROLE=commander`) gets them. The first time Claude Code opens in a folder it asks
  whether you trust it: that session shows **needs trust** in the hub, `axa status` and the
  commander's list ("the user must answer the trust prompt (or run axa trust <project>)"). Nothing is
  typed into a session before it has started (its first SessionStart event), while it starts or
  while the trust prompt is open, so typed text can't answer a dialog; the commander's `open_session`
  takes `wait: true` to return once the session is ready or waiting (at most 60 s). A new commander
  runs in its own folder, `~/.axa/commander/` (Claude Code never saves trust for the home folder):
  answer its trust prompt once, or run `axa trust ~/.axa/commander`.
- **Project sessions run in accept-edits mode** under AXA's permission policy: safe actions are
  approved, dangerous ones refused, the rest goes to AXA's approver. Only one-way doors (shipping to
  main, deploying, publishing, accounts, spending) wait for you, in the yellow bar.
- **Guardrails stay on.** Sessions can't edit `.claude/settings*.json` (that could switch AXA's checks
  off), git hooks and `.git` (`.husky/`, `.githooks/`), `.mcp.json` or `.claude/hooks/`, and commands
  that write files are never auto-approved. Pushes are read the way git reads them (quotes, `git -C`/`-c`
  options, `refs/heads/main`, `HEAD` while on main), and any tag push is yours to approve, as are
  `migrate deploy` and deploy/publish/infra commands with options before the subcommand. Test data isn't
  a command: an `echo`ed or commit-message `git push` is text, and a one-way-door
  pattern that only appears in text a heredoc writes into a project file is judged as file data. If
  AXA's approver can't be reached (usage limit, network), only local, reversible steps inside the
  project are approved; everything else comes to you. **The commander** gets narrower rules: read-only
  shell and reads in your home folder (not secrets), edits only in the project it started in, never
  writing to `~/.axa` or answering prompts. Details: `hooks/policy.mjs`, tests in `test/`.
- **Sessions can't drive AXA or loosen Claude Code.** Project sessions can't run the `axa` CLI (the
  plugin's `bin/` is on their PATH), read or write `~/.claude.json` (folder trust, MCP servers), or start
  Claude Code with `--dangerously-skip-permissions` / `bypassPermissions` (the commander can't either).
  Text typed into a Claude session (the commander's `send_to_session`, links, supervisor updates) never
  starts with `!` (bash mode, which skips hooks) unless you confirmed that exact command, may only use
  the slash commands `/goal`, `/compact`, `/clear`, `/context` and `/cost`, and has control characters
  stripped. Known gap: code a project session runs as your user could still read the console token
  and answer a prompt; see `docs/tasks/answer-auth.md` (fix: sandbox project sessions).
- **"Done" means checked.** If a session edits code and tries to finish without running a check,
  AXA's verify gate sends it back once. `"verifyGate": "off"` in `~/.axa/policy.json` turns it off.
- **An independent review at milestones** (or after every turn, if you choose), with a fixer loop. See [Independent review](#independent-review).
- **Statuses you can trust.** From the hook events: **exited** when Claude Code ends (SessionEnd; also
  when a started session's pane is back to its shell, and nothing is typed into that shell), **failed**
  or **limited** when a turn ends on an API error or a usage limit (StopFailure, with the reset time when
  Claude Code gives it), **needs you** on permission prompts, MCP input dialogs and AskUserQuestion
  menus, and **ready** when Claude has gone idle waiting for input. Text typed into a Claude session
  must be confirmed by its UserPromptSubmit within 5 s (Enter is pressed once more, then it's an error,
  and a link isn't counted as fired). Time spent waiting on a permission never makes a step look stuck.
- **AXA wakes itself.** When a session finishes, gets stuck or needs you, the daemon tells the
  commander (only when it's idle and you aren't typing in it), so it can check the work and report.
  `AXA_SUPERVISOR=0` turns it off.
- **Budgets.** `{ "default": { "budget": { "tokens": 5000000 } } }` in `~/.axa/policy.json`: a
  session over budget is flagged and gets no more work from the commander.

## Independent review

A separate reviewer checks the work: a headless `claude -p` in the project folder, on `claude-opus-5-5`
at high effort, with its own prompt (`agents/reviewer-gate.md`). It is read-only (`AXA_ROLE=reviewer` in
`hooks/policy.mjs`): it reads files, looks at git diff/status/log and runs the project's own checks
(tests, type-check, build) once per review. It never edits, pushes or goes on the web. When it runs
depends on `reviewer.mode`:

- **`"milestone"` (the default): a batch of work, on request.** The commander calls `review_changes`
  (before a push, or when a batch of work is done), or you run `axa review [path] [--base <sha>]`
  (the same engine, through the daemon's `POST /api/review`; it prints the progress and the verdict, and
  the commander isn't woken for it). The reviewer gets the range base..HEAD plus uncommitted and new
  files: the commit subjects and the diff (over ~150 KB: per-file stats and the most important files'
  diffs, and it reads the rest itself), and is asked to review the batch as a whole: does each commit do
  what its message says, problems across commits, regressions, missing tests, docs, security, leftovers.
  The base is `--base` if given, else the last milestone of that repo and branch (`~/.axa/milestones.json`),
  else the merge-base with the upstream (`@{upstream}`, or `origin/<branch>`), else `HEAD~20`.
  Over budget, source and logic files (`src/`, `lib/`, `hooks/`, `mcp/`, `bin/`, most lines changed
  first) are inlined before other code, then tests, then docs and fixtures; every file left out is
  listed. `axa review --reset-milestone [path]` forgets the stored milestone of that repo and branch.
  Worker turns get no model review in this mode; the verify gate still runs.
- **The fixer loop.** When the confirmed verdict is `block` (or a `warn` with confirmed high findings),
  the daemon opens a new worker session named **fixer** in that repo (like `open_session`: accept-edits,
  the normal policy) and sends it one self-contained instruction: the confirmed findings (file:line,
  quote, problem, evidence), fix exactly these, add or adjust tests, run the checks, commit locally as
  `Fix review findings: …`, change nothing else, never push. When the fixer finishes, the reviewer
  re-reviews the same base..new HEAD with the previous findings listed. At most 3 fix rounds
  (`milestone_rounds`); then the commander hears what's still open (the fixer stays open). Only an
  approve records the milestone (the next review starts from it). A warn with nothing serious ends the
  review the same way but leaves the base where it was, so its findings are in the next review's range
  again; an error never records. Either way the fixer is closed and the commander gets the verdict and
  the fix commits: `milestone review <repo>: ✓ approve · …`. The fixer never reviews; the reviewer
  never edits.
- **`"turn"`: every code-changing turn.** When a project session finishes a turn that changed code (it
  edited files, or git moved), the reviewer runs before the commander hears about it (below).
- **`"off"`**, or `AXA_REVIEWER=0` in the daemon's environment: no reviews.

- **What it checks:** that the diff does what was asked (checked against the instruction, not the
  session's report), that the checks pass, and what's around the change: side effects and unrelated
  files, edge cases, security, leftover debug or temp code, docs and README that are now wrong, missing
  tests. It sees the whole turn: AXA records the commit the turn started from and gives it the diff
  from there (commits made during the turn and uncommitted edits) with the list of those commits. If
  the instruction cites a task spec in a Claude scratchpad or `~/.axa/tasks/`, AXA reads that file and
  includes it, since the reviewer itself can't read outside the project.
- **The evidence rule:** every finding needs a file and line, a snippet quoted from the file, and how to
  see or reproduce it. Without evidence it isn't reported, and when unsure it's a warning, never a
  block. The answer must be one strict JSON verdict (`approve`, `warn` or `block`); anything else counts
  as a failed review.
- **Blocks are double-checked.** Before a block counts, the daemon itself looks for each serious
  finding's quoted snippet in that file near that line. Findings it can't find are dropped, and with
  none left the block becomes a warning. In turn mode a confirmed block goes back to the session to fix
  (at most two rounds per instruction); the third time, the commander gets the findings instead. In
  milestone mode it goes to the fixer (above).
- **Where you see it:** a badge on the session (`… reviewing`, `✓ reviewed`, `⚠ review`, `✗ blocked`,
  `fixer (milestone review)`) on the Control map and in the Sessions list, `review: …` and
  `milestone review: …` in the log, the verdict line in the commander's update, and the findings and
  running milestone reviews (with their round) in `list_sessions`. A running review shows what it is
  doing (`reviewing… (checks running: npm test)`). If the reviewer times out (a turn review after 15
  minutes, a milestone review after 30) or fails, AXA carries on, says the work wasn't reviewed and how
  far the reviewer got. The limit is wall-clock time (a laptop's sleep counts), and at the limit the
  reviewer and every process it started (a hanging test run, say) are killed.
- **Settings** in `~/.axa/policy.json`, for all projects or one:
  `{ "default": { "reviewer": { "mode": "milestone", "model": "claude-opus-5-5", "effort": "high", "timeout_ms": 900000, "milestone_timeout_ms": 1800000, "milestone_rounds": 3 } }, "projects": { "notes": { "reviewer": { "mode": "off" } } } }`
  (`"mode": "on"`, the old name, means `"turn"`). Each review is a real, billed model run.

## Make it yours

```
cp roster.example.md ~/.axa/roster.md
```

The roster holds the roles AXA uses (which agent, which model), house rules every agent follows,
and your projects with notes. Settings for the hub are in `,` and saved in `~/.axa/ui.json`: theme (`axa`, the default on
terminals with 24-bit color; `terminal`, your terminal's own 16 colors; `mono`), icons (Nerd Font
glyphs if one is installed, else plain Unicode), prefix key, bell and voice (on/off, engine, voice name, speed).
