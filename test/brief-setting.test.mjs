// The daily brief from the hub and the CLI: the settings row's cycle (other notify keys kept), `axa brief`
// parsing and its ui.json write, a brief turned on after today's time waits for tomorrow, and the brief is
// always summarised when spoken. Temp HOME / AXA_HOME only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = realpathSync(mkdtempSync(join(tmpdir(), "axa-brief-test-")));
process.env.HOME = join(base, "home");
process.env.AXA_HOME = join(base, "axahome");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.AXA_HOME, { recursive: true });
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const P = await import("../src/core/projects.mjs");
const { nextBrief } = await import("../src/tui/app.mjs");
const { notesNeedSummary } = await import("../src/core/summary.mjs");

test("the hub's Daily brief row cycles off -> 07:00 -> 08:00 -> 09:00 -> 10:00 -> 12:00 -> off, keeping the other notify keys", () => {
  let n = { voice: "all", desktop: "off" };
  const seen = [];
  for (let i = 0; i < 6; i++) { n = nextBrief(n); seen.push(n.brief_at || "off"); }
  assert.deepEqual(seen, ["07:00", "08:00", "09:00", "10:00", "12:00", "off"]);
  assert.deepEqual(n, { voice: "all", desktop: "off" }, "off removes the key, keeps the rest");
  assert.equal(nextBrief({ brief_at: "09:30" }).brief_at, undefined, "a hand-set time not in the list goes to off");
  assert.equal(nextBrief(undefined).brief_at, "07:00");
  const app = readFileSync(join(ROOT, "src/tui/app.mjs"), "utf8");
  assert.match(app, /\{ label: "Daily brief \(all projects, once a day\)", hint: cfg\.notify\?\.brief_at \|\| "off", value: "brief" \}/);
  assert.match(app, /if \(o\.value === "brief"\) cfg\.notify = nextBrief\(cfg\.notify\);/);
});

test("axa brief's argument: HH:MM (padded), off, now; anything else is refused", () => {
  assert.equal(P.parseBriefArg("09:00"), "09:00");
  assert.equal(P.parseBriefArg("9:05"), "09:05");
  assert.equal(P.parseBriefArg("23:59"), "23:59");
  assert.equal(P.parseBriefArg("off"), null);
  assert.equal(P.parseBriefArg("OFF"), null);
  assert.equal(P.parseBriefArg("now"), "now");
  for (const bad of ["24:00", "9", "9:60", "nine", "09:00am", "", "-1:00"]) assert.throws(() => P.parseBriefArg(bad), /isn't a time/, bad);
});

test("axa brief writes ui.json read-modify-write (every other setting kept) and shows the setting", () => {
  const home = join(base, "cli-home"), axa = join(home, ".axa");
  mkdirSync(axa, { recursive: true });
  writeFileSync(join(axa, "ui.json"), JSON.stringify({ voice: "on", theme: "axa", notify: { voice: "all" } }));
  const run = (...a) => spawnSync(process.execPath, [join(ROOT, "bin", "axa"), "brief", ...a], { env: { PATH: process.env.PATH, HOME: home, AXA_HOME: axa, AXA_PORT: "4858" }, encoding: "utf8", timeout: 15_000 });
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Daily brief: off\./);
  r = run("9:30");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Daily brief at 09:30\. If that time has already passed today, the first one comes tomorrow/);
  assert.deepEqual(JSON.parse(readFileSync(join(axa, "ui.json"), "utf8")), { voice: "on", theme: "axa", notify: { voice: "all", brief_at: "09:30" } });
  assert.match(run().stdout, /every day at 09:30/);
  r = run("25:00");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /isn't a time/);
  assert.equal(run("off").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(axa, "ui.json"), "utf8")).notify, { voice: "all" });
  // a broken ui.json is never overwritten
  writeFileSync(join(axa, "ui.json"), "{ broken");
  r = run("08:00");
  assert.equal(r.status, 1);
  assert.equal(readFileSync(join(axa, "ui.json"), "utf8"), "{ broken");
});

test("turned on after today's time: nothing today, the first brief tomorrow; turned on before it: today", async () => {
  const at = (h, m, day = 23) => new Date(2026, 10, day, h, m).getTime();
  const sent = [];
  const tick = (file, brief_at, now) => P.briefTick({ brief_at, now, file, review: async () => [], push: (n) => sent.push({ n, now }) });
  const late = join(base, "late.json");
  assert.equal(await tick(late, "09:00", at(10, 0)), false, "just turned on at 10:00");
  assert.equal(await tick(late, "09:00", at(10, 1)), false);
  assert.equal(await tick(late, "09:00", at(23, 59)), false);
  assert.equal(await tick(late, "09:00", at(9, 0, 24)), true, "tomorrow at 09:00");
  const early = join(base, "early.json");
  assert.equal(await tick(early, "09:00", at(8, 0)), false, "turned on at 08:00");
  assert.equal(await tick(early, "09:00", at(9, 1)), true, "today at 09:00");
  // moved to an earlier time that has passed: not a second one today
  assert.equal(await tick(early, "08:00", at(10, 0)), false);
  assert.equal(await tick(early, "08:00", at(11, 0)), false);
  assert.equal(await tick(early, "08:00", at(8, 0, 24)), true);
  // off, then on again after the time: tomorrow again
  const again = join(base, "again.json");
  await tick(again, "09:00", at(8, 0)); await tick(again, null, at(8, 30)); assert.equal(await tick(again, "09:00", at(9, 30)), false);
  assert.equal(sent.length, 3);
});

test("axa brief now: the daemon posts one at once; a spoken brief always goes through the summary", () => {
  const s = readFileSync(join(ROOT, "src/core/server.mjs"), "utf8");
  assert.match(s, /\["POST", \/\^\\\/api\\\/brief\$\/, async \(\) => \{ const n = notifier\.push\(await briefNotification\(\(\) => projectReview\(true\)\)\);/);
  assert.match(s, /const long = notesNeedSummary\(text, items\);/);
  assert.equal(notesNeedSummary("Daily brief: Nothing changed.", [{ kind: "brief" }]), true, "even a short brief");
  assert.equal(notesNeedSummary("feed finished: done.", [{ kind: "done" }]), false);
  assert.equal(notesNeedSummary("a", [{ kind: "done" }, { kind: "link" }]), true);
  const cli = readFileSync(join(ROOT, "bin/axa"), "utf8");
  assert.match(cli, /api\("\/api\/brief", \{ method: "POST" \}\)/);
});
