// AXA verify gate (Stop hook): "done" means checked. When a project session tries to finish its turn
// after editing code but without running any check since its last edit (tests, build, typecheck,
// lint, a syntax check, a screenshot, a reviewer), it's sent back once to verify and report the result.
//   - acts only in AXA project sessions (AXA_ROLE=worker); never in the commander or your own sessions
//   - at most once per turn: Claude Code sets stop_hook_active on the retry, and the gate then lets it stop
//   - edits to docs only (.md, .txt...) don't need a check
//   - off with "verifyGate": "off" in ~/.axa/policy.json (default or per project), or AXA_VERIFY_GATE=0
// Reads the session's own transcript; logs a VerifyGate event when it sends a session back. Never throws.
// Hook contract: https://code.claude.com/docs/en/hooks#stop-and-subagentstop-decision-control
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

const MAX_INPUT = 1024 * 1024;
const TAIL = 4 * 1024 * 1024; // the current turn is near the end of the transcript
const home = process.env.AXA_HOME || join(homedir(), ".axa");

// A Bash command that checks the work
const CHECK = /\b(?:test|tests|spec|vitest|jest|mocha|ava|pytest|unittest|playwright|cypress|tsc|typecheck|type-check|lint|eslint|biome|ruff|mypy|pyright|clippy|build|check|verify|shot\.mjs|lighthouse|axe)\b|node\s+--check|\b(?:cargo|go)\s+(?:test|check|build|vet|clippy)\b|\bmake\b/i;
const DOC = /\.(?:md|mdx|markdown|txt|rst|adoc)$|(?:^|\/)(?:LICENSE|CHANGELOG|AUTHORS)[^/]*$/i;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

let raw = "";
process.stdin.on("data", (c) => { if (raw.length < MAX_INPUT) raw += c; });
process.stdin.on("end", () => {
  try {
    if (process.env.AXA_ROLE !== "worker" || process.env.AXA_VERIFY_GATE === "0") return process.exit(0);
    const e = JSON.parse(raw);
    if (e.stop_hook_active) return process.exit(0); // already sent back once this turn
    if (gateSetting(e.cwd) === "off") return process.exit(0);
    const edits = uncheckedEdits(e.transcript_path);
    if (!edits.length) return process.exit(0);
    const files = [...new Set(edits)].slice(0, 5).map((f) => basename(f)).join(", ");
    const reason = `AXA verify gate: you changed ${files} but ran no check after your last edit. Before reporting done, verify the change with this project's own checks (tests, build, typecheck or lint; for a script, at least a syntax check; for UI, a screenshot), fix what fails, and put the commands and their results in your report. If there is genuinely nothing to run, say so in one line of your report.`;
    log(e, files);
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
  } catch {}
  process.exit(0);
});

function gateSetting(cwd) {
  try {
    const file = JSON.parse(readFileSync(join(home, "policy.json"), "utf8"));
    const root = resolve(process.env.CLAUDE_PROJECT_DIR || cwd || ".");
    // a session in its own worktree (<repo>/.claude/worktrees/<name>) gets its repo's project settings
    const proj = root.replace(/\/\.claude\/worktrees\/[^/]+$/, "");
    const match = Object.entries(file.projects || {}).find(([k]) => (isAbsolute(k) || k.startsWith("~") ? resolve(k.replace(/^~(?=$|\/)/, homedir())) === proj : k === basename(proj)));
    return match?.[1]?.verifyGate ?? file.default?.verifyGate ?? "on";
  } catch { return "on"; }
}

// Code files edited this turn after the last check (empty: nothing to verify, or already verified)
function uncheckedEdits(path) {
  if (!path || !existsSync(path)) return [];
  const size = statSync(path).size, start = Math.max(0, size - TAIL);
  const fd = openSync(path, "r"), buf = Buffer.alloc(size - start);
  readSync(fd, buf, 0, buf.length, start); closeSync(fd);
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift();
  const msgs = [];
  for (const l of lines) { try { const o = JSON.parse(l); if ((o.type === "user" || o.type === "assistant") && !o.isSidechain) msgs.push(o); } catch {} }
  // the turn starts at the last real prompt (not a tool result)
  let from = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type !== "user" || m.isMeta) continue;
    const c = m.message?.content;
    if (typeof c === "string" || (Array.isArray(c) && c.some((b) => b.type === "text"))) { from = i; break; }
  }
  let edits = [];
  for (const m of msgs.slice(from)) {
    if (m.type !== "assistant" || !Array.isArray(m.message?.content)) continue;
    for (const b of m.message.content) {
      if (b.type !== "tool_use") continue;
      const input = b.input || {};
      if (EDIT_TOOLS.has(b.name)) { const f = String(input.file_path || input.notebook_path || ""); if (f && !DOC.test(f)) edits.push(f); }
      else if (b.name === "Bash" && CHECK.test(String(input.command || ""))) edits = [];
      else if (b.name === "Skill" && /verify|review|test/i.test(String(input.skill || ""))) edits = [];
      else if ((b.name === "Agent" || b.name === "Task") && /review|test|verif/i.test(String(input.subagent_type || ""))) edits = [];
    }
  }
  return edits;
}

function log(e, files) {
  try {
    const ev = { ts: Date.now(), event: "VerifyGate", session: e.session_id, cwd: e.cwd, decision: "block", summary: `changed ${files} without a check`, terminal: process.env.AXA_TERMINAL_ID || undefined, role: process.env.AXA_ROLE };
    const file = join(home, "events.jsonl");
    if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
    const fresh = !existsSync(file);
    appendFileSync(file, JSON.stringify(ev) + "\n", { mode: 0o600 });
    if (fresh) chmodSync(file, 0o600);
  } catch {}
}
