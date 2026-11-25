// Notifications: everything that happens in AXA's sessions, for YOU (the commander's supervisor wakes are
// separate and stay as they are). One stream in the daemon:
//   - session states (from the session list, every supervisor tick): done (its one-line report), waiting
//     (what it wants), failed, limited, exited, stuck, needs trust;
//   - events from the log: milestone review verdicts and fix rounds, a link that fired, the approver
//     declining something.
// Each item: { id, at, kind, session, project, title, body, needsUser }. The last 200 are kept in
// ~/.axa/notifications.jsonl (only the daemon writes it). The same state of the same session again within
// 60 s is dropped. Each new item goes to: the hub (GET /api/notifications, the bell, the commander chat's
// "⚙ notice" lines), the voice (when it's on: the narrator, narrator.mjs) and a desktop notification.
// Settings in ~/.axa/ui.json "notify": { "voice": "all" | "needs-you" | "off" (default needs-you: what
// needs you and finished work), "desktop": "all" | "needs-you" | "off" (default needs-you), "brief_at" }.
// Outward (desktop and voice) is stricter than the hub's list: a test or demo daemon (another AXA home or port)
// never toasts or speaks; a session waiting on a prompt only goes out if it still waits after HOLD_MS (the
// approver usually answers it in that time); at most one desktop toast per session per TOAST_MS, with a count.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { files, home, isWsl, port } from "../paths.mjs";
import { clip, safe } from "./text.mjs";
import { stripSpoken } from "./attention.mjs";

export const KEEP = 200;
export const DEDUPE_MS = 60_000;
const DONE_MS = Number(process.env.AXA_DONE_MS) || 6_000; // a "done" must hold this long (verify-gate bounce)
export const file = () => join(home, "notifications.jsonl");
export const HOLD_MS = 15_000, TOAST_MS = 2 * 60_000;

// Only the real daemon (the default AXA home, port 4747) may show desktop toasts or speak: a test or demo daemon
// (temp AXA_HOME, another port) has fake sessions. AXA_NOTIFY_TEST=1 lets one through on purpose.
export const outwardAllowed = ({ env = process.env, axaHome = home, axaPort = port, userHome = homedir() } = {}) =>
  env.AXA_NOTIFY_TEST === "1" || (axaHome === join(userHome, ".axa") && Number(axaPort) === 4747);

// Desktop toasts: at most one per session per TOAST_MS; the next one says how many it stands for
export function createToastGate({ now = () => Date.now(), every = TOAST_MS } = {}) {
  const last = new Map(); // session -> { at, skipped }
  return (n) => {
    const k = n.session || `${n.kind}:${n.project}`, t = now(), l = last.get(k);
    if (l && t - l.at < every) { l.skipped++; return null; }
    last.set(k, { at: t, skipped: 0 });
    return l?.skipped ? { title: `${n.title} (${l.skipped + 1}×)`, body: n.body } : { title: n.title, body: n.body };
  };
}

// ---------- settings ----------
const LEVELS = ["all", "needs-you", "off"];
export function notifySettings(cfg) {
  if (cfg === undefined) { try { cfg = JSON.parse(readFileSync(files.ui, "utf8")); } catch { cfg = {}; } }
  const n = cfg?.notify && typeof cfg.notify === "object" ? cfg.notify : {};
  return {
    voice: LEVELS.includes(n.voice) ? n.voice : "needs-you",
    desktop: LEVELS.includes(n.desktop) ? n.desktop : "needs-you",
    brief_at: typeof n.brief_at === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(n.brief_at) ? n.brief_at : null,
    // interruptions (attention.mjs): live (default) | digest | quiet, and the digest's period in minutes
    mode: ["live", "digest", "quiet"].includes(n.mode) ? n.mode : "live",
    digestMin: Number.isInteger(n.digestMin) && n.digestMin >= 1 && n.digestMin <= 240 ? n.digestMin : 15,
  };
}
// `axa notify live|digest|quiet`: ui.json's notify.mode, read-modify-write (every other setting kept; a file that
// isn't valid JSON is never overwritten)
export function writeNotifyMode(f, mode) {
  if (!["live", "digest", "quiet"].includes(mode)) throw new Error(`isn't a mode: use live, digest or quiet`);
  let cfg = {};
  if (existsSync(f)) {
    const raw = readFileSync(f, "utf8");
    try { cfg = raw.trim() ? JSON.parse(raw) : {}; } catch (e) { throw new Error(`${f} isn't valid JSON (${e.message}); not touching it`); }
  }
  cfg.notify = { ...(cfg.notify && typeof cfg.notify === "object" ? cfg.notify : {}), mode };
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, f);
  return cfg;
}
// What a level lets through. "needs-you" for the voice also says finished work ("feed finished: ...").
export const voiceWants = (level, n) => level === "all" || (level === "needs-you" && (n.needsUser || n.kind === "done" || n.kind === "brief"));
export const desktopWants = (level, n) => level === "all" || (level === "needs-you" && n.needsUser);

