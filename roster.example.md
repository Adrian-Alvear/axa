# AXA roster

Your personal config for AXA. Copy this file to `~/.axa/roster.md` and edit it —
AXA reads that copy first, so your changes survive plugin updates.

Add a row to add a role. Change `model` to trade speed/cost for quality
(haiku < sonnet < opus). `subagent_type` is what AXA passes to the Agent tool:
built-ins (`Explore`, `Plan`, `general-purpose`), this plugin's agents
(`axa:builder`, `axa:reviewer`, `axa:researcher`), or your own from `~/.claude/agents/`.

## Roles

| Role | subagent_type | model | Use for | Default skills |
|------|---------------|-------|---------|----------------|
| scout | Explore | haiku | Finding files, mapping a codebase, "where is X" | — |
| planner | Plan | opus | Designing an approach before a big change | — |
| researcher | axa:researcher | sonnet | Web/docs research, comparing libraries, API lookups; checking for an existing library/tool before a new feature is built | — |
| builder | axa:builder | opus | Writing/changing code, one feature per builder | — |
| reviewer | axa:reviewer | sonnet | Reading a finished diff, running build + typecheck, finding bugs | — |
| generalist | general-purpose | sonnet | Anything that fits no other role | — |

## House rules (passed into every agent prompt)

- Don't push, deploy, or write to production data unless I say so in this conversation.
- Fix build and type errors before calling anything done.
- Reports back to the lead are short: what changed, what was verified, what's open.

## Projects (context to paste into prompts)

- **my-app** — `~/projects/my-app`. Stack, key folders, how to build/verify.
