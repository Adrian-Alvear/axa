---
name: console
description: Start (or reopen) the AXA console — a local web page that shows AXA in the center and every agent, skill and tool call around it, live. Use when the user asks to open the AXA console/dashboard/UI, "show me what the agents are doing", or wants to watch an orchestration run.
---

# AXA console

Start the console server in the background (if one is already running on the port, this just reopens it). The first run installs the console's dependencies (terminal support), which takes a few seconds:

```bash
cd "${CLAUDE_PLUGIN_ROOT}/console" && { [ -d node_modules ] || npm install --no-fund --no-audit; } && node server.mjs --open
```

Run it with `run_in_background: true`. The server prints an unlock link (`http://localhost:4747/?t=…`) and opens it — the token is what lets the page open terminals, so don't paste it anywhere else. It serves http://localhost:4747 (override with `AXA_PORT`) and reads `~/.axa/events.jsonl` (override with `AXA_HOME`). Tell the user in one line that the console is open; the **Terminals** button launches Claude Code or a shell in any project from inside the dashboard.
