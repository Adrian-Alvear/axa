# Task: a live, anticipating voice (AXA narrator)

Repo /home/adrianwsl/axa, branch axa-v2. Read docs/HANDOFF.md, src/core/notify.mjs, src/core/summary.mjs, src/core/voice.mjs,
src/core/server.mjs (voice parts), src/core/events.mjs first. Copy this spec to docs/tasks/voice-live.md in the first commit. Local
commits only (git -c user.name="Adrian Alvear" -c user.email=adrianalvear09@gmail.com commit, message ending "Co-Authored-By: Claude
Opus 5.5 <noreply@anthropic.com>"), stage only your files. Never push. Don't restart the user's daemon; don't modify ~/.axa or
~/.claude.json (tests use temp HOME). `npm run check` must pass after each part.
Why: the user often isn't looking at the screen. Today the voice lags: it only speaks at turn end / needs-you, max 1 notice per 20 s,
long replies wait up to ~10 s for a Haiku summary, and queued notices play even after they're stale. The user wants it close to
real time and, where possible, anticipating. Research found no shipped dev tool that anticipates; VS Code's audio cues and cockpit
alert tiers (warning / caution / advisory) are the closest prior art.

## Part A: a speech queue that stays current (commit "Voice: priority queue that preempts, coalesces and drops stale speech")
1. One narrator module (src/core/narrator.mjs, pure core + thin I/O): items { session, key, priority, at, ttl, text }.
   P0 needs-you / failed / limited / exited (never rate-limited, no TTL until resolved), P1 done / review verdict / milestone,
   P2 progress, P3 routine (earcon only or nothing).
2. One "now speaking" slot + pending list. Coalesce by (session, key): a newer item replaces a queued older one ("tests passed"
   replaces "running tests"). At dequeue, drop items whose TTL passed (P2 ~15 s, P1 ~90 s) or that the session state has made
   obsolete (the user already answered the prompt, the session moved on, the reply was superseded).
3. Preempt at sentence boundaries (Kokoro already speaks sentence by sentence): a P0 cuts in after the current sentence; a stale
   P2/P3 being spoken stops. Never cut a P0.
4. Replace the fixed 20 s gap with per-priority budgets; bursts within ~4 s merge into one state line, from templates, no LLM:
   "Two sessions finished, axa and feed. Feed needs you." Say current state, not history.
5. Log spoken vs dropped items (reason) to the console log so thresholds can be tuned.

## Part B: speak fast (commit "Voice: instant template lines, summary as follow-up")
1. Template lines for frequent events (finished with its one-line report trimmed to a sentence, needs approval: "feed wants to run
   npm install", failed, review verdict) spoken immediately; the Haiku summary only for long replies (> ~350 chars), and while it's
   being written the first sentence of the reply (or a template) is spoken at once; the summary follows if it arrives within its TTL,
   else dropped. Keep "a question for the user is always said".
2. Start the summary speculatively at Stop (before the hub asks) and cache by hash; measure and log time to first audio.
3. Pre-render a few earcons/phrases at speaker start (done chime, attention tone, failed tone) as short WAVs (generate tones
   in code, no downloaded audio); setting voice.earcons on|off (default on).
4. Liveness: when a session the user started a goal in has been working > 3 min with nothing spoken, one short P2 line at most every
   ~5 min ("feed is still working: running tests"), only at verbosity "chatty" or "normal".

## Part C: anticipate (commit "Voice: heads-ups before you're needed, time estimates")
1. Approval heads-up: when the approver / policy decides a step must go to the USER (escalated), speak P0 right away with what and
   why ("feed is about to need you: it wants to push to main") instead of waiting for the Notification.
2. Duration store (~/.axa/durations.json written by the daemon; key = project + command signature like "npm test", "next build",
   "turn"): median and p90 per key. On a matching PreToolUse with median > 20 s, P2 heads-up "feed is running the tests, usually
   about a minute"; "taking longer than usual" at 1.5x p90 (once). Per-session turn ETA from UserPromptSubmit->Stop history used
   in the "what's up" answer.
3. "What's up" on demand: a hub key (e.g. `w` on Control) and `axa whatsup` speak the current state of all sessions in 1-3
   sentences (templates; who's working on what, who needs you, ETA when known).
4. Settings: voice.verbosity quiet (P0 only) | normal (P0+P1+heads-ups, default) | chatty (all); quiet hours (voice.quiet "22:00-07:00",
   default off; P0 still as a desktop toast); suppress P2/P3 for a session while the user is typing in it.

## Tests
Pure narrator tests: coalesce, TTL drop, obsolete drop after answer, P0 preemption, burst merge text, budgets; template outputs; duration
store median/p90 and heads-up thresholds; escalation heads-up from an approver event; verbosity / quiet hours. Then play ONE real demo
through AXA's voice path on the Windows speakers (the user will hear it): a burst of 4 events collapsing into one line, then a P0
cutting in. Report in <= 8 lines: what changed per part, tests, measured time-to-first-audio before/after, what needs `axa restart`.
