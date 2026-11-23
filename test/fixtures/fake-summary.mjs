#!/usr/bin/env node
// A stand-in for `claude -p --model claude-haiku-5-5` in the spoken-summary tests (AXA_SUMMARY_CMD).
// Reads the prompt on stdin and prints a canned summary the way `--output-format text` does.
//   FAKE_SUMMARY: the summary to print; FAKE_SUMMARY_MODE: "hang" (never answers), "fail" (exit 1)
//   FAKE_SUMMARY_LOG: a file that gets one JSON line per call: { args, role, terminal, cwd, prompt }
import { appendFileSync } from "node:fs";

// `node --test` picks up every file under test/ as a test file: then there's nothing to do (run as the
// summariser it always gets arguments)
if (process.env.NODE_TEST_CONTEXT && process.argv.length <= 2) process.exit(0);
let prompt = "";
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  if (process.env.FAKE_SUMMARY_LOG) appendFileSync(process.env.FAKE_SUMMARY_LOG, JSON.stringify({ args: process.argv.slice(2), role: process.env.AXA_ROLE, terminal: process.env.AXA_TERMINAL_ID || null, cwd: process.cwd(), prompt }) + "\n");
  const mode = process.env.FAKE_SUMMARY_MODE || "";
  if (mode === "hang") return setInterval(() => {}, 1000);
  if (mode === "fail") process.exit(1);
  process.stdout.write((process.env.FAKE_SUMMARY || "All three parts are done and every test passes.") + "\n");
});