// ---------- what a session's status means for you ----------
const one = (t, n = 200) => clip(safe(String(t || "").replace(/\s+/g, " ").trim()), n);
// (the agent's own spoken line, "🔊 ...", is for the voice: never shown in a notification)
const firstLine = (t) => one(stripSpoken(String(t || "")).split(/\n\s*\n/)[0], 200);
export const projectOf = (s) => basename(s.worktree?.repo || s.cwd || "") || s.name;
export function fromStatus(s) {
  const name = s.mode === "axa" ? "AXA" : one(s.name, 40);
  const base = { session: s.id, project: s.mode === "axa" ? "axa" : projectOf(s) };
  switch (s.status) {
    case "done": return s.mode === "axa" ? null : { ...base, kind: "done", title: `${name} finished`, body: firstLine(s.last_report) || "its turn is done", needsUser: false };
    case "waiting": return { ...base, kind: "waiting", title: `${name} needs you`, body: one(s.choices?.question?.split("\n").filter(Boolean).pop() || s.doing || "a prompt is waiting for your answer"), needsUser: true };
    case "needs_trust": return { ...base, kind: "needs_trust", title: `${name} needs trust`, body: s.hint || "answer its folder-trust prompt (or run axa trust <project>)", needsUser: true };
    case "failed": return { ...base, kind: "failed", title: `${name} failed`, body: one(s.error) || "its turn ended on an API error", needsUser: true };
    case "limited": return { ...base, kind: "limited", title: `${name} hit a usage limit`, body: s.limit_resets ? `it resets ${one(s.limit_resets, 60)}` : "it can't work until the limit resets", needsUser: true };
    case "exited": return { ...base, kind: "exited", title: `${name} exited`, body: "Claude Code ended in that session", needsUser: false };
    case "stuck": return { ...base, kind: "stuck", title: `${name} looks stuck`, body: `no activity for ${s.stuck_minutes ?? "?"} min${s.doing ? ` · ${one(s.doing, 120)}` : ""}`, needsUser: true };
  }
  return null;
}
// ...and what an event from the log means (null: nothing for you)
export function fromEvent(e) {
  if (!e?.event) return null;
  // a review's final verdict comes from fromMilestone (when it ends); its fix rounds come from the log
  if (e.event === "MilestoneReview") {
    const text = one(String(e.summary || "").replace(/^milestone review /, ""), 240);
    const repo = /^([^:]+):/.exec(text)?.[1] || "milestone";
    if (!e.verdict && /fix round/.test(text)) return { kind: "fixer", session: e.terminal && e.terminal !== "milestone" ? e.terminal : null, project: repo, title: `review of ${repo}: fixer`, body: text.replace(/^[^:]+:\s*/, ""), needsUser: false };
    return null;
  }
  if (e.event === "ChainFired") return { kind: "link", session: e.terminal || null, project: one(e.to, 40), title: `link fired: ${one(e.from, 40)} → ${one(e.to, 40)}`, body: one(e.text, 200), needsUser: false };
  // the approver's circuit breaker: it stopped deciding for that session (needs you)
  if (e.event === "AxaDecision" && e.by === "breaker") return { kind: "breaker", session: e.terminal || null, project: e.cwd ? basename(e.cwd) : "", title: `AXA stopped deciding${e.cwd ? ` in ${basename(e.cwd)}` : ""}`, body: one(`${e.reason || ""} · ${e.tool || "a tool"}${e.summary ? ` ${e.summary}` : ""}`, 240), needsUser: true };
  if (e.event === "AxaDecision" && e.decision === "deny") return { kind: "declined", session: e.terminal || null, project: e.cwd ? basename(e.cwd) : "", title: `AXA declined a step${e.cwd ? ` in ${basename(e.cwd)}` : ""}`, body: one(`${e.tool || "a tool"}${e.summary ? ` ${e.summary}` : ""} · ${e.reason || ""}`, 240), needsUser: false };
  return null;
}

