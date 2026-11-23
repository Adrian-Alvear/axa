// Sessions: each Claude Code (or shell) session AXA runs lives in its own tmux session on AXA's private
// socket (tmux -L axa-<port>; your own tmux is untouched). They keep running when the daemon or the UI
// stops. The daemon attaches one tmux client per session (in a PTY) to stream it to the web console,
// reads screens with capture-pane and types with send-keys. The terminal UI attaches its own clients.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dangerousShell } from "../../lib/safety.mjs";
import { expand, files, home, inHome, pluginRoot } from "../paths.mjs";
import { SOCKET, TMUX_CONF, tmuxEnv } from "./tmux-client.mjs";
import { safe } from "./text.mjs";
import { gitInfo, diffOf, makeWorktree, removeWorktree } from "./git.mjs";
import { fixerOf, reviewOf } from "./reviewer.mjs";
import { CHAT_ID, usageOf } from "./claude-data.mjs";
import { parseChoices, promptOnScreen, trustOnScreen } from "./screen.mjs";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

// node-pty's prebuilt spawn-helper sometimes ships without the execute bit ("posix_spawnp failed")
try {
  const prebuilds = join(dirname(require.resolve("node-pty/package.json")), "prebuilds");
  for (const arch of readdirSync(prebuilds)) { const h = join(prebuilds, arch, "spawn-helper"); if (existsSync(h)) chmodSync(h, 0o755); }
} catch {}

// ---------- tmux ----------
const tmux = (...args) => spawnSync("tmux", ["-L", SOCKET, "-f", TMUX_CONF, ...args], { encoding: "utf8", env: tmuxEnv(), timeout: 5000 });
// 3.2 -> 3.02 so versions compare as numbers; null when tmux isn't installed
const tmuxVersion = (() => {
  try {
    const m = spawnSync("tmux", ["-V"], { encoding: "utf8", timeout: 3000 }).stdout?.match(/(\d+)\.(\d+)/);
    return m ? Number(m[1]) + Number(m[2]) / 100 : null;
  } catch { return null; }
})();
export const hasTmux = !!tmuxVersion;
export const tmuxName = (id) => `axa-${id}`;
const pane = (id) => `=axa-${id}:`;
const tmuxHas = (id) => tmux("has-session", "-t", `=${tmuxName(id)}`).status === 0;

