// ---------- phone push (off by default): tell your phone when a session needs you ----------
// A notifier is anything with send({ title, body, priority, tags }) -> Promise<boolean>. The one built
// in posts to ntfy (https://ntfy.sh or your own server), configured in $AXA_HOME/notify.json:
//   { "ntfy": { "enabled": false, "server": "https://ntfy.sh", "topic": "<private random topic>" } }
// The topic works like a password (anyone who knows it can read it), so it's long and random.
// What is sent is only the session's name and a short reason in AXA's own words ("needs you",
// "stuck", "failed: rate limit", "done"): never prompts, screen text, commands or reports.
//   node console/notify.mjs init   writes notify.json (disabled) with a fresh random topic
//   node console/notify.mjs test   sends one test notification (only when enabled)
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"; // 64: a byte & 63 is unbiased
export const randomTopic = (n = 32) => [...randomBytes(Math.max(24, Math.min(64, n)))].map((b) => ALPHABET[b & 63]).join("");

export const REASONS = { waiting: "needs you", stuck: "stuck", failed: "failed", done: "done" };
export const DEDUP_MS = 10 * 60_000; // the same session and reason isn't pushed again within this
export const PER_HOUR = 12; // at most this many pushes an hour, whatever happens
const CONFIG_CHECK_MS = 5000;
// Session names are folder names; still, keep them to plain characters and short
const cleanName = (s) => String(s || "session").replace(/[^\w .@+-]/g, "").trim().slice(0, 40) || "session";

// ntfy: POST the body as plain text to <server>/<topic>, title/priority/tags as headers
export function createNtfy({ server = "https://ntfy.sh", topic, timeoutMs = 5000, fetchFn = globalThis.fetch } = {}) {
  if (!TOPIC_RE.test(String(topic || ""))) throw new Error("ntfy topic must be 1-64 characters of A-Z a-z 0-9 _ -");
  const base = new URL(server);
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("ntfy server must be an http(s) URL");
  const url = `${base.origin}${base.pathname.replace(/\/+$/, "")}/${topic}`;
  return {
    async send({ title = "AXA", body = "", priority = 3, tags = [] } = {}) {
      const headers = { "content-type": "text/plain; charset=utf-8", Title: ascii(title), Priority: String(Math.max(1, Math.min(5, Math.round(priority) || 3))) };
      if (tags.length) headers.Tags = tags.map(ascii).join(",");
      try { const r = await fetchFn(url, { method: "POST", headers, body: String(body).slice(0, 200), signal: AbortSignal.timeout(timeoutMs) }); return r.ok; }
      catch { return false; }
    },
  };
}
const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, "").slice(0, 80);

export const configPath = (home) => join(home, "notify.json");
export function readConfig(home) { try { return JSON.parse(readFileSync(configPath(home), "utf8")) || {}; } catch { return {}; } }
// The configured notifier, or null (not configured, disabled, or invalid)
export function notifierFrom(cfg, opts = {}) {
  const n = cfg?.ntfy;
  if (!n || n.enabled !== true) return null;
  try { return createNtfy({ server: n.server || "https://ntfy.sh", topic: n.topic, ...opts }); } catch { return null; }
}

// What the supervisor calls on a notable change. Deduped per session+reason and rate-limited.
// `notifier` given (tests) or read from $AXA_HOME/notify.json (re-read when the file changes).
export function createPush({ home, notifier, now = Date.now, perHour = PER_HOUR, dedupMs = DEDUP_MS, events = null } = {}) {
  let cfg = {}, mtime = -1, checked = -Infinity, active = notifier || null;
  const sent = new Map(), times = [];
  function current() {
    if (notifier) return { active: notifier, on: events || Object.keys(REASONS) };
    const t = now();
    if (t - checked >= CONFIG_CHECK_MS) {
      checked = t;
      let m = 0;
      try { m = statSync(configPath(home)).mtimeMs; } catch {}
      if (m !== mtime) { mtime = m; cfg = m ? readConfig(home) : {}; active = notifierFrom(cfg); }
    }
    return { active, on: Array.isArray(cfg.ntfy?.on) ? cfg.ntfy.on : events || Object.keys(REASONS) };
  }
  // s: a session summary (name, status, failed_reason); returns whether a push was sent
  async function notify(s) {
    const { active: n, on } = current();
    if (!n || !REASONS[s?.status] || !on.includes(s.status)) return false;
    const reason = s.status === "failed" && s.failed_reason ? `failed: ${cleanName(s.failed_reason)}` : REASONS[s.status];
    const key = `${s.id}\u0000${reason}`, t = now();
    if (t - (sent.get(key) ?? -Infinity) < dedupMs) return false;
    while (times.length && t - times[0] > 3600_000) times.shift();
    if (times.length >= perHour) return false;
    sent.set(key, t); times.push(t);
    for (const [k, at] of sent) if (t - at > dedupMs) sent.delete(k);
    const urgent = s.status !== "done";
    return n.send({ title: "AXA", body: `${cleanName(s.name)}: ${reason}`, priority: urgent ? 4 : 3, tags: [urgent ? "warning" : "white_check_mark"] });
  }
  return { notify };
}

// ---------- command line: init / test ----------
const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const home = process.env.AXA_HOME || join(homedir(), ".axa");
  const [cmd] = process.argv.slice(2);
  if (cmd === "init") {
    if (existsSync(configPath(home))) { console.log(`${configPath(home)} already exists; edit it to change the topic or turn pushes on.`); process.exit(0); }
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const topic = randomTopic();
    writeFileSync(configPath(home), JSON.stringify({ ntfy: { enabled: false, server: "https://ntfy.sh", topic } }, null, 2) + "\n", { mode: 0o600 });
    chmodSync(configPath(home), 0o600);
    console.log(`Wrote ${configPath(home)} (pushes are OFF).\nSubscribe to topic ${topic} in the ntfy app, then set "enabled": true.`);
  } else if (cmd === "test") {
    const n = notifierFrom(readConfig(home));
    if (!n) { console.log(`Pushes are off or not set up (${configPath(home)}).`); process.exit(1); }
    const ok = await n.send({ title: "AXA", body: "test: pushes work", priority: 3, tags: ["white_check_mark"] });
    console.log(ok ? "Sent." : "The ntfy server didn't accept it."); process.exit(ok ? 0 : 1);
  } else console.log("Usage: node console/notify.mjs init|test");
}