// A finished milestone review, from the line the commander gets ("milestone review feed: ✓ approve · …")
export function fromMilestone(line) {
  const text = one(line, 300).replace(/^milestone review /, "");
  const repo = /^([^:]+):/.exec(text)?.[1] || "milestone", rest = text.replace(/^[^:]+:\s*/, "");
  const verdict = /\b(approve|warn|block|error)\b/.exec(rest)?.[1] || "ended";
  return { kind: "milestone", session: null, project: repo, title: `review of ${repo}: ${verdict}`, body: rest, needsUser: verdict !== "approve" };
}

// ---------- the stream (deps injected: tests run it without a daemon) ----------
// save: the hub's list (at once); deliver: outward (desktop, voice). A "waiting" (a prompt) is held HOLD_MS before
// it goes out, and dropped if the approver decided it or the session moved on meanwhile.
export function createNotifier({ now = () => Date.now(), load = () => [], save = () => {}, deliver = () => {}, hold = HOLD_MS } = {}) {
  let items = load().slice(-KEEP);
  const last = new Map(); // dedupe key -> at
  const since = new Map(); // session -> { status, at, told }
  const held = new Map(); // session -> { item, due, at (when that state began) }
  let primed = false;
  function push(n) {
    if (!n) return null;
    const at = now();
    const key = `${n.kind}:${n.session || n.project}:${n.kind === "done" || n.session ? "" : n.title}`;
    if (at - (last.get(key) ?? -Infinity) < DEDUPE_MS) return null;
    last.set(key, at);
    const item = { id: randomBytes(5).toString("hex"), at, kind: n.kind, session: n.session ?? null, project: n.project || "", title: n.title, body: n.body || "", needsUser: !!n.needsUser };
    items.push(item);
    if (items.length > KEEP) items = items.slice(-KEEP);
    try { save(item, items); } catch {}
    if (item.kind === "waiting" && item.session && hold > 0) held.set(item.session, { item, due: at + hold, at: since.get(item.session)?.at });
    else try { deliver(item); } catch {}
    return item;
  }
  // held prompts: out once they've waited long enough, gone if the session isn't waiting on that prompt any more
  function release(list) {
    const t = now();
    for (const [id, h] of held) {
      const s = list?.find((x) => x.id === id), c = since.get(id);
      if (list && (!s || s.status !== "waiting" || (h.at !== undefined && c?.at !== h.at))) { held.delete(id); continue; }
      if (t >= h.due) { held.delete(id); try { deliver(h.item); } catch {} }
    }
  }
  // the session list, every tick: a state change into one that matters (a "done" once it has held)
  function tick(list) {
    const t = now();
    for (const s of list) {
      if (s.mode === "shell") continue;
      const c = since.get(s.id);
      if (!c || c.status !== s.status) since.set(s.id, { status: s.status, at: t, told: !primed || !c });
      const cur = since.get(s.id);
      if (cur.told) continue;
      if (s.status === "done" && t - cur.at < DONE_MS) continue;
      cur.told = true;
      push(fromStatus(s));
    }
    for (const id of since.keys()) if (!list.some((s) => s.id === id)) since.delete(id);
    primed = true;
    release(list);
  }
  // the approver answered (allowed or declined) a session's prompt: what was held for it never goes out
  function event(e) {
    if (e?.event === "AxaDecision" && e.terminal && e.by !== "breaker") held.delete(e.terminal);
    return push(fromEvent(e));
  }
  return { push, tick, event, held: () => [...held.keys()], list: () => [...items], clear: () => { items = []; try { save(null, items); } catch {} } };
}

