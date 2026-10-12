// AXA terminal tools: a zero-dependency MCP server (stdio) that lets any Claude Code session see
// and drive the terminals open in the AXA console. It talks to the console's local API using the
// token in ~/.axa/console-token, so the console must be running (/axa:console).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const home = process.env.AXA_HOME || join(homedir(), ".axa");
const port = Number(process.env.AXA_PORT || 4747);

async function api(path, { method = "GET", body } = {}) {
  let token;
  try { token = readFileSync(join(home, "console-token"), "utf8").trim(); }
  catch { throw new Error("AXA console has never been started. Ask the user to run /axa:console."); }
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { host: `localhost:${port}`, cookie: `axa_token=${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error("AXA console is not running. Ask the user to run /axa:console."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `console returned ${res.status}`);
  return data;
}

const TOOLS = [
  {
    name: "list_terminals",
    description: "List every terminal open in the AXA console: id, project name, folder, mode (claude/shell/axa), whether it is alive, seconds since it last printed anything (a rough 'is it still working' signal), and whether it is waiting on a permission prompt the user must answer.",
    inputSchema: { type: "object", properties: {} },
    run: async () => api("/api/terms"),
  },
  {
    name: "read_terminal",
    description: "Read the current screen of one terminal as plain text (the last N lines). Use it to see what a Claude session in another project is doing, whether it finished, or what it asked.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Terminal id from list_terminals" }, lines: { type: "number", description: "How many trailing lines to return (default 60, max 400)" } }, required: ["id"] },
    run: async ({ id, lines }) => api(`/api/terms/${encodeURIComponent(id)}/screen?lines=${lines || 60}`),
  },
  {
    name: "send_to_terminal",
    description: "Type a message into a terminal and press Enter — e.g. give the Claude session in another project an instruction, or run a command in a shell. Write instructions to Claude sessions as complete, self-contained requests. Refuses if that terminal is showing a permission or trust prompt: never try to answer those; tell the user which terminal needs them.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string", description: "What to type" }, enter: { type: "boolean", description: "Press Enter after typing (default true)" } }, required: ["id", "text"] },
    run: async ({ id, text, enter }) => api(`/api/terms/${encodeURIComponent(id)}/input`, { method: "POST", body: { text, enter } }),
  },
  {
    name: "open_terminal",
    description: "Open a new terminal in the AXA console in a project folder. mode 'claude' starts Claude Code there (the usual choice), 'shell' starts a plain shell. Returns the new terminal's id. Note: the first time Claude opens in a folder it shows a trust prompt that only the user can answer.",
    inputSchema: { type: "object", properties: { cwd: { type: "string", description: "Project folder, e.g. ~/projects/n2s-platform" }, mode: { type: "string", enum: ["claude", "shell"] } }, required: ["cwd"] },
    run: async ({ cwd, mode }) => api("/api/terms", { method: "POST", body: { cwd, mode: mode || "claude" } }),
  },
];

// ---------- minimal MCP over stdio (JSON-RPC 2.0, newline-delimited) ----------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (e.g. notifications/initialized)
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "axa-terminals", version: "0.3.0" },
      instructions: "Tools to see and drive the terminals open in the AXA console. Each terminal is usually a separate Claude Code session in a different project. Never answer another terminal's permission prompt.",
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS.map(({ run, ...t }) => t) });
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return fail(id, -32602, `unknown tool ${params?.name}`);
    try {
      const out = await tool.run(params.arguments || {});
      const text = typeof out?.screen === "string"
        ? `[${out.name} · ${out.mode} · ${out.alive ? "alive" : "exited"}${out.awaiting_permission ? " · WAITING ON USER PERMISSION" : ""} · idle ${out.idle_seconds}s]\n${out.screen}`
        : JSON.stringify(out, null, 2);
      return reply(id, { content: [{ type: "text", text }] });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: e.message }], isError: true });
    }
  }
  fail(id, -32601, `method not found: ${method}`);
});
