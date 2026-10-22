// AXA console: Home. "Needs you" (sessions waiting on you, answerable right there) and "While you were
// away" (a timeline since your last visit in this browser: finished runs with one-line outcomes,
// verify-gate bounces, AXA's approvals and refusals, failures, links fired; each row opens its run,
// session or diff).

// ---------- "Needs you" ----------
const needEls = new Map();
let evlog = []; // every event this page has seen (the /events history, then live), for the timeline and runs
const EVLOG_MAX = 20000;
function logSeen(e) { if (e && e.ts) { evlog.push(e); if (evlog.length > EVLOG_MAX) evlog.splice(0, evlog.length - EVLOG_MAX); } }
const lastEventAt = () => Math.max(evlog.length ? evlog[evlog.length - 1].ts || 0 : 0, ...terms.map((t) => t.last_event_at || 0));

function renderHome(list, fresh) {
  const need = list.filter(LK.needsYou), host = $("needlist");
  // AXA itself waiting on you comes first (it's answered in its own tab)
  const g = sessions.get(current), axaPerm = g?.nodes.get("axa")?.perm;
  let axaRow = host.querySelector(".axaneed");
  if (axaPerm && !axaRow) { axaRow = document.createElement("div"); axaRow.className = "sess hot axaneed"; axaRow.dataset.nav = "1"; axaRow.tabIndex = 0; axaRow.style.setProperty("--c", "var(--warn)"); axaRow.onclick = () => { const cmd = [...tabs.values()].find((t) => t.info.mode === "axa" && t.info.alive); if (cmd) showTerminal(cmd.info.id); }; }
  if (axaRow) { if (axaPerm) { axaRow.innerHTML = `<div class="sh"><span class="chip">${statusText("waiting")}</span><b class="nm">AXA</b></div><div class="sd">Answer it in the AXA tab: ${esc(axaPerm === true ? "a permission" : axaPerm)}</div>`; host.prepend(axaRow); } else axaRow.remove(); }
  renderCards(host, need, needEls, fresh);
  if (axaRow && axaPerm) host.prepend(axaRow);
  const counts = (s) => list.filter((p) => LK.statusOf(p) === s).length;
  const idle = list.filter((p) => ["ready", "done", "shell"].includes(LK.statusOf(p))).length, working = counts("working");
  const last = lastEventAt();
  const quiet = [working && `${working} working`, `${idle} idle`, last ? `last event ${ago(Date.now() - last)} ago` : ""].filter(Boolean).join(" · ");
  placeState(host, need.length || axaPerm ? "" : locked ? stateHtml("locked", "Console locked", "Open it with <code>/axa:console</code>, or the unlock link the server prints.")
    : !termsLoaded ? stateHtml("loading", "Loading…") : termsError ? stateHtml("error", termsOffline ? "Can't reach the console" : "Can't list the sessions", esc(termsError), `<button data-act="retry">Try again</button>`)
    : stateHtml("quiet", "All quiet", list.length ? quiet : "No project sessions yet. Ask AXA to start one, or play the demo.", list.length ? "" : `<button data-act="new">${icon("plus")}New session</button><button data-act="demo">${icon("play")}Play the demo</button>`));
  $("homesum").textContent = need.length ? `${need.length} waiting` : "";
  if (viewNow === "home") renderAwaySoon();
}

// ---------- "While you were away": since this browser last looked ----------
const SEEN_KEY = "axa.lastSeen";
const readSeen = () => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } };
const writeSeen = (t) => { try { localStorage.setItem(SEEN_KEY, String(t)); } catch {} };
let awaySince = readSeen() || 0, awayFirst = !awaySince; // first visit: the last day
if (awayFirst) awaySince = Date.now() - 864e5;
let awayRuns = [], awayLoaded = false, awayError = "", hiddenAt = 0, awayMore = false;
// leaving (tab hidden, page closed) marks now as seen; coming back after a while starts a new "away"
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = Date.now(); writeSeen(hiddenAt); }
  else if (hiddenAt && Date.now() - hiddenAt > 5 * 60_000) { awaySince = hiddenAt; awayFirst = false; loadAway(); }
});
addEventListener("pagehide", () => writeSeen(Date.now()));
$("seenbtn").onclick = () => { awaySince = Date.now(); awayFirst = false; writeSeen(awaySince); renderAway(); };

