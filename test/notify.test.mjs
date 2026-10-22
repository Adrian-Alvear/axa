// Phone push (console/notify.mjs) against a local mock ntfy server only, and its supervisor wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomTopic, TOPIC_RE, createNtfy, createPush, notifierFrom } from "../console/notify.mjs";
import { createSupervisor, DONE_MS } from "../console/supervisor.mjs";

const PORT = 4877;
async function mockNtfy() {
  const got = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { got.push({ method: req.method, url: req.url, title: req.headers.title, priority: req.headers.priority, tags: req.headers.tags, body }); res.writeHead(200).end("{}"); });
  });
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  return { got, close: () => new Promise((r) => srv.close(r)) };
}
const flush = () => new Promise((r) => setTimeout(r, 50));

test("randomTopic: long, private alphabet, different every time", () => {
  const a = randomTopic(), b = randomTopic();
  assert.ok(a.length >= 24 && TOPIC_RE.test(a));
  assert.notEqual(a, b);
  assert.equal(randomTopic(4).length, 24); // never shorter than 24
});

test("ntfy: POSTs plain text to <server>/<topic> with Title, Priority and Tags", async () => {
  const m = await mockNtfy();
  try {
    const n = createNtfy({ server: `http://127.0.0.1:${PORT}/`, topic: "abc_DEF-123" });
    assert.equal(await n.send({ title: "AXA", body: "launches: needs you", priority: 4, tags: ["warning"] }), true);
    assert.deepEqual(m.got, [{ method: "POST", url: "/abc_DEF-123", title: "AXA", priority: "4", tags: "warning", body: "launches: needs you" }]);
  } finally { await m.close(); }
  assert.throws(() => createNtfy({ topic: "bad/topic" }));
  assert.throws(() => createNtfy({ server: "file:///etc", topic: "ok" }));
});

test("config: off by default, on only with enabled: true and a valid topic", () => {
  assert.equal(notifierFrom({}), null);
  assert.equal(notifierFrom({ ntfy: { enabled: false, topic: "abc" } }), null);
  assert.equal(notifierFrom({ ntfy: { enabled: true, topic: "a b" } }), null);
  assert.ok(notifierFrom({ ntfy: { enabled: true, topic: "abc" } }));
});

test("push: only name + short reason, deduped and rate-limited; nothing without notify.json", async () => {
  const sent = [], clock = { now: 0 };
  const p = createPush({ notifier: { send: async (m) => (sent.push(m), true) }, now: () => clock.now, perHour: 3 });
  assert.equal(await p.notify({ id: "a", name: "launches", status: "waiting", doing: "secret prompt text" }), true);
  assert.equal(await p.notify({ id: "a", name: "launches", status: "waiting" }), false); // deduped
  await p.notify({ id: "a", name: "launches", status: "failed", failed_reason: "rate limit" });
  await p.notify({ id: "b", name: "feed\u001b[31m", status: "done", last_report: "the report" });
  assert.equal(await p.notify({ id: "c", name: "x", status: "stuck" }), false); // 3 an hour
  assert.equal(await p.notify({ id: "c", name: "x", status: "working" }), false); // not notable
  assert.deepEqual(sent.map((m) => m.body), ["launches: needs you", "launches: failed: rate limit", "feed31m: done"]);
  assert.deepEqual(sent.map((m) => [m.priority, m.tags[0]]), [[4, "warning"], [4, "warning"], [3, "white_check_mark"]]);
  clock.now += 3600_001;
  assert.equal(await p.notify({ id: "c", name: "x", status: "stuck" }), true);
  const home = mkdtempSync(join(tmpdir(), "axa-notify-"));
  assert.equal(await createPush({ home }).notify({ id: "a", name: "n", status: "waiting" }), false);
  rmSync(home, { recursive: true, force: true });
});

test("supervisor → notify.json → mock ntfy: a session needing you is pushed once it has held", async () => {
  const m = await mockNtfy();
  const home = mkdtempSync(join(tmpdir(), "axa-notify-"));
  writeFileSync(join(home, "notify.json"), JSON.stringify({ ntfy: { enabled: true, server: `http://127.0.0.1:${PORT}`, topic: "t0p1c" } }));
  const clock = { now: 1e9 };
  const w = { id: "w1", name: "launches", mode: "claude", alive: true, status: "working" };
  const T = { listTerms: () => [w], lastInputAt: () => 0, sendToTerm: async () => ({ ok: true }) };
  const sup = createSupervisor({ T, home, logEvent: () => {}, enabled: false, push: createPush({ home, now: () => clock.now }), now: () => clock.now });
  try {
    sup.supervise(); // learns the current state
    w.status = "done"; sup.supervise(); await flush();
    assert.equal(m.got.length, 0); // a verify gate may still bounce it
    clock.now += DONE_MS; sup.supervise(); await flush();
    w.status = "failed"; w.failed_reason = "billing"; sup.supervise(); await flush();
    assert.deepEqual(m.got.map((g) => [g.url, g.body]), [["/t0p1c", "launches: done"], ["/t0p1c", "launches: failed: billing"]]);
  } finally { await m.close(); rmSync(home, { recursive: true, force: true }); }
});
