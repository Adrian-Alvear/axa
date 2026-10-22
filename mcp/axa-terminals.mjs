// AXA session tools: a zero-dependency MCP server (stdio) that lets the AXA commander see and drive
// the Claude Code sessions running in the AXA console, one per project. It talks to the console's
// local API with the token in ~/.axa/console-token, and starts the console if it isn't running.
// Project sessions also load the AXA plugin (for tracing) but get no tools here (AXA_ROLE=worker),
// so only the commander can drive other sessions.
import { createInterface } from "node:readline";
import { ensureConsole, port, readToken } from "../console/ensure.mjs";
import { digestText, gitLine, untrusted, UNTRUSTED_NOTE, fmtTokens } from "./digest.mjs";

const isWorker = process.env.AXA_ROLE === "worker";
const GOAL_LIMIT = 4000; // Claude Code's /goal condition limit

async function api(path, { method = "GET", body } = {}) {
  if (!(await ensureConsole())) throw new Error("The AXA console isn't running and couldn't be started. Ask the user to run `axa console`.");
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { host: `localhost:${port}`, cookie: `axa_token=${readToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `console returned ${res.status}`);
  return data;
}


// One line per session for the commander: what it is, its status, what it's doing or last said
function describe(s) {
  const flag = s.status === "waiting" ? " — NEEDS THE USER'S APPROVAL" : s.status === "stuck" ? ` — STUCK (${s.stuck_reason || `${s.stuck_minutes ?? "?"}m`}), may need the user` : s.status === "failed" ? ` — FAILED (${s.failed_reason || "API error"}), tell the user` : "";
  const head = `[${s.id}] ${s.name} (${s.mode}) · ${s.status}${flag} · idle ${s.idle_seconds}s · ${s.cwd}`;
  const said = [];
  if (s.doing) said.push(`now: ${s.doing}`);
  if (s.git) said.push(`git: ${gitLine(s.git)}`);
  if (s.worktree) said.push(`worktree: its own folder ${s.worktree.path} on branch ${s.worktree.branch} (repo ${s.worktree.repo})`);
  if (s.usage) said.push(`usage: ${fmtTokens(s.usage.tokens)} tokens${s.usage.budget ? ` of a ${fmtTokens(s.usage.budget)} budget${s.usage.over_budget ? " — OVER BUDGET: give it no more work" : ""}` : ""}`);
  if (s.choices) said.push(`prompt on screen (only the user may answer it): ${s.choices.question.replace(/\s+/g, " ").slice(-300)} → ${s.choices.options.map((o) => `${o.n}. ${o.label}`).join(" | ")}`);
  if (s.error) said.push(`last error: ${s.error}`);
  if (s.last_report) said.push(`last report: ${s.last_report.replace(/\s+/g, " ").slice(0, 600)}`);
  return said.length ? `${head}\n${untrusted(said.join("\n"))}` : head;
}

// ---------- digest: every session in a few lines, from the event log (no screens read; mcp/digest.mjs) ----------
let lastDigest = 0; // "since the last digest": this server remembers when the commander last asked

const TOOLS = [
  {
    name: "digest_sessions",
    description:
      "The cheap way to check on every session at once: per session its state (working, done, waiting, stuck with the reason, failed with the API error), last report, uncommitted diff stat, cost and context %, PR/CI status, and what happened since your last digest (approvals, declines, escalations, policy refusals, failed tool calls, verify-gate bounces). Built from the event log, no screens read. Use it before read_session; read a screen only when the digest isn't enough.",
    inputSchema: { type: "object", properties: { since_minutes: { type: "number", description: "Look back this many minutes instead of since the last digest" } } },
    run: async ({ since_minutes } = {}) => {
      const now = Date.now(), since = since_minutes > 0 ? now - since_minutes * 60_000 : lastDigest;
      const d = await api(`/api/digest?since=${since}`);
      lastDigest = now;
      return digestText(d, now);
    },
  },
  {
    name: "list_sessions",
    description:
      "List every session open in the AXA console (usually one Claude Code session per project) with its status: starting, ready, working (and what it's doing), done (with its last report), waiting (needs the user's approval), or exited. Also lists the known projects you can open.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const [sessions, projects, chains] = await Promise.all([api("/api/terms"), api("/api/projects"), api("/api/chains").catch(() => [])]);
      const open = sessions.length ? sessions.map(describe).join("\n") : "No sessions open.";
      const active = chains.filter((c) => !c.fired && !c.failed);
      const links = active.length ? `\n\nLinks (fire when the first session finishes): ${active.map((c) => `[${c.id}] ${c.from_name} → ${c.to_name}`).join("; ")}` : "";
      return `${open}${links}\n\nProjects: ${projects.map((p) => `${p.name} (${p.path})`).join(", ") || "none found"}${sessions.length ? `\n\n${UNTRUSTED_NOTE}` : ""}`;
    },
  },
  {
    name: "read_session",
    description: "Read the current screen of one session as plain text (the last N lines), to see in detail what it's doing, what it finished, or what it asked.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Session id from list_sessions" }, lines: { type: "number", description: "Trailing lines to return (default 60, max 400)" } }, required: ["id"] },
    run: async ({ id, lines }) => {
      const s = await api(`/api/terms/${encodeURIComponent(id)}/screen?lines=${lines || 60}`);
      return `${describe(s)}\n---\n${untrusted(s.screen)}\n\n${UNTRUSTED_NOTE}`;
    },
  },
  {
    name: "send_to_session",
    description:
      "Type a message into a session and press Enter: a quick, complete, self-contained instruction for the Claude session there (it can't see this conversation), or a command in a shell session. Refuses if the session is waiting on a permission or trust prompt: never try to answer those; tell the user which session needs them. In shell sessions, dangerous commands (recursive deletes, force-push, reset --hard, touching .env or keys, piping downloads into a shell...) are refused unless confirmed_by_user is true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string", description: "What to type" },
        enter: { type: "boolean", description: "Press Enter after typing (default true)" },
        confirmed_by_user: { type: "boolean", description: "Only set true when the user explicitly approved this exact command in the conversation." },
      },
      required: ["id", "text"],
    },
    run: async ({ id, text, enter, confirmed_by_user }) => api(`/api/terms/${encodeURIComponent(id)}/input`, { method: "POST", body: { text, enter, confirmed_by_user: confirmed_by_user === true } }),
  },
  {
    name: "read_changes",
    description: "Read a session's uncommitted changes in its project (git diff against its last commit, plus new files), to verify what it claims it did before reporting it done. Secret files are left out.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Session id from list_sessions" } }, required: ["id"] },
    run: async ({ id }) => {
      const s = await api(`/api/terms/${encodeURIComponent(id)}/diff`);
      if (s.error) return `${describe(s)}\n---\n${s.error}`;
      const extra = s.untracked_total ? `\nNew files (${s.untracked_total}): ${s.untracked.join(", ")}` : "";
      return `${describe(s)}\n---\n${untrusted((s.diff || "(no changes to tracked files)") + extra + (s.truncated ? "\n(diff cut: too long)" : ""))}\n\n${UNTRUSTED_NOTE}`;
    },
  },
  {
    name: "link_sessions",
    description:
      "Chain two sessions: when session `from` next finishes its turn (verified, settled), AXA sends `instruction` to session `to` (once, when `to` is idle). Use it for handoffs the user asked for, e.g. \"when launches finishes, have feed rebase on it and re-run its tests\". The instruction must be complete and self-contained. Shows on the map in the console and the terminal UI.",
    inputSchema: { type: "object", properties: { from: { type: "string", description: "Session id that finishes first" }, to: { type: "string", description: "Session id that gets the next instruction" }, instruction: { type: "string" } }, required: ["from", "to", "instruction"] },
    run: async ({ from, to, instruction }) => { const c = await api("/api/chains", { method: "POST", body: { from, to, text: instruction } }); return `Linked [${c.id}]: when ${c.from_name} finishes, ${c.to_name} gets the instruction.`; },
  },
  {
    name: "unlink_sessions",
    description: "Remove a link made with link_sessions (its id is shown in list_sessions).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: async ({ id }) => api(`/api/chains/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => `removed link ${id}`),
  },
  {
    name: "start_goal",
    description:
      `Give a session a long-running goal with Claude Code's /goal: it keeps working on its own until the condition is met. Write the condition as what "done" looks like, self-contained, under ${GOAL_LIMIT} characters; for a long spec, have the session write it to a file first and make the goal point to that file.`,
    inputSchema: { type: "object", properties: { id: { type: "string" }, goal: { type: "string", description: "The goal condition: what done looks like" } }, required: ["id", "goal"] },
    run: async ({ id, goal }) => {
      const text = String(goal).replace(/\s*\n\s*/g, " ").trim();
      if (text.length > GOAL_LIMIT) throw new Error(`Goal is ${text.length} characters; /goal allows ${GOAL_LIMIT}. Put the details in a file in that project and point the goal at it.`);
      return api(`/api/terms/${encodeURIComponent(id)}/input`, { method: "POST", body: { text: `/goal ${text}` } });
    },
  },
  {
    name: "open_session",
    description:
      "Open a new session in the AXA console for a project: by project name (from list_sessions) or folder. mode 'claude' (default) starts a traced Claude Code session in auto mode; 'shell' starts a plain shell. worktree (true or a short name like 'fix-login') runs it in its own git worktree of that repo, on branch axa/<name>: use it when another session already works in the same project, or for risky or experimental work, so changes can't collide; its work stays on that branch until someone merges it. Returns the session id. The first time Claude opens in a folder it shows a trust prompt only the user can answer.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name, e.g. launches" },
        cwd: { type: "string", description: "Or a folder, e.g. ~/launches" },
        mode: { type: "string", enum: ["claude", "shell"] },
        worktree: { type: ["boolean", "string"], description: "true or a short name: run in its own git worktree on branch axa/<name>" },
      },
    },
    run: async ({ project, cwd, mode, worktree }) => api("/api/terms", { method: "POST", body: { project, cwd, mode: mode || "claude", worktree: worktree || undefined } }),
  },
  {
    name: "close_session",
    description: "Close a session (stops whatever is running in it). Only when the user asked, or the session is finished and no longer needed. remove_worktree: for a session in its own worktree, also remove that folder; git refuses if it has uncommitted changes, and the branch is always kept.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, remove_worktree: { type: "boolean" } }, required: ["id"] },
    run: async ({ id, remove_worktree }) => {
      const r = await api(`/api/terms/${encodeURIComponent(id)}${remove_worktree ? "?remove_worktree=1" : ""}`, { method: "DELETE" });
      if (!remove_worktree || r.worktree_removed === undefined) return `closed ${id}`;
      return r.worktree_removed ? `closed ${id}; removed its worktree (branch ${r.branch_kept} kept)` : `closed ${id}; kept its worktree: ${r.worktree_error}`;
    },
  },
];

// ---------- minimal MCP over stdio (JSON-RPC 2.0, newline-delimited) ----------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (e.g. notifications/initialized)
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "axa-sessions", version: "0.4.0" },
      instructions: isWorker
        ? "This is a project session started by AXA; session tools are only available to the AXA commander."
        : "Tools to see and drive the sessions open in the AXA console, usually one Claude Code session per project. Never answer another session's permission prompt.",
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: isWorker ? [] : TOOLS.map(({ run, ...t }) => t) });
  if (method === "tools/call") {
    const tool = !isWorker && TOOLS.find((t) => t.name === params?.name);
    if (!tool) return fail(id, -32602, `unknown tool ${params?.name}`);
    try {
      const out = await tool.run(params.arguments || {});
      return reply(id, { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: e.message }], isError: true });
    }
  }
  fail(id, -32601, `method not found: ${method}`);
});
