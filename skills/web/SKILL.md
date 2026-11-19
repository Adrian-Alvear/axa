---
name: web
description: Open the AXA web console: the same sessions as the `axa` hub, in a browser (and on a phone), with live terminals, the agent map and the activity feed. Use when the user asks to open the AXA console, dashboard or web UI, or to watch what the agents are doing.
---

# AXA web console

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/axa" web
```

This starts AXA's background daemon if needed (installing its dependencies the first time) and opens
the console in the browser. It prints an unlock link (`http://localhost:4747/?t=…`): the token in it
is what lets the page drive sessions, so don't paste it anywhere else. Tell the user in one line that
it's open, and that `axa` in a terminal shows the same sessions in the hub.
