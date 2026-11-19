# AXA functionality research (branch axa-v2 @ bfac820), condensed
Verified by the commander: S1 (git push origin feat main -> allow "safe command"), the 6/33 branch divergence, dd73931 on origin, and origin/axa-v2 has test/.

## Security / approval policy
- S1 H hooks/policy.mjs:225-232: pushes reaching main are auto-allowed (extra refspec, refs/heads/main, @, tag pushes, bare push with push.default=upstream). Fix: check every refspec, normalize refs, protect tags and the remote default branch; port dd73931.
- S2 H lib/safety.mjs:78-82, hooks/approver.mjs:37,101: one-way-door regexes skipped by quoting or git -C/--no-pager, npm --tag x publish, vercel --yes --prod, kubectl --context, docker compose push, make deploy, npm run deploy, gh api -f; these go to the LLM judge. The judge sees the session-written description. Fix: shell-tokenize, match argv.
- S3 H policy.mjs:197-204: pnpm/yarn/bun pass-through allows pnpm wrangler deploy, pnpm prisma migrate deploy, yarn vercel --prod; npm install <pkg> allowed. Fix: oneWayDoor() on the whole command first; allow only package.json scripts.
- S4 H policy.mjs:103-110: writes to .claude/settings.json, .mcp.json, .husky/, git hooks allowed (.GIT case bypass on macOS). Fix: deny them; port e989c17 and dd73931.
- S5 H: node x.mjs etc. allow arbitrary code: a worker can read ~/.axa/console-token and call /answer or /input with spoofed headers (server.mjs:32). Fix: sandbox workers (denyRead ~/.axa), a nonce or socket peer check for /answer.
- S6 H sessions.mjs:136-147: text sent while a session is starting can answer the trust/MCP dialog. Fix: refuse while starting; open_session({wait:true}).
- S7 H/M: send_to_session passes "!cmd" (bash mode skips hooks), slash commands and control characters. Fix: refuse !, allowlist slash commands, strip control characters.
- S8 M: plugin bin/ is on workers' PATH (axa stop --all). Move the CLI out of bin/.
- S9 M mcp/axa-terminals.mjs:9,168: tools hidden only for worker; expose only to the commander.
- S10 M: three different project-path matchers (symlinks on WSL).
- S11 M lib/safety.mjs:106: the MCP door denylist misses github push_files/create_repository, stripe refunds and more. Invert to a read-verb allowlist.
- S12 M: confirmed_by_user is self-asserted by the commander.
- S13 L app.mjs:68: yesOpt falls back to options[0] (on the MCP dialog that's "all future servers").
- S14 L: git diff --output, --ext-diff allowed.

## Status / supervisor
- R1 H: no SessionEnd; Claude exiting leaves a bash shell, so links type English into bash; the "exited" wake never fires.
- R2 H: StopFailure, usage limits, Esc and notification types are ignored, so sessions show "stuck".
- R3 M screen.mjs:7: AskUserQuestion menus aren't detected.
- R4 M events.mjs:7,191: status rebuilt from the last 4MB of the log only.
- R5 M supervisor.mjs:89: can submit a half-typed draft.
- R6 M sessions.mjs:144-147: no submit confirmation; links marked fired anyway.
- R7 M: /goal turns can trigger done links. R8 M verify gate misses subagent/Bash edits. R9 L chains.json never pruned.

## Daemon / install
R10 stale-pid SIGTERM, restart race; R11 first-run double daemon -> 401s; R12 no crash restart; R13 node-pty build prerequisites undocumented, errors hidden; R14 worktrees inside the repo (.claude/worktrees) get scanned by tooling; R15-R23 smaller items (rotation loss, body >100KB hang, budgets per chat, /mnt/c refused, tmux 3.0a, commander in ~ never stays trusted, shell sessions tagged worker, port collision); R24 local axa-v2 vs origin diverged 6/33.

## Docs drift
"Only one-way doors wait for you" is false today (S1-S3); "auto mode" vs acceptEdits; link tools missing from the skill; exited wake; budgets advisory; install prerequisites.

## Trust / MCP prompt fix
1. Remove the root .mcp.json; declare the server in .claude-plugin/plugin.json mcpServers (plugin servers start without a prompt).
2. Launch workers with claude --settings '{...disabledMcpjsonServers:["terminals"], sandbox...}'. Avoid enableAllProjectMcpServers.
3. Keep trust the user's decision: a "needs trust" status, `axa trust <project>` (user only, never ~), commander home in ~/.axa/commander/.

## Missing features
F1 unattended-safe launch (S, High); F2 wait_for tool (S, High); F3 interrupt/resume/restart session (S, High); F4 read_transcript (S); F5 pending-approval queue (M, High); F6 git checkpoint + rollback (S, High); F7 worktree lifecycle (M, High); F8 run_checks tool (S); F9 usage-limit awareness (S, High); F10 OS notifications (M, High); F11 axa doctor; F12 daemon service; F13 axa policy test; F14 session profiles; F15 enforced budgets; F16 durable run history; F17 commander singleton.

## Fix first
1 policy bypasses (S1-S3, S11, S14; port dd73931) 2 workers disarming AXA (S4, S5, S8) 3 safe typing + unattended start (S6, S7, F1) 4 trustworthy status (R1-R3, R6) 5 restore tests, reconcile branches (R24).

## Test plan
node --test with temp AXA_HOME: ~150 policy/door cases; approver with a PATH shim; typing safety on a throwaway tmux socket; status-machine replays; supervisor with a fake clock; daemon lifecycle races; worktrees on temp repos; CI on ubuntu 22.04/20.04 and macOS.