// ---------- desktop notifications: the command for each OS (pure: unit-tested, never run in tests) ----------
const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");
// Windows (and WSL): a toast through the built-in Windows.UI.Notifications API (PowerShell's app id), a tray
// balloon if that fails. The text goes in as base64, so nothing in it is ever PowerShell code.
export function winToastScript(title, body) {
  return [
    `$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(title)}'))`,
    `$b = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(body)}'))`,
    "try {",
    "  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "  $x = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "  $x.LoadXml(\"<toast><visual><binding template='ToastGeneric'><text>$([Security.SecurityElement]::Escape($t))</text><text>$([Security.SecurityElement]::Escape($b))</text></binding></visual></toast>\")",
    "  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
    "} catch {",
    "  Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    "  $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true",
    "  $n.ShowBalloonTip(8000, $t, $b, [System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Seconds 9; $n.Dispose()",
    "}",
  ].join("\n");
}
// os: { platform, wsl, has(cmd) }. Returns [cmd, args] or null (nothing to show it with).
export function desktopCommand({ platform, wsl, has }, title, body) {
  const t = clip(String(title || "AXA"), 120), b = clip(String(body || ""), 300);
  if (platform === "darwin") return ["osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title \"AXA\" subtitle (item 1 of argv)", "-e", "end run", t, b]];
  if (platform === "win32") return ["powershell", ["-NoProfile", "-NonInteractive", "-Command", winToastScript(t, b)]];
  if (wsl && has("powershell.exe")) return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", winToastScript(t, b)]];
  if (has("notify-send")) return ["notify-send", ["-a", "AXA", "--", t, b]];
  return null;
}

// ---------- the daemon's notifier: file, voice, desktop ----------
const has = (c) => spawnSync("which", [c], { stdio: "ignore" }).status === 0;
const failed = new Set(); // what's been logged once
const logOnce = (k, m) => { if (failed.has(k)) return; failed.add(k); console.log(`[${new Date().toISOString()}] notify: ${m}`); };
export function showDesktop(title, body, os = { platform: process.platform, wsl: process.platform === "linux" && isWsl(), has }) {
  if (!outwardAllowed()) return;
  let c;
  try { c = desktopCommand(os, title, body); } catch (e) { return logOnce("cmd", e.message); }
  if (!c) return logOnce("none", "no way to show desktop notifications here (install notify-send)");
  try {
    const p = spawn(c[0], c[1], { stdio: "ignore", detached: true });
    const kill = setTimeout(() => { try { p.kill(); } catch {} }, 30_000);
    p.on("error", (e) => { clearTimeout(kill); logOnce(c[0], `${c[0]} failed: ${e.message}`); });
    p.on("close", (code) => { clearTimeout(kill); if (code) logOnce(`${c[0]}:${code}`, `${c[0]} exited with ${code}`); });
    p.unref();
  } catch (e) { logOnce(c[0], `${c[0]} failed: ${e.message}`); }
}

function loadFile() {
  try { return readFileSync(file(), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
let lines = 0;
function saveFile(item, all) {
  // append; past 2 × KEEP lines, rewrite with the last KEEP (through a temp file)
  if (item && existsSync(file()) && lines < 2 * KEEP) { appendFileSync(file(), JSON.stringify(item) + "\n", { mode: 0o600 }); lines++; return; }
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, all.map((x) => JSON.stringify(x)).join("\n") + (all.length ? "\n" : ""), { mode: 0o600 });
  renameSync(tmp, file());
  lines = all.length;
}

// voice: set by the daemon (server.mjs) to { on(), add(item) }: the narrator (narrator.mjs) decides what is
// said and when (priorities, coalescing, stale items dropped, bursts merged into one line)
export const voiceHooks = { on: () => false, add: () => {} };
const toastGate = createToastGate();
export const notifier = createNotifier({
  load: () => { const l = loadFile(); lines = l.length; return l; },
  save: saveFile,
  deliver: (n) => {
    if (!outwardAllowed()) return;
    const st = notifySettings();
    if (voiceHooks.on() && voiceWants(st.voice, n)) voiceHooks.add(n);
    // (never from a test run: `node --test` sets NODE_TEST_CONTEXT in every test process)
    if (desktopWants(st.desktop, n) && !process.env.NODE_TEST_CONTEXT) { const t = toastGate(n); if (t) showDesktop(t.title, t.body); }
  },
});