let awayFetch = 0;
async function loadAway() {
  if (locked) return renderAway();
  const n = ++awayFetch;
  try {
    const r = await fetch(`/api/runs?since=${awaySince}&limit=300`);
    if (n !== awayFetch) return;
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    awayRuns = await r.json(); awayError = "";
  } catch (e) { if (n === awayFetch) awayError = e.message === "Failed to fetch" ? "The console is unreachable" : e.message; }
  awayLoaded = true;
  renderAway();
}
let awayTimer = 0;
const renderAwaySoon = () => { if (!awayTimer) awayTimer = setTimeout(() => { awayTimer = 0; renderAway(); }, 250); };
const nameOfTerm = (id, fallback) => { const t = terms.find((x) => x.id === id); return t ? (t.mode === "axa" ? "AXA" : t.name) : fallback || awayRuns.find((r) => r.terminal === id)?.name || allRuns.find((r) => r.terminal === id)?.name || "a session"; };
const oneLine = (s, n = 140) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const isSupervisor = (prompt) => /^\s*\[AXA (supervisor|link)/.test(prompt || "");
// the run a moment belongs to (to open from an event row)
const runAt = (terminal, ts) => [...awayRuns, ...demoRuns()].find((r) => r.terminal === terminal && r.start <= ts && (r.end || Infinity) + 10_000 >= ts);

function awayItems() {
  const items = [];
  for (const r of [...awayRuns, ...demoRuns().filter((r) => (r.end || r.start) >= awaySince)]) {
    if (r.status === "running") continue;
    const st = r.status === "done" ? "done" : r.status === "replaced" ? "ready" : "exited";
    const bits = [r.end ? dur(r.end - r.start) : "", r.steps ? `${r.steps} steps` : "", r.helpers ? `${r.helpers} helpers` : "", r.gate ? `verify gate ${r.gate}×` : "", r.failures ? `${r.failures} failed steps` : ""].filter(Boolean).join(" · ");
    const what = r.status === "done" ? (r.report ? oneLine(r.report) : "finished") : r.status === "replaced" ? "interrupted by a new instruction" : "ended before finishing";
    items.push({ ts: r.end || r.start, st, who: r.name, what, sub: `${isSupervisor(r.prompt) ? "AXA update" : oneLine(r.prompt, 90)}${bits ? " · " + bits : ""}`, run: r.id, terminal: r.terminal, kind: "run" });
  }
  const approved = new Map(); // terminal -> { n, last }: routine approvals fold into one row each
  for (const e of evlog) {
    if (!e.ts || e.ts < awaySince) continue;
    const who = e.terminal ? nameOfTerm(e.terminal) : "AXA";
    switch (e.event) {
      case "VerifyGate": items.push({ ts: e.ts, st: "waiting", who, what: `verify gate sent it back to check its work`, sub: e.summary || "", terminal: e.terminal, kind: "gate" }); break;
      case "AxaDecision":
        if (e.decision === "allow") { const a = approved.get(e.terminal) || { n: 0 }; a.n++; a.last = e; approved.set(e.terminal, a); }
        else items.push({ ts: e.ts, st: e.decision === "deny" ? "failed" : "waiting", who, what: e.decision === "deny" ? `AXA declined: ${oneLine(e.summary || e.tool, 80)}` : `AXA asked you: ${oneLine(e.summary || e.tool, 80)}`, sub: e.reason || "", terminal: e.terminal, kind: "decision" });
        break;
      case "PolicyDecision": if (e.decision === "deny") items.push({ ts: e.ts, st: "failed", who, what: `policy refused: ${oneLine(e.summary || e.tool, 80)}`, sub: e.reason || "", terminal: e.terminal, kind: "policy" }); break;
      case "ChainFired": items.push({ ts: e.ts, st: "working", who: `${e.from} → ${e.to}`, what: "link fired", sub: oneLine(e.text, 120), terminal: e.terminal, kind: "link", icon: "link" }); break;
      case "UserAnswer": items.push({ ts: e.ts, st: "ready", who, what: `you answered: ${oneLine(e.answer, 60)}`, sub: "", terminal: e.terminal, kind: "answer" }); break;
    }
  }
  for (const [terminal, a] of approved) items.push({ ts: a.last.ts, st: "done", who: terminal ? nameOfTerm(terminal) : "AXA", what: `AXA approved ${a.n} request${a.n > 1 ? "s" : ""}`, sub: `last: ${oneLine(a.last.summary || a.last.tool, 70)}${a.last.reason ? ` (${oneLine(a.last.reason, 60)})` : ""}`, terminal, kind: "approved", icon: "shield" });
  // sessions that failed (and are still failed) belong here too
  for (const p of projectSessions()) if (LK.statusOf(p) === "failed") items.push({ ts: (p.last_event_at || Date.now()), st: "failed", who: p.name, what: "failed", sub: LK.reasonOf(p) || p.error || "", terminal: p.id, kind: "failed" });
  return items.sort((a, b) => b.ts - a.ts);
}
function renderAway() {
  const host = $("away"), since = awayFirst ? "last 24 hours" : `since ${hhmm(awaySince)}${Date.now() - awaySince > 864e5 ? ` ${new Date(awaySince).toLocaleDateString([], { month: "short", day: "numeric" })}` : ""} (${ago(Date.now() - awaySince)} ago)`;
  $("awaysince").textContent = since;
  if (locked) { host.innerHTML = ""; return; }
  if (!awayLoaded && !awayRuns.length) { host.innerHTML = `<div class="trow skel"></div><div class="trow skel"></div><div class="trow skel"></div>`; return; }
  const items = awayItems(), shown = awayMore ? items.slice(0, 300) : items.slice(0, 40);
  if (!items.length) {
    host.innerHTML = awayError ? stateHtml("error", "Couldn't load the history", esc(awayError), `<button id="awayretry">Try again</button>`) : stateHtml("quiet", "Nothing happened while you were away", awayFirst ? "" : "Runs, approvals and checks show up here.", awayFirst ? "" : `<button data-act="since">Show the last 24 hours</button>`);
    $("awayretry")?.addEventListener("click", loadAway);
    return;
  }
  host.innerHTML = shown.map((it, i) => {
    const l = LK.lookOf(it.st);
    const p = it.terminal && terms.find((t) => t.id === it.terminal);
    const diff = p?.git?.files ? `<button class="small" data-diff="${esc(p.id)}">${icon("diff")}Changes</button>` : "";
    return `<div class="trow" data-nav="1" tabindex="0" data-i="${i}" style="--c:var(--${l.role === "text" ? "dim" : l.role})">
      <span class="tt">${hhmm(it.ts)}</span><span class="tg">${it.icon ? icon(it.icon) : glyphOf(it.st)}</span>
      <span class="tb"><span class="tx"><b>${esc(it.who)}</b> ${esc(it.what)}</span>${it.sub ? `<span class="ts">${esc(it.sub)}</span>` : ""}</span>${diff}</div>`;
  }).join("") + (items.length > shown.length ? `<button class="small more" id="awaymore">Show ${items.length - shown.length} more</button>` : "");
  host.onclick = (ev) => {
    if (ev.target.id === "awaymore") { awayMore = true; return renderAway(); }
    const d = ev.target.closest("[data-diff]");
    if (d) { const p = terms.find((t) => t.id === d.dataset.diff); if (p) showDiff(p); return; }
    const row = ev.target.closest(".trow[data-i]"); if (!row) return;
    openAwayItem(shown[Number(row.dataset.i)]);
  };
}
function openAwayItem(it) {
  if (!it) return;
  const run = it.run || (it.terminal && runAt(it.terminal, it.ts)?.id);
  if (run) return openRun(run);
  const p = it.terminal && terms.find((t) => t.id === it.terminal);
  if (p) openSession(p); else go("runs");
}
