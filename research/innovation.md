# AXA innovation research (November 2026)

Lane: new ideas and bigger bets, not polish. Design, performance and functionality are covered by
other reports. The October report (`docs/research/2026-10-self-improve.md`) already surveyed the
consoles (Conductor, Claude Squad, Sculptor, Crystal, Vibe Kanban, Agent View) and its backlog is
mostly built. This report starts from that point and asks a different question: **what would let
the user hand AXA a goal and come back to finished, trusted work, with even less input than
today?**

Bottom line: AXA's plumbing (tmux sessions, policy plus approver, verify gate, supervisor, links)
is ahead of most tools. What's missing is a **brain around the plumbing**: a durable plan the
commander can't lose, an independent judge of "done" that doesn't spend the commander's context,
and a loop that learns from the thousands of decisions AXA already logs. Claude Code itself
shipped primitives in 2026 (channels, agent hooks, `StopFailure`, `claude agents --json`, plugin
evals, the advisor) that make each of these cheaper to build than it was six months ago.

---

## 1. Landscape (what moved since October)

### Claude Code primitives AXA can build on

| Primitive | What it gives AXA | Source |
|---|---|---|
| **`/goal`** | A Haiku-class evaluator checks the condition after every turn, but *only reads the transcript*: "It doesn't run commands or read files independently". Auto-retries, pauses on rate limits, idle check-ins every 30 min of background work. | [goal docs](https://code.claude.com/docs/en/goal) |
| **Channels** (research preview) | An MCP server declares `experimental['claude/channel']` and pushes `notifications/claude/channel` events into a running session; events queue and are delivered together on the next turn. Optional `claude/channel/permission` relays permission prompts to another device. Custom channels need `--dangerously-load-development-channels server:<name>` (interactive confirmation). | [channels reference](https://code.claude.com/docs/en/channels-reference), [channels](https://code.claude.com/docs/en/channels) |
| **Agent view / background sessions** | `claude --bg --name x "<prompt>"`, `claude agents --json --all` with `state` (working/blocked/done/failed/stopped) and `waitingFor` (permission prompt, input needed...), `claude respawn`, its own supervisor, automatic worktree per dispatched session, idle stop after ~1 h. | [agent view](https://code.claude.com/docs/en/agent-view), [blog](https://claude.com/blog/agent-view-in-claude-code) |
| **Hooks, new events and types** | `StopFailure` (error = `rate_limit`, `billing_error`, `server_error`...), `TaskCreated`/`TaskCompleted`, `TeammateIdle`, `FileChanged`, `PreCompact`/`PostCompact`, `PreModelSwitch`, `SessionEnd`; handler types `prompt` and `agent` (a multi-turn verifier subagent with Read/Grep/Glob). | [hooks reference](https://code.claude.com/docs/en/hooks) |
| **Agent teams** (experimental) | Lead + teammates with a shared task list and mailbox, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; one team per session, no nesting, same-file edits collide. | [agent teams](https://code.claude.com/docs/en/agent-teams), [reverse-engineering write-up](https://dev.to/nwyin/reverse-engineering-claude-code-agent-teams-architecture-and-protocol-o49) |
| **Routines / cloud sessions** | Saved prompt + repos + environment that runs on Anthropic's infrastructure on a schedule, API call or GitHub event; `--remote`/`--teleport` move work between cloud and terminal (flag names vary by source). | [routines announcement](https://claude.com/blog/introducing-routines-in-claude-code), [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) |
| **Managed Agents** (API beta) | Server-hosted agent harness with cloud or self-hosted sandboxes and memory stores. | [platform docs](https://platform.claude.com/docs/en/managed-agents/overview) |
| **`claude plugin eval`** | Eval suites inside a plugin: cases (`prompt.md`, `case.yaml`), graders `regex`, `tool_used`, `tool_order`, `file_exists`, `llm`, `baseline`; no-plugin baseline (Δ), mock MCP servers, `--threshold` exit code for CI. | [plugin evals](https://code.claude.com/docs/en/plugin-evals) |
| **Advisor strategy** | A cheaper executor (Sonnet/Haiku) consults Opus mid-task; Anthropic reports +2.7 pts on SWE-bench Multilingual at 11.9% lower cost per task for Sonnet+Opus advisor. | [the advisor strategy](https://claude.com/blog/the-advisor-strategy) |
| **Auto memory / dream** | MEMORY.md + topic files written during sessions; a consolidation pass merges duplicates and drops stale notes (rollout status unclear). | [tessl write-up](https://tessl.io/blog/anthropic-tests-auto-dream-to-clean-up-claudes-memory/), [claudefa.st](https://claudefa.st/blog/guide/mechanics/auto-dream) |

### Other orchestrators

- **Devin "manages Devins"** (Mar 2026): a coordinator scopes work, spawns child sessions each with
  its own prompt, skills and **ACU (cost) limit**, is **woken automatically** when a child finishes
  or needs input, can **schedule messages to itself** for checkpoints, and compiles results. This is
  the closest commercial analogue to AXA's commander. ([Cognition blog](https://cognition.ai/blog/devin-can-now-manage-devins),
  [docs](https://docs.devin.ai/work-with-devin/advanced-capabilities), ["batch 3 agents, pick the best"](https://docs.devin.ai/use-cases/gallery/batch-3-agents-best-solution))
- **Codex cloud** `--attempts 1-4`: best-of-N on one task, the user picks a diff
  ([third-party guide](https://codex.danielvaughan.com/2026/04/01/codex-cloud-exec-best-of-n-attempts/)).
  VS Code's agents window compares models side by side ([docs](https://code.visualstudio.com/docs/agents/run/compare-models.md)).
- **OpenHands critic**: a trained critic reranks N rollouts. Best@8 73.8% vs 57.9% random on the
  mixed-outcome subset of SWE-bench Verified; **early stopping** gains 17.7 pts with ~1.35 attempts
  on average; now built into the OpenHands CLI.
  ([blog, Mar 2026](https://openhands.dev/blog/20260305-learning-to-verify-ai-generated-code),
  [2025 SOTA post](https://openhands.dev/blog/sota-on-swe-bench-verified-with-inference-time-scaling-and-critic-model),
  [Critic Rubrics paper](https://arxiv.org/pdf/2603.03800), [SWE-Gym verifier](https://arxiv.org/pdf/2412.21139))
- **Conductor** (worktrees, Claude/Codex/Cursor agents, now cloud workspaces) and **Sculptor**
  (container per agent, pairing mode): the UI race is crowded and well funded
  ([madewithlove on Conductor](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel.md),
  [Imbue Sculptor](https://imbue.com/sculptor/), [2026 tool roundup](https://crystl.dev/blog/best-ai-agent-orchestration-tools/)).
  AXA should not compete on UI chrome; it should compete on **autonomy you can trust**.
- **Spec-driven development**: GitHub Spec Kit's constitution → specify → plan → tasks → implement,
  and Kiro's requirements → design → tasks
  ([Spec Kit guide](https://www.augmentcode.com/guides/github-spec-kit-practical-guide-sdd-workflow)).

### Research that bears on design choices

- **Why multi-agent systems fail (MAST, NeurIPS 2025)**: 14 failure modes in 3 groups:
  *specification issues*, *inter-agent misalignment*, *task verification*. Failures come mostly from
  system design, not model weakness. ([arXiv 2503.13657](https://arxiv.org/abs/2503.13657v2))
  → AXA's three weak spots map exactly onto these: specs live only in the commander's chat, sessions
  don't know about each other, and "done" is checked by regex plus the commander's goodwill.
- **Anthropic's multi-agent research system**: orchestrator-worker beat single agent by 90.2% on
  their eval; token usage explains ~80% of variance; multi-agent runs burn ~15× chat tokens.
  ([engineering post](https://www.anthropic.com/engineering/multi-agent-research-system))
  → spend tokens where they buy quality (verification, parallel attempts on hard tasks), not on
  chatter.
- **ACE, Agentic Context Engineering (ICLR 2026)**: treat context as an evolving *playbook* updated by
  generate → reflect → curate with **incremental deltas**, avoiding "brevity bias" and "context
  collapse"; +10.6% on agent benchmarks, learns from execution feedback without labels.
  ([arXiv 2510.04618](https://arxiv.org/html/2510.04618v2), [code](https://github.com/ace-agent/ace))
- **Voyager** (skill library of verified programs) vs **Reflexion** (in-episode verbal lessons):
  keep what *worked* as reusable artifacts, not just notes. ([Voyager](https://arxiv.org/html/2305.16291v2),
  [Reflexion](https://arxiv.org/abs/2303.11366))
- **Routing and cascades**: RouteLLM routes strong vs weak per query with large savings at ~95% quality;
  code cascades escalate only when the cheap model's candidate is weak; LLM self-confidence is poorly
  calibrated, so escalate on *external* signals (tests). ([RouteLLM](https://arxiv.org/abs/2406.18665v4),
  [Stanford review](https://web.stanford.edu/~shuhuiq/blog/review-routing-cascades.html),
  [cascades overview](https://tianpan.co/blog/2025/11/03/llm-routing-model-cascades))

---

## 2. Proposals

Each has: the idea, why it matters for minimal input, where it fits, risks, effort (S < 1 day,
M a few days, L a week+), impact. File names are AXA's current modules.

### P1. Done-time critic: an independent judge with fresh context

**Idea.** When a session settles on "done", the daemon starts a short, read-only `claude -p` review
(the `axa:reviewer` agent's discipline, tools Read/Grep/Glob plus `verify.mjs`) in that session's
folder. It gets the session's goal/acceptance criteria, the diff (`git.mjs diffOf`) and the session's
last report, runs the project checks, and returns structured JSON: `{verdict: approve|warn|block,
criteria: [{text, met, evidence}], checks: [...], risks: [...]}`. The verdict is stored on the run
(`events.mjs` runs) and shown in the hub. On **block**, the critic's findings go back to the session
automatically (once or twice, capped); on **approve**, the commander is told "feed done, critic
approved, 4/4 criteria met" instead of having to re-read the diff itself.

**Why for minimal input.** Today "done means checked" means *a* check ran (a regex over Bash commands
in `hooks/verify-gate.mjs`), and `/goal`'s evaluator only reads the transcript. The real verification
load falls on the commander (context, tokens) or the user. A fresh-context critic is what the
OpenHands and MAST results say pays off most: verification is where multi-agent systems fail, and a
critic with early stopping gets most of best-of-N's gain at ~1.35× cost.

**Fit.** New `src/core/critic.mjs` (spawn like `hooks/approver.mjs judge()`: env scrubbed,
`--json-schema`, timeout); trigger from `src/core/supervisor.mjs` on a settled done (reuse `DONE_MS`);
verdict on runs in `src/core/events.mjs`; new MCP tool `review_session` and a verdict line in
`describe()` in `mcp/axa-terminals.mjs`; `agents/reviewer.md` reused as the prompt; hub/web badge.
Optional second form: an `type: "agent"` Stop hook in `hooks/hooks.json` for the gate itself (the
hooks reference supports agent hooks on Stop).

**Risks.** Cost per done (mitigate: Sonnet/Haiku critic, only when the diff touched code, skip if
verify gate already saw a passing `verify.mjs` and the diff is small). False blocks causing loops
(cap retries, then escalate). The critic must treat the session's report as untrusted data (same
marking as `untrusted()`).

**Effort** M. **Impact** Very high.

### P2. Mission ledger: a durable plan with acceptance criteria

**Idea.** Missions become first-class objects in `~/.axa/missions/<id>.json`: the user's ask
(verbatim), acceptance criteria, a task graph (task → session, depends_on, status, evidence, critic
verdict), budget, and a running log. New MCP tools: `create_mission`, `update_task`, `get_mission`.
The supervisor's wake text names the mission and task ("feed finished task 2/5 of 'phone polish';
next unblocked: 3"), links (`chains.json`) become edges of the graph, and the hub shows a progress
line per mission. The commander can be restarted or compacted at any time and rebuild its picture
from `get_mission`.

**Why for minimal input.** The plan currently lives only in the commander's conversation. Compaction,
a restart or a long weekend loses it, and the user has to re-explain. MAST's largest failure group is
*specification*; Devin's coordinator, Claude agent teams' shared task list and Spec Kit's `tasks.md`
all externalize the plan. A ledger also makes "what's left?" answerable without the user asking.

**Fit.** New `src/core/missions.mjs` (same file pattern as `chains.json` in `supervisor.mjs`: 0600,
atomic writes); routes in `src/core/server.mjs`; tools in `mcp/axa-terminals.mjs`; `commander.md`
rule "every multi-step ask becomes a mission"; generalize `link_sessions` into task dependencies;
hub/web mission strip (`src/tui/control.mjs`, `src/web/index.html`). A `PreCompact` hook on the
commander can re-inject the active missions.

**Risks.** Over-structuring quick asks (rule: missions only for 2+ tasks or anything over ~30 min).
Ledger drift from reality (the supervisor updates task status from real session states, not from
the commander's claims).

**Effort** M. **Impact** Very high (it is the substrate for P1, P6, P7, P9).

### P3. Learning loop: lessons and policy suggestions from AXA's own log

**Idea.** AXA already logs a labeled dataset nobody uses: `AxaDecision` (allow/deny/escalate +
reason), `UserAnswer` (what the user did with escalations), `VerifyGate` bounces, `PolicyDecision`
refusals, `PostToolUseFailure`, critic verdicts (P1), runs with success or replacement. A periodic
`reflect` job (daily, or when the machine is idle) does ACE-style **delta** updates:

1. **Per-project lessons** (`~/.axa/lessons/<project>.md`): short bullets with evidence counts
   ("tests need `pnpm -w test`, not `npm test` (seen 6×)", "the e2e suite needs the dev server on
   :5173"). Injected into new project sessions through `SessionStart` `additionalContext`, capped at a
   few hundred tokens, pruned when unused or contradicted.
2. **Policy suggestions**: "You approved `docker compose up` 9 of 9 times in launches: add an allow
   rule?" and "the approver allowed X, then you reverted it: tighten?" Shown as one card in the hub;
   accepting writes `~/.axa/policy.json`. Never self-applied.

**Why for minimal input.** Every escalation the user answers twice is an interruption AXA should have
learned to avoid; every repeated mistake costs a verify bounce and tokens. This is the one loop that
makes AXA *need less of the user over time*.

**Fit.** New `src/core/reflect.mjs` reading `events.jsonl` (`readRange`) plus runs; `hooks/log-event.mjs`
(or a small new SessionStart hook) to print lessons; `hooks/policy.mjs` and `hooks/approver.mjs`
unchanged except reading accepted rules; suggestion card in `src/tui/control.mjs` and web.

**Risks.** Memory poisoning: a session could get text into lessons. Learn only from deterministic
signals and user-originated actions (UserAnswer, exit codes, critic verdicts), never from session
prose; redact with `lib/safety.mjs`; keep lessons human-readable and diffable. Collapse/bloat:
ACE-style bullets with counters, hard size cap.

**Effort** M. **Impact** High, compounding.

### P4. Push, not type: the supervisor as a Claude Code channel

**Idea.** Replace `sendText(commander, "[AXA supervisor: ...]")` (tmux send-keys) with a channel. The
commander's MCP server (`mcp/axa-terminals.mjs`) declares `experimental['claude/channel']`,
subscribes to the daemon's event stream, and emits `notifications/claude/channel` with structured
meta (`kind="done" session="feed" mission="m3" verdict="approve"`). Claude Code queues events while
the commander is busy and delivers them together on the next turn, so the `QUIET_MS` / "is the
commander idle" / "is the user typing" heuristics go away.

**Why for minimal input.** No more updates lost or delayed because the user was typing, no injected
keystrokes colliding with the user's input, and structured events the commander can route on. It also
gives a vetted path to the phone later: the channel permission relay (`claude/channel/permission`,
sender allowlist, five-letter request IDs) is exactly the "answer from my phone" feature the October
backlog held back (#6), but built on an official mechanism. (Still the owner's call.)

**Fit.** `mcp/axa-terminals.mjs` (capability + notification; it already talks to the daemon);
`src/core/supervisor.mjs` (emit instead of type; keep send-keys fallback); `src/core/sessions.mjs`
line ~173 (commander launch adds the channel flag); `src/core/server.mjs` (SSE already exists).

**Risks.** Research preview; custom channels need `--dangerously-load-development-channels`, which
shows a confirmation dialog at every start, and Team/Enterprise orgs must enable channels. Keep the
tmux path as the default until the channel can be allowlisted; detect and fall back automatically.

**Effort** M. **Impact** High (reliability), Very high if permission relay is later accepted.

### P5. Cost-aware model routing with escalation on evidence

**Idea.** Every session today runs the account's default model. Add per-task model and effort:
`open_session`/`start_goal` take `model` and `effort`; the roster gains defaults per kind of work;
the supervisor runs a **cascade on external signals**: start on Sonnet (or Haiku for mechanical
work), escalate to Opus after two failed verify/critic rounds or a stalled goal, and try the
advisor pairing (`/advisor`, Sonnet executor + Opus advisor) where available. Track tokens per
*completed and approved* task per project and model, so the commander learns which tier finishes a
project's typical task cheapest. Commander itself stays on the strongest model.

**Why for minimal input.** Rate limits and plan quotas are the hard ceiling on how much AXA can do
unattended; parallel sessions burn quota in parallel. Spending Opus only where it is needed buys more
finished work per day without the user tuning anything.

**Fit.** `src/core/sessions.mjs` (claude command line: `--model`, `--effort`); `mcp/axa-terminals.mjs`
(params, escalation tool); `roster.example.md` (already has a model column for subagents; extend to
sessions); `src/core/claude-data.mjs` (usage per run); `src/core/supervisor.mjs` (escalation rule);
optionally a `PreModelSwitch` hook to cap who may switch to the expensive tier.

**Risks.** Cheap model makes a mess that costs more to fix (escalate early on failing checks, never
on self-reported confidence, per the routing literature); model names drift (use aliases).

**Effort** S–M. **Impact** High.

### P6. Quota- and failure-aware scheduler with a work queue

**Idea.** Wire `StopFailure` into `hooks/hooks.json` (AXA doesn't listen to it today). A session that
hits `rate_limit`, `billing_error` or `server_error` becomes **paused (rate limit)** rather than
looking idle or done. On top of that, a queue: the user (or commander) adds tasks; AXA runs at most
K concurrently (K from settings, lowered automatically after rate-limit hits), starts the next when
one finishes, and resumes paused sessions when limits reset. `axa add "..."` from the CLI and a box
on the web console feed it.

**Why for minimal input.** "Here are six things, do them" should work without the user pacing it.
Today a rate-limited session silently stalls and parallel sessions compete for the same quota.

**Fit.** `hooks/hooks.json` + `hooks/log-event.mjs` (log StopFailure); `src/core/events.mjs` (status
`paused`, reason); `src/core/supervisor.mjs` (queue and concurrency); `bin/axa` (`add`, `queue`);
P2 missions supply the queue's structure.

**Risks.** Wrong concurrency guesses (start conservative, K=2–3); queue items need self-contained
instructions (same rule as `send_to_session`).

**Effort** S–M. **Impact** High.

### P7. Race mode: best-of-N attempts for hard or risky tasks, judged by the critic

**Idea.** `start_goal` with `attempts: 2–3` opens N worktree sessions (`open_session worktree`) on
the same goal, optionally on different models or with different approach hints ("minimal change" vs
"refactor"). The P1 critic scores each against the criteria; the commander presents one
recommendation and keeps the others' branches. With **early stopping**: start one attempt, start a
second only if the critic blocks or the first stalls (OpenHands' ~1.35 attempts result).

**Why for minimal input.** For ambiguous or high-stakes work, the user's input today is "look at the
result and decide whether to redo it". Racing turns that into "pick from verified options", or no
input at all when one clearly wins.

**Fit.** `mcp/axa-terminals.mjs` (`attempts`), `src/core/git.mjs` and worktree code in
`src/core/sessions.mjs` (already there), `src/core/critic.mjs` (P1), mission ledger (P2) to group
attempts; hub view "3 attempts, B recommended".

**Risks.** N× tokens: gate behind budgets and reserve for tasks the commander marks hard; worktree
clutter (auto-remove losers after the user merges a winner; branches kept).

**Effort** M. **Impact** Medium–high (high on hard tasks, wasteful on easy ones).

### P8. Spec-first intake: one round of questions, then silence

**Idea.** When the user's ask is non-trivial, the commander writes `SPEC.md` (or
`.claude/axa/specs/<mission>.md`) in the project: goal, acceptance criteria phrased as checkable
facts ("`pnpm test` exits 0", "the settings page has no horizontal scroll at 390px"), constraints,
out-of-scope. It asks the user **at most three** questions, only where the answer changes the work,
via `AskUserQuestion`, and then starts the goal pointing at the file. Criteria flow into the mission
(P2), the `/goal` condition and the critic (P1).

**Why for minimal input.** Paradoxically, one minute of the right questions up front is the cheapest
input: it prevents the redo loop. `/goal` docs stress conditions that "Claude's own output can
demonstrate"; criteria written this way are what makes P1 and `/goal` reliable.

**Fit.** `commander.md`, `skills/axa/SKILL.md` (a short "intake" section) or a new `skills/spec/`;
`mcp/axa-terminals.mjs` `start_goal` description already suggests pointing at a file.

**Risks.** Asking too much (hard cap; skip for small asks); spec files committed into the user's
repo (default to `.claude/axa/`, gitignored).

**Effort** S. **Impact** Medium–high.

### P9. Tiered supervision: a cheap triage before waking the commander

**Idea.** Not every "done" needs the strongest model's attention. A Haiku-class triage (one tool-less
`claude -p` with the same pattern as the approver) reads the structured facts (status, critic
verdict, mission next step, budget) and decides: *auto-continue* (the next task in the mission is
already specified and unblocked: send it), *log only*, or *wake the commander* (failure, decision,
anything ambiguous, or anything that needs the user). Optionally batch wakes into digests.

**Why for minimal input.** The commander's context and tokens are the scarcest resource in the
system; every wake grows its conversation. Routine progress shouldn't cost a commander turn, and the
user only needs the commander's summary when something changed.

**Fit.** `src/core/supervisor.mjs` (`supervise()` gains a triage step before `sendText`); needs P1
verdicts and P2 next steps to be safe; `WAKES_PER_HOUR` stays as a backstop.

**Risks.** Triage auto-continuing into work the user didn't ask for (only tasks already in the
mission ledger, never new ones; one-way doors are still caught by the policy and approver).

**Effort** S (after P1/P2). **Impact** Medium.

### P10. AXA evals: regression tests for the commander, approver and skills

**Idea.** Use `claude plugin eval` (AXA is already a plugin) with three suites:
(a) **approver**: a corpus built from real `AxaDecision` + `UserAnswer` pairs (redacted), graded on
"never allow what the user declined", "never escalate what the user always approves", plus adversarial
prompt-injection cases; (b) **commander**: mock the `terminals` MCP server (plugin eval supports mock
MCP servers) with scripted sessions and grade `tool_order` ("read_changes before reporting done",
"never send_to_session to a waiting session", "doesn't start unrequested work"); (c) **skills**:
`axa`, `verify` triggering on natural phrasing, with the no-plugin baseline Δ.

**Why for minimal input.** Every autonomy feature above changes prompts and policy. Without evals,
each change risks a silent regression the user discovers by being interrupted, or worse, by an
unwanted action. Evals are what let AXA improve itself (P3) safely.

**Fit.** New `evals/` directory in the plugin root; small refactor to export the approver prompt
builder from `hooks/approver.mjs`; corpus exporter script under `scripts/`.

**Risks.** Cost of runs (run the cheap graders on every change, `llm` graders before releases);
corpus must be redacted (`lib/safety.mjs redact`) and stay local.

**Effort** M. **Impact** High (enabler).

### P11. Cross-session conflict radar

**Idea.** The daemon already knows each session's changed files (`gitInfo`/`diffOf`). Detect overlaps:
two sessions editing the same file in one repo, a session changing an exported API/schema/route that
another project's session imports, or a worktree branch falling behind its base. Tell the commander
early ("feed and launches both edit `api/types.ts`") and suggest a link or a rebase task.

**Why for minimal input.** MAST's second failure group is inter-agent misalignment; for the user it
shows up as a merge conflict at the end, which is exactly the kind of decision that lands on them.

**Fit.** `src/core/git.mjs` (file lists per session), a check in `src/core/supervisor.mjs` loop,
a note in `describe()` in `mcp/axa-terminals.mjs`; hub badge.

**Risks.** Noise from lockfiles and generated files (ignore list); cross-repo dependency detection is
heuristic (start with same-repo overlaps).

**Effort** S–M. **Impact** Medium.

### P12. Hybrid backend: lean on Claude Code's own supervisor and cloud for overflow

**Idea.** Keep tmux for the live, interactive view (AXA's core UX), but read status from
`claude agents --json` (`state`, `waitingFor`) where available instead of parsing screens
(`src/core/screen.mjs`), and allow overflow tasks to run as `claude --bg` local background sessions
or cloud sessions/routines when the laptop will be closed, with results pulled back as branches.

**Why for minimal input.** Official state fields are sturdier than screen parsing and survive Claude
Code UI changes; cloud overflow lets "do this overnight" work with the lid shut.

**Fit.** `src/core/sessions.mjs`, `src/core/events.mjs` (status source), `src/core/screen.mjs`
(fallback only); a `where: "local" | "background" | "cloud"` option on `open_session`.

**Risks.** Research-preview interfaces change; Agent View auto-creates its own worktrees and stops
idle sessions after ~1 h, which can fight AXA's model; cloud means code and data leave the machine
(owner's call, like push). Start read-only (status), not dispatch.

**Effort** L. **Impact** Medium (strategic hedge).

### P13. Skill harvesting: turn verified successes into reusable playbooks

**Idea.** Voyager's insight applied to AXA: when a mission completes with an approved critic verdict
and the same *shape* of task has succeeded before (e.g. "add a page + route + test" in this repo,
"bump dependency and fix breakage"), the reflect job (P3) drafts a project skill
(`.claude/skills/<name>/SKILL.md`) with the exact steps and commands that worked, and offers it to
the user. Devin calls these playbooks.

**Why for minimal input.** Next time the instruction can be one line ("do the usual dependency bump
in feed"), and the session follows a proven recipe instead of rediscovering it.

**Fit.** `src/core/reflect.mjs` (P3), output to the project's `.claude/skills/` only after approval;
skill quality checked with P10 evals.

**Risks.** Overfitting to one success; writing into the user's repo (offer, don't write).

**Effort** M. **Impact** Medium, compounding.

---

## 3. Top 3, ranked

Ranking weighs impact on "minimal input, trusted result", how much else it unlocks, and risk.

### #1 Done-time critic (P1)

It turns AXA's weakest link (verification by regex plus the commander's diligence) into its
strongest claim, and every other bet (triage, race mode, learning) needs a trustworthy verdict.

Sketch:
1. `src/core/critic.mjs`: `review(session)` builds the input from the mission criteria (or the
   session's goal from the log, as `goalOf()` in `approver.mjs` does), `diffOf()` output (capped,
   secrets excluded, as today) and the last report, all wrapped as untrusted data.
2. Spawn `claude -p --model sonnet --tools Read,Grep,Glob,Bash --output-format json --json-schema
   <VERDICT>` in the session's cwd with the scrubbed env pattern from `approver.mjs`. Bash is limited
   to running `node <plugin>/skills/verify/verify.mjs .` and read-only git via the existing policy
   hook (the critic runs as `AXA_ROLE=worker`, so `hooks/policy.mjs` applies), or with no Bash and
   the daemon runs `verify.mjs` itself and pastes the table in.
3. Trigger in `supervisor.mjs`: on a done that held `DONE_MS`, and only if the diff touched non-doc
   files; one critic per session at a time; result logged as a `CriticVerdict` event and attached to
   the run in `events.mjs`.
4. On `block`: send the findings to the session (max 2 rounds, then mark "needs you"). On
   `approve`/`warn`: include the verdict in the supervisor wake and in `describe()`.
5. Hub/web: a verdict chip on the session card and run history. Setting `"critic": "off" | "on" |
   {"model": "haiku"}` in `policy.json`.
6. Evals (P10): seeded diffs with known bugs; measure catch rate and false blocks before turning it
   on by default.

### #2 Mission ledger with spec-first intake (P2 + P8)

The plan and acceptance criteria survive compaction, restarts and days; criteria feed `/goal`, the
critic and triage; the user explains once.

Sketch:
1. Schema: `{id, title, ask, criteria[], tasks: [{id, title, session, depends_on[], status, goal,
   verdict, evidence}], budget, created, log[]}` in `~/.axa/missions/<id>.json` (0600, atomic write
   like `saveMeta()`).
2. `src/core/missions.mjs` + REST routes in `server.mjs`; MCP tools `create_mission`
   (with criteria and tasks), `update_task`, `get_mission`, `list_missions`.
3. The supervisor maps session state → task status (truth from sessions, not commander claims);
   when a task's dependencies are done, it is "ready" (replacing ad-hoc links, which become
   dependencies with an instruction).
4. `commander.md`: "multi-step asks → intake (≤3 questions) → `SPEC.md` under `.claude/axa/` →
   `create_mission` → `start_goal` per task pointing at the spec". A `PreCompact`/`SessionStart`
   hook on the commander re-injects a one-screen summary of active missions.
5. Hub and web: one progress line per mission ("phone polish 3/5 · 1 needs you").

### #3 Learning loop from AXA's own log (P3, with P13 later)

The only proposal that reduces input *over time*; it uses data AXA already collects.

Sketch:
1. `src/core/reflect.mjs` runs nightly or after N finished runs: reads `events.jsonl` since the last
   pass; extracts escalation → `UserAnswer` pairs, verify-gate bounces followed by the command that
   then passed, repeated failures and critic findings, grouped by project.
2. Policy suggestions: pattern-mine commands the user approved ≥N times with zero declines →
   propose an allow rule; approver allows followed by a user revert or decline → propose an escalate
   rule. One card in the hub; Enter accepts and writes `policy.json`.
3. Lessons: a single tool-less `claude -p` turns the extracted facts (never raw session prose) into
   ≤10 bullets per project with counters; merge as deltas (add, bump, retire), never full rewrites.
4. Injection: a `SessionStart` command hook for AXA workers prints the project's lessons as
   `additionalContext` (cap ~300 tokens).
5. Safety: only deterministic or user-originated signals; redaction via `lib/safety.mjs`; lessons
   file is plain markdown the user can edit; P10 evals gate prompt changes.

Runner-up: **P4 channels** is the cleanest engineering upgrade and the right long-term home for phone
approvals, but it depends on a research-preview flag with a confirmation dialog, so it ranks fourth.

---

## 4. Ideas considered and rejected

| Idea | Why not (now) |
|---|---|
| **Replace AXA sessions with Claude agent teams** | Experimental flag; one team per session, no nesting; teammates in one project and same-file edits collide. AXA's cross-project tmux sessions with their own policy are more capable. Borrow the shared task list idea instead (P2). |
| **Replace tmux with headless Agent SDK sessions** | Gives structured events but loses the live, interactive full-screen session, which is AXA's core experience. Use structured status as a supplement (P12). |
| **Debate / voting among several agents on every task** | Multi-agent runs cost ~15× tokens and MAST shows more agents add misalignment failures. Reserve multiple attempts for hard tasks, judged by a critic (P7). |
| **Trained router (RouteLLM-style)** | Needs preference data AXA doesn't have and a model to host; subscription billing blurs the cost signal. Rule-based cascade on test outcomes (P5) gets most of the value. |
| **Vector database / embeddings memory** | New dependency, opaque, poisoning-prone; the corpus per project is small. Plain markdown lessons with counters (P3) are auditable and enough. |
| **AXA rewriting its own `commander.md`, policy or hooks automatically** | A self-modifying control plane is a safety hazard (prompt injection could persist). Learning produces *suggestions* the user accepts (P3), checked by evals (P10). |
| **Auto-merge winning branches or auto-push** | One-way doors. Merging stays the user's call per AXA's existing rules. |
| **A cloud VM per session by default (Devin/Cursor style)** | Cost, account setup, and code leaving the machine. Keep cloud as opt-in overflow (P12). |
| **Supporting Codex/Gemini/Cursor agents inside AXA** | Conductor already does this; AXA's policy, approver, verify gate and tracing all rely on Claude Code hooks, so each new harness doubles the safety surface. |
| **Kanban/issue board UI as the main surface** | It's the design lane and the field is crowded (Vibe Kanban is sunsetting). The mission ledger (P2) gives the structure without a new UI paradigm. |
| **Phone push via a third-party service now** | The owner put it on hold (October backlog #6). P4's channel permission relay is the route to revisit when the owner wants it. |
| **`/loop` polling in the commander instead of the supervisor** | Burns commander turns and context on "nothing changed". Event-driven wakes (today) or channels (P4) are strictly better. |
