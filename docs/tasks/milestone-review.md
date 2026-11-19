# Task: milestone reviews with a verifier <-> fixer loop (replace per-turn Opus reviews by default)

Repo /home/adrianwsl/axa, branch axa-v2. Commit locally at the end (git -c user.name="Adrian Alvear"
-c user.email=adrianalvear09@gmail.com commit; message "Reviewer: milestone mode with a verifier/fixer loop",
plus "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"). Never push. Don't revert other changes.
Don't restart the daemon yourself; say in the report that it needs a restart.
Read first: src/core/reviewer.mjs, src/core/supervisor.mjs, agents/reviewer-gate.md, hooks/policy.mjs (reviewer role),
mcp/axa-terminals.mjs, bin/axa, README "Independent review", test/reviewer.test.mjs.

## Behaviour
1. Setting reviewer.mode in ~/.axa/policy.json (global and per project, like today): "milestone" (NEW DEFAULT) | "turn"
   (today's behaviour: review after every code-changing worker turn) | "off". AXA_REVIEWER=0 still turns it off.
   In "milestone" mode a worker's finished turn gets NO model review; the cheap checks (verify gate) are unchanged.
2. A milestone review reviews a RANGE in a repo: base..HEAD plus uncommitted and untracked work. Base defaults to the
   last milestone recorded for that repo+branch (store in ~/.axa/milestones.json: { "<repo>#<branch>": { sha, at,
   verdict } }), else the upstream (`@{upstream}` / origin/<branch> merge-base), else HEAD~20. The reviewer gets the
   commit list (subjects) and the diff (redacted like read_changes; if the diff is > ~150 KB, give per-file stats plus the
   largest/most important files' diffs and let it read others itself), and cited spec files inlined as today.
   Prompt framing: "review this batch of work as a whole: does each commit do what its message says; cross-commit
   problems; regressions; missing tests; docs; security; leftovers" with the same EVIDENCE RULE, JSON verdict and the
   daemon's mechanical confirmation of block findings.
3. Triggers:
   - MCP tool for the commander: review_changes({ project | cwd, base? }) -> starts the milestone review and returns an id;
     the verdict arrives as a supervisor wake ("milestone review <repo>: ✓ approve / ⚠ warn / ✗ block · summary").
   - CLI for the user: `axa review [path] [--base <sha>]` (prints progress and the verdict; same engine via the daemon API
     POST /api/review { cwd, base }).
4. Fixer loop when the confirmed verdict is "block" (or "warn" with high-severity findings): the daemon opens a NEW
   worker session in that repo (same mechanism as open_session; AXA_ROLE=worker, accept-edits, normal policy), named
   "fixer", and sends it ONE self-contained instruction: the confirmed findings (file:line, quote, problem, evidence),
   "fix exactly these, add/adjust tests, run the project's checks, commit locally with message 'Fix review findings:
   <short>', don't change anything else, never push". When the fixer finishes, the verifier re-reviews ONLY base..new
   HEAD with the previous findings listed ("check these are fixed and nothing new broke"). Max 3 rounds; then wake the
   commander with what's still open. On approve: record the milestone (sha), close the fixer session, wake the commander
   with the verdict and the fix commits. The fixer never reviews; the verifier never edits.
5. Visibility: the Control log shows "milestone review: …", the session/map shows the fixer with a "fixer" label, and
   list_sessions shows active milestone reviews and their round.
5b. Timeouts: a per-turn review timed out at today's 10 min default (Opus at high effort, diff + full test run). Make the
   timeout per mode: turn 15 min, milestone 30 min (settings reviewer.timeout_ms / reviewer.milestone_timeout_ms). Tell
   the reviewer in its prompt to run the project's checks ONCE, and stream its progress so a long review shows
   "reviewing… (checks running)" instead of looking stuck. On timeout, keep today's "error" verdict but include how far it got.
6. commander.md: one short paragraph: reviews run at milestones (before a push, or when a batch of work is done) via
   review_changes; don't push until the milestone review approves or the user accepts the open findings.

## Checks before you finish
- node --check on changed files; node --test test/*.test.mjs all pass.
- New tests: base selection (stored milestone, upstream merge-base, fallback), range diff includes commits + uncommitted,
  mode handling (milestone skips per-turn review, turn mode unchanged, off), the verifier/fixer loop with a fake reviewer
  (AXA_REVIEWER_CMD) and a fake fixer (drive events): block -> fixer -> re-review approve; block x3 -> commander;
  milestone recorded on approve.
- README: update "Independent review" for the modes, review_changes, `axa review`, and the fixer loop.
- Report in <= 8 lines, noting that no real billed review ran (unless one did).
