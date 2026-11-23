// Part A of docs/tasks/briefing.md: notifications. Event and status replays give the right items, repeats
// within 60 s are dropped, the voice says at most one per 20 s (the rest batched), desktop commands per OS
// (built, never run). Temp AXA_HOME only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-notify-test-")));
process.env.HOME = join(base, "home");
process.env.AXA_HOME = join(base, "axahome");
process.env.AXA_PORT = "4856";
process.env.AXA_DONE_MS = "6000";
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.AXA_HOME, { recursive: true });
const N = await import("../src/core/notify.mjs");
const { trackEvent, statusOf } = await import("../src/core/events.mjs");

const clock = (t = 1_000_000) => { const c = { t, now: () => c.t }; return c; };
const sess = (status, o = {}) => ({ id: "w1", name: "feed", mode: "claude", alive: true, cwd: "/home/me/feed", status, ...o });

// ---------- what each state and event means ----------
test("session states become notifications: done with its report, waiting with what it wants, the rest", () => {
  assert.deepEqual(N.fromStatus(sess("done", { last_report: "Fixed the login bug; tests pass.\n\nDetails: ..." })), { session: "w1", project: "feed", kind: "done", title: "feed finished", body: "Fixed the login bug; tests pass.", needsUser: false });
  const w = N.fromStatus(sess("waiting", { choices: { question: "Bash command\nDo you want to proceed?" } }));
  assert.equal(w.title, "feed needs you"); assert.equal(w.body, "Do you want to proceed?"); assert.equal(w.needsUser, true);
  assert.equal(N.fromStatus(sess("failed", { error: "server_error: 500" })).body, "server_error: 500");
  assert.match(N.fromStatus(sess("limited", { limit_resets: "3pm" })).body, /resets 3pm/);
  assert.equal(N.fromStatus(sess("exited")).kind, "exited");
  assert.match(N.fromStatus(sess("stuck", { stuck_minutes: 25 })).body, /25 min/);
  assert.equal(N.fromStatus(sess("needs_trust", { hint: "answer it" })).needsUser, true);
  for (const st of ["ready", "working", "starting"]) assert.equal(N.fromStatus(sess(st)), null, st);
  // the commander's own reply is spoken already: its "done" isn't a notification
  assert.equal(N.fromStatus(sess("done", { mode: "axa" })), null);
  // a worktree session belongs to its repo
  assert.equal(N.fromStatus(sess("exited", { cwd: "/x/feed/.claude/worktrees/a", worktree: { repo: "/x/feed" } })).project, "feed");
});

test("events: fix rounds, links, the approver's declines; final milestone verdicts", () => {
  assert.equal(N.fromEvent({ event: "MilestoneReview", summary: "milestone review feed: fix round 1: 2 findings to the fixer", terminal: "fx1" }).kind, "fixer");
  assert.equal(N.fromEvent({ event: "MilestoneReview", summary: "milestone review feed: ✗ block · bad", verdict: "block" }), null);
  const l = N.fromEvent({ event: "ChainFired", terminal: "w2", from: "api", to: "web", text: "rebase on api" });
  assert.equal(l.title, "link fired: api → web");
  const d = N.fromEvent({ event: "AxaDecision", decision: "deny", tool: "Bash", summary: "git push origin main", reason: "a push to main", cwd: "/home/me/feed", terminal: "w1" });
  assert.equal(d.kind, "declined"); assert.match(d.body, /git push origin main · a push to main/);
  assert.equal(N.fromEvent({ event: "AxaDecision", decision: "allow" }), null);
  assert.equal(N.fromEvent({ event: "PreToolUse" }), null);
  const m = N.fromMilestone("milestone review feed: ⚠ warn · two findings");
  assert.deepEqual([m.kind, m.project, m.title, m.needsUser], ["milestone", "feed", "review of feed: warn", true]);
  assert.equal(N.fromMilestone("milestone review feed: ✓ approve · fine").needsUser, false);
});

// ---------- the stream ----------
test("a replay of status changes: the first pass is quiet, a done waits until it holds, repeats are dropped", () => {
  const c = clock(), got = [], saved = [];
  const n = N.createNotifier({ now: c.now, deliver: (i) => got.push(i), save: (i) => i && saved.push(i) });
  n.tick([sess("working")]);
  assert.equal(got.length, 0, "first pass only learns");
  n.tick([sess("done", { last_report: "All done." })]);
  assert.equal(got.length, 0, "a done must hold first");
  c.t += 7000;
  n.tick([sess("done", { last_report: "All done." })]);
  assert.deepEqual(got.map((x) => x.title), ["feed finished"]);
  // waiting -> working -> waiting within a minute: one notification
  c.t += 1000; n.tick([sess("waiting", { doing: "needs approval · Bash" })]);
  c.t += 1000; n.tick([sess("working")]);
  c.t += 1000; n.tick([sess("waiting", { doing: "needs approval · Bash" })]);
  assert.equal(got.filter((x) => x.kind === "waiting").length, 1);
  // a minute later the same state counts again
  c.t += 61_000; n.tick([sess("working")]); n.tick([sess("waiting")]);
  assert.equal(got.filter((x) => x.kind === "waiting").length, 2);
  assert.equal(saved.length, got.length);
  for (const i of got) for (const k of ["id", "at", "kind", "session", "project", "title", "body", "needsUser"]) assert.ok(k in i, k);
});

