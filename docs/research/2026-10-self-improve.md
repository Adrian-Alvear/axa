# AXA self-improvement research (October 2026)

What other agent consoles and terminal tools do that AXA doesn't, what would make the console
clearer (especially on a phone), and which skills, hooks and tools AXA should ship. Every claim links
to its source. Five researcher agents ran in parallel. Each section notes the places they could only
reach secondary sources.

**Bottom line.** Claude Code now covers persistence, status lists, mobile and notifications natively
([Agent View](https://code.claude.com/docs/en/agent-view), [Remote Control](https://code.claude.com/docs/en/remote-control)).
AXA's own value is three things together: the **commander**, the **policy plus approver** that keeps
sessions from stopping, and the **live feed**. None of the tools below offers a user-tunable
allow/deny engine plus an AI approver. The gaps worth closing are review ("what did it actually
change?"), phone glanceability ("does anything need me?"), terminal ergonomics, and verification
before "done".

---

## (a) Similar tools

| Tool | License | Ideas worth taking |
|---|---|---|
| [Claude Code Agent View](https://code.claude.com/docs/en/agent-view) | first-party | States Working / Needs input / Idle / Completed / Failed / Stopped; rows grouped "Ready for review / Needs input / Working / Completed"; one-line summary and PR status per row; peek and answer numbered choices from the list; a worktree per dispatched session; `claude agents --json`; `Notification` hook with `agent_needs_input` / `agent_completed`; idle sessions are stopped after about an hour |
| [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) | first-party | Drive a local session from the phone app; reconnects after sleep; send photos and files from the phone |
| [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing) | first-party | `/rewind` of code and conversation. It misses Bash-made changes, so a git snapshot per goal is safer |
| [Claude Squad](https://github.com/smtg-ai/claude-squad) | AGPL-3.0 (ideas only) | tmux plus a worktree and branch per task; review the diff before applying; agent profiles |
| [Conductor](https://www.conductor.build/docs/) | not stated | A workspace per task with branch, terminal and diff; the flow is review diff → PR → merge → archive; "checks" |
| [Crystal](https://github.com/stravu/crystal) | MIT, deprecated in Feb 2026 | Parallel sessions in worktrees to compare approaches to one task |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | Apache-2.0, sunsetting | Kanban board of issues turned into agent workspaces; inline diff comments go back to the agent; dev-server preview |
| [Sculptor](https://imbue.com/sculptor) ([containers](https://docs.imbue.com/features/containers)) | not confirmed | A container per agent; "pairing mode" checks the agent's branch out locally; take some changes and discard the rest |
| [disler multi-agent observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) | not stated | Closest to AXA's feed: hooks → server → live dashboard, with filters by app, session and event type, a pulse chart and a transcript viewer |
| [OpenHands](https://github.com/OpenHands/OpenHands) | MIT | Optional Docker sandbox per conversation; scheduled and webhook automations |
| [Cursor background agents](https://docs.cursor.com/background-agent/web-and-mobile) | proprietary | PWA with push notifications; create, review and merge PRs from the phone |
| [Devin](https://docs.devin.ai/work-with-devin/advanced-capabilities) | proprietary | A coordinator spawns child sessions with a cost limit (ACUs) each; successful sessions become reusable playbooks; approvals from Slack |
| [OpenAI Codex](https://rubinlake.com/en/technology-radar/developer-ai-and-delivery/openai-codex) (third-party guide) | Apache-2.0 CLI | Sandbox mode is a separate setting from approval policy; network off by default in cloud tasks |
| [Kiro](https://innfactory.ai/en/ai-harness/kiro/) (third-party summary) | proprietary | Spec flow (requirements → design → tasks), steering files, hooks on file save |
| [everything-claude-code](https://github.com/affaan-m/everything-claude-code) | MIT (already credited) | Deterministic hooks, a fresh-context reviewer, a final build/lint/type/test pass, AgentShield config scanner |
| [ccusage](https://github.com/ryoppippi/ccusage) | MIT | Token and cost reports from Claude's local JSONL logs, with 5-hour block tracking |

**What AXA lacks or does worse:** a diff/review view of what a session changed (Conductor, Squad,
Vibe Kanban, Agent View); a worktree per goal (Squad, Conductor, Agent View); answering prompts from a
list (Agent View); push to the phone (Cursor, Agent View hooks); test-gated "done" (ECC, Conductor
checks); cost tracking (ccusage, Devin); per-goal snapshots for rollback (Sculptor, `/rewind`).

## (b) Design: clarity, phone, mission-control look

The researchers couldn't find a dashboard among Awwwards Sites of the Day. Awwwards' related
"elements" are dark data-visualization pieces such as
[EternaCloud](https://www.awwwards.com/inspiration/data-visualization-eternacloud) and
[Apiary Life](https://www.awwwards.com/inspiration/data-visualization-apiary-life). These are good
for mood, not for information hierarchy. The useful guidance came from product and accessibility
sources:

1. **One answer first.** A dashboard should answer one question and lower cognitive load
   ([Grafana best practices](https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/dashboards/build-dashboards/best-practices.md),
   [Canonical's dashboard guide](https://charmhub.io/grafana-k8s/docs/charmed-dashboard)). For AXA,
   the question is "does anything need me?" So: a sessions list sorted by urgency (needs you → stuck
   → working → done → idle → ended) at the top on the phone.
2. **Dashboards show status, alerts drive action**
   ([Grafana community](https://community.grafana.com/t/how-do-i-design-and-set-up-dashboards-in-grafana/162161)).
   So: bell or push when something starts needing you, not more glow.
3. **Never color alone.** WCAG 1.4.1 and 1.4.11 (3:1 for UI states)
   ([WCAG 2.2 Understanding](https://www.w3.org/WAI/WCAG22/UNDERSTANDING/),
   [digitala11y](https://www.digitala11y.com/understanding-sc-1-4-11-non-text-contrast/)). Every
   status gets a glyph, a word and a color.
4. **Contrast.** Body text needs at least 4.5:1
   ([WCAG 1.4.3](https://www.w3.org/WAI/WCAG22/UNDERSTANDING/contrast-minimum.html)). AXA's `--dim`
   (#4f6b7a on #04070b) was **3.57:1**. It's now #6c8a99 at **5.51:1**.
5. **One accent, neutral gradations.** This is Linear's hierarchy according to
   [open-design's analysis](https://open-design.ai/it/plugins/design-system-linear-app/) and
   [Linear's redesign post](https://linear.app/blog/how-we-redesigned-the-linear-ui). Raycast pairs
   a near-black blue-tinted background with visible shortcuts
   ([design study](https://blakecrosley.com/guides/design/raycast),
   [open-design](https://open-design.ai/plugins/design-system-raycast/)). AXA already has this
   palette. Keep amber for "needs you" and save glow for that.
6. **Phone mechanics:** `viewport-fit=cover` with `env(safe-area-inset-*)`
   ([MDN env()](https://developer.mozilla.org/zh-CN/docs/Web/CSS/env),
   [Chromium cutout doc](https://chromium.googlesource.com/chromium/src.git/+/fafff21/docs/ui/android/display_cutout.md));
   `dvh` units so the address bar doesn't cut panes; a bottom tab bar with targets of 44px or more
   ([Material nav bar](https://m3.material.io/components/navigation-bar/overview)); container
   queries and `color-mix()` are Baseline 2023 ([web.dev](https://web.dev/blog/baseline2023)).
7. **Motion restraint.** Honor `prefers-reduced-motion`
   ([web.dev](https://web.dev/articles/prefers-reduced-motion)). Keep motion for state (working
   pulse, needs-you pulse). Use HUD decoration such as corner brackets, ticks and rings only where it
   carries no information ([arwes](https://arwes.dev/docs) is the reference look, but it's React and
   alpha, so take the ideas, not the code).
8. **Installable PWA and Web Push** ([web.dev PWA](https://web.dev/explore/progressive-web-apps)).
   This is the long-term route to phone alerts without opening the page.

## (c) Design tooling

| Tool | License | Fit |
|---|---|---|
| Headless Chrome over the DevTools protocol | BSD (Chromium) | **Adopted**: `scripts/shot.mjs` takes desktop and phone screenshots with zero dependencies, and the agent reads the PNGs |
| [Playwright `toHaveScreenshot`](https://www.mintlify.com/microsoft/playwright/advanced/visual-comparisons) | Apache-2.0 | Baselines and diffs, but a heavy dependency; later, if visual regressions become a problem |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) / [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Apache-2.0 | Interactive verification for sessions. DevTools MCP sends usage statistics unless `--no-usage-statistics` is passed. Recommend these; don't bundle them |
| [Open Props](https://www.jsdelivr.com/package/npm/open-props) | MIT | Token naming ideas (spacing and easing scales). AXA keeps its own `:root` tokens |
| Radix Colors / Tabler icons | MIT | Copy a dark scale or single inline SVGs if needed (Lucide is ISC, which is not on the allowed list) |
| axe-core / pa11y | MPL-2.0 / LGPL | Run only as external tools; not reusable under the MIT/Apache/BSD rule |
| WCAG contrast formula | n/a | A 10-line check (used above) |
| [Anthropic frontend-design skill](https://agentskillsfinder.com/skills/frontend-design) | check upstream | Its "pick a clear direction, real content" brief is worth paraphrasing in a design-review skill |

## (d) Skills, plugins, agents, hooks and MCP servers

**What makes a skill useful** ([Anthropic best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)):
a specific description that drives triggering; a concise SKILL.md under 500 lines with progressive
disclosure; exact scripts for fragile steps; validate → fix → repeat feedback loops; scripts that
handle their own errors; evals written first.

| Item | License | Relevance |
|---|---|---|
| [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Apache-2.0 | Reference layout for AXA's manifest and marketplace |
| [anthropics/skills](https://github.com/anthropics/skills) | mostly Apache-2.0 (doc skills source-available) | `template-skill` and the spec |
| [obra/superpowers](https://github.com/obra/superpowers) | MIT | verification-before-completion, dispatching-parallel-agents, finishing-a-development-branch: closest to AXA's playbook |
| [wshobson/agents](https://github.com/wshobson/agents) | MIT | A large roster to mine for roles |
| [disler/claude-code-hooks-mastery](https://github.com/disler/claude-code-hooks-mastery) | not shown | Exit code 2 blocks and feeds stderr back; Stop hooks must check `stop_hook_active` |
| [ccusage](https://github.com/ryoppippi/ccusage) | MIT | Model for a usage skill |
| [GitHub MCP server](https://github.com/github/github-mcp-server) | MIT | For a release/PR skill that stops at one-way doors |

**Recommended for AXA to ship:** (1) a Stop-hook **"done means verified"** gate: no clean stop if
files were edited after the last test, build or screenshot; it checks `stop_hook_active`, has a retry
cap and can be switched off. (2) A `verify` skill plus `verify.mjs` that detects and runs the
project's test, lint and build commands, and screenshots UI changes with `scripts/shot.mjs`. (3) A
`design-review` skill: screenshot → rubric (hierarchy, contrast, 44px targets, no horizontal scroll
at 390px) → fix → re-shoot. (4) An `/axa:status` command. (5) An `axa-usage` skill that parses
Claude's local logs, following ccusage. (6) A `release` skill that opens a PR and stops at the
one-way door.

## (e) Terminal experience

| Source | Idea |
|---|---|
| [herdr](https://github.com/ogulcancelik/herdr) (Apache-2.0) | Per-pane working, blocked or idle state; a CLI and socket API where you can *wait* until an agent is blocked. For AXA: `axa wait <name>` |
| `claude agents` ([blog](https://claude.com/blog/agent-view-in-claude-code), [guide](https://dsebastien.net/claude-code-agent-view-one-screen-for-every-background-session/)) | Verb set `attach`, `logs`, `--json`, and peek with Space; copy the verbs so AXA feels familiar |
| [Claude Code statusline](https://code.claude.com/docs/en/statusline) | Show "2 waiting" in the commander's own status bar |
| [clig.dev](https://clig.dev) | No color when not a TTY, `NO_COLOR`, `TERM=dumb` or `--no-color`; `--json`; output within about 100ms; Ctrl-C exits fast; help leads with examples |
| [no-color.org](https://no-color.org) | `NO_COLOR` set and non-empty means no color |
| [gh CLI accessibility](https://github.blog/engineering/user-experience/building-a-more-accessible-github-cli/) | Use only the 16 ANSI colors so the user's theme applies; pair color with a glyph and a word |
| [Bubble Tea](https://github.com/charmbracelet/bubbletea) (MIT) | Elm loop: one state, one `render`, one key handler (pattern only; it's Go) |
| [k9s hotkeys](https://k9scli.io/topics/hotkeys/) | A key legend in the footer of every list view |
| [tmux man page](https://man.openbsd.org/tmux.1) | `-L` sockets (AXA already uses them), `#(cmd)` in `status-right` for a needs-you counter |
| Notifications ([tnotify](https://pkg.go.dev/github.com/soloterm/tnotify@v0.1.6), [pi-notify](https://github.com/ferologics/pi-notify)) | Always ring the bell. OSC 9 / OSC 777 support varies by terminal, so make them opt-in. tmux swallows OSC unless passthrough is on; on WSL use `powershell.exe` toasts, since `notify-send` lacks D-Bus |

The researchers found no usable sources for lazygit, btop, Warp, Zellij or Gum, so nothing above
relies on them.

---

## Ranked backlog

Impact is for a solo developer who wants to give the least input possible. Effort assumes AXA's
zero-dependency Node and plain-HTML style. Risk means risk to the user's work or safety.

| # | Item | Impact | Effort | Risk | Status |
|---|---|---|---|---|---|
| 1 | **Phone-first sessions list**: urgency-sorted "needs you" inbox, glyph + word + color, big tap targets, bottom nav, safe-area/dvh, reduced motion, contrast fix | High | S | Low | **Built** |
| 2 | **What each session changed**: branch, files and ± on every card; a changes (diff) viewer; `read_changes` MCP tool so the commander verifies diffs; git line in `list_sessions` | High | S | Low (read-only) | **Built** |
| 3 | **Terminal**: `axa status` urgency-sorted with NO_COLOR/TTY rules, `--json`, `--watch` live dashboard (bell on new needs-you, 1-9 attach), `axa attach <name>` with Ctrl-] detach | High | M | Low | **Built** |
| 4 | **Visual review loop**: `scripts/shot.mjs` (desktop + phone screenshots, `--eval` to open dialogs) | Med | S | Low | **Built** |
| 5 | Fix: xterm replies (`1;2c0;276;0c`) typed into sessions on every page load | Med | XS | Low | **Built** (bug found while verifying) |
| 6 | Opt-in phone push when a session needs you (ntfy/Telegram URL in policy.json; name + status only, redacted) | Very high | S | Med (data leaves the machine; opt-in) | **On hold** (owner's call, 2026-10-16) |
| 7 | Answer a prompt from the list: the waiting session's options (numbered or not) as buttons; tap to arm, tap to send; the server re-checks the same prompt is on screen; only the console page may call it (Sec-Fetch-Site), and project sessions are refused access to `~/.axa` and the console API | High | M | Med | **Built** |
| 8 | Stop-hook "done means verified" gate (once per turn via `stop_hook_active`, docs exempt, switchable) + `verify` skill (`verify.mjs` PASS/FAIL table) | High | M | Med | **Built** |
| 9 | Worktree per goal: opt-in `worktree` on `open_session` (`<repo>/.claude/worktrees/<name>`, branch `axa/<name>`), `remove_worktree` on close (refuses if dirty; branch kept); merge stays the user's call | High | M | Med | **Built** |
| 10 | Usage per session from Claude's transcripts (helpers included, deduplicated), per-project token budget; the commander is told when one goes over | Med | M | Low | **Built** (tokens; no dollar cost, since prices change and subscriptions don't bill per token) |
| 11 | Git snapshot (tag or `stash create`) before each `start_goal`, for one-step rollback | Med | S | Low | Later |
| 12 | `axa wait <name>`, `axa log` (tail decisions), tmux status-line counter, shell completions | Med | S | Low | Later |
| 13 | Feed filters (needs you / decisions / errors) and search | Med | S | Low | Later |
| 14 | PWA manifest + Web Push (VAPID signing without dependencies) | High | L | Med | Later |
| 15 | `design-review` skill, `/axa:status` command, statusline script | Med | S | Low | Later |
| 16 | Spec-first goal template (requirements → design → tasks in SPEC.md) | Med | S | Low | Later |
| 17 | One-line AI summary per session (a cheap `claude -p` per state change) | Med | S | Low (cost) | Later |
| 18 | Container sandbox for overnight auto-approve runs | High | L | Med | Later |
| 19 | Terminal pass: the right size on every screen (the window follows the screen in use, re-claimed on focus), a phone key bar (Esc, Ctrl, ^C, Tab, ⇧Tab, arrows, Enter), text size A−/A+, search, clickable links, GPU drawing on desktop (xterm add-ons, MIT) | Med | S | Low | **Built** |
| 20 | Auto-verify in the commander: after a supervisor "done", run `read_changes` + the verify skill in the session before reporting | Med | S | Low | Later |
| 21 | Isolation beyond pattern checks: project sessions run as the user, so the console token and AXA's tmux are only kept out of reach by the policy and a clean env; a per-session OS user or container (see #18) would make it a hard boundary | Med | L | Low | Later (from review) |
| 22 | Send photos/files from the phone into a session (as Claude Code Remote Control does) | Low-Med | M | Low | Later |
| 23 | **Mission control in the terminal** (`axa`): herdr-style sidebar of AXA + sessions by urgency next to the live, interactive session (headless-terminal renderer), with Ctrl-b actions for answers, diff, verify, goals, worktrees, new/close; mouse; bell + title | High | M | Low | **Built** |
| 24 | Terminal UI polish from great TUIs: settings screen + ui.json, five themes (terminal default, hud, light, contrast, mono), configurable prefix, command palette (Warp/lazygit), split panes and zoom (tmux/zellij), browse with live preview (choose-tree/peek) | High | M | Low | **Built** |
| 25 | Next for the terminal UI: activity sparklines (btop), floating panels (zellij), search across sessions (Warp), feed strip, SSH machines (herdr) | Med | M | Low | Later |
