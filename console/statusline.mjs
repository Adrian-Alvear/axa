// `axa statusline`: a Claude Code statusLine command. Claude Code pipes the session's JSON on stdin
// (session_id, cost.total_cost_usd, context_window.used_percentage, model.display_name, ...; any field
// may be missing) and shows what this prints, one line:
//   AXA ⚠ 1 needs you · 3 working · $1.24 · ctx 42%
// It also records the session's cost and context % into $AXA_HOME/cost.json for the console. The
// console is asked with a short timeout; when it isn't up, the line shows just cost and context.
// Installing it in your Claude settings is a manual step (README). Never fails the status line.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { recordCost } from "./cost.mjs";
import { STATUS, needsYou } from "./look.mjs";

const TERMS_MS = 300; // Claude Code debounces the status line at 300ms and cancels a slow one
const MAX_INPUT = 256 * 1024;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const fmtUsd = (v) => (v == null ? "" : v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);

// Pure: the one line, from Claude Code's statusLine JSON and the console's session list (null when
// the console isn't reachable)
export function statusLine(input = {}, list = null, { color = false } = {}) {
  const usd = num(input.cost?.total_cost_usd), ctx = num(input.context_window?.used_percentage);
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const parts = [];
  if (list) {
    const needs = list.filter(needsYou).length, working = list.filter((s) => s.status === "working").length;
    if (needs) parts.push(paint("1;33", `${STATUS.waiting.glyph} ${needs} ${STATUS.waiting.word}`));
    if (working) parts.push(`${working} ${STATUS.working.word}`);
    if (!needs && !working) parts.push("all quiet");
  }
  if (usd != null) parts.push(fmtUsd(usd));
  if (ctx != null) parts.push(`ctx ${Math.round(ctx)}%`);
  const line = parts.join(" · ");
  return list ? `AXA ${line}` : line;
}

async function consoleList(home, port) {
  let token = "";
  try { token = readFileSync(join(home, "console-token"), "utf8").trim(); } catch { return null; }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/terms`, { headers: { host: `localhost:${port}`, cookie: `axa_token=${token}` }, signal: AbortSignal.timeout(TERMS_MS) });
    if (!res.ok) return null;
    const list = await res.json();
    return Array.isArray(list) ? list : null;
  } catch { return null; }
}

const readStdin = () => new Promise((ok) => {
  if (process.stdin.isTTY) return ok("");
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { if (raw.length < MAX_INPUT) raw += c; });
  process.stdin.on("end", () => ok(raw));
  process.stdin.on("error", () => ok(raw));
});

export async function main({ env = process.env, out = process.stdout } = {}) {
  const home = env.AXA_HOME || join(homedir(), ".axa"), port = Number(env.AXA_PORT || 4747);
  let input = {};
  try { input = JSON.parse(await readStdin()) || {}; } catch {}
  if (input.session_id) {
    try {
      recordCost(home, { session: input.session_id, usd: num(input.cost?.total_cost_usd), context_pct: num(input.context_window?.used_percentage), model: input.model?.display_name || input.model?.id, terminal: env.AXA_TERMINAL_ID, cwd: input.workspace?.current_dir || input.cwd });
    } catch {}
  }
  const list = await consoleList(home, port);
  const color = !env.NO_COLOR && env.TERM !== "dumb";
  out.write(statusLine(input, list, { color }) + "\n");
}
