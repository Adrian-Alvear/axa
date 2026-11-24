// Part 1 of docs/tasks/landscape-build.md: cost and limits. Tokens are official (Claude Code's transcripts), cost an
// estimate; the account's 5-hour / weekly limits from the status line data; runaway spending. Temp HOME only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-usage-")));
process.env.HOME = join(base, "home");
process.env.AXA_HOME = join(base, "axahome");
mkdirSync(process.env.AXA_HOME, { recursive: true });
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = (f) => readFileSync(join(ROOT, f), "utf8");
const U = await import("../src/core/usage.mjs");
const C = await import("../src/core/claude-data.mjs");

test("estimated cost from list prices, by model family (cache writes and reads priced apart)", () => {
  assert.equal(U.costOf({ input: 1e6, written: 0, cached: 0, output: 1e6 }, "claude-opus-5-5"), 30);
  assert.equal(U.costOf({ input: 2e6, written: 1e6, cached: 10e6, output: 0 }, "claude-sonnet-5-5"), 3 + 3.75 + 3);
  assert.equal(U.costOf({ input: 1e6, output: 1e6 }, "claude-haiku-5-5"), 6);
  assert.equal(U.costOf(null), null);
  assert.equal(U.usd(3.456), "$3.46"); assert.equal(U.usd(123.4), "$123");
});

test("a session's usage from its transcript: tokens (official), cost (estimate), per day", () => {
  const chat = "11111111-2222-3333-4444-555555555555", dir = join(process.env.HOME, ".claude", "projects", "-x-feed");
  mkdirSync(dir, { recursive: true });
  const line = (id, ts, u) => JSON.stringify({ type: "assistant", timestamp: ts, requestId: `r${id}`, message: { id: `m${id}`, model: "claude-opus-5-5", usage: u } });
  writeFileSync(join(dir, `${chat}.jsonl`), [
    line(1, "2026-11-23T10:00:00", { input_tokens: 1000, cache_creation_input_tokens: 4000, cache_read_input_tokens: 0, output_tokens: 500 }),
    line(1, "2026-11-23T10:00:01", { input_tokens: 1000, cache_creation_input_tokens: 4000, cache_read_input_tokens: 0, output_tokens: 800 }), // streamed: counted once
    line(2, "2026-11-24T09:00:00", { input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 300 }),
  ].join("\n") + "\n");
  const u = C.usageOf(chat, "/x/feed", true);
  assert.equal(u.tokens, 5000 + 800 + 200 + 300);
  assert.equal(u.written, 4000); assert.equal(u.cached, 5000);
  assert.equal(u.cost_label, "estimate");
  assert.equal(u.cost, U.costOf(u, "claude-opus-5-5"));
  assert.deepEqual(Object.keys(u.days), ["2026-11-23", "2026-11-24"]);
  assert.equal(u.days["2026-11-23"].output, 800);
  const pd = U.byProjectDay([{ name: "feed", cwd: "/x/feed", usage: u }, { name: "feed-2", cwd: "/x/feed", usage: u }]);
  assert.equal(pd.feed["2026-11-24"].tokens, 2 * 500);
  assert.equal(pd.feed["2026-11-24"].cost, 2 * U.costOf(u.days["2026-11-24"], "claude-opus-5-5"));
});

test("the account's limits from Claude Code's status line data (official); stale or missing: unknown", () => {
  const f = join(base, "statusline.json");
  writeFileSync(f, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 29, resets_at: 1795564800 }, seven_day: { used_percentage: 39, resets_at: 1795838400 } } }));
  const l = U.readLimits(f);
  assert.equal(l.label, "official"); assert.equal(l.five_hour.pct, 29); assert.equal(l.seven_day.resets_at, 1795838400000);
  assert.equal(U.limitsText(l), "5h 29% · wk 39%");
  const old = (Date.now() - 7 * 3600_000) / 1000; utimesSync(f, old, old);
  assert.equal(U.limitsText(U.readLimits(f)), null, "older than 6 h: not shown");
  assert.equal(U.readLimits(join(base, "missing.json")), null);
  assert.equal(U.limitsFile({ AXA_STATUSLINE_FILE: "/x/y.json" }), "/x/y.json");
});

test("runaway: > 1.5M tokens in 15 min with no commit and no turn end; or spending on after it said done", () => {
  const m = 60_000, at = (min, tokens) => ({ at: min * m, tokens });
  const burn = [at(0, 0), at(5, 600_000), at(10, 1_200_000), at(15, 1_600_000)];
  assert.deepEqual(U.runawayCheck(burn, { now: 15 * m }), { kind: "burn", spent: 1_600_000 });
  assert.equal(U.runawayCheck(burn, { now: 15 * m, lastCommitAt: 7 * m }), null, "it committed");
  assert.equal(U.runawayCheck(burn, { now: 15 * m, lastStopAt: 9 * m }), null, "a turn ended");
  assert.equal(U.runawayCheck(burn.slice(0, 2), { now: 5 * m }), null, "not enough history yet");
  assert.equal(U.runawayCheck([at(0, 0), at(15, 900_000)], { now: 15 * m }), null, "under the limit");
  assert.equal(U.runawayCheck(burn, { now: 15 * m, limit: 3_000_000 }), null, "the policy's own limit");
  const after = [at(0, 0), at(3, 100_000), at(10, 500_000), at(15, 1_000_000)];
  assert.deepEqual(U.runawayCheck(after, { now: 15 * m, lastStopAt: 3 * m, doneAt: 3 * m }), { kind: "after_done", spent: 900_000 });
  assert.match(U.runawayText("feed", { kind: "burn", spent: 1_600_000 }), /^feed spent 1600k tokens in 15 min with no commit/);
});

test("wiring: /api/usage, the hub's $ panel and status bar figure, axa usage, list_sessions, the runaway notification", async () => {
  const s = src("src/core/server.mjs");
  assert.match(s, /\["GET", \/\^\\\/api\\\/usage\$\/, \(\) => \[200, usageReport\(\)\]\]/);
  assert.match(s, /notifier\.push\(\{ kind: "runaway", session: s\.id, project: s\.name, title: `\$\{s\.name\} may be looping`, body: runawayText\(s\.name, hit\), needsUser: true \}\)/);
  const app = src("src/tui/app.mjs");
  assert.match(app, /case "\$": return openUsage\(\);/);
  assert.match(src("bin/axa"), /case "usage": \{/);
  assert.match(src("mcp/axa-terminals.mjs"), /tokens \(official\)\$\{s\.usage\.cost != null \? `, about \$\$\{s\.usage\.cost\.toFixed\(2\)\} \(estimate\)`/);
  const { axaStatusLine } = await import("../src/tui/control.mjs");
  const plain = (x) => x.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain(axaStatusLine({}, [], 160, 1, { usage: { cost: 12.3456, limits: "5h 29% · wk 39%" } })[0]), /\$12 est · 5h 29% · wk 39%/);
  assert.equal((await import("../src/core/narrator.mjs")).KIND_TIER.runaway, "important");
});
