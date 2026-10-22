// AXA console: Runs. Every instruction a session got (the same data as the terminal app's history,
// /api/runs), and for the one you pick its timeline: steps, helpers, approvals, checks and the result
// (/api/runs/:id, the events that run logged).

let allRuns = [], runsLoaded = false, runsError = "", runSel = null;
const RUN_LOOK = { done: "done", running: "working", replaced: "ready", unfinished: "exited" };
const runWord = (r) => ({ done: "done", running: "working", replaced: "interrupted", unfinished: "unfinished" }[r.status] || r.status);
const runPromptText = (r) => (/^\s*\[AXA supervisor/.test(r.prompt || "") ? "AXA update (supervisor)" : /^\s*\[AXA link/.test(r.prompt || "") ? `Link: ${oneLine(String(r.prompt).replace(/^\s*\[AXA link: [^\]]*\]\s*/, ""), 200)}` : oneLine(r.prompt, 200));
const whenOf = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

async function loadRuns() {
  if (locked) { runsLoaded = true; return renderRuns(); }
  try {
    const r = await fetch("/api/runs?limit=300");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    allRuns = await r.json(); runsError = "";
  } catch (e) { runsError = e.message === "Failed to fetch" ? "The console is unreachable" : e.message; }
  runsLoaded = true;
  renderRuns();
}
const runsShown = () => {
  const f = $("runfilter").value;
  return [...allRuns, ...demoRuns()].sort((a, b) => b.start - a.start).filter((r) => !f || r.terminal === f);
};
function renderRuns() {
  const list = runsShown(), host = $("runrows");
  // the filter: one entry per session that has runs
  const names = new Map(); for (const r of [...allRuns, ...demoRuns()]) names.set(r.terminal, r.name);
  const sig = [...names].join("|"), sel = $("runfilter");
  if (sel.dataset.sig !== sig) { const v = sel.value; sel.innerHTML = `<option value="">All sessions</option>` + [...names].map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join(""); sel.value = names.has(v) ? v : ""; sel.dataset.sig = sig; }
  if (!list.length) {
    host.innerHTML = locked ? stateHtml("locked", "Console locked", "Open it with <code>/axa:console</code>.") : !runsLoaded ? `<div class="trow skel"></div><div class="trow skel"></div><div class="trow skel"></div>`
      : runsError ? stateHtml("error", "Couldn't load the runs", esc(runsError), `<button id="runsretry">Try again</button>`) : stateHtml("empty", "No runs yet", "A run appears each time a session gets an instruction.");
    $("runsretry")?.addEventListener("click", loadRuns);
    $("rundetail").innerHTML = "";
    return;
  }
  host.innerHTML = list.map((r) => {
    const st = RUN_LOOK[r.status] || "exited", l = LK.lookOf(st);
    return `<div class="runrow${r.id === runSel ? " on" : ""}" data-nav="1" tabindex="0" data-run="${esc(r.id)}" style="--c:var(--${l.role === "text" ? "dim" : l.role})">
      <span class="rg" title="${esc(runWord(r))}">${glyphOf(st)}</span><span class="rn">${esc(r.name)}</span><span class="rt">${whenOf(r.start)}</span>
      <span class="rp">${esc(runPromptText(r))}</span><span class="rd">${r.end ? dur(r.end - r.start) : r.status === "running" ? "now" : ""}</span></div>`;
  }).join("");
  if (!runSel || !list.some((r) => r.id === runSel)) { if (!isPhone()) selectRun(list[0].id, false); }
  else if (!$("rundetail").dataset.run) selectRun(runSel, false);
}
$("runfilter").onchange = () => { runSel = null; renderRuns(); };
$("runrows").onclick = (ev) => { const row = ev.target.closest("[data-run]"); if (row) selectRun(row.dataset.run, true); };

// from Home (or the palette): show that run
async function openRun(id) {
  go("runs");
  if (!allRuns.some((r) => r.id === id) && !demoRuns().some((r) => r.id === id)) await loadRuns();
  $("runfilter").value = ""; selectRun(id, true); renderRuns();
}

let runFetch = 0;
async function selectRun(id, user) {
  runSel = id;
  for (const row of document.querySelectorAll("#runrows .runrow")) row.classList.toggle("on", row.dataset.run === id);
  const box = $("rundetail");
  box.dataset.run = id;
  document.body.classList.toggle("run-open", !!user);
  const run = [...allRuns, ...demoRuns()].find((r) => r.id === id);
  if (!run) { box.innerHTML = stateHtml("empty", "That run isn't in the history any more"); return; }
  box.innerHTML = runHead(run) + `<div class="tl">${`<div class="trow skel"></div>`.repeat(3)}</div>`;
  let events = null;
  const n = ++runFetch;
  if (run.demo) events = run.events;
  else {
    try { const r = await fetch(`/api/runs/${encodeURIComponent(id)}`); if (r.ok) events = (await r.json()).events; } catch {}
    // an older console without the route: what this page saw itself
    if (!events) events = evlog.filter((e) => e.terminal === run.terminal && e.ts >= run.start && e.ts <= (run.end || Date.now()) + 10_000);
  }
  if (n !== runFetch || runSel !== id) return;
  box.innerHTML = runHead(run) + runTimeline(run, events || []) + runResult(run);
  box.querySelector("[data-a=back]")?.addEventListener("click", () => document.body.classList.remove("run-open"));
  box.querySelector("[data-a=open]")?.addEventListener("click", () => { const p = terms.find((t) => t.id === run.terminal); if (p) openSession(p); });
  box.querySelector("[data-a=diff]")?.addEventListener("click", () => { const p = terms.find((t) => t.id === run.terminal); if (p) showDiff(p); });
  if (user && isPhone()) box.scrollIntoView({ block: "start" });
}
function runHead(r) {
  const st = RUN_LOOK[r.status] || "exited", p = terms.find((t) => t.id === r.terminal);
  const chips = [["steps", r.steps], ["helpers", r.helpers], ["approved by AXA", r.approvals], ["declined", r.declined], ["asked you", r.escalated], ["policy refused", r.refused], ["verify gate", r.gate], ["failed steps", r.failures]]
    .filter(([, v]) => v).map(([k, v]) => `<span class="kchip${/declined|refused|failed/.test(k) ? " bad" : /asked|gate/.test(k) ? " warn" : ""}"><b>${v}</b> ${k}</span>`).join("");
  return `<div class="rhead"><button class="small back" data-a="back">${icon("arrow")}Runs</button>
    <div class="rtitle">${statusHtml(st).replace(LK.lookOf(st).word, esc(runWord(r)))}<b>${esc(r.name)}</b><span class="sum">${whenOf(r.start)}${r.end ? ` · took ${dur(r.end - r.start)}` : ""}</span></div>
    <div class="ract">${p && !p.demo ? `<button class="small" data-a="open">${icon("terminal")}Open session</button>` : ""}${p?.git?.files ? `<button class="small" data-a="diff">${icon("diff")}Changes</button>` : ""}</div></div>
    <p class="title">Instruction</p><pre class="rprompt">${esc(r.prompt || "")}</pre>${chips ? `<div class="kchips">${chips}</div>` : ""}`;
}
// the run's events as a readable timeline: tool steps folded into one line per stretch
function runTimeline(run, events) {
  const rows = [], t0 = run.start;
  let stretch = null;
  const flush = () => { if (stretch) { const names = [...stretch.tools].map(([k, v]) => (v > 1 ? `${k} ×${v}` : k)).join(", "); rows.push({ ts: stretch.ts, st: "working", text: `${stretch.n} step${stretch.n > 1 ? "s" : ""}: ${esc(names)}`, sub: esc(stretch.last || "") }); stretch = null; } };
  for (const e of events) {
    if (e.event === "PreToolUse" && !e.agent_id && e.tool !== "Agent" && e.tool !== "Task") {
      if (!e.skill && PLUMBING.test(e.tool || "")) continue;
      stretch ||= { ts: e.ts, n: 0, tools: new Map() };
      const nm = e.skill ? `${e.skill} skill` : toolName(e.tool);
      stretch.n++; stretch.tools.set(nm, (stretch.tools.get(nm) || 0) + 1); stretch.last = humanAction(e.tool, e.summary, e.skill);
      continue;
    }
    const row = (() => {
      switch (e.event) {
        case "PreToolUse": return e.agent_id ? null : { st: "working", icon: "plus", text: `helper started (<b>${esc(roleFor(e.subagent_type))}</b>): ${esc(e.summary || "")}` };
        case "SubagentStop": return { st: "done", text: `helper reported back`, sub: esc(oneLine(e.message, 200)) };
        case "PostToolUseFailure": return e.agent_id ? null : { st: "failed", text: `${esc(toolName(e.tool) || "a step")} failed`, sub: esc(oneLine(e.error, 200)) };
        case "AxaDecision": return { st: e.decision === "allow" ? "done" : e.decision === "deny" ? "failed" : "waiting", icon: e.decision === "allow" ? "shield" : "", text: e.decision === "allow" ? `AXA approved: ${esc(oneLine(e.summary || e.tool, 120))}` : e.decision === "deny" ? `AXA declined: ${esc(oneLine(e.summary || e.tool, 120))}` : `AXA asked you: ${esc(oneLine(e.summary || e.tool, 120))}`, sub: esc(e.reason || "") };
        case "PolicyDecision": return e.decision === "deny" ? { st: "failed", text: `policy refused: ${esc(oneLine(e.summary || e.tool, 120))}`, sub: esc(e.reason || "") } : null;
        case "VerifyGate": return { st: "waiting", icon: "ci", text: "verify gate: sent back to check its work", sub: esc(e.summary || "") };
        case "UserAnswer": return { st: "ready", text: `you answered: <b>${esc(e.answer || "")}</b>` };
        case "Stop": return { st: "done", text: "reported back" };
      }
      return null;
    })();
    if (!row) continue;
    flush(); rows.push({ ts: e.ts, ...row });
  }
  flush();
  if (!rows.length) return `<p class="title">Timeline</p><div class="tl">${stateHtml("empty", "No events for this run", "Its events are older than the history this console keeps in memory.")}</div>`;
  const off = (ts) => { const s = Math.max(0, Math.round((ts - t0) / 1000)); return s < 60 ? `+${s}s` : `+${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`; };
  return `<p class="title">Timeline</p><div class="tl">` + rows.map((r) => { const l = LK.lookOf(r.st); return `<div class="trow" style="--c:var(--${l.role === "text" ? "dim" : l.role})"><span class="tt">${off(r.ts)}</span><span class="tg">${r.icon ? icon(r.icon) : glyphOf(r.st)}</span><span class="tb"><span class="tx">${r.text}</span>${r.sub ? `<span class="ts">${r.sub}</span>` : ""}</span></div>`; }).join("") + `</div>`;
}
const runResult = (r) => `<p class="title">Result</p><pre class="rresult">${esc(r.report || (r.status === "running" ? "(still working)" : r.status === "replaced" ? "(a new instruction came first)" : "(no report)"))}</pre>`;
