#!/usr/bin/env node
// Desktop + phone screenshots of a page, for a "look at it, then fix it" review loop.
// Zero dependencies: drives an installed Chrome/Chromium headless over the DevTools protocol
// (needs Node 22+ for the built-in WebSocket).
//   node scripts/shot.mjs [url] [outdir] [--wait=ms] [--eval=js]
// url defaults to the AXA console on $AXA_PORT (4747), unlocked with the token in $AXA_HOME so the
// page opens with its cookie; outdir defaults to ./shots; the page gets --wait ms (default 3500) to
// load its live data; --eval runs JavaScript in the page before the shot (e.g. to open a dialog). Writes desktop.png (1440x900) and phone.png (390x844, 2x, mobile).
// Set AXA_CHROME to pick the browser binary.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const wait = Number(process.argv.find((a) => a.startsWith("--wait="))?.slice(7)) || 3500;
const evalJs = process.argv.find((a) => a.startsWith("--eval="))?.slice(7);
const port = Number(process.env.AXA_PORT || 4747);
const home = process.env.AXA_HOME || join(homedir(), ".axa");
const token = (() => { try { return readFileSync(join(home, "console-token"), "utf8").trim(); } catch { return ""; } })();
const url = args[0] || `http://localhost:${port}/?t=${token}`;
const out = resolve(args[1] || "shots");
const SHOTS = [
  { name: "desktop", width: 1440, height: 900, scale: 1, mobile: false },
  { name: "phone", width: 390, height: 844, scale: 2, mobile: true },
];

function findChrome() {
  if (process.env.AXA_CHROME) return process.env.AXA_CHROME;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
    const r = spawnSync("which", [name], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  // Playwright's browser cache (from `npx playwright install`)
  const cache = join(homedir(), ".cache", "ms-playwright");
  try {
    for (const d of readdirSync(cache).sort().reverse()) {
      for (const bin of ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell", "chrome-linux64/chrome", "chrome-linux/chrome"]) {
        if (existsSync(join(cache, d, bin))) return join(cache, d, bin);
      }
    }
  } catch {}
  for (const p of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]) if (existsSync(p)) return p;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = findChrome();
if (!chrome) { console.error("No Chrome/Chromium found. Install one or set AXA_CHROME."); process.exit(1); }
if (typeof WebSocket === "undefined") { console.error("Needs Node 22+ (built-in WebSocket)."); process.exit(1); }
mkdirSync(out, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "axa-shot-"));
const proc = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const cleanup = () => { try { proc.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);

try {
  // Chrome prints "DevTools listening on ws://..." once it's ready
  const browserWs = await new Promise((ok, fail) => {
    let err = "";
    const timer = setTimeout(() => fail(new Error(`Chrome didn't start:\n${err.slice(-800)}`)), 20_000);
    proc.stderr.on("data", (c) => { err += c; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) { clearTimeout(timer); ok(m[1]); } });
    proc.on("exit", () => { clearTimeout(timer); fail(new Error(`Chrome exited:\n${err.slice(-800)}`)); });
  });
  const ws = new WebSocket(browserWs);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error("couldn't connect to Chrome")); });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); const w = waiting.get(msg.id); if (w) { waiting.delete(msg.id); msg.error ? w.fail(new Error(msg.error.message)) : w.ok(msg.result); } };
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const id = ++seq; waiting.set(id, { ok, fail }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

  for (const s of SHOTS) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Emulation.setDeviceMetricsOverride", { width: s.width, height: s.height, deviceScaleFactor: s.scale, mobile: s.mobile }, sessionId);
    if (s.mobile) await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);
    await send("Page.enable", {}, sessionId);
    await send("Page.navigate", { url }, sessionId);
    await sleep(wait);
    if (evalJs) {
      const r = await send("Runtime.evaluate", { expression: evalJs, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) console.error(`--eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      await sleep(1000);
    }
    const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    const file = join(out, `${s.name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log(file);
    await send("Target.closeTarget", { targetId });
  }
  ws.close();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
cleanup();
process.exit();