// ---------- what each session is: $AXA_HOME/sessions.json (so a restart shows it again, or resumes its chat) ----------
const meta = new Map(); // id -> { id, name, cwd, mode, created, resume, claudeSession, recovered, worktree }
try { for (const m of JSON.parse(readFileSync(files.sessions, "utf8"))) if (m?.id) meta.set(String(m.id), m); } catch {}
function saveMeta() {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const tmp = `${files.sessions}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...meta.values()], null, 2), { mode: 0o600 });
    renameSync(tmp, files.sessions);
  } catch {}
}
// The daemon learns from the hook events which Claude chat each session runs
export function noteChat(id, chat) {
  const m = meta.get(id);
  if (!m || !CHAT_ID.test(String(chat)) || m.claudeSession === chat) return;
  m.claudeSession = chat;
  saveMeta();
}

// Live status per session comes from its traced events (set by the server)
let traced = () => null;
export const setStatusSource = (fn) => (traced = fn);

const SCROLLBACK = 256 * 1024;
const terms = new Map(); // id -> { id, name, cwd, mode, proc, buf, alive, created, lastOutput, lastInput, sockets, capture, width }

// ---------- screen ----------
function screenLines(t, n = 60) {
  n = Math.max(1, Math.min(n, 400));
  // -J rejoins wrapped lines (so a long secret split across rows is still recognized). Briefly cached.
  const c = t.capture;
  if (!(c && Date.now() - c.at < 500 && c.n >= n) && t.alive) {
    const r = tmux("capture-pane", "-p", "-J", "-t", pane(t.id), "-S", `-${n}`);
    if (r.status === 0) t.capture = { at: Date.now(), n, lines: r.stdout.split("\n").map((l) => l.trimEnd()) };
  }
  const out = [...(t.capture?.lines || [])];
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.slice(-n);
}
const paneWidth = (t) => {
  if (!(t.width && Date.now() - t.width.at < 2000)) t.width = { at: Date.now(), n: Number(tmux("display-message", "-p", "-t", pane(t.id), "#{pane_width}").stdout) || 100 };
  return t.width.n;
};
const promptOpen = (t) => promptOnScreen(screenLines(t, 40));
// What runs in the pane now (tmux #{pane_current_command}). Claude sessions run `claude ...; exec $SHELL`,
// so once Claude has exited a shell is left, and typed English would run as shell commands.
const paneCommand = (t, fresh = false) => {
  if (fresh || !(t.cmd && Date.now() - t.cmd.at < 1000)) t.cmd = { at: Date.now(), name: (tmux("display-message", "-p", "-t", pane(t.id), "#{pane_current_command}").stdout || "").trim() };
  return t.cmd.name;
};
const SHELL_NAMES = new Set(["bash", "zsh", "sh", "dash", "ksh", "mksh", "fish", "tcsh", "csh", "nu", "xonsh"]);
export const claudeGone = (cmd, shell = process.env.SHELL) => !!cmd && (SHELL_NAMES.has(cmd.replace(/^-/, "")) || cmd === basename(shell || "/bin/bash"));
function choicesOf(t) {
  const c = parseChoices(screenLines(t, 40), paneWidth(t));
  return c && { ...c, question: safe(c.question), options: c.options.map((o) => ({ ...o, label: safe(o.label) })) };
}

// ---------- the summary every client sees ----------
export const TRUST_HINT = "the user must answer the trust prompt (or run axa trust <project>)";
// A session's status from what's known about it (pure, for tests). tr: its traced status; trust: the
// folder-trust dialog is on screen; prompt: any choice dialog is; restored: it was already running when
// the daemon started (its SessionStart may be older than the replayed history).
export function deriveStatus({ alive, mode, tr, trust, prompt, restored, gone }) {
  if (!alive) return "exited";
  // Claude Code ended (SessionEnd), or a started session's pane is back to its shell (no SessionEnd)
  if (mode !== "shell" && (tr?.status === "exited" || gone)) return "exited";
  if (mode !== "shell" && trust) return "needs_trust";
  // While AXA's approver is deciding, the prompt is already on screen: not your turn yet
  if (tr?.status === "waiting" || (!tr?.asking && prompt)) return "waiting";
  return tr?.status || (mode === "shell" || restored ? "ready" : "starting");
}
// Why typing into this session now is refused (null: it may be typed into). Text typed while Claude
// Code starts can land in the trust or MCP dialog and answer it, so nothing is typed before the
// session's first SessionStart, nor while it's starting or waits on the trust prompt.
const CLAUDE_EXITED = "Not sent: Claude has exited in this session (only a shell is left there, which would run the text as commands). Nothing was typed; open a new session or ask the user.";
export function inputRefusal(s) {
  if (!s.alive) return "the session has exited";
  if (s.mode !== "shell" && s.status === "exited") return CLAUDE_EXITED;
  if (s.status === "needs_trust") return `Not sent: this session is waiting on the folder-trust prompt; ${TRUST_HINT}. Nothing was typed.`;
  if (s.mode !== "shell" && (s.status === "starting" || !s.started)) return "Not sent: this session is still starting (Claude Code hasn't reported its start yet). Nothing was typed; try again when it's ready (open_session with wait: true returns then).";
  return null;
}
function summary(t) {
  const tr = traced(t.id) || null;
  const lines = t.alive && t.mode !== "shell" ? screenLines(t, 40) : [];
  const started = t.mode === "shell" || !!tr?.started || !!t.restored;
  // (before it has started, the pane runs the shell that launches Claude: that isn't an exit)
  const gone = t.alive && t.mode !== "shell" && started && claudeGone(paneCommand(t));
  const status = deriveStatus({ alive: t.alive, mode: t.mode, tr, trust: lines.length > 0 && trustOnScreen(lines), prompt: t.alive && promptOpen(t), restored: t.restored, gone });
  const waiting = status === "waiting" || status === "needs_trust";
  const m = meta.get(t.id) || {};
  return {
    id: t.id, name: t.name, cwd: t.cwd, mode: t.mode, alive: t.alive, created: t.created,
    status,
    hint: status === "needs_trust" ? TRUST_HINT : undefined,
    started,
    limit_resets: status === "limited" ? safe(tr?.limit_resets) : undefined,
    stuck_minutes: tr?.stuck_minutes,
    doing: safe(tr?.doing), tool: tr?.tool, skill: tr?.skill,
    last_report: safe(tr?.report), error: safe(tr?.error), last_event_at: tr?.at,
    idle_seconds: Math.round((Date.now() - t.lastOutput) / 1000),
    awaiting_permission: waiting,
    git: t.alive && t.mode !== "axa" ? gitInfo(t.cwd) : null,
    usage: t.mode === "shell" ? null : usageOf(m.claudeSession, t.cwd, t.alive),
    choices: waiting ? choicesOf(t) : undefined,
    chat: m.claudeSession || m.resume || null,
    helpers: tr?.helpers || [],
    worktree: m.worktree,
    recovered: !!t.recovered,
    review: t.mode === "claude" ? reviewOf(t.id) : null, // the independent reviewer's latest verdict
    fixer: fixerOf(t.id) || undefined, // the milestone review (id) this session fixes findings for
  };
}
export const listSessions = () => [...terms.values()].map(summary);
// Resolves once a session is ready, waiting on something (a prompt, the trust dialog) or gone, or after
// timeoutMs, with its summary and timed_out (open_session / POST /api/terms with wait)
export const settled = (s) => !s.alive || ["needs_trust", "waiting"].includes(s.status) || (s.status !== "starting" && s.started);
export async function waitReady(id, { timeoutMs = 60_000, every = 500 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = getSession(id);
    if (!s) return { id, alive: false, status: "exited", timed_out: false };
    if (settled(s)) return { ...s, timed_out: false };
    if (Date.now() >= end) return { ...s, timed_out: true };
    await new Promise((r) => setTimeout(r, every));
  }
}
export const getSession = (id) => (terms.has(id) ? summary(terms.get(id)) : null);
export const lastInputAt = (id) => terms.get(id)?.lastInput || 0;

export function readScreen(id, lines = 60) {
  const t = terms.get(id);
  return t ? { ...summary(t), screen: safe(screenLines(t, lines).join("\n")) } : null;
}
export async function diffSession(id) {
  const t = terms.get(id);
  return t ? { ...summary(t), ...(await diffOf(t.cwd)) } : null;
}

// ---------- typing ----------
function typeText(t, text) {
  if (!text) return;
  // tmux reads a lone ";" (or a trailing "\;") as a command separator: send those as hex bytes
  if (text === ";" || text.endsWith("\\;")) tmux("send-keys", "-t", pane(t.id), "-H", ...[...Buffer.from(text)].map((b) => b.toString(16)));
  else tmux("send-keys", "-t", pane(t.id), "-l", "--", text);
  t.capture = null;
}
// What may be typed into a Claude session (send_to_session, links, the supervisor). A leading "!" is
// Claude Code's bash mode, which runs the command without any hook (so outside AXA's policy): only
// with the user's explicit OK. Slash commands: only these few. Control characters (escape sequences,
// Tab, Ctrl keys) are stripped; newlines stay. Returns { text } (cleaned) or { error }.
export const SLASH_OK = ["goal", "compact", "clear", "context", "cost"];
export function typedText(text, { confirmed = false } = {}) {
  const clean = String(text ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
  const head = clean.trimStart();
  if (!head) return { error: "Not sent: nothing to type." };
  if (head.startsWith("!") && !confirmed) return { error: "Not sent: text starting with \"!\" runs as a shell command in Claude Code's bash mode, outside AXA's checks. Ask the user to approve this exact command, then resend with confirmed_by_user: true." };
  const slash = /^\/(\S*)/.exec(head);
  if (slash && !SLASH_OK.includes(slash[1])) return { error: `Not sent: only these slash commands may be typed into a session: ${SLASH_OK.map((c) => "/" + c).join(", ")} (got /${slash[1].slice(0, 40)}). For anything else, start the text with words.` };
  return { text: clean };
}
// confirmed: you explicitly approved this exact command (needed for dangerous shell commands, and a
// leading "!" in a Claude session)
export async function sendText(id, text, { enter = true, confirmed = false } = {}) {
  const t = terms.get(id);
  if (!t) return { ok: false, error: "no such session" };
  t.capture = null; // judge from a fresh screen
  const s = summary(t);
  const refused = inputRefusal(s);
  if (refused) return { ok: false, error: refused };
  // Claude gone, its shell left (no SessionEnd seen): checked right before typing
  if (t.mode !== "shell" && claudeGone(paneCommand(t, true))) return { ok: false, error: CLAUDE_EXITED };
  if (t.mode !== "shell") {
    const r = typedText(text, { confirmed });
    if (r.error) return { ok: false, error: r.error };
    text = r.text;
  }
  // Shells run whatever is typed, so dangerous commands need your explicit OK (Claude has its own checks)
  const danger = t.mode === "shell" && dangerousShell(text);
  if (danger && !confirmed) return { ok: false, error: `Not sent: this looks dangerous (${danger}). Ask the user to approve this exact command first, then resend with confirmed_by_user: true.` };
  if (promptOpen(t) || traced(t.id)?.status === "waiting") return { ok: false, error: "This session is waiting on a permission/trust prompt. Only the user may answer it: tell them which session needs attention." };
  const since = Date.now();
  typeText(t, text);
  if (!enter) return { ok: true };
  // submit separately so TUIs treat it as Enter, not part of a paste
  const pressEnter = () => { tmux("send-keys", "-t", pane(t.id), "Enter"); t.capture = null; };
  await sleep(60);
  pressEnter();
  // A Claude session confirms with its UserPromptSubmit event. Not checked: shells (no events), a busy
  // session (the text is queued for its next turn) and built-in slash commands (/clear, /cost... send
  // no prompt; /goal does start a turn, so any event of the session counts for it)
  if (t.mode === "shell" || s.status === "working" || (/^\//.test(text.trim()) && !/^\/goal\b/.test(text.trim()))) return { ok: true };
  const anyEvent = /^\/goal\b/.test(text.trim());
  return confirmSubmit({
    seen: () => { const tr = traced(t.id); return !!tr && ((tr.promptAt || 0) >= since || (anyEvent && (tr.at || 0) >= since)); },
    pressEnter, promptOpen: () => { t.capture = null; return promptOpen(t); },
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const SUBMIT_MS = Number(process.env.AXA_SUBMIT_MS) || 5000;
// Wait up to ms for the submit to be seen; if not, press Enter once more (unless a dialog opened: then
// Enter would answer it) and wait again. Unconfirmed: an error, and callers (links, the supervisor)
// don't count it as sent. (exported for tests)
export async function confirmSubmit({ seen, pressEnter, promptOpen, ms = SUBMIT_MS, every = 100 }) {
  const waitSeen = async () => { const end = Date.now() + ms; for (;;) { if (seen()) return true; if (Date.now() >= end) return false; await sleep(every); } };
  if (await waitSeen()) return { ok: true, submitted: true };
  if (promptOpen()) return { ok: false, unsubmitted: true, error: "Typed, but a prompt opened before it was submitted: only the user may answer it. The text may still be in the session's input box." };
  pressEnter();
  if (await waitSeen()) return { ok: true, submitted: true, retried: true };
  return { ok: false, unsubmitted: true, error: `Typed, but Claude Code didn't confirm the submit (no UserPromptSubmit within ${Math.round((2 * ms) / 1000)} s, Enter pressed twice). The text may still be in the session's input box: check it with read_session before sending again.` };
}
// You picked option n (and saw `label`): move the menu cursor there and press Enter, only if the same
// menu is still on screen, so an answer never lands on a different prompt
export function answer(id, n, label) {
  const t = terms.get(id);
  if (!t || !t.alive) return { ok: false, error: "That session isn't running." };
  t.capture = null;
  const c = promptOpen(t) && choicesOf(t);
  if (!c) return { ok: false, error: "That prompt is no longer on screen." };
  const o = c.options.find((x) => x.n === Number(n));
  if (!o || o.label !== label) return { ok: false, error: "The prompt changed. Look again before answering." };
  const moves = o.n - 1 - c.cursor;
  tmux("send-keys", "-t", pane(t.id), ...Array(Math.abs(moves)).fill(moves > 0 ? "Down" : "Up"), "Enter");
  t.capture = null;
  return { ok: true, option: o, question: c.question };
}
// Someone typed into the session from a UI (the supervisor waits until you stop)
export function noteInput(id) { const t = terms.get(id); if (t) t.lastInput = Date.now(); }

// ---------- starting sessions ----------
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
// Every Claude session AXA starts loads the AXA plugin so its hooks trace it. Project sessions run in
// accept-edits mode under AXA's permission policy; the commander gets AXA's prompt and session tools.
const claudeCmd = (role) =>
  role === "commander"
    ? `claude --plugin-dir ${shq(pluginRoot)} --append-system-prompt-file ${shq(join(pluginRoot, "commander.md"))}`
    : `claude --plugin-dir ${shq(pluginRoot)} --permission-mode acceptEdits`;
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
// The commander's own folder (the daemon creates it; it may write AXA's home)
export const commanderDir = () => { const d = join(home, "commander"); try { mkdirSync(d, { recursive: true, mode: 0o700 }); } catch {} return d; };

// mode: claude | axa (the commander) | shell. resume: a chat id to continue. worktree: true or a name.
export function createSession({ cwd, mode = "claude", cols = 100, rows = 30, resume, worktree, name }) {
  if (!hasTmux) throw new Error("AXA needs tmux: install it (sudo apt install tmux / brew install tmux) and try again");
  if (!["claude", "axa", "shell"].includes(mode)) throw new Error("mode must be claude, axa or shell");
  if (resume !== undefined && resume !== null && !CHAT_ID.test(String(resume))) throw new Error("not a chat id");
  // A new commander runs in its own folder in AXA's home: Claude Code never saves trust for the home
  // folder itself, so a commander there would ask again every time. (Resuming a chat keeps its folder.)
  const cmdDir = mode === "axa" && !resume ? commanderDir() : null;
  let dir = cmdDir || expand(cwd || homedir());
  if (!(cmdDir || inHome(dir)) || !isDir(dir)) throw new Error("cwd must be an existing folder in your home folder");
  let wt = null;
  if (worktree && mode !== "axa") { wt = makeWorktree(dir, worktree); dir = wt.path; }
  const id = randomUUID().slice(0, 8);
  const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : wt?.name;
  return summary(launch({ id, cwd: dir, mode, cols, rows, resume: resume || null, created: Date.now(), name: label, worktree: wt ? { repo: wt.repo, path: wt.path, branch: wt.branch } : undefined }));
}

function launch({ id, cwd, mode, cols, rows, resume, created, recovered = false, name, worktree }) {
  const shell = process.env.SHELL || "/bin/bash";
  const resumeArg = resume ? ` --resume ${resume}` : "";
  // claude/axa: run Claude Code (traced), and drop to a normal shell if it exits
  const args = mode === "shell" ? ["-l"] : ["-l", "-c", `${claudeCmd(mode === "axa" ? "commander" : "worker")}${resumeArg}; exec "$SHELL" -l`];
  // AXA_TERMINAL_ID tags this session's hook events so the daemon knows its status
  const tag = { AXA_TERMINAL_ID: id, AXA_ROLE: mode === "axa" ? "commander" : "worker" };
  const withEnv = tmuxVersion >= 3.02; // tmux 3.2+ sets the session's env with -e; older ones get it through `env`
  // `env -u TMUX`: a session must not be able to reach AXA's tmux (and type into other sessions)
  const cmd = "exec " + ["env", "-u", "TMUX", "-u", "TMUX_PANE", ...(withEnv ? [] : Object.entries(tag).map(([k, v]) => `${k}=${v}`)), shell, ...args].map(shq).join(" ");
  const envArgs = withEnv ? Object.entries(tag).flatMap(([k, v]) => ["-e", `${k}=${v}`]) : [];
  const r = tmux("new-session", "-d", "-s", tmuxName(id), "-c", cwd, "-x", String(cols), "-y", String(rows), ...envArgs, cmd);
  if (r.status !== 0) throw new Error(`couldn't start the session in tmux: ${(r.stderr || r.error?.message || "").trim()}`);
  const t = { id, name: mode === "axa" ? "AXA" : name || meta.get(id)?.name || (cwd === homedir() ? "home" : basename(cwd)), cwd, mode, buf: "", alive: true, created, lastOutput: Date.now(), sockets: new Set(), recovered };
  meta.set(id, { ...meta.get(id), id, name: t.name, cwd, mode, created, resume, recovered, ...(worktree ? { worktree } : {}) });
  saveMeta();
  attachStream(t, cols, rows);
  terms.set(id, t);
  return t;
}

