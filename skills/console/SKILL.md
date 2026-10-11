---
name: console
description: Start (or reopen) the AXA console — a local web page that shows AXA in the center and every agent, skill and tool call around it, live. Use when the user asks to open the AXA console/dashboard/UI, "show me what the agents are doing", or wants to watch an orchestration run.
---

# AXA console

Start the console server in the background (it's a no-op if one is already running on the port), then open it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/console/server.mjs" --open
```

Run it with `run_in_background: true`. It serves http://localhost:4747 (override with `AXA_PORT`) and reads `~/.axa/events.jsonl` (override with `AXA_HOME`). Tell the user the URL in one line.
