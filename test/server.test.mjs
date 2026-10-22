// The console server end to end: started as a child process on a private port and a temporary
// AXA_HOME (never 4747 or ~/.axa), with its own tmux socket, removed afterwards.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4872;
const SOCKET = `axa-${PORT}`;
const home = mkdtempSync(join(tmpdir(), "axa-test-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server, token = "", out = "";

// One HTTP request with full control over the headers (Host included); resolves { status, headers, body }
function req(path, { method = "GET", headers = {}, body, cookie = true } = {}) {
  return new Promise((ok, fail) => {
    const h = { host: `localhost:${PORT}`, ...(cookie ? { cookie: `axa_token=${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers };
    const r = request({ host: "127.0.0.1", port: PORT, path, method, headers: h }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => { let j; try { j = JSON.parse(b); } catch {} ok({ status: res.statusCode, headers: res.headers, body: b, json: j }); });
    });
    r.on("error", fail);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

before(async () => {
  // a log with history from before the start: replayed to each new page from memory
  writeFileSync(join(home, "events.jsonl"), [{ ts: 1, event: "SessionStart", terminal: "old1", role: "worker" }, { ts: 2, event: "Stop", terminal: "old1", role: "worker", message: "earlier" },
    // one run (an instruction to its result), with another session's event in the middle of it
    { ts: 10, event: "UserPromptSubmit", terminal: "run1", role: "worker", cwd: "/tmp/proj", prompt: "fix the login" }, { ts: 11, event: "PreToolUse", terminal: "run1", role: "worker", tool: "Read", summary: "login.js" },
    { ts: 12, event: "PreToolUse", terminal: "other", role: "worker", tool: "Bash" }, { ts: 13, event: "AxaDecision", terminal: "run1", role: "worker", decision: "allow", reason: "tests", summary: "npm test", by: "rules" },
    { ts: 14, event: "Stop", terminal: "run1", role: "worker", message: "fixed it" }].map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n", { mode: 0o600 });
  const env = { ...process.env, AXA_PORT: String(PORT), AXA_HOME: home, AXA_SUPERVISOR: "0", AXA_ALLOWED_HOSTS: "MyBox.tailnet.ts.net, not a host!", AXA_GITHUB: "0" };
  for (const k of ["TMUX", "TMUX_PANE", "AXA_TERMINAL_ID", "AXA_ROLE"]) delete env[k];
  server = spawn(process.execPath, [join(root, "console/server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (out += d));
  server.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 100 && !out.includes("AXA console →"); i++) await sleep(100);
  token = readFileSync(join(home, "console-token"), "utf8").trim();
  assert.ok(out.includes("AXA console →"), `server didn't start: ${out}`);
});

after(async () => {
  server?.kill("SIGTERM");
  await new Promise((r) => (server?.exitCode != null ? r() : server.on("exit", r)));
  spawnSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
  rmSync(home, { recursive: true, force: true });
});

test("data routes need the cookie", async () => {
  const r = await req("/api/terms", { cookie: false });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "locked");
  assert.equal((await req("/events", { cookie: false })).status, 401);
  assert.equal((await req("/api/terms", { headers: { cookie: "axa_token=wrong" } })).status, 401);
});

test("a foreign Host is refused (DNS rebinding)", async () => {
  assert.equal((await req("/api/terms", { headers: { host: `evil.example:${PORT}` } })).status, 403);
  assert.equal((await req("/", { headers: { host: `evil.example:${PORT}` } })).status, 403);
  // and a foreign Origin can't use the cookie
  assert.equal((await req("/api/terms", { headers: { origin: "http://evil.example" } })).status, 401);
});

test("the page and the unlock link", async () => {
  const page = await req("/", { cookie: false });
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.equal((await req("/?t=nope", { cookie: false })).status, 403);
  const unlock = await req(`/?t=${token}`, { cookie: false });
  assert.equal(unlock.status, 302);
  assert.match(unlock.headers["set-cookie"][0], /HttpOnly; SameSite=Strict/);
});

test("/ui/ serves only allow-listed files from console/ui", async () => {
  for (const p of ["/ui/..%2Fserver.mjs", "/ui/..%2f..%2fpackage.json", "/ui/.gitkeep", "/ui/nope.css", "/ui/", "/ui/x/y.js", "/ui/server.mjs"]) {
    assert.equal((await req(p, { cookie: false })).status, 404, p);
  }
  // dot segments are resolved by the URL parser before routing: that's /server.mjs, not a ui file
  assert.equal((await req("/ui/%2e%2e/server.mjs", { cookie: false })).status, 401);
  assert.equal((await req("/ui/../server.mjs", { cookie: false })).status, 401);
  // whatever the page ships there (another change adds the files) is served without the token
  const files = readdirSync(join(root, "console/ui")).filter((f) => /^[\w.-]+\.(?:css|js|svg|json|webmanifest)$/.test(f));
  for (const f of files.slice(0, 3)) {
    const r = await req(`/ui/${f}`, { cookie: false });
    assert.equal(r.status, 200, f);
    assert.equal(r.headers["cache-control"], "no-cache");
    assert.match(r.headers["content-type"], /css|javascript|svg|json|manifest/);
  }
});

test("/shared/ serves exactly the design system's two modules", async () => {
  for (const name of ["theme.mjs", "look.mjs"]) {
    const r = await req(`/shared/${name}`, { cookie: false });
    assert.equal(r.status, 200, name);
    assert.match(r.headers["content-type"], /^text\/javascript/);
    assert.equal(r.headers["cache-control"], "no-cache");
    assert.equal(r.body, readFileSync(join(root, "console", name), "utf8"));
  }
  for (const p of ["/shared/server.mjs", "/shared/status.mjs", "/shared/", "/shared/..%2Fserver.mjs", "/shared/theme.mjs.bak"]) {
    assert.notEqual((await req(p, { cookie: false })).status, 200, p);
  }
});

test("/api/ui-settings: theme and themeSync only, merged into ui.json", async () => {
  const file = join(home, "ui.json"), page = { "sec-fetch-site": "same-origin", origin: `http://localhost:${PORT}` };
  const post = (body, headers = page) => req("/api/ui-settings", { method: "POST", body, headers });
  assert.equal((await req("/api/ui-settings", { cookie: false })).status, 401);
  assert.equal((await req("/api/ui-settings", { method: "POST", body: { theme: "paper" }, cookie: false, headers: page })).status, 401);
  assert.deepEqual((await req("/api/ui-settings")).json, { theme: null, themeSync: false }); // no file yet

  // the terminal app's own settings are kept
  writeFileSync(file, JSON.stringify({ theme: "terminal", prefix: "C-a", labels: { x: "y" } }), { mode: 0o600 });
  assert.deepEqual((await req("/api/ui-settings")).json, { theme: "terminal", themeSync: false });

  // writing needs the page (or the terminal app), like /answer
  assert.equal((await post({ theme: "paper" }, {})).status, 403);
  assert.equal((await post({ theme: "paper" }, { "sec-fetch-site": "same-origin" })).status, 403);
  assert.equal((await post({ theme: "paper" }, { origin: `http://localhost:${PORT}` })).status, 403);
  assert.equal((await post({ theme: "paper" }, { "sec-fetch-site": "same-origin", origin: "http://evil.example" })).status, 401);

  const ok = await post({ theme: "paper", themeSync: true, prefix: "C-z", evil: 1 });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { theme: "paper", themeSync: true });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { theme: "paper", prefix: "C-a", labels: { x: "y" }, themeSync: true });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readdirSync(home).some((f) => f.endsWith(".tmp")));

  assert.equal((await post({ theme: "terminal" }, { "x-axa-client": "tui" })).json.theme, "terminal");
  assert.equal((await post({ theme: "mono" }, { "x-axa-client": "tui" })).json.theme, "mono");
  assert.equal((await req("/api/ui-settings")).json.theme, "mono");
  assert.equal((await post({ theme: "high-contrast" })).json.theme, "contrast"); // an older name
  // (a body that isn't an object, 1 or [], used to crash the server)
  for (const bad of [{ theme: "neon" }, { theme: 3 }, { themeSync: "yes" }, {}, { prefix: "C-z" }, 1, []]) assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).theme, "contrast");

  // a file it can't read is left alone
  writeFileSync(file, "{ not json", { mode: 0o600 });
  assert.equal((await post({ theme: "paper" })).status, 500);
  assert.equal(readFileSync(file, "utf8"), "{ not json");
  rmSync(file);
});