// The daemon's own view of a session (for the web console): a tmux client in a PTY. Only this client
// ends with the daemon; the session keeps running.
function attachStream(t, cols, rows) {
  const proc = pty.spawn("tmux", ["-L", SOCKET, "-f", TMUX_CONF, "attach-session", "-t", `=${tmuxName(t.id)}`], { name: "xterm-256color", cols, rows, cwd: homedir(), env: tmuxEnv() });
  t.proc = proc;
  proc.onData((d) => {
    t.buf = (t.buf + d).slice(-SCROLLBACK);
    t.lastOutput = Date.now();
    for (const ws of t.sockets) ws.send(d);
  });
  proc.onExit(({ exitCode }) => {
    if (t.closing) return;
    t.alive = false;
    // its program exited and the tmux session is gone: forget it, so a restart doesn't bring it back
    if (!tmuxHas(t.id)) { meta.delete(t.id); saveMeta(); }
    for (const ws of t.sockets) ws.send(`\r\n\x1b[2m[process exited ${exitCode}]\x1b[0m\r\n`);
  });
}

// On daemon start: show the tmux sessions still running. If the tmux server itself is gone (the machine
// restarted), Claude sessions are relaunched resuming their chat; shells are dropped.
export function restoreSessions() {
  if (!hasTmux) return [];
  const r = tmux("list-sessions", "-F", "#{session_name}\t#{session_path}\t#{window_width}\t#{window_height}\t#{session_created}");
  const serverUp = r.status === 0; // tmux.conf keeps the server up when empty, so "no server" means a restart
  const live = new Map();
  if (serverUp) for (const line of r.stdout.split("\n")) {
    const [nm, path, w, h, made] = line.split("\t");
    const m = nm?.match(/^axa-([\w-]+)$/);
    if (m) live.set(m[1], { path: path || homedir(), cols: Number(w) || 100, rows: Number(h) || 30, created: Number(made) * 1000 || Date.now() });
  }
  const restored = [];
  for (const [id, s] of live) {
    if (terms.has(id)) continue;
    if (!meta.has(id)) meta.set(id, { id, name: basename(s.path), cwd: s.path, mode: "shell", created: s.created, resume: null });
    const m = meta.get(id);
    m.recovered = false;
    // (already running: its start may be older than the history the daemon replayed)
    const t = { id, name: m.name, cwd: m.cwd, mode: m.mode, buf: "", alive: true, created: m.created, lastOutput: Date.now(), sockets: new Set(), recovered: false, restored: true };
    attachStream(t, s.cols, s.rows);
    terms.set(id, t);
    restored.push(id);
  }
  for (const m of [...meta.values()]) {
    if (live.has(m.id) || terms.has(m.id)) continue;
    const chat = [m.claudeSession, m.resume].find((c) => CHAT_ID.test(String(c)));
    if (!serverUp && m.mode !== "shell" && chat && inHome(m.cwd) && isDir(m.cwd)) {
      try { launch({ id: m.id, cwd: m.cwd, mode: m.mode, cols: 100, rows: 30, resume: chat, created: m.created || Date.now(), recovered: true, name: m.name, worktree: m.worktree }); restored.push(m.id); continue; } catch {}
    }
    meta.delete(m.id);
  }
  saveMeta();
  return restored;
}

