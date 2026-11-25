// The milestone review of the landscape work (review-landscape.txt): 5 findings, each with a regression test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("./fixtures/approver-run.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pure = mkdtempSync(join(tmpdir(), "axa-review-fix-"));
process.env.HOME = join(pure, "home"); process.env.AXA_HOME = join(pure, "axahome");
mkdirSync(process.env.HOME, { recursive: true }); mkdirSync(process.env.AXA_HOME, { recursive: true });
const App = await import("../src/tui/app.mjs");

function sandbox(policy) {
  const base = mkdtempSync(join(tmpdir(), "axa-review-fix-sb-"));
  const s = { base, home: join(base, "home"), axa: join(base, "axahome"), proj: join(base, "proj"), calls: join(base, "calls.jsonl") };
  for (const d of [s.home, s.axa, join(s.proj, "sub")]) mkdirSync(d, { recursive: true });
  if (policy) writeFileSync(join(s.axa, "policy.json"), JSON.stringify(policy));
  return s;
}
function sh(s, command, { judge = '{"decision":"allow","reason":"fine."}', session = "sess-1" } = {}) {
  const r = spawnSync(process.execPath, [RUNNER], {
    input: JSON.stringify({ session_id: session, tool_name: "Bash", tool_input: { command }, cwd: s.proj }),
    env: { PATH: process.env.PATH, HOME: s.home, AXA_HOME: s.axa, AXA_ROLE: "worker", CLAUDE_PROJECT_DIR: s.proj, AXA_TEST_JUDGE: judge, AXA_TEST_JUDGE_LOG: s.calls },
    encoding: "utf8", timeout: 15_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.decision : null;
}
const calls = (s) => (existsSync(s.calls) ? readFileSync(s.calls, "utf8").trim().split("\n").filter(Boolean) : []);
const decisions = (s) => readFileSync(join(s.axa, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === "AxaDecision");

test("1. a door or escalate rule matched in any part of a chain goes to the user, never to the model as a quoted-text match", () => {
  const s = sandbox({ default: { escalate: ["^make bundle$"] } });
  assert.equal(sh(s, "cd sub && make bundle"), null, "the user decides");
  assert.equal(calls(s).length, 0, "the model is never asked");
  assert.equal(decisions(s).at(-1).by, "rule");
  // a door only in a later part of the chain, outside quotes: the user too
  assert.equal(sh(s, "npm test && npm publish"), null);
  assert.equal(calls(s).length, 0);
  // (text really inside quotes is still the model's to judge, as before)
  sh(s, `echo "npm publish" && make lint`);
  assert.equal(calls(s).length, 1);
});

test("2. the audit log keeps the door's full name", () => {
  const s = sandbox();
  sh(s, "git push origin main");
  const d = decisions(s).at(-1);
  const a = JSON.parse(readFileSync(join(s.axa, "approver-audit.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.equal(`one-way door: ${a.door}`, d.reason.slice(0, 14 + 45));
  assert.match(a.door, /^push/);
});

test("3. the circuit breaker stays tripped until the user gives a new instruction; a remembered allow doesn't reset it", () => {
  const s = sandbox();
  const log = join(s.axa, "events.jsonl");
  const prompt = (p) => writeFileSync(log, (existsSync(log) ? readFileSync(log, "utf8") : "") + JSON.stringify({ ts: Date.now(), event: "UserPromptSubmit", session: "sess-1", prompt: p }) + "\n");
  prompt("build the thing");
  assert.equal(sh(s, "make a").behavior, "allow"); // remembered under this task
  for (const c of ["make b", "make c", "make d"]) assert.equal(sh(s, c, { judge: '{"decision":"deny","reason":"no."}' }).behavior, "deny");
  const n = calls(s).length;
  assert.equal(sh(s, "make a"), null, "the remembered allow doesn't get past the breaker");
  assert.equal(sh(s, "make e"), null, "and nothing new goes to the model");
  assert.equal(calls(s).length, n);
  assert.equal(decisions(s).at(-1).by, "breaker");
  // the user's new instruction is their decision: the approver decides again
  prompt("ok, now do it differently");
  assert.equal(sh(s, "make f").behavior, "allow");
});

test("4. Space has one case in the hub's key switch (the dead duplicate is gone)", () => {
  const app = readFileSync(join(ROOT, "src/tui/app.mjs"), "utf8");
  const hub = app.slice(app.indexOf("  function hubKey(k) {"), app.indexOf("\n  }\n", app.indexOf("  function hubKey(k) {")));
  assert.equal((hub.match(/case " "/g) || []).length, 1);
  assert.match(hub, /case " ": return nextNeedsYou\(\);/);
});

test("5. the Ctrl+P palette maps glyph keys to the keys that really run them, and leaves out what isn't a key", () => {
  assert.equal(App.paletteKey("⏎"), "\r");
  assert.equal(App.paletteKey("→"), "\x1b[C");
  assert.equal(App.paletteKey("Space"), " ");
  assert.equal(App.paletteKey("L"), "L");
  for (const k of ["↑↓", "drag", "y/x", "PgUp", "Tab / 1-5", "Ctrl+P", "Esc"]) assert.equal(App.paletteKey(k), null, k);
  // every key the palette can run is one the hub handles
  const app = readFileSync(join(ROOT, "src/tui/app.mjs"), "utf8");
  for (const p of [...Object.keys(App.PANEL_NAMES), "global"]) for (const [k] of App.KEYMAP[p]) {
    const key = App.paletteKey(k);
    if (key === null) continue;
    const lit = JSON.stringify(key).slice(1, -1).split(String.fromCharCode(92) + "u001b").join(String.fromCharCode(92) + "x1b");
    assert.ok(app.includes(`case "${lit}"`) || app.includes(`k === "${lit}"`) || app.includes(`"${lit}": `) || app.includes(`case ${lit === "\\x1b" ? "ESC" : "x"}`), `${p}: ${k} -> ${lit}`);
  }
});
