// The supervisor's wake limit notice and links between sessions (console/supervisor.mjs), with a
// fake terminals module, a fake clock and a temporary home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSupervisor, DONE_MS } from "../console/supervisor.mjs";

const HOUR = 3600_000;
const flush = () => new Promise((r) => setImmediate(r));
function setup({ terms, wakesPerHour = 30, chains } = {}) {
  const home = mkdtempSync(join(tmpdir(), "axa-sup-"));
  if (chains) writeFileSync(join(home, "chains.json"), JSON.stringify(chains));
  const clock = { now: 10 * HOUR }, events = [], sent = [];
  const T = { listTerms: () => terms, lastInputAt: () => 0, sendToTerm: async (id, text) => { sent.push({ id, text }); return { ok: true }; } };
  const sup = createSupervisor({ T, home, logEvent: (e) => events.push(e), wakesPerHour, now: () => clock.now });
  return { sup, clock, events, sent, home, done: () => rmSync(home, { recursive: true, force: true }) };
}
const cmd = { id: "c1", name: "AXA", mode: "axa", alive: true, status: "ready" };
const worker = (id, status = "working") => ({ id, name: `proj-${id}`, mode: "claude", alive: true, status });

test("wake limit: one SupervisorLimit event per hour window, then wakes resume", async () => {
  const w1 = worker("w1"), w2 = worker("w2"), w3 = worker("w3");
  const s = setup({ terms: [cmd, w1, w2, w3], wakesPerHour: 1 });
  const step = async (ms) => { s.clock.now += ms; s.sup.supervise(); await flush(); };
  await step(0); // learns the current states
  w1.status = "done"; await step(0); await step(DONE_MS + 1000);
  assert.equal(s.sent.length, 1);
  assert.equal(s.events.filter((e) => e.event === "SupervisorWake").length, 1);
  const firstWake = s.clock.now;

  w2.status = "done"; await step(0); await step(DONE_MS + 1000);
  assert.equal(s.sent.length, 1); // over the limit: not woken
  const limits = () => s.events.filter((e) => e.event === "SupervisorLimit");
  assert.equal(limits().length, 1);
  const [ev] = limits();
  assert.deepEqual(Object.keys(ev).sort(), ["event", "limit", "pending", "resets_at", "role", "terminal", "ts"]);
  assert.deepEqual({ role: ev.role, terminal: ev.terminal, limit: ev.limit, pending: ev.pending, resets_at: ev.resets_at }, { role: "console", terminal: "c1", limit: 1, pending: ["proj-w2"], resets_at: firstWake + HOUR });

  w3.status = "done"; await step(0); await step(DONE_MS + 1000); await step(60_000);
  assert.equal(limits().length, 1); // still the same window: no second notice
  await step(HOUR); // the first wake left the window
  assert.equal(s.sent.length, 2);
  assert.match(s.sent[1].text, /proj-w2.*proj-w3|proj-w3.*proj-w2/);
  s.done();
});

test("links: fire into an idle shell once the first session is done; validation", async () => {
  const from = { ...worker("w1", "working"), last_event_at: 0 }, to = { id: "s1", name: "shell", mode: "shell", alive: true, status: "shell" };
  const s = setup({ terms: [from, to] });
  assert.equal(s.sup.addChain(undefined, to, "x")[0], 404);
  assert.equal(s.sup.addChain(from, from, "x")[0], 400);
  assert.equal(s.sup.addChain(from, to, "  ")[0], 400);
  assert.equal(s.sup.addChain(from, to, "y".repeat(4001))[0], 400);
  const [code, ch] = s.sup.addChain(from, to, " npm test ");
  assert.equal(code, 200);
  assert.equal(ch.text, "npm test");
  s.sup.runChains([from, to]);
  from.status = "done"; from.last_event_at = s.clock.now + 1; s.clock.now += 1000;
  s.sup.runChains([from, to]);
  s.clock.now += DONE_MS + 1;
  s.sup.runChains([from, to]); await flush();
  assert.deepEqual(s.sent, [{ id: "s1", text: "npm test" }]); // a shell gets just the command
  assert.ok(s.sup.chains[0].fired);
  assert.equal(s.events[0].event, "ChainFired");
  s.sup.runChains([from, to]); await flush();
  assert.equal(s.sent.length, 1); // once
  s.done();
});

test("links: a closed session fails the link; fired and failed links are dropped after a day", () => {
  const now = 10 * HOUR, day = 24 * HOUR;
  const s = setup({ terms: [], chains: [
    { id: "old-fired", from: "a", to: "b", text: "x", created: now - 2 * day, fired: now - day - 1000 },
    { id: "new-fired", from: "a", to: "b", text: "x", created: now - 1000, fired: now - 500 },
    { id: "old-failed", from: "a", to: "b", text: "x", created: now - 2 * day, failed: "the next session was closed" },
    { id: "pending", from: "a", to: "b", text: "x", created: now - 2 * day },
  ] });
  assert.deepEqual(s.sup.chains.map((c) => c.id), ["new-fired", "pending"]);
  s.sup.runChains([]);
  assert.equal(s.sup.chains.find((c) => c.id === "pending").failed, "the first session was closed");
  s.clock.now += day + 1000;
  s.sup.runChains([]);
  assert.deepEqual(s.sup.chains, []);
  assert.deepEqual(JSON.parse(readFileSync(join(s.home, "chains.json"), "utf8")), []);
  s.done();
});
