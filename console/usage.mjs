// ---------- usage: the tokens each session's chat has used (from Claude Code's own transcript) ----------
// Read incrementally in the background (one refresh per chat every USAGE_MS, async reads, so the
// session list never waits on a transcript); helper agents' transcripts (<chat>/subagents/*.jsonl)
// count too. Each API response is counted once (by message and request id).
import { readFileSync, statSync } from "node:fs";
import { open, readdir, stat, access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { home } from "./ensure.mjs";

const USAGE_MS = 15_000;
const MISS_MS = 120_000; // a chat whose transcript isn't there (yet): look again this much later
const READ_MAX = 8 * 1024 * 1024; // at most this much per file per refresh, so a huge first read is spread out
const usageCache = new Map(); // chat id -> { at, busy, dir, missAt, files: Map(path -> { offset, partial }), seen: Map, tot }
const expand = (p) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

async function findChatDir(chat) {
  const root = join(homedir(), ".claude", "projects");
  try {
    for (const d of await readdir(root)) {
      try { await access(join(root, d, `${chat}.jsonl`)); return join(root, d); } catch {}
    }
  } catch {}
  return null;
}
async function readFrom(p, f) {
  const size = (await stat(p)).size;
  if (size < f.offset) Object.assign(f, { offset: 0, partial: "" });
  const end = Math.min(size, f.offset + READ_MAX);
  if (end <= f.offset) return [];
  const fh = await open(p, "r");
  try {
    const buf = Buffer.alloc(end - f.offset);
    await fh.read(buf, 0, buf.length, f.offset);
    f.offset = end;
    const lines = (f.partial + buf.toString("utf8")).split("\n");
    f.partial = lines.pop();
    return lines;
  } finally { await fh.close(); }
}
export function refreshUsage(chat) {
  const c = usageCache.get(chat) || { files: new Map(), seen: new Map(), tot: { input: 0, cached: 0, output: 0 } };
  usageCache.set(chat, c);
  if (c.busy || (c.at && Date.now() - c.at < USAGE_MS) || (c.missAt && Date.now() - c.missAt < MISS_MS)) return;
  c.busy = true;
  (async () => {
    c.dir ||= await findChatDir(chat);
    if (!c.dir) { c.missAt = Date.now(); return; }
    c.missAt = 0;
    const sub = join(c.dir, chat, "subagents");
    const paths = [join(c.dir, `${chat}.jsonl`)];
    try { for (const f of await readdir(sub)) if (f.endsWith(".jsonl")) paths.push(join(sub, f)); } catch {}
    for (const p of paths) {
      const f = c.files.get(p) || { offset: 0, partial: "" };
      c.files.set(p, f);
      let lines;
      try { lines = await readFrom(p, f); } catch { continue; }
      for (const line of lines) {
        if (!line.includes('"usage"')) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const u = o.type === "assistant" && o.message?.usage;
        if (!u) continue;
        const key = `${o.message.id}:${o.requestId}`;
        // a streamed response repeats its line as it grows: count the largest numbers once
        const now = { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
        const was = c.seen.get(key) || { input: 0, cached: 0, output: 0 };
        for (const k of ["input", "cached", "output"]) if (now[k] > was[k]) { c.tot[k] += now[k] - was[k]; was[k] = now[k]; }
        c.seen.set(key, was);
      }
    }
  })().catch(() => {}).finally(() => { c.busy = false; c.at = Date.now(); });
}
// A session was closed: drop its chat's counters (a resumed chat is read again from the start)
export const forgetUsage = (chat) => { if (chat) usageCache.delete(chat); };

// Per-project token budget from ~/.axa/policy.json: { "default": { "budget": { "tokens": 5000000 } }, "projects": { "x": { ... } } }
// The file is read again only when it changes (checked at most every few seconds).
let policy = { at: 0, mtime: -1, file: null };
function policyFile() {
  if (Date.now() - policy.at < 5000) return policy.file;
  policy.at = Date.now();
  try {
    const p = join(home, "policy.json"), m = statSync(p).mtimeMs;
    if (m !== policy.mtime) policy = { at: policy.at, mtime: m, file: JSON.parse(readFileSync(p, "utf8")) };
  } catch { policy = { at: policy.at, mtime: -1, file: null }; }
  return policy.file;
}
export function budgetFor(cwd) {
  const file = policyFile();
  if (!file) return 0;
  try {
    const match = Object.entries(file.projects || {}).find(([k]) => (k.startsWith("/") || k.startsWith("~") ? expand(k) === cwd || cwd.startsWith(expand(k) + "/") : k === basename(cwd) || cwd.includes(`/${k}/.claude/worktrees/`)));
    return Number(match?.[1]?.budget?.tokens ?? file.default?.budget?.tokens) || 0;
  } catch { return 0; }
}
// t: a terminal; chat: the Claude chat it runs (from sessions.json)
export function usageOf(t, chat) {
  if (!chat || t.mode === "shell") return null;
  if (t.alive) refreshUsage(chat);
  const tot = usageCache.get(chat)?.tot;
  if (!tot) return null;
  // tokens = new input + output (what a budget limits); cache re-reads are cheap and reported apart
  const tokens = tot.input + tot.output, budget = budgetFor(t.cwd);
  return { tokens, input: tot.input, cached: tot.cached, output: tot.output, budget: budget || undefined, over_budget: budget > 0 && tokens > budget };
}
