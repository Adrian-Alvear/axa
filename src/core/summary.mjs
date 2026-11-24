// Spoken summaries: what AXA's voice says for a long reply (or a batch of notifications, or the daily
// brief) instead of its first paragraph plus "You can read the rest on screen". The user often isn't
// looking at the screen; that's why the voice exists.
//
// A fast model rewrites the text for speaking: `claude -p --model claude-haiku-5-5` with no tools at all,
// no MCP servers, no slash commands or skills, no saved session, in an empty temp folder, as AXA's
// read-only reviewer role (its policy denies any edit) and untraced (no AXA_TERMINAL_ID). Hard limit 10 s,
// then its whole process group goes. AXA_SUMMARY_CMD replaces the `claude` command (tests).
// The result goes through the usual speech normalizer (speech.mjs).
//
// ui.json "voiceSummary": "model" (default) | "first-paragraph" (the old behaviour) | "full" (all of it).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { files } from "../paths.mjs";
import { SHORT, toSpeech } from "./speech.mjs";
import { killTree } from "./reviewer.mjs";

export const SUMMARY_MODEL = "claude-haiku-5-5";
export const SUMMARY_TIMEOUT = 10_000;
export const MODES = ["model", "first-paragraph", "full"];
export const MORE_DETAIL = "There's more detail in the chat.";
export const SUMMARY_PROMPT = "Rewrite this for speaking aloud to the user who is not looking at the screen. 2-5 short sentences, conversational. Keep every decision, number that matters, result, and especially any question or choice the user must answer (say the options). No markdown, no file paths, no commit ids. Don't say 'on screen'. Reply with only the words to say.";

export function summaryMode(cfg) {
  if (cfg === undefined) { try { cfg = JSON.parse(readFileSync(files.ui, "utf8")); } catch { cfg = {}; } }
  return MODES.includes(cfg?.voiceSummary) ? cfg.voiceSummary : "model";
}

