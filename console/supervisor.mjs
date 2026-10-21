// The console's background helpers that act on sessions: links between sessions (chains) and the
// supervisor that wakes the AXA commander. The server calls supervise() every few seconds; both only
// read the session list (T.listTerms(), cached, no screen captures) and type through T.sendToTerm.
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const DONE_MS = 6_000; // "done" must hold this long (a verify-gate bounce flips it back to working)
const WAIT_MS = 15_000; // how long a prompt must stay open before it counts as needing the user
const QUIET_MS = 30_000; // don't type while the user is typing in the commander tab
const HOUR = 3600_000, DAY = 24 * HOUR;
const NOTABLE = { done: "finished its turn", waiting: "needs the user's approval", stuck: "looks stuck", exited: "exited", over_budget: "went over its token budget: don't give it more work; report its usage to the user" };
// Sessions a link may type into: idle Claude sessions, and plain shells (they have no traced status)
const IDLE = ["ready", "done", "shell"];
const clipText = (v, n) => (v == null ? undefined : String(v).slice(0, n));

// T: the terminals module; logEvent(ev): append an event to the log; enabled: AXA_SUPERVISOR != "0"
export function createSupervisor({ T, home, logEvent, enabled = true, wakesPerHour = 30, now = Date.now }) {
  // ---------- links: when one session finishes, AXA sends the next instruction to another ----------
  // Saved in $AXA_HOME/chains.json. A link fires once, on a "done" that comes after it was made and has
  // held DONE_MS (so a verify-gate bounce settles first), and only when the next session is idle.
  // Fired and failed links are kept a day (for the console to show), then dropped.
  const chainsPath = join(home, "chains.json");
  let chains = [];
  const load = () => { try { chains = JSON.parse(readFileSync(chainsPath, "utf8")).filter((c) => c?.id); } catch { chains = []; } pruneChains(); };
  const saveChains = () => { try { writeFileSync(chainsPath, JSON.stringify(chains.map(({ sending, ...c }) => c), null, 2), { mode: 0o600 }); chmodSync(chainsPath, 0o600); } catch {} };
  function pruneChains() {
    const n = chains.length, t = now();
    chains = chains.filter((c) => !((c.fired && t - c.fired > DAY) || (c.failed && t - (c.failedAt || c.created || 0) > DAY)));
    if (chains.length < n) saveChains();
  }
  const fail = (ch, why) => { ch.failed = why; ch.failedAt = now(); saveChains(); };
  const chainSeen = new Map(); // session -> { status, since }
  function runChains(list) {
    const t = now();
    for (const s of list) { const c = chainSeen.get(s.id); if (!c || c.status !== s.status) chainSeen.set(s.id, { status: s.status, since: t }); }
    for (const id of chainSeen.keys()) if (!list.some((s) => s.id === id)) chainSeen.delete(id);
    for (const ch of chains) {
      if (ch.fired || ch.failed || ch.sending) continue;
      const from = list.find((s) => s.id === ch.from), to = list.find((s) => s.id === ch.to);
      if (!from || !to || !to.alive) { fail(ch, !from ? "the first session was closed" : "the next session was closed"); continue; }
      if (from.status !== "done" || (from.last_event_at || 0) <= ch.created || t - chainSeen.get(from.id).since < DONE_MS) continue;
      if (!IDLE.includes(to.status) || to.awaiting_permission) continue; // the next one is busy: wait for it
      ch.sending = true;
      // Claude sessions get a note saying where the instruction comes from; shells get just the command
      T.sendToTerm(to.id, to.mode === "shell" ? ch.text : `[AXA link: ${from.name} just finished] ${ch.text}`).then((r) => {
        ch.sending = false;
        if (!r.ok) { if (/dangerous/i.test(r.error || "")) fail(ch, r.error); return; }
        ch.fired = now(); saveChains();
        logEvent({ ts: now(), event: "ChainFired", terminal: to.id, role: "console", from: from.name, to: to.name, text: clipText(ch.text, 200) });
      }, () => { ch.sending = false; });
    }
    pruneChains();
  }
  const chainsView = () => { const terms = new Map((T?.listTerms() || []).map((t) => [t.id, t])); return chains.map(({ sending, ...c }) => ({ ...c, from_name: terms.get(c.from)?.name, to_name: terms.get(c.to)?.name })); };
  // from/to: entries of listTerms(). Returns [status, body] for the HTTP reply.
  function addChain(from, to, rawText) {
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!from || !to) return [404, { error: "Both sessions must be open (ids from list_sessions)." }];
    if (from.id === to.id) return [400, { error: "A session can't be linked to itself." }];
    if (!text || text.length > 4000) return [400, { error: "Give the next session an instruction (up to 4000 characters)." }];
    const ch = { id: randomBytes(4).toString("hex"), from: from.id, to: to.id, text, created: now() };
    chains.push(ch); saveChains();
    return [200, { ...ch, from_name: from.name, to_name: to.name }];
  }
  const deleteChain = (id) => { const n = chains.length; chains = chains.filter((c) => c.id !== id); saveChains(); return chains.length < n; };

  // ---------- supervisor: AXA wakes itself ----------
  // When a project session finishes, gets stuck, exits, or needs the user, the console tells the AXA
  // commander session (if one is open) so it can check the work, take the next step and report, without
  // the user having to ask. The note is written here, never copied from a session's screen, so it
  // carries no untrusted text. It's only typed when the commander is idle and the user hasn't typed
  // into it for a while; updates queue up meanwhile. AXA_SUPERVISOR=0 turns this off.
  const lastSeen = new Map(), pending = new Map(), wakes = [], budgetTold = new Set();
  let primed = false, limitToldAt = 0; // limitToldAt: when the last limit notice expires
  function supervise() {
    if (!T) return;
    const list = T.listTerms();
    runChains(list);
    if (!enabled) return;
    const t = now();
    for (const s of list) {
      if (s.mode !== "claude") continue;
      const prev = lastSeen.get(s.id);
      lastSeen.set(s.id, s.status);
      // over budget: tell AXA once per session
      if (primed && s.usage?.over_budget && !budgetTold.has(s.id)) { budgetTold.add(s.id); pending.set(`${s.id}:budget`, { id: s.id, name: s.name, status: "over_budget", since: t }); }
      // the first pass only learns the current states; afterwards, report changes into a notable state
      if (!primed || prev === undefined || prev === s.status) continue;
      if (NOTABLE[s.status]) pending.set(s.id, { name: s.name, status: s.status, since: t });
      else pending.delete(s.id); // back to work before AXA got to it
    }
    // A prompt can show on screen a moment before the approver picks it up: "needs the user" only
    // counts once it has lasted WAIT_MS
    const ready = [...pending.entries()].filter(([, p]) => (p.status === "waiting" ? t - p.since >= WAIT_MS : p.status === "done" ? t - p.since >= DONE_MS : true));
    for (const id of lastSeen.keys()) if (!list.some((s) => s.id === id)) { lastSeen.delete(id); pending.delete(id); pending.delete(`${id}:budget`); budgetTold.delete(id); }
    primed = true;
    if (!ready.length) return;

    const cmd = list.find((s) => s.mode === "axa" && s.alive);
    if (!cmd || !["ready", "done"].includes(cmd.status) || cmd.awaiting_permission) return;
    if (t - (T.lastInputAt?.(cmd.id) || 0) < QUIET_MS) return;
    while (wakes.length && t - wakes[0] > HOUR) wakes.shift();
    if (wakes.length >= wakesPerHour) {
      // A runaway loop: updates wait (the needs-you badge still shows them). Say so once an hour, so
      // the console can show why AXA went quiet (again once the last notice's reset time has passed,
      // so the banner never disappears while updates are still held back)
      if (t >= limitToldAt) {
        limitToldAt = wakes[0] + HOUR;
        logEvent({ ts: t, event: "SupervisorLimit", role: "console", terminal: cmd.id, limit: wakesPerHour, pending: ready.map(([, p]) => p.name), resets_at: wakes[0] + HOUR });
      }
      return;
    }

    const items = ready.map(([id, p]) => `${p.name} (${p.id || id}) ${NOTABLE[p.status]}`);
    const text = `[AXA supervisor: automatic update from the console, not typed by the user] ${items.join("; ")}. Handle this under your supervisor rules: check each one, verify any claims, take the next step if it is within what the user asked, and end with a short report for the user.`;
    T.sendToTerm(cmd.id, text).then((r) => {
      if (!r.ok) return;
      wakes.push(now());
      for (const [id] of ready) pending.delete(id);
      logEvent({ ts: now(), event: "SupervisorWake", terminal: cmd.id, role: "console", items });
    }, () => {});
  }

  load();
  return { supervise, runChains, chainsView, addChain, deleteChain, saveChains, load, get chains() { return chains; } };
}