export function renameSession(id, name) {
  const t = terms.get(id), m = meta.get(id);
  if (!t || !m) return false;
  t.name = m.name = String(name).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) || basename(t.cwd);
  saveMeta();
  return true;
}

// removeWorktree: also remove its worktree folder (only if nothing is uncommitted; the branch is kept)
export function closeSession(id, { removeWorktree: rm = false } = {}) {
  const t = terms.get(id);
  if (!t) return false;
  const wt = meta.get(id)?.worktree;
  t.closing = true;
  tmux("kill-session", "-t", `=${tmuxName(id)}`);
  meta.delete(id); saveMeta();
  try { t.proc?.kill(); } catch {}
  for (const ws of t.sockets) ws.close();
  terms.delete(id);
  return rm && wt ? { closed: true, ...removeWorktree(wt) } : { closed: true };
}

// Daemon stopping: detach (sessions keep running in tmux)
export function detachAll() {
  for (const t of terms.values()) { t.closing = true; try { t.proc?.kill(); } catch {} for (const ws of t.sockets) ws.close(); }
  terms.clear();
}

// ---------- web console streaming: WebSocket /pty/<id> ----------
export function attachWebSocket(server, authorize) {
  const { WebSocketServer } = require("ws");
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const m = req.url.match(/^\/pty\/([\w-]+)/);
    const t = m && terms.get(m[1]);
    if (!t || !authorize(req)) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => {
      t.sockets.add(ws);
      if (t.buf) ws.send(t.buf);
      ws.on("message", (raw) => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        if (!t.alive) return;
        if (msg.t === "i" && typeof msg.d === "string") { t.proc.write(msg.d); t.lastInput = Date.now(); }
        if (msg.t === "r" && msg.c > 0 && msg.r > 0) {
          const c = Math.min(msg.c, 500), r = Math.min(msg.r, 300);
          t.proc.resize(c, r); t.capture = null;
          // the window follows whichever screen you're using right now
          tmux("resize-window", "-t", `=${tmuxName(t.id)}:`, "-x", String(c), "-y", String(r));
        }
      });
      ws.on("close", () => t.sockets.delete(ws));
    });
  });
}
