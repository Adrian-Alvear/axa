// What AXA reads from Claude Code's own files in ~/.claude/projects: your past chats (to list and
// resume them from the hub) and the tokens each chat has used.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { expand, files, inHome } from "../paths.mjs";

export const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const projectsDir = () => join(homedir(), ".claude", "projects");

function readSlice(file, start, bytes) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, start);
    return buf.subarray(0, n).toString("utf8");
  } finally { closeSync(fd); }
}

// ---------- chats ----------
// Titles: your own (/rename) wins, then Claude's generated title, then the first thing you typed.
// Only the start and the end of each transcript are read; results are cached by file size.
const chatCache = new Map(); // path -> { size, chat }
const firstText = (o) => {
  const c = o.message?.content;
  const t = typeof c === "string" ? c : Array.isArray(c) ? c.find((p) => p?.type === "text")?.text : null;
  // skip the wrappers Claude Code puts around commands and hook output
  if (!t || /^\s*<(command|local-command|system-reminder|bash-|task-notification)/.test(t)) return null;
  return t.replace(/\s+/g, " ").trim().slice(0, 100);
};
function describeChat(path, id, size, mtime) {
  const c = chatCache.get(path);
  if (c && c.size === size) return c.chat;
  const SLICE = 96 * 1024;
  const head = readSlice(path, 0, SLICE);
  const tail = size > SLICE ? readSlice(path, Math.max(0, size - SLICE), SLICE) : "";
  let custom, ai, first, cwd, branch;
  for (const chunk of [head, tail]) {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("{")) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === "custom-title" && o.customTitle) custom = o.customTitle;
      if (o.aiTitle) ai = o.aiTitle;
      cwd ??= o.cwd;
      if (o.gitBranch) branch = o.gitBranch;
      if (o.type === "user" && !o.isMeta && !o.toolUseResult) first ??= firstText(o);
    }
  }
  const chat = cwd ? { id, title: custom || ai || first || "Untitled chat", cwd, project: basename(cwd), branch, updated: mtime } : null;
  chatCache.set(path, { size, chat });
  return chat;
}

// Most recent first. q filters on title and project. Only chats in folders inside your home that
// still exist (a chat resumes in its own folder).
export function listChats({ limit = 50, q = "" } = {}) {
  const found = [];
  try {
    for (const dir of readdirSync(projectsDir(), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const d = join(projectsDir(), dir.name);
      for (const f of readdirSync(d)) {
        if (!f.endsWith(".jsonl") || !CHAT_ID.test(f.slice(0, -6))) continue;
        try { const st = statSync(join(d, f)); found.push({ path: join(d, f), id: f.slice(0, -6), size: st.size, updated: st.mtimeMs }); } catch {}
      }
    }
  } catch {}
  const needle = String(q || "").toLowerCase().trim();
  const out = [];
  for (const f of found.sort((a, b) => b.updated - a.updated)) {
    if (out.length >= limit) break;
    if (f.size < 200) continue; // started and closed without a message
    let chat;
    try { chat = describeChat(f.path, f.id, f.size, f.updated); } catch { continue; }
    if (!chat || !inHome(chat.cwd) || !existsSync(chat.cwd)) continue;
    if (needle && !`${chat.title} ${chat.project}`.toLowerCase().includes(needle)) continue;
    out.push(chat);
  }
  return out;
}
export const findChat = (id) => listChats({ limit: 2000 }).find((c) => c.id === id);

// ---------- usage: the tokens a chat has used, helper agents included ----------
// Read incrementally (one refresh per chat every USAGE_MS). Each API response counts once.
const USAGE_MS = 15_000;
const usageCache = new Map(); // chat -> { at, busy, dir, files: Map(path -> { offset, partial }), seen, tot }
function chatDir(chat) {
  try { for (const d of readdirSync(projectsDir())) if (existsSync(join(projectsDir(), d, `${chat}.jsonl`))) return join(projectsDir(), d); } catch {}
  return null;
}
function refreshUsage(chat) {
  const c = usageCache.get(chat) || { files: new Map(), seen: new Map(), tot: { input: 0, cached: 0, output: 0 } };
  usageCache.set(chat, c);
  if (c.busy || (c.at && Date.now() - c.at < USAGE_MS)) return;
  c.busy = true;
  try {
    c.dir ||= chatDir(chat);
    if (!c.dir) return;
    const paths = [join(c.dir, `${chat}.jsonl`)];
    try { for (const f of readdirSync(join(c.dir, chat, "subagents"))) if (f.endsWith(".jsonl")) paths.push(join(c.dir, chat, "subagents", f)); } catch {}
    for (const p of paths) {
      const f = c.files.get(p) || { offset: 0, partial: "" };
      c.files.set(p, f);
      const size = statSync(p).size;
      if (size < f.offset) Object.assign(f, { offset: 0, partial: "" });
      const end = Math.min(size, f.offset + 8 * 1024 * 1024); // at most 8MB per refresh
      if (end <= f.offset) continue;
      const text = readSlice(p, f.offset, end - f.offset);
      f.offset = end;
      const lines = (f.partial + text).split("\n");
      f.partial = lines.pop();
      for (const line of lines) {
        if (!line.includes('"usage"')) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const u = o.type === "assistant" && o.message?.usage;
        if (!u) continue;
        // a streamed response repeats its line as it grows: count the largest numbers once
        const key = `${o.message.id}:${o.requestId}`;
        const now = { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
        const was = c.seen.get(key) || { input: 0, cached: 0, output: 0 };
        for (const k of ["input", "cached", "output"]) if (now[k] > was[k]) { c.tot[k] += now[k] - was[k]; was[k] = now[k]; }
        c.seen.set(key, was);
      }
    }
  } catch {} finally { c.busy = false; c.at = Date.now(); }
}
// Per-project token budget from ~/.axa/policy.json: { "default": { "budget": { "tokens": 5e6 } }, "projects": { "x": {...} } }
function budgetFor(cwd) {
  try {
    const p = JSON.parse(readFileSync(files.policy, "utf8"));
    const hit = Object.entries(p.projects || {}).find(([k]) => (/^[~/]/.test(k) ? expand(k) === cwd || cwd.startsWith(expand(k) + "/") : k === basename(cwd) || cwd.includes(`/${k}/.claude/worktrees/`)));
    return Number(hit?.[1]?.budget?.tokens ?? p.default?.budget?.tokens) || 0;
  } catch { return 0; }
}
// tokens = new input + output (what a budget limits); cache re-reads are cheap and reported apart
export function usageOf(chat, cwd, live) {
  if (!CHAT_ID.test(String(chat || ""))) return null;
  if (live) refreshUsage(chat);
  const tot = usageCache.get(chat)?.tot;
  if (!tot) return null;
  const tokens = tot.input + tot.output, budget = budgetFor(cwd);
  return { tokens, input: tot.input, cached: tot.cached, output: tot.output, budget: budget || undefined, over_budget: budget > 0 && tokens > budget };
}