test("AXA_ALLOWED_HOSTS: an HTTPS proxy's name (Tailscale Serve) is accepted, nothing else", async () => {
  const host = "mybox.tailnet.ts.net";
  assert.equal((await req("/api/terms", { headers: { host } })).status === 403, false);
  assert.equal((await req("/", { headers: { host }, cookie: false })).status, 200);
  assert.notEqual((await req("/roster", { headers: { host, origin: `https://${host}` } })).status, 401);
  assert.equal((await req("/roster", { headers: { host, origin: `http://${host}` } })).status, 401); // https only
  assert.equal((await req("/roster", { headers: { host: "not a host!" } })).status, 403);
  assert.equal((await req("/roster", { headers: { host: "other.tailnet.ts.net" } })).status, 403);
});

test("/sw.js: the service worker, from the root, without the token; it never caches live data", async () => {
  const r = await req("/sw.js", { cookie: false });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^text\/javascript/);
  assert.equal(r.headers["cache-control"], "no-cache");
  assert.ok(r.body.includes("api\\/|events$|roster$|pty\\/"), "the LIVE pattern skips /api/, /events, /roster, /pty/");
  for (const f of ["manifest.webmanifest", "icon.svg"]) assert.equal((await req(`/ui/${f}`, { cookie: false })).status, 200, f);
  const m = JSON.parse((await req("/ui/manifest.webmanifest", { cookie: false })).body);
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url.startsWith("/"), true);
});

