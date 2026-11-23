#!/usr/bin/env node
// A stand-in for `claude -p` in the reviewer's tests (AXA_REVIEWER_CMD="node test/fixtures/fake-reviewer.mjs").
// Reads the prompt on stdin and prints a canned verdict the way `claude -p --output-format json` does.
//   FAKE_REVIEW: the verdict text to return (default: an approve)
//   FAKE_REVIEW_LOG: a file to append { args, role, cwd, prompt } to, one JSON line per call
//   FAKE_REVIEW_MODE: "crash" (exit 1, no output), "hang" (never answers), "raw" (print FAKE_REVIEW as is),
//     "stream" (stream-json: a step running `npm test`, then the result line), "stream-hang" (that step, then hangs),
//     "stream-big" (like stream, with over 8 MB of stream lines before the result line)
//   FAKE_REVIEW_PIDS: in the hang modes, a file that gets {"pid","child"}: its own pid and a child process it
//     starts (like a check that hangs), so a test can see both are gone after the timeout;
//     FAKE_REVIEW_CHILD_DETACHED=1 starts that child in a process group of its own
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

// `node --test` picks up every file under test/ as a test file: then there's nothing to do (run as the
// reviewer it always gets arguments, and the tests that start it pass NODE_TEST_CONTEXT down)
if (process.env.NODE_TEST_CONTEXT && process.argv.length <= 2) process.exit(0);
const hang = () => {
  if (process.env.FAKE_REVIEW_PIDS) {
    const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: process.env.FAKE_REVIEW_CHILD_DETACHED === "1" });
    writeFileSync(process.env.FAKE_REVIEW_PIDS, JSON.stringify({ pid: process.pid, child: c.pid }));
  }
  setInterval(() => {}, 1000);
};

let prompt = "";
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  const mode = process.env.FAKE_REVIEW_MODE || "";
  if (process.env.FAKE_REVIEW_LOG) appendFileSync(process.env.FAKE_REVIEW_LOG, JSON.stringify({ args: process.argv.slice(2), role: process.env.AXA_ROLE, terminal: process.env.AXA_TERMINAL_ID || null, cwd: process.cwd(), prompt }) + "\n");
  if (mode === "crash") { process.stderr.write("fake reviewer: boom\n"); process.exit(1); }
  if (mode === "hang") return hang();
  const step = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } });
  if (mode === "stream-hang") { process.stdout.write(step + "\n"); return hang(); }
  if (mode === "stream-big") {
    const pad = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(4000) }] } }) + "\n";
    process.stdout.write(step + "\n" + pad.repeat(Math.ceil((9 << 20) / pad.length)));
  }
  if (mode === "stream") process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\n" + step + "\n");
  const text = process.env.FAKE_REVIEW || JSON.stringify({ verdict: "approve", summary: "does what was asked; tests pass", checks: [{ cmd: "node --test", ok: true, tail: "# pass 3" }], findings: [] });
  if (mode === "raw") process.stdout.write(text);
  else process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0 }) + (mode === "stream" || mode === "stream-big" ? "\n" : ""));
});
