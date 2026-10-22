// Cost records (console/cost.mjs) and `axa statusline` (console/statusline.mjs): pure parts, the file
// it writes, and the command against a mock console on a private port (never 4747 or ~/.axa).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addReading, recordCost, createCostReader, dayOf } from "../console/cost.mjs";
import { statusLine, fmtUsd } from "../console/statusline.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4876;
const DAY = 24 * 3600_000;
const tmp = () => mkdtempSync(join(tmpdir(), "axa-cost-"));

test("addReading: per-day spend is what each session added that day", () => {
  const t0 = new Date(2026, 9, 20, 10).getTime(), c = { sessions: {}, days: {} };
  addReading(c, { session: "s1", usd: 1, context_pct: 10, model: "Opus" }, t0);
  addReading(c, { session: "s1", usd: 1.5, context_pct: 20 }, t0 + 3600_000);
  addReading(c, { session: "s2", usd: 0.25 }, t0);
  assert.deepEqual(c.days[dayOf(t0)], { s1: 1.5, s2: 0.25 });
  addReading(c, { session: "s1", usd: 2 }, t0 + DAY); // next day: only the new 0.5
  assert.equal(c.days[dayOf(t0 + DAY)].s1, 0.5);
  assert.equal(c.sessions.s1.model, "Opus"); // kept when a reading leaves it out
  assert.equal(c.sessions.s1.context_pct, 20);
  addReading(c, { session: "../bad id", usd: 9 }, t0);
  assert.equal(c.sessions["../bad id"], undefined);
});

test("recordCost writes atomically, 0600; the reader finds sessions by chat id or terminal and totals per day", () => {
  const home = tmp();
  const now = Date.now();
  recordCost(home, { session: "chat-1", usd: 1.24, context_pct: 42, model: "Opus", terminal: "t9" }, now);
  recordCost(home, { session: "chat-2", usd: 0.5 }, now);
  assert.equal(statSync(join(home, "cost.json")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(home), ["cost.json"]); // no temp file left behind
  const r = createCostReader(home);
  assert.deepEqual(r.costOf("chat-1"), { usd: 1.24, context_pct: 42, model: "Opus", at: now });
  assert.equal(r.costOf(undefined, "t9").usd, 1.24);
  assert.equal(r.costOf("nope", "nope"), null);
  const t = r.totals();
  assert.equal(t.today_usd, 1.74);
  assert.deepEqual(t.days, [{ date: dayOf(now), usd: 1.74, sessions: 2 }]);
  rmSync(home, { recursive: true, force: true });
});

test("statusLine: AXA's state with cost and context; just cost/context without the console", () => {
  const input = { cost: { total_cost_usd: 1.237 }, context_window: { used_percentage: 41.6 } };
  const list = [{ status: "waiting" }, { status: "working" }, { status: "working" }, { status: "working" }, { status: "done" }];
  assert.equal(statusLine(input, list), "AXA ⚠ 1 needs you · 3 working · $1.24 · ctx 42%");
  assert.equal(statusLine(input, [{ status: "failed" }, { status: "stuck" }]), "AXA ⚠ 2 needs you · $1.24 · ctx 42%");
  assert.equal(statusLine(input, []), "AXA all quiet · $1.24 · ctx 42%");
  assert.equal(statusLine(input, null), "$1.24 · ctx 42%");
  assert.equal(statusLine({}, null), "");
  assert.equal(fmtUsd(123.4), "$123");
});

// Runs `axa statusline` with the given stdin; resolves its stdout
function runStatusline(home, stdin) {
  return new Promise((ok) => {
    const env = { ...process.env, AXA_HOME: home, AXA_PORT: String(PORT), NO_COLOR: "1", AXA_TERMINAL_ID: "term1" };
    const p = spawn(process.execPath, [join(root, "bin", "axa"), "statusline"], { env, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => ok(out));
    p.stdin.end(stdin);
  });
}

test("axa statusline: records cost and asks the console (mock) for the line; falls back when it's down", async () => {
  const home = tmp();
  const input = JSON.stringify({ session_id: "chat-7", cost: { total_cost_usd: 0.5 }, context_window: { used_percentage: 12 }, model: { display_name: "Sonnet" } });
  // console down: no token, nothing listening
  assert.equal(await runStatusline(home, input), "$0.50 · ctx 12%\n");
  assert.equal(JSON.parse(readFileSync(join(home, "cost.json"), "utf8")).sessions["chat-7"].terminal, "term1");
  // a mock console that checks the cookie
  writeFileSync(join(home, "console-token"), "tok", { mode: 0o600 });
  const srv = createServer((req, res) => {
    if (req.url !== "/api/terms" || req.headers.cookie !== "axa_token=tok") return res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ status: "waiting" }, { status: "working" }]));
  });
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  try { assert.equal(await runStatusline(home, input), "AXA ⚠ 1 needs you · 1 working · $0.50 · ctx 12%\n"); }
  finally { srv.close(); rmSync(home, { recursive: true, force: true }); }
});

test("axa statusline: a slow console doesn't hold the line (300ms timeout)", async () => {
  const home = tmp();
  writeFileSync(join(home, "console-token"), "tok", { mode: 0o600 });
  const srv = createServer(() => {}); // never answers
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  const t0 = Date.now();
  try {
    assert.equal(await runStatusline(home, "not json"), "\n");
    assert.ok(Date.now() - t0 < 3000);
  } finally { srv.closeAllConnections(); srv.close(); rmSync(home, { recursive: true, force: true }); }
});
