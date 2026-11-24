// UserPromptSubmit: asks AXA's worker sessions to end a finished turn with one spoken line ("🔊 <= 12 words, the
// outcome"), which the daemon says the moment the turn stops (src/core/attention.mjs). Only sessions AXA started as
// workers (AXA_ROLE=worker); the user's own Claude sessions only when they opt in with AXA_SPOKEN_LINE=1.
// Never blocks the prompt: any problem prints nothing.
import { SPOKEN_INSTRUCTION, wantsSpokenLine } from "../src/core/attention.mjs";

process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  try {
    if (wantsSpokenLine(process.env)) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: SPOKEN_INSTRUCTION } }));
  } catch {}
  process.exit(0);
});
