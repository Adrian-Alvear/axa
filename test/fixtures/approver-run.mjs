// Test-only runner for hooks/approver.mjs: the real hook logic with the model call replaced by a
// stub, so tests never reach an LLM. Not a hook and not wired into hooks.json.
//   AXA_TEST_JUDGE      JSON reply ({"decision":"allow","reason":"..."}), "fail" (no answer), "throw"
//                       (e.g. the usage limit) or "hang" (never answers: the approver's timeout fires)
//   AXA_TEST_JUDGE_LOG  file that gets one JSON line per model call: { prompt, model }
//   AXA_TEST_JUDGE_MS   the approver's timeout for the model call (default: the real one)
import { appendFileSync } from "node:fs";
import { run } from "../../hooks/approver.mjs";

const ask = async (prompt, settings) => {
  if (process.env.AXA_TEST_JUDGE_LOG) appendFileSync(process.env.AXA_TEST_JUDGE_LOG, JSON.stringify({ prompt, model: settings.approver?.model }) + "\n");
  const reply = process.env.AXA_TEST_JUDGE || "fail";
  if (reply === "fail") return null;
  if (reply === "throw") throw new Error("usage limit");
  if (reply === "hang") return new Promise(() => {});
  return JSON.parse(reply);
};

// `node --test` picks up every file under test/ as a test file: then there's nothing to do
if (process.env.NODE_TEST_CONTEXT) process.exit(0);
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", async () => {
  const judgeMs = Number(process.env.AXA_TEST_JUDGE_MS) || undefined;
  try { const o = await run(raw, { ask, judgeMs }); if (o) process.stdout.write(JSON.stringify(o)); } catch {}
  process.exit(0);
});
