// The Control screen's live lanes (docs/tasks/map-lanes.md): ordering, the activity strip, columns by width,
// time text, scrolling, the empty state, motion only with meaning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { laneLayout, laneOrder, laneRows, laneSessions, laneTime, laneDoing, laneWord, stripBuckets, stripSegs, LANE_IDLE_MS } from "../src/tui/lanes.mjs";
import { createStore, createTracker } from "../src/core/durations.mjs";
import { laneTimes } from "../src/core/events.mjs";
import { width } from "../src/tui/draw.mjs";

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const T0 = 1_800_000_000_000;
const S = (id, status, extra = {}) => ({ id, name: id, mode: "claude", alive: true, status, created: T0 - 3600_000, ...extra });

test("lane order: commander, needs you, failed/stuck, working, the rest; stable inside a group", () => {
  const ss = [S("d", "done", { created: 1 }), S("w2", "working", { created: 5 }), S("w1", "working", { created: 2 }), S("q", "waiting", { created: 9 }),
    S("f", "failed", { created: 3 }), { ...S("axa", "ready"), mode: "axa" }, S("t", "needs_trust", { created: 1 }), S("st", "stuck", { created: 4 }), S("r", "ready", { created: 0 })];
  assert.deepEqual(laneOrder(ss).map((s) => s.id), ["axa", "t", "q", "f", "st", "w1", "w2", "r", "d"]);
  // the same input in another order gives the same lanes (rows don't jump between polls)
  assert.deepEqual(laneOrder([...ss].reverse()).map((s) => s.id), laneOrder(ss).map((s) => s.id));
});

test("idle sessions leave the lanes after 20 min, unless selected; dead ones never show", () => {
  const old = (LANE_IDLE_MS + 60_000) / 1000;
  const ss = [S("a", "done", { idle_seconds: old }), S("b", "ready", { idle_seconds: 10 }), S("c", "working", { idle_seconds: old }), S("x", "done", { alive: false })];
  const r = laneSessions(ss, null);
  assert.deepEqual(r.lanes.map((s) => s.id), ["c", "b"]);
  assert.equal(r.hidden, 1);
  assert.deepEqual(laneSessions(ss, "a").lanes.map((s) => s.id), ["c", "a", "b"]);
});

test("strip buckets: on a fixed grid, newest at the right, blank before the session existed", () => {
  const n = 15, size = 60_000, now = Math.floor(T0 / size) * size + 30_000; // halfway through a bucket
  const b = stripBuckets([now - 1000, now - 2000, now - size, now - 14 * size, now - 20 * size, now + 5000], { now, n });
  assert.equal(b.length, n);
  assert.equal(b[n - 1], 2, "the newest bucket: events in the current minute (a future one ignored)");
  assert.equal(b[n - 2], 1);
  assert.equal(b[0], 1, "14 min ago is the oldest bucket; 20 min ago is off the strip");
  // a later frame inside the same bucket: nothing shifts, the newest just fills
  const later = stripBuckets([now - 1000, now - 2000, now + 10_000, now - size], { now: now + 20_000, n });
  assert.equal(later[n - 1], 3); assert.equal(later[n - 2], 1);
  // a session started 3 minutes ago: older buckets are null
  const young = stripBuckets([], { now, n, since: now - 3 * size });
  assert.equal(young.filter((c) => c === null).length, n - 4);
  assert.equal(young[n - 1], 0);
  // drawn: blank, faint ▁ for quiet buckets, taller for more
  const segs = stripSegs([null, 0, 1, 8], 8, "work");
  assert.equal(segs.map(([t]) => t).join(""), " ▁▂█");
  assert.deepEqual(segs.map(([, r]) => r), ["", "frame", "work"]);
});

