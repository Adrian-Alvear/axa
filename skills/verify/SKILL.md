---
name: verify
description: Verifies a code change before it's reported done. Runs the project's own checks (typecheck, lint, tests, build, syntax checks of changed scripts) through one script that prints a PASS/FAIL table, and takes desktop and phone screenshots for UI changes. Use after editing code and before saying a task is finished, when asked to "verify", "check it works" or "prove it", or when AXA's verify gate sends a session back.
---

# Verify

"Done" means checked. Run this after your last edit, fix what fails, and run it again.

1. **Run the checks.** The script finds them from the project's files (package.json scripts with the
   right package manager, Cargo, Go, pytest, `make test`) and syntax-checks changed JavaScript:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/verify/verify.mjs" .
   ```

   `--list` shows what it would run. It exits 1 if anything fails and prints the last 30 lines of each
   failure. Fix the cause and re-run it; don't skip or weaken a failing check.

2. **UI changes: look at them.** Start the app (or use the page you changed) and take screenshots:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/shot.mjs" http://localhost:3000 /tmp/shots   # desktop.png + phone.png
   ```

   Read both PNGs. Check hierarchy, contrast, tap targets of at least 44px, no horizontal scroll at
   390px, and no overlapping or cut-off text. Add `--eval='js'` to open a dialog or menu first. Fix
   what's wrong and take the shots again.

3. **Report with evidence.** Paste the script's table (and name the screenshots you reviewed) in your
   report. If the project has no checks at all, say so in one line and describe how you verified by
   hand.
