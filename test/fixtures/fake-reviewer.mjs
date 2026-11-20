#!/usr/bin/env node
// A stand-in for `claude -p` in the reviewer's tests (AXA_REVIEWER_CMD="node test/fixtures/fake-reviewer.mjs").
// Reads the prompt on stdin and prints a canned verdict the way `claude -p --output-format json` does.
//   FAKE_REVIEW: the verdict text to return (default: an approve)
//   FAKE_REVIEW_LOG: a file to append { args, role, cwd, prompt } to, one JSON line per call
//   FAKE_REVIEW_MODE: "crash" (exit 1, no output), "hang" (never answers), "raw" (print FAKE_REVIEW as is),
//     "stream" (stream-json: a step running `npm test`, then the result line), "stream-hang" (that step, then hangs)
import { appendFileSync } from "node:fs";

let prompt = "";
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  const mode = process.env.FAKE_REVIEW_MODE || "";
  if (process.env.FAKE_REVIEW_LOG) appendFileSync(process.env.FAKE_REVIEW_LOG, JSON.stringify({ args: process.argv.slice(2), role: process.env.AXA_ROLE, terminal: process.env.AXA_TERMINAL_ID || null, cwd: process.cwd(), prompt }) + "\n");
  if (mode === "crash") { process.stderr.write("fake reviewer: boom\n"); process.exit(1); }
  if (mode === "hang") { setInterval(() => {}, 1000); return; }
  const step = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } });
  if (mode === "stream-hang") { process.stdout.write(step + "\n"); setInterval(() => {}, 1000); return; }
  if (mode === "stream") process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\n" + step + "\n");
  const text = process.env.FAKE_REVIEW || JSON.stringify({ verdict: "approve", summary: "does what was asked; tests pass", checks: [{ cmd: "node --test", ok: true, tail: "# pass 3" }], findings: [] });
  if (mode === "raw") process.stdout.write(text);
  else process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0 }) + (mode === "stream" ? "\n" : ""));
});