test("/api/runs/:id: one run and its own events, behind the cookie", async () => {
  assert.equal((await req("/api/runs/run1-10", { cookie: false })).status, 401);
  assert.equal((await req("/api/runs/run1-10", { headers: { host: `evil.example:${PORT}` } })).status, 403);
  assert.equal((await req("/api/runs/nope-1")).status, 404);
  const list = (await req("/api/runs")).json;
  const run = list.find((x) => x.terminal === "run1");
  assert.ok(run, JSON.stringify(list));
  assert.equal(run.id, "run1-10");
  const r = await req(`/api/runs/${run.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.run.report, "fixed it");
  assert.equal(r.json.run.approvals, 1);
  // only this run's session, in order, slimmed (no role/cwd/terminal fields)
  assert.deepEqual(r.json.events.map((e) => e.event), ["UserPromptSubmit", "PreToolUse", "AxaDecision", "Stop"]);
  assert.deepEqual(r.json.events[2], { ts: 13, event: "AxaDecision", summary: "npm test", decision: "allow", reason: "tests", by: "rules" });
  assert.equal(r.json.events.some((e) => "terminal" in e || "role" in e), false);
});

test("/events replays the history from memory", async () => {
  const body = await new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port: PORT, path: "/events", headers: { host: `localhost:${PORT}`, cookie: `axa_token=${token}` } }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { b += c; if (b.includes("\n\n")) { r.destroy(); ok(b); } });
    });
    r.on("error", fail);
    r.end();
  });
  const m = /^event: history\ndata: (.*)\n\n/.exec(body);
  assert.ok(m, body.slice(0, 200));
  const events = JSON.parse(m[1]);
  assert.deepEqual(events.map((e) => e.event), ["SessionStart", "Stop", "UserPromptSubmit", "PreToolUse", "PreToolUse", "AxaDecision", "Stop"]); // the broken line is left out
});

test("shells, links and answering", async (t) => {
  const make = () => req("/api/terms", { method: "POST", body: { mode: "shell", cwd: root, cols: 100, rows: 30 } });
  const a = await make(), b = await make();
  if (a.status !== 200) return t.skip(`no terminals here: ${a.body}`);
  assert.equal(b.status, 200);
  assert.equal(a.json.status, "shell");

  await t.test("shell sessions report status shell", async () => {
    await sleep(1500); // after the background screen refresher has looked at them
    const list = (await req("/api/terms")).json;
    for (const s of list.filter((s) => [a.json.id, b.json.id].includes(s.id))) {
      assert.equal(s.status, "shell");
      assert.equal(s.alive, true);
      assert.equal(s.awaiting_permission, false);
    }
  });

  await t.test("answering needs the page or the terminal app", async () => {
    const path = `/api/terms/${a.json.id}/answer`;
    assert.equal((await req(path, { method: "POST", body: { n: 1, label: "Yes" } })).status, 403);
    assert.equal((await req(path, { method: "POST", body: { n: 1, label: "Yes" }, headers: { "sec-fetch-site": "same-origin" } })).status, 403); // no origin
    assert.equal((await req(path, { method: "POST", body: { n: 1, label: "Yes" }, headers: { origin: `http://localhost:${PORT}` } })).status, 403); // no sec-fetch-site
    // allowed through, but there's no prompt on a shell's screen: nothing is pressed
    const tui = await req(path, { method: "POST", body: { n: 1, label: "Yes" }, headers: { "x-axa-client": "tui" } });
    assert.equal(tui.status, 409);
    assert.match(tui.json.error, /no longer on screen/);
  });

  await t.test("/api/chains validation", async () => {
    const post = (body) => req("/api/chains", { method: "POST", body });
    assert.equal((await post({ from: "nope", to: b.json.id, text: "x" })).status, 404);
    assert.equal((await post({ from: a.json.id, to: "nope", text: "x" })).status, 404);
    assert.equal((await post({ from: a.json.id, to: a.json.id, text: "x" })).status, 400);
    assert.equal((await post({ from: a.json.id, to: b.json.id, text: "   " })).status, 400);
    assert.equal((await post({ from: a.json.id, to: b.json.id })).status, 400);
    assert.equal((await post({ from: a.json.id, to: b.json.id, text: "x".repeat(4001) })).status, 400);
    const ok = await post({ from: a.json.id, to: b.json.id, text: "echo next" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.text, "echo next");
    const list = (await req("/api/chains")).json;
    assert.ok(list.some((c) => c.id === ok.json.id && c.from_name && c.to_name));
    assert.equal((await req(`/api/chains/${ok.json.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await req(`/api/chains/${ok.json.id}`, { method: "DELETE" })).status, 404);
  });

  await t.test("/api/digest: every session with what happened since; /api/cost: per-day totals", async () => {
    const t0 = Date.now();
    const log = (e) => appendFileSync(join(home, "events.jsonl"), JSON.stringify({ terminal: a.json.id, role: "worker", ...e }) + "\n");
    log({ ts: t0 - 60_000, event: "AxaDecision", decision: "allow", reason: "old" });
    log({ ts: t0, event: "AxaDecision", decision: "deny", reason: "r" });
    log({ ts: t0, event: "PostToolUseFailure", tool: "Bash", error: "boom sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    writeFileSync(join(home, "cost.json"), JSON.stringify({ sessions: { c1: { usd: 1.5, at: t0, day: "2026-10-21", base: 0 } }, days: { "2026-10-21": { c1: 1.5 }, "2026-10-20": { c9: 0.25 } } }));
    await sleep(600);
    const d = (await req(`/api/digest?since=${t0 - 1000}`)).json;
    assert.ok(d.now >= t0 && d.since === t0 - 1000);
    const s = d.sessions.find((x) => x.id === a.json.id);
    assert.deepEqual(s.since, { approved: 0, declined: 1, escalated: 0, refused: 0, failures: 1, gate: 0, api_errors: 0, last_failures: [s.since.last_failures[0]] });
    assert.doesNotMatch(s.since.last_failures[0], /AAAAAAAAAAAAAAAA/); // redacted
    assert.equal((await req("/api/digest")).json.sessions.find((x) => x.id === a.json.id).since.approved, 1);
    assert.equal(s.status, "shell");
    assert.equal(s.github, null); // AXA_GITHUB=0 here: no gh calls from tests
    const term = (await req("/api/terms")).json.find((x) => x.id === a.json.id);
    assert.ok("cost" in term && "github" in term);
    assert.deepEqual((await req("/api/cost")).json, { days: [{ date: "2026-10-21", usd: 1.5, sessions: 1 }, { date: "2026-10-20", usd: 0.25, sessions: 1 }], today_usd: (await req("/api/cost")).json.today_usd, total_usd: 1.75 });
    assert.equal((await req("/api/digest", { cookie: false })).status, 401);
  });

  await t.test("reading the screen and closing", async () => {
    const s = await req(`/api/terms/${a.json.id}/screen?lines=20`);
    assert.equal(s.status, 200);
    assert.equal(typeof s.json.screen, "string");
    assert.equal((await req(`/api/terms/${a.json.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await req(`/api/terms/${b.json.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await req(`/api/terms/${a.json.id}`, { method: "DELETE" })).status, 404);
    const list = (await req("/api/terms")).json;
    assert.ok(!list.some((s) => s.id === a.json.id || s.id === b.json.id));
  });
});
