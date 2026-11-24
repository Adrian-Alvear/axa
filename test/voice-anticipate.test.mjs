// Part C of docs/tasks/voice-live.md: heads-ups before you're needed, time estimates, "what's up", verbosity and
// quiet hours. Pure, temp AXA_HOME only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-anticipate-")));
process.env.AXA_HOME = join(base, "axahome");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = (f) => readFileSync(join(ROOT, f), "utf8");
const D = await import("../src/core/durations.mjs");
const A = await import("../src/core/anticipate.mjs");
const N = await import("../src/core/narrator.mjs");

test("command signatures: the kind of work, not its arguments", () => {
  const cases = {
    "npm test": "npm test", "npm run build -- --watch": "npm run build", "CI=1 npm test -- -u": "npm test", "cd web && pnpm run lint": "pnpm run lint",
    "npx next build": "next build", "npx vitest run src/x.test.ts": "vitest run", "pytest -q tests/": "pytest", "cargo test --release": "cargo test",
    "node scripts/check.mjs": "node check.mjs", "npm test | tail -5": "npm test", "make": "make", "git push origin main": "git push", "": null,
  };
  for (const [cmd, sig] of Object.entries(cases)) assert.equal(D.signature(cmd), sig, cmd);
  assert.equal(D.labelOf("npm test"), "the tests"); assert.equal(D.labelOf("next build"), "the build"); assert.equal(D.labelOf("npm run lint"), "the linter");
  assert.equal(D.labelOf("node check.mjs"), "the checks"); assert.equal(D.labelOf("terraform plan"), "terraform plan");
});

test("the duration store: median and p90 of the last 30; about()", () => {
  assert.deepEqual(D.stats([10, 20, 30, 40]), { n: 4, median: 25, p90: 40 });
  assert.deepEqual(D.stats([5, 1, 3]), { n: 3, median: 3, p90: 5 });
  const s = D.stats([...Array(10).keys()].map((i) => (i + 1) * 1000));
  assert.equal(s.p90, 9000);
  assert.equal(D.stats([]), null);
  const st = D.createStore();
  for (let i = 0; i < 40; i++) st.record("k", 1000 + i);
  assert.equal(st.data().k.length, D.MAX_SAMPLES);
  assert.equal(st.data().k[0], 1010, "the oldest dropped");
  st.record("k", -5); st.record("k", 10 * 3600_000);
  assert.equal(st.data().k.length, D.MAX_SAMPLES, "nonsense is ignored");
  assert.equal(D.about(30_000), "about 30 seconds"); assert.equal(D.about(70_000), "about a minute");
  assert.equal(D.about(4 * 60_000), "about 4 minutes"); assert.equal(D.about(65 * 60_000), "about an hour");
  // the daemon's file, in AXA's home
  const f = join(base, "durations.json"), fs = D.fileStore(f);
  fs.record("feed::npm test", 61_000);
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { "feed::npm test": [61000] });
  assert.deepEqual(D.fileStore(f).stats("feed::npm test"), { n: 1, median: 61000, p90: 61000 });
  assert.equal(D.file(), join(process.env.AXA_HOME, "durations.json"));
});

test("heads-ups: 'usually about a minute' only for what usually takes > 20 s (3+ samples); 'taking longer' once at 1.5x p90", () => {
  const store = D.createStore(), said = [];
  let t = 0;
  const tr = D.createTracker({ store, now: () => t, nameOf: () => "feed", say: (it) => said.push(it) });
  const ev = (event, extra = {}) => tr.event({ event, terminal: "f1", cwd: "/home/u/feed", ts: t, ...extra });
  // learn: three runs of ~60 s
  for (const ms of [55_000, 60_000, 70_000]) { ev("PreToolUse", { tool: "Bash", tool_use_id: `u${ms}`, command: "npm test" }); t += ms; ev("PostToolUse", { tool_use_id: `u${ms}` }); }
  assert.deepEqual(store.stats("feed::npm test"), { n: 3, median: 60_000, p90: 70_000 });
  assert.equal(said.length, 0, "nothing said while it was still learning");
  ev("PreToolUse", { tool: "Bash", tool_use_id: "now", command: "npm test -- --runInBand" });
  assert.deepEqual(said.map((s) => [s.kind, s.text, s.toolUse]), [["eta", "feed is running the tests, usually about a minute.", "now"]]);
  assert.ok(tr.running("now"));
  t += 100_000; tr.tick(t);
  assert.equal(said.length, 1, "1.4x p90: not yet");
  t += 10_000; tr.tick(t); tr.tick(t + 5000);
  assert.deepEqual(said.slice(1).map((s) => s.text), ["feed is taking longer than usual on the tests."], "once");
  ev("PostToolUse", { tool_use_id: "now" });
  assert.equal(tr.running("now"), false);
  // quick things never get a heads-up
  for (let i = 0; i < 3; i++) { ev("PreToolUse", { tool: "Bash", tool_use_id: `g${i}`, command: "git status" }); t += 300; ev("PostToolUse", { tool_use_id: `g${i}` }); }
  ev("PreToolUse", { tool: "Bash", tool_use_id: "g9", command: "git status" });
  assert.equal(said.length, 2);
  // a failed command isn't a sample
  ev("PreToolUse", { tool: "Bash", tool_use_id: "x", command: "npm run e2e" }); t += 5000; ev("PostToolUseFailure", { tool_use_id: "x" });
  assert.equal(store.stats("feed::npm run e2e"), null);
});