test("columns drop by width: agents, then time, then doing; never past the panel; grapheme-safe", () => {
  const want = { nameW: 10, statusW: 9, timeW: 12, agentsW: 9 };
  const wide = laneLayout(200, want);
  assert.ok(wide.agentsW && wide.timeW && wide.doingW > 40);
  const mid = laneLayout(64, want);
  assert.equal(mid.agentsW, 0); assert.ok(mid.timeW > 0 && mid.doingW >= 10);
  const narrow = laneLayout(52, want);
  assert.equal(narrow.timeW, 0); assert.ok(narrow.doing);
  const tiny = laneLayout(40, want);
  assert.equal(tiny.doing, false); assert.ok(tiny.strip >= 4);
  for (const cols of [40, 52, 70, 100, 160, 200]) {
    const L = laneLayout(cols, want);
    const used = 3 + L.nameW + 1 + L.strip + 1 + L.statusW + 1 + (L.doing ? 1 + L.doingW : 0) + (L.agentsW ? 1 + L.agentsW : 0) + (L.timeW ? 1 + L.timeW : 0);
    assert.ok(used <= cols, `${cols} columns: ${used} used`);
  }
  // rendered rows are exactly the panel's width, wide names and emoji included
  for (const cols of [40, 60, 100, 136, 198]) {
    const ctx = { sessions: [S("日本語のプロジェクト名前", "working", { doing: "🚀 deploying 日本 now", helpers: [{ id: "h", type: "x:researcher", status: "running" }] }), S("b", "waiting", { choices: { question: "Run deploy:preview?" } })], selId: "b", motion: "off", question: (c) => c.question, mapHits: [] };
    for (const r of laneRows(ctx, cols, 8, T0)) assert.equal(width(plain(r)), cols, `${cols}: ${plain(r)}`);
  }
});

test("time text: waiting, time left from the duration store, longer than usual, ago", () => {
  assert.equal(laneTime(S("a", "waiting", { wait_since: T0 - 125_000 }), T0), "waiting 2m");
  assert.equal(laneTime(S("a", "working", { eta: { left_ms: 70_000 } }), T0), "~1 min left");
  assert.equal(laneTime(S("a", "working", { eta: { left_ms: 20_000 } }), T0), "<1 min left");
  assert.equal(laneTime(S("a", "working", { eta: { over: true } }), T0), "longer than usual");
  assert.equal(laneTime(S("a", "working", { turn_start: T0 - 3 * 60_000 }), T0), "for 3m");
  assert.equal(laneTime(S("a", "done", { last_event_at: T0 - 5 * 60_000 }), T0), "5m ago");
  assert.equal(laneTime(S("a", "done", { last_event_at: T0 - 10_000 }), T0), "just now");
  assert.equal(laneTime(S("a", "stuck", { stuck_minutes: 22 }), T0), "stuck 22m");
  assert.equal(laneTime(S("a", "ready", { last_event_at: T0 - 90 * 60_000 }), T0), "1h 30m ago");
  // the tracker's time left: the turn's median minus the time it has run; over 1.5x p90: longer than usual
  const store = createStore();
  for (const ms of [60_000, 60_000, 60_000]) store.record("p::turn", ms);
  let t = T0;
  const tr = createTracker({ store, now: () => t, projectOf: () => "p" });
  tr.event({ terminal: "s", event: "UserPromptSubmit", ts: T0 });
  assert.deepEqual(tr.left("s", T0 + 15_000), { left_ms: 45_000 });
  assert.deepEqual(tr.left("s", T0 + 100_000), { over: true });
  assert.equal(tr.left("other", T0), null);
});

test("what a lane says: the question it waits on, its step, its report; the commander stands by", () => {
  assert.equal(laneDoing(S("a", "waiting", { choices: { question: "x" } }), () => "deploy:preview?"), "deploy:preview?");
  assert.equal(laneDoing(S("a", "working", { doing: "Bash · npm test" })), "Bash · npm test");
  // a permission prompt: the command it asks about, not "Do you want to proceed?"
  const perm = { question: "Bash command\nnpm run deploy:preview\nDeploy a preview build\nDo you want to proceed?" };
  assert.equal(laneDoing(S("a", "waiting", { choices: perm }), (c) => c.question.split("\n").at(-1)), "npm run deploy:preview?");
  assert.equal(laneDoing(S("a", "waiting", { choices: { question: "Which database?" } })), "Which database?");
  assert.equal(laneDoing(S("a", "done", { last_report: "\nREADME updated\nmore" })), "README updated");
  assert.equal(laneWord({ ...S("c", "ready"), mode: "axa" }), "standing by");
  assert.equal(laneWord(S("a", "waiting")), "NEEDS YOU");
});