test("event replays through the status machine: a usage limit and an exit reach the user", () => {
  const c = clock(), got = [];
  const n = N.createNotifier({ now: c.now, deliver: (i) => got.push(i) });
  const ev = (event, o = {}) => trackEvent({ event, terminal: "rp1", role: "worker", session: "chat", ...o });
  const view = () => ({ ...sess(statusOf("rp1").status), id: "rp1", error: statusOf("rp1").error, limit_resets: statusOf("rp1").limit_resets });
  ev("SessionStart"); n.tick([view()]);
  ev("UserPromptSubmit", { prompt: "x" }); n.tick([view()]);
  ev("StopFailure", { error: "rate_limit", error_details: "usage limit reached, resets 5pm" }); n.tick([view()]);
  ev("SessionEnd", { reason: "prompt_input_exit" }); n.tick([view()]);
  assert.deepEqual(got.map((x) => [x.kind, x.body]), [["limited", "it resets 5pm"], ["exited", "Claude Code ended in that session"]]);
});

test("only the last 200 are kept, and the file holds them", () => {
  const c = clock();
  const n = N.createNotifier({ now: c.now });
  for (let i = 0; i < 250; i++) { c.t += 1; n.push({ kind: "link", session: null, project: "p", title: `t${i}`, body: "" }); }
  assert.equal(n.list().length, 200);
  assert.equal(n.list()[0].title, "t50");
  // the daemon's notifier writes notifications.jsonl in AXA's home
  N.notifier.push({ kind: "link", session: null, project: "p", title: "to the file", body: "" });
  assert.match(readFileSync(join(process.env.AXA_HOME, "notifications.jsonl"), "utf8"), /to the file/);
});

// ---------- voice ----------
test("the voice says one notification per 20 s; the rest are batched", () => {
  const c = clock(), said = [], timers = [];
  const q = N.createVoiceQueue({ now: c.now, say: (t) => { said.push(t); }, setTimer: (fn, ms) => { timers.push({ fn, at: c.t + ms }); return 1; } });
  const item = (title, needsUser = false) => ({ title, body: "x", needsUser });
  q.add(item("feed finished"));
  assert.deepEqual(said, ["feed finished: x."]);
  c.t += 2000; q.add(item("api finished")); q.add(item("web needs you", true)); q.add(item("docs finished"));
  assert.equal(said.length, 1, "nothing more within 20 s");
  assert.equal(timers.length, 1); assert.equal(timers[0].at, 1_000_000 + 20_000);
  c.t = timers[0].at; timers.shift().fn();
  assert.equal(said[1], "web needs you: x. 2 more updates on screen.");
  // busy (a reply being read): tried again later, nothing lost
  const said2 = [], timers2 = [];
  let busy = true;
  const q2 = N.createVoiceQueue({ now: c.now, say: (t) => (busy ? false : said2.push(t)), setTimer: (fn, ms) => { timers2.push({ fn, ms }); return 1; } });
  q2.add(item("a"));
  assert.equal(said2.length, 0); assert.equal(timers2[0].ms, 2000);
  busy = false; timers2.shift().fn();
  assert.deepEqual(said2, ["a: x."]);
});

test("settings: what is spoken and shown by default", () => {
  assert.deepEqual(N.notifySettings({}), { voice: "needs-you", desktop: "needs-you", brief_at: null });
  assert.deepEqual(N.notifySettings({ notify: { voice: "all", desktop: "off", brief_at: "09:00" } }), { voice: "all", desktop: "off", brief_at: "09:00" });
  assert.equal(N.notifySettings({ notify: { voice: "loud", brief_at: "9am" } }).voice, "needs-you");
  assert.equal(N.notifySettings({ notify: { brief_at: "25:00" } }).brief_at, null);
  const done = { kind: "done", needsUser: false }, wait = { kind: "waiting", needsUser: true }, link = { kind: "link", needsUser: false };
  assert.deepEqual([N.voiceWants("needs-you", done), N.voiceWants("needs-you", wait), N.voiceWants("needs-you", link), N.voiceWants("all", link), N.voiceWants("off", wait)], [true, true, false, true, false]);
  assert.deepEqual([N.desktopWants("needs-you", done), N.desktopWants("needs-you", wait), N.desktopWants("all", link), N.desktopWants("off", wait)], [false, true, true, false]);
});

// ---------- desktop: the command per OS (pure; never run here) ----------
test("desktop notification commands: WSL/Windows toast, macOS osascript, Linux notify-send", () => {
  const evil = "x'); Remove-Item C:\\ -Recurse; ('\"$(id)\"";
  const has = (c) => c === "powershell.exe" || c === "notify-send";
  const [wc, wa] = N.desktopCommand({ platform: "linux", wsl: true, has }, "feed needs you", evil);
  assert.equal(wc, "powershell.exe");
  assert.deepEqual(wa.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(wa[3], /Windows\.UI\.Notifications\.ToastNotificationManager/);
  assert.match(wa[3], /NotifyIcon/, "a balloon if the toast API fails");
  assert.ok(!wa[3].includes("Remove-Item"), "the text goes in as base64, never as code");
  assert.ok(wa[3].includes(Buffer.from(evil).toString("base64")));
  assert.equal(N.desktopCommand({ platform: "win32", wsl: false, has: () => false }, "t", "b")[0], "powershell");
  const [mc, ma] = N.desktopCommand({ platform: "darwin", has: () => false }, "feed finished", evil);
  assert.equal(mc, "osascript");
  assert.deepEqual(ma.slice(-2), ["feed finished", evil], "title and body as argv, not in the script");
  assert.ok(!ma.slice(0, -2).join(" ").includes("feed finished"));
  assert.deepEqual(N.desktopCommand({ platform: "linux", wsl: false, has }, "-t", "b"), ["notify-send", ["-a", "AXA", "--", "-t", "b"]]);
  assert.equal(N.desktopCommand({ platform: "linux", wsl: false, has: () => false }, "t", "b"), null);
});