test("the turn's ETA from UserPromptSubmit -> Stop history", () => {
  const store = D.createStore();
  let t = 0;
  const tr = D.createTracker({ store, now: () => t });
  const ev = (event) => tr.event({ event, terminal: "f1", cwd: "/x/feed", ts: t });
  for (const ms of [4, 5, 6].map((m) => m * 60_000)) { ev("UserPromptSubmit"); t += ms; ev("Stop"); }
  ev("UserPromptSubmit");
  t += 60_000;
  assert.equal(tr.eta("f1"), "usually done in about 4 minutes");
  t += 4 * 60_000;
  assert.equal(tr.eta("f1"), null, "past the median, not yet late");
  t += 5 * 60_000;
  assert.equal(tr.eta("f1"), "taking longer than usual");
  assert.equal(tr.eta("other"), null);
});

test("the approval heads-up: said from the approver's escalation, before Claude Code's notice; that notice isn't said again", () => {
  const door = { event: "AxaDecision", decision: "escalate", terminal: "f1", tool: "Bash", summary: "git push origin main", reason: "one-way door: push to main" };
  assert.ok(A.isEscalation(door));
  assert.equal(A.escalationLine(door, "feed"), "feed is about to need you: it wants to push to main.");
  assert.equal(A.escalationLine({ tool: "Bash", summary: "npm install left-pad", reason: "installs a new dependency" }, "feed"), "feed is about to need you: it wants to run npm install left-pad: installs a new dependency.");
  assert.equal(A.escalationLine({ tool: "WebFetch", summary: "https://example.com/x", reason: "AXA couldn't decide (approver unavailable)" }, "api"), "api is about to need you: it wants to fetch https://example.com/x.");
  assert.ok(A.isEscalation({ event: "PolicyDecision", decision: "ask", terminal: "t" }));
  assert.ok(!A.isEscalation({ ...door, decision: "allow" }));
  assert.ok(!A.isEscalation({ ...door, agent_id: "sub" }));
  assert.equal(N.normalize({ kind: "escalate", text: "x" }, 0).priority, N.P0);
  // the narrator: the heads-up goes at once (P0); the "needs you" that follows is dropped
  const said = [], logs = [];
  const n = N.createNarrator({ now: () => 0, speak: (t) => { said.push(t); return Promise.resolve(); }, log: (e) => logs.push(e), setTimer: () => 0, clearTimer: () => {} });
  n.add({ kind: "escalate", session: "f1", name: "feed", text: "feed is about to need you: it wants to push to main." });
  n.add({ kind: "waiting", session: "f1", name: "feed", text: "feed needs your permission to use Bash." });
  assert.deepEqual(said, ["feed is about to need you: it wants to push to main."]);
  assert.ok(logs.some((l) => l.why === "heads-up already said"));
});

test("what's up: who needs you, who's working on what (with its ETA), what's done, in 1-3 sentences", () => {
  const s = (name, status, doing = "", mode = "claude") => ({ id: name, name, status, doing, mode, alive: true });
  assert.equal(A.whatsUp([]), "Nothing is running right now.");
  assert.equal(A.whatsUp([s("AXA", "ready", "", "axa")]), "Nothing is running right now.");
  assert.equal(A.whatsUp([s("feed", "working", "Bash · Run the test suite"), s("api", "waiting", "needs your approval · push to main"), s("docs", "done")], { etaOf: (x) => (x.id === "feed" ? "usually done in about 4 minutes" : null) }),
    "Api needs your approval: push to main. Feed is working (run the test suite), usually done in about 4 minutes. Docs is done.");
  assert.equal(A.whatsUp([s("a", "working"), s("b", "working"), s("c", "working"), s("d", "failed"), s("e", "waiting")]), "D and e need you. Three sessions are working: a, b and c.");
  assert.equal(A.whatsUp([s("a", "ready"), s("b", "ready")]), "Two sessions are open, all idle.");
});

