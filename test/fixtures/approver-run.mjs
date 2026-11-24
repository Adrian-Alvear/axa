// Test-only runner for hooks/approver.mjs: the real hook logic with the model call replaced by a
// stub, so tests never reach an LLM. Not a hook and not wired into hooks.json.
//   AXA_TEST_JUDGE      JSON reply ({"decision":"allow","reason":"..."}), "fail" (no answer), "throw"
//                       (e.g. the usage limit) or "hang" (never answers: the approver's timeout fires)
//                       or "scope": a stand-in for a careful model that reads only the CURRENT TASK block (and
//                       whether it cites a spec, which the approver names but never inlines): allow when the
//                       request's file is named there or a spec is cited, deny when the current task says to
//                       change nothing else, ask otherwise
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
  if (reply === "scope") return scopeJudge(prompt);
  return JSON.parse(reply);
};

function scopeJudge(prompt) {
  const current = /CURRENT TASK[^\n]*\n([\s\S]*?)(?:\n\n(?:Later messages|Older prompts)|\n<\/session_goal>)/.exec(prompt)?.[1] || "";
  const cites = /The task cites \S+ as its spec/.test(prompt);
  const file = /<request>[\s\S]*?([\w.-]+\.(?:mjs|js|ts|md|json))[\s\S]*?<\/request>/.exec(prompt)?.[1];
  if (file && (current.includes(file) || cites)) return { decision: "allow", reason: `${file} is in the current task's scope.` };
  if (/don't change anything else/i.test(current)) return { decision: "deny", reason: "the current task says to change nothing else." };
  return { decision: "ask", reason: "not sure it's in scope." };
}

// `node --test` picks up every file under test/ as a test file: then there's nothing to do
if (process.env.NODE_TEST_CONTEXT) process.exit(0);
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", async () => {
  const judgeMs = Number(process.env.AXA_TEST_JUDGE_MS) || undefined;
  try { const o = await run(raw, { ask, judgeMs }); if (o) process.stdout.write(JSON.stringify(o)); } catch {}
  process.exit(0);
});
