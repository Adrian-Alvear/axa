// Reads one Claude Code hook payload from stdin and appends a compact event to
// $AXA_HOME/events.jsonl (default ~/.axa). Never blocks or fails the session.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const home = process.env.AXA_HOME || join(homedir(), ".axa");
const clip = (s, n = 300) => (s == null ? undefined : String(s).length > n ? String(s).slice(0, n) + "…" : String(s));

// One-line human summary of what a tool call is doing.
function summarize(tool, input = {}) {
  switch (tool) {
    case "Bash": return clip(input.description || input.command, 160);
    case "Read": case "Write": case "Edit": case "NotebookEdit": return input.file_path && basename(input.file_path);
    case "Grep": case "Glob": return clip(input.pattern, 120);
    case "WebFetch": return clip(input.url, 160);
    case "WebSearch": return clip(input.query, 160);
    case "Skill": return input.skill;
    case "Agent": case "Task": return clip(input.description || input.prompt, 160);
    default: return clip(JSON.stringify(input), 160);
  }
}

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const e = JSON.parse(raw);
    const input = e.tool_input || {};
    const ev = {
      ts: Date.now(),
      event: e.hook_event_name,
      session: e.session_id,
      cwd: e.cwd,
      agent_id: e.agent_id,
      agent_type: e.agent_type,
      tool: e.tool_name,
      tool_use_id: e.tool_use_id,
      summary: e.tool_name ? summarize(e.tool_name, input) : undefined,
      skill: e.tool_name === "Skill" ? input.skill : undefined,
      subagent_type: ["Agent", "Task"].includes(e.tool_name) ? input.subagent_type || "general-purpose" : undefined,
      prompt: clip(e.prompt || (["Agent", "Task"].includes(e.tool_name) ? input.prompt : undefined), 2000),
      message: clip(e.last_assistant_message ?? (e.hook_event_name === "Notification" ? e.message : undefined), 2000),
      error: clip(e.error, 500),
      duration_ms: e.duration_ms,
      source: e.source,
      notification_type: e.notification_type,
      // Set by AXA when it starts a session: which console terminal it is, and commander or worker
      terminal: process.env.AXA_TERMINAL_ID || undefined,
      role: process.env.AXA_ROLE || undefined,
    };
    mkdirSync(home, { recursive: true });
    appendFileSync(join(home, "events.jsonl"), JSON.stringify(ev) + "\n");
  } catch {}
  process.exit(0);
});