test("verbosity, quiet hours (a P0 becomes a toast), and no chatter about a session you're typing in", () => {
  const at = (h, m = 0) => new Date(2026, 10, 24, h, m).getTime();
  const it = (kind, priority, extra = {}) => ({ kind, priority, ...extra });
  assert.equal(A.admitItem(it("done", 1), { verbosity: "quiet" }), "verbosity quiet");
  assert.equal(A.admitItem(it("waiting", 0), { verbosity: "quiet" }), null);
  assert.equal(A.admitItem(it("progress", 2), { verbosity: "normal" }), "verbosity normal");
  for (const k of ["eta", "longer", "liveness"]) assert.equal(A.admitItem(it(k, 2), { verbosity: "normal" }), null, k);
  assert.equal(A.admitItem(it("progress", 2), { verbosity: "chatty" }), null);
  assert.equal(A.admitItem(it("routine", 3), { verbosity: "normal" }), "verbosity normal", "earcons for routine things only when chatty");
  assert.equal(A.admitItem(it("whatsup", 1, { asked: true }), { verbosity: "quiet" }), null, "you asked");
  // quiet hours, across midnight
  assert.deepEqual(A.parseQuiet("22:00-07:00"), { from: 1320, to: 420 });
  assert.equal(A.parseQuiet("10pm-7am"), null);
  assert.ok(A.inQuietHours("22:00-07:00", new Date(at(23, 30)))); assert.ok(A.inQuietHours("22:00-07:00", new Date(at(6, 59))));
  assert.ok(!A.inQuietHours("22:00-07:00", new Date(at(7, 0)))); assert.ok(A.inQuietHours("13:00-14:00", new Date(at(13, 30))));
  assert.equal(A.admitItem(it("waiting", 0), { quiet: "22:00-07:00", now: at(23) }), "quiet hours (a desktop toast instead)");
  assert.equal(A.admitItem(it("done", 1), { quiet: "22:00-07:00", now: at(23) }), "quiet hours");
  assert.equal(A.admitItem(it("done", 1), { quiet: "22:00-07:00", now: at(12) }), null);
  // typing in that session: no P2/P3 about it; a P0 still goes
  assert.equal(A.admitItem(it("eta", 2), { now: 100_000, typingAt: 95_000 }), "you're typing in it");
  assert.equal(A.admitItem(it("eta", 2), { now: 100_000, typingAt: 50_000 }), null);
  assert.equal(A.admitItem(it("waiting", 0), { now: 100_000, typingAt: 99_000 }), null);
});

test("the hook log keeps a Bash command (secrets blanked) so durations can be learned", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "hooks/log-event.mjs")], { input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/x", tool_name: "Bash", tool_use_id: "u1", tool_input: { command: "API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 npm test", description: "Run tests" } }), env: { ...process.env, AXA_HOME: process.env.AXA_HOME }, encoding: "utf8" });
  assert.equal(r.status, 0);
  const e = JSON.parse(readFileSync(join(process.env.AXA_HOME, "events.jsonl"), "utf8").trim().split("\n").pop());
  assert.match(e.command, /npm test$/);
  assert.doesNotMatch(e.command, /abcdefghijklmnop/);
  assert.equal(e.summary, "Run tests");
});

test("wiring: the daemon, `axa whatsup`, the hub's w and settings rows", () => {
  const s = src("src/core/server.mjs");
  assert.match(s, /if \(isEscalation\(e\) && V\.settings\(\)\.on\)/);
  assert.match(s, /const tracker = createTracker\(\{ store: fileStore\(\)/);
  assert.match(s, /\["POST", \/\^\\\/api\\\/whatsup\$\/[\s\S]{0,300}asked: true/);
  assert.match(s, /admitItem\(it, \{ verbosity: vs\.verbosity, quiet: vs\.quiet, typingAt/);
  assert.match(src("bin/axa"), /case "whatsup": \{[\s\S]{0,200}api\("\/api\/whatsup", \{ method: "POST" \}\)/);
  const app = src("src/tui/app.mjs");
  assert.match(app, /if \(k === "w"\) \{ whatsUpNow\(\); return true; \}/);
  for (const v of ["voiceVerbosity", "voiceEarcons", "voiceQuiet"]) assert.match(app, new RegExp(`value: "${v}"`));
  const V = src("src/core/voice.mjs");
  assert.match(V, /verbosity: VERBOSITY\.includes\(cfg\.voiceVerbosity\)/);
  assert.match(V, /quiet: \/\^/);
});
