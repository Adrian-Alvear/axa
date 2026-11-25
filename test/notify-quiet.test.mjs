// Fewer, truer notifications on the desktop: a test or demo daemon never toasts or speaks; a prompt only goes out
// if it still waits after 15 s (the approver usually answers it first); at most one toast per session per 2 min.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AXA_HOME = mkdtempSync(join(tmpdir(), "axa-notify-quiet-"));
const N = await import("../src/core/notify.mjs");

const clock = (t = 1_000_000) => { const c = { t, now: () => c.t }; return c; };
const sess = (id, status, o = {}) => ({ id, name: id, mode: "claude", alive: true, cwd: `/home/me/${id}`, status, ...o });

test("only the real daemon (default AXA home, port 4747) toasts or speaks, unless AXA_NOTIFY_TEST=1", () => {
  const userHome = "/home/me", real = { env: {}, axaHome: "/home/me/.axa", axaPort: 4747, userHome };
  assert.equal(N.outwardAllowed(real), true);
  assert.equal(N.outwardAllowed({ ...real, axaHome: "/tmp/axa-map/alive-run/axahome" }), false, "a demo's AXA home");
  assert.equal(N.outwardAllowed({ ...real, axaPort: 4859 }), false, "another port");
  assert.equal(N.outwardAllowed({ ...real, axaPort: 4859, env: { AXA_NOTIFY_TEST: "1" } }), true);
  // this test process: a temp AXA home
  assert.equal(N.outwardAllowed(), false);
});

test("a prompt goes out only if it still waits after 15 s; the approver's answer or moving on drops it", () => {
  const c = clock(), got = [], saved = [];
  const n = N.createNotifier({ now: c.now, deliver: (i) => got.push(i), save: (i) => i && saved.push(i) });
  n.tick([sess("api", "working"), sess("jobs", "working"), sess("web", "working")]);
  c.t += 1000;
  n.tick([sess("api", "waiting", { doing: "Bash npm publish" }), sess("jobs", "waiting"), sess("web", "waiting")]);
  assert.equal(saved.length, 3, "the hub's list has all three at once");
  assert.equal(got.length, 0, "nothing on the desktop yet");
  assert.deepEqual(n.held().sort(), ["api", "jobs", "web"]);
  // the approver allows jobs' prompt; web moves on by itself
  c.t += 3000;
  n.event({ event: "AxaDecision", terminal: "jobs", decision: "allow", by: "model" });
  n.tick([sess("api", "waiting", { doing: "Bash npm publish" }), sess("jobs", "waiting"), sess("web", "working")]);
  assert.deepEqual(n.held(), ["api"]);
  c.t += 12_000;
  n.tick([sess("api", "waiting", { doing: "Bash npm publish" }), sess("jobs", "working"), sess("web", "working")]);
  assert.deepEqual(got.map((i) => i.title), ["api needs you"], "only the one still unanswered");
  // a prompt answered and a new one asked in between: that's not the same wait
  const c2 = clock(), got2 = [];
  const m = N.createNotifier({ now: c2.now, deliver: (i) => got2.push(i) });
  m.tick([sess("a", "working")]); c2.t += 1000; m.tick([sess("a", "waiting")]);
  c2.t += 2000; m.tick([sess("a", "working")]); c2.t += 2000; m.tick([sess("a", "waiting")]);
  c2.t += 20_000; m.tick([sess("a", "waiting")]);
  assert.equal(got2.length, 0, "dropped: the session moved on (and the repeat within a minute is deduped)");
  // other kinds go out at once
  m.push({ kind: "failed", session: "a", project: "a", title: "a failed", needsUser: true });
  assert.equal(got2.length, 1);
});

test("at most one desktop toast per session per 2 minutes, the next one with a count", () => {
  const c = clock(), gate = N.createToastGate({ now: c.now });
  const n = (s) => ({ session: s, kind: "waiting", title: `${s} needs you`, body: "x" });
  assert.deepEqual(gate(n("api")), { title: "api needs you", body: "x" });
  c.t += 30_000; assert.equal(gate(n("api")), null);
  c.t += 30_000; assert.equal(gate(n("api")), null);
  assert.deepEqual(gate(n("jobs")), { title: "jobs needs you", body: "x" }, "another session: its own");
  c.t += 61_000; assert.deepEqual(gate(n("api")), { title: "api needs you (3×)", body: "x" });
  c.t += 121_000; assert.deepEqual(gate(n("api")), { title: "api needs you", body: "x" });
});
