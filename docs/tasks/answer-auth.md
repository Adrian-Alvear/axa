# Answering prompts: proving the request comes from you (S5) — not done, written up

Status: **open**. Part C item 3 of `docs/tasks/reliability.md` asked for a way for the hub to prove it
is the hub, so that a process that merely has the console token can't answer permission prompts. I
found no design that holds up against the actual threat, so nothing was changed and the existing checks
stay exactly as they are. This note says why and what would work.

## Today

- Every API call needs the console token (`~/.axa/console-token`, mode 0600), sent as the `axa_token`
  cookie, plus a local Host/Origin.
- `POST /api/terms/<id>/answer` additionally needs `fromUser(req)` (`src/core/server.mjs`): either
  `Sec-Fetch-Site: same-origin` with an `Origin` (the web console) or `x-axa-client: tui` (the hub).
- Project sessions are kept off the token and the console by the policy (`hooks/policy.mjs`: Read/Grep/
  Glob/Edit of `~/.axa` denied, Bash naming `~/.axa`, `console-token`, `localhost:4747` or AXA's tmux
  denied, and since Part C the `axa` CLI too). The commander may read the token but is denied any Bash
  that sends the answer route or those headers.

## The threat

A worker can write a project file and run it (`node scripts/x.mjs`, `npm test` running its own test
code). That code runs as **your OS user**, outside the policy's pattern checks. It can read
`~/.axa/console-token`, send any header (`Sec-Fetch-Site` and `x-axa-client` are ordinary headers for
anything that isn't a browser), and call `/answer` to approve its own prompts. So the extra
`fromUser` check stops the commander's tools and casual misuse, not a worker's own code.

## Options considered, and why none is robust

1. **The hub registers a fresh secret on first connect; the daemon then requires it for answers.**
   Registration has to be open to some client holding the token, and the worker's code holds the token
   too. Whoever registers first wins. The hub is usually *not* running (unattended sessions,
   web-only use) or restarts (each `axa` run is a new process), so the worker can register first and
   the real hub would only be able to report "someone else registered". That detects the problem, but
   doesn't prevent it.
2. **The daemon writes a one-time secret into the hub's tmux environment.** The hub doesn't run inside
   AXA's tmux: it runs in your own terminal and attaches tmux clients through node-pty. And anything a
   tmux server holds is readable by any process of your user (`tmux -L axa-4747 show-environment`): the
   socket is the same user's, and the policy's tmux check is a text pattern, not a barrier.
3. **A Unix socket with peer credentials (SO_PEERCRED) plus ancestry checks**: refuse peers that
   descend from AXA's tmux server, carry `AXA_TERMINAL_ID`, or have no controlling terminal. A worker's
   code can drop its environment, double-fork so init (or the user's systemd) adopts it, and get a
   fresh controlling pty (`script`, Python's `pty`, or its own `tmux -L x new -d`, which daemonizes).
   From then on it looks like a hub started in your own terminal or your own tmux. That's a speed bump,
   not a proof.
4. **Pairing confirmed by you** (the daemon shows a code and you confirm it elsewhere). The only other
   place to confirm is the web console, whose "browser only" check is the same spoofable header. A code
   in a file or log under `~/.axa` is readable by the same user.
5. **Secrets only in process memory.** With Yama `ptrace_scope=1` (this machine: 1) a worker can't read
   the hub's memory. But the secret still has to be *established* between the hub and the daemon over a
   channel the worker can also use. That is option 1 again.

Underneath all five: **with no OS boundary between the worker and you, the worker can do whatever your
hub can do.** No protocol between two same-user processes can fix that.

## What would work (recommended next step)

Put an OS boundary around a worker's code, then the existing token check is enough:

- **Claude Code's sandbox for project sessions** (`sandbox.enabled` in the `--settings` AXA passes when
  it launches a worker): Bash, and so every program a worker runs, executes in bubblewrap (Linux/WSL)
  or Seatbelt (macOS) with `filesystem.denyRead: ["~/.axa", "~/.claude.json"]` and no network to
  `localhost:4747`. The file tools are already covered by the policy. Then a worker can't read the token
  or reach the console at all, and S5 is closed for every route, not just `/answer`.
  Needs: `bubblewrap` and `socat` installed on Linux/WSL (neither is installed here today), a check in
  `axa doctor`/startup that warns when they're missing, and tests that a sandboxed `node -e` can't read
  the token or connect to the port. Watch out for: package installs and test runners that need the
  network (allow the registries), and `/tmp` use.
- Optionally, after that: run the daemon as a separate user, with the token readable only by your user
  through a group. That only helps once workers are sandboxed.

Until then, keep what's there: the token, the policy's denials, the `fromUser` headers (which keep the
commander's tools and casual misuse out), and the rule that the commander never answers prompts.

## Tests to add when it's built

- A request with only the token and `x-axa-client: tui` (or `Sec-Fetch-Site: same-origin` plus Origin)
  from a sandboxed worker process can't reach `/answer`: the connection is refused or the token is
  unreadable.
- The hub and the web console can still answer.