test("lanes: selection hints, agents line, scrolling with +N more, idle note, empty state, motion", () => {
  const q = (c) => c.question;
  const cmd = { ...S("axa", "ready"), mode: "axa" };
  const w = S("charlie", "waiting", { choices: { question: "deploy:preview?" }, wait_since: T0 - 120_000 });
  const a = S("alpha", "working", { doing: "npm test", helpers: [{ id: "h1", type: "axa:builder", status: "running", doing: "Edit x" }, { id: "h2", type: "axa:reviewer", status: "running" }] });
  const ctx = { sessions: [a, w, cmd], selId: "charlie", motion: "full", question: q, mapHits: [], act: { lanes: { alpha: [T0 - 1000, T0 - 2000] } } };
  const rows = laneRows(ctx, 120, 10, T0).map(plain);
  assert.match(rows[0], /^ ◆ AXA\s/); assert.match(rows[1], /charlie .*NEEDS YOU\s+deploy:preview\?  y yes · x no\s+waiting 2m/);
  assert.match(rows[2], /alpha .*WORKING\s+npm test\s+\+2 agents/);
  assert.match(rows[3], /└ .*builder: Edit x · .*reviewer/, "its agents, on a dim second line");
  assert.ok(ctx.mapHits.some((h) => h.agent === "h2" && h.id === "alpha"), "each agent is clickable");
  assert.equal(ctx.anim, true, "a working spinner, a pulsing needs-you glyph");
  // not selected: no hint
  assert.doesNotMatch(laneRows({ ...ctx, selId: "alpha", mapHits: [] }, 120, 10, T0).map(plain).join("\n"), /y yes/);
  // 15 sessions in 8 rows: a window around the selection and a "+N more" line
  const many = Array.from({ length: 15 }, (_, i) => S(`s${String(i).padStart(2, "0")}`, "done", { created: i }));
  const c2 = { sessions: [cmd, ...many], selId: "s12", motion: "full", question: q, mapHits: [] };
  const r2 = laneRows(c2, 100, 8, T0).map(plain);
  assert.equal(r2.length, 8);
  assert.ok(r2.some((r) => /s12/.test(r)), "the selected lane stays in view");
  assert.match(r2[7], /↑ \d+ above · \+\d+ more · ↑↓ scroll/);
  assert.equal(c2.mapHits.length, 7);
  assert.equal(c2.anim, false, "all idle: nothing moves");
  // idle ones hidden
  const r3 = laneRows({ sessions: [cmd, S("old", "done", { idle_seconds: 99999 })], selId: null, motion: "full", question: q, mapHits: [] }, 100, 6, T0).map(plain);
  assert.ok(r3.some((r) => /1 idle hidden · Sessions tab/.test(r)));
  // empty
  assert.match(laneRows({ sessions: [], motion: "full", mapHits: [] }, 100, 4, T0).map(plain)[0], /No sessions yet · N starts one · : talk to AXA/);
  assert.match(laneRows({ sessions: [cmd], motion: "full", mapHits: [] }, 100, 4, T0).map(plain)[1], /No sessions yet/);
});

test("lane event times: the last 15 minutes per session, oldest first", () => {
  const now = T0;
  const list = [{ ts: now - 20 * 60_000, terminal: "a" }, { ts: now - 60_000, terminal: "a" }, { ts: now - 30_000, terminal: "b" }, { ts: now - 1000, terminal: "a" }, { ts: now - 500 }];
  assert.deepEqual(laneTimes(now, list), { a: [now - 60_000, now - 1000], b: [now - 30_000] });
});