// The command line (no tools of any kind, nothing loaded that could act)
export const summaryArgs = (model = SUMMARY_MODEL) => ["-p", "--model", model, "--output-format", "text", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"];

// Resolves to the summary text, or null (failed, empty, timed out, cancelled)
export function runSummary(text, { env = process.env, timeoutMs = SUMMARY_TIMEOUT, model = SUMMARY_MODEL, signal } = {}) {
  const cmd = (env.AXA_SUMMARY_CMD || "claude").trim().split(/\s+/);
  const cwd = join(tmpdir(), "axa-summary");
  try { mkdirSync(cwd, { recursive: true, mode: 0o700 }); } catch {}
  const childEnv = { ...env, AXA_ROLE: "reviewer" };
  delete childEnv.AXA_TERMINAL_ID; delete childEnv.TMUX; delete childEnv.TMUX_PANE;
  return new Promise((done) => {
    let out = "", finished = false, child, timer, kill = () => {};
    const end = (v) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener?.("abort", kill); done(v); };
    if (signal?.aborted) return end(null);
    try { child = spawn(cmd[0], [...cmd.slice(1), ...summaryArgs(model)], { cwd, env: childEnv, stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" }); }
    catch { return end(null); }
    kill = () => { try { killTree(child.pid); } catch {} end(null); };
    timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener?.("abort", kill, { once: true });
    child.stdout.on("data", (c) => { if (out.length < 64 << 10) out += c; });
    child.on("error", () => end(null));
    child.on("close", (code) => end(code === 0 && out.trim() ? out.trim() : null));
    child.stdin.on("error", () => {});
    child.stdin.end(`${SUMMARY_PROMPT}\n\n<text>\n${String(text).slice(0, 60_000)}\n</text>\n`);
  });
}

// Spoken notifications: a batch, the daily brief (always), or one long one is summarised; one short one is said as is
export const notesNeedSummary = (text, items = []) => items.length > 1 || items.some((n) => n?.kind === "brief") || toSpeech(text, { full: true }).length > SHORT;

// ---------- the question the user must answer ----------
const sentences = (t) => String(t).match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) || [];
// the last question in the reply, as it would be spoken (with its options, if they follow it as a list)
export function questionOf(md) {
  const said = toSpeech(md, { full: true });
  const qs = sentences(said).filter((s) => s.endsWith("?"));
  if (!qs.length) return null;
  const q = qs.at(-1), rest = said.slice(said.lastIndexOf(q) + q.length).trim();
  // "Which one? Option A. Option B." -> keep a short list of options right after it
  const opts = sentences(rest).slice(0, 4).filter((s) => s.length < 80);
  return opts.length && /\b(?:or|which|choose|pick|should i|want me|prefer)\b/i.test(q) ? `${q} ${opts.join(" ")}` : q;
}
// said already asks it: the same words, or any question at all (a summary rephrases: "send it in now?")
const has = (said, q) => said.toLowerCase().includes(q.split(/[?]/)[0].toLowerCase().slice(0, 60)) || /\?(?:\s|$)/.test(said);
const withQuestion = (said, q) => (q && !has(said, q) ? `${said} ${q}`.trim() : said);

// ---------- the fallback: whole sentences only ----------
// The first sentences that fit in SHORT (the first one whole, however long), then a natural line only
// when something was left out. Never a cut in the middle of a sentence.
// question: said before that closing line, if it isn't in the sentences kept
export function shortSpeech(md, question = null) {
  const all = toSpeech(md, { full: true });
  if (!all) return "";
  const ss = sentences(all);
  let said = "";
  for (const s of ss) { if (said && (said + " " + s).length > SHORT) break; said = said ? `${said} ${s}` : s; }
  const cut = said.length < all.length;
  said = withQuestion(said, question);
  return cut ? `${said} ${MORE_DETAIL}` : said;
}

// ---------- what to say for a reply ----------
// summarize(text) -> Promise<string|null> (runSummary, or a fake in tests). Returns { text, how }:
// how = "short" (said as is) | "summary" | "fallback" | "first-paragraph" | "full".
const cache = new Map(); // hash -> summary
const inflight = new Map(); // hash -> Promise<summary|null>: started at Stop, before anything asks for it
const keyOf = (md) => createHash("sha256").update(md).digest("hex");
const remember = (key, sum) => { if (!sum) return; cache.set(key, sum); if (cache.size > 100) cache.delete(cache.keys().next().value); };
// Start the summary of a long reply as soon as the turn stops (speculatively: the voice may never ask). The
// reply's spokenReply() then waits for this one instead of starting another. Returns the promise, or null.
export function prefetchSummary(md, { summarize = runSummary, mode = summaryMode() } = {}) {
  if (mode !== "model" || toSpeech(md, { full: true }).length <= SHORT) return null;
  const key = keyOf(md);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve(summarize(md, {})).catch(() => null).then((sum) => { remember(key, sum); inflight.delete(key); return sum; });
  inflight.set(key, p);
  return p;
}
// What's said at once for a reply (the summary, if any, follows): a short one whole; a long one's first sentence.
// question: the reply's question for the user, said in the follow-up (or right here, when there's none to come)
export function firstLine(md) {
  const all = toSpeech(md, { full: true });
  if (!all) return { text: "", long: false, question: null };
  if (all.length <= SHORT) return { text: all, long: false, question: null };
  return { text: sentences(all)[0] || all.slice(0, 200), long: true, question: questionOf(md) };
}
// signal: an AbortSignal (Esc, mute): the summariser's process is killed at once and nothing is said
export async function spokenReply(md, { mode = summaryMode(), summarize = runSummary, more = true, signal } = {}) {
  const all = toSpeech(md, { full: true });
  if (!all) return { text: "", how: "short" };
  if (mode === "full") return { text: all, how: "full" };
  const q = questionOf(md);
  if (mode === "first-paragraph") return { text: withQuestion(toSpeech(md, { more }), q), how: "first-paragraph" };
  // short enough: said as it is
  if (all.length <= SHORT) return { text: all, how: "short" };
  const key = keyOf(md);
  let sum = cache.get(key);
  if (!sum) {
    sum = await (inflight.get(key) || Promise.resolve(summarize(md, { signal }))).catch(() => null);
    if (signal?.aborted) return { text: "", how: "stopped" };
    remember(key, sum);
  }
  const said = sum ? toSpeech(sum, { full: true }) : "";
  if (said) return { text: withQuestion(said, q), how: "summary" };
  return { text: shortSpeech(md, q), how: "fallback" };
}
