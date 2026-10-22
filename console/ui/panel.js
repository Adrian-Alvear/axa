// AXA console: the intel panel (selected node, activity feed, dock), header stats and the frame loop

// ---------- side panel ----------
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dur = (ms) => ms < 60000 ? (ms / 1000).toFixed(1) + "s" : Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
const short = (id) => String(id || "").replace(/^agent-/, "").slice(0, 6);
const kv = (rows) => `<div class="kv">${rows.filter(([, v]) => v).map(([k, v]) => `<span class="k">${k}</span><span>${v}</span>`).join("")}</div>`;

function renderDetail(g) {
  const box = $("detail");
  if (!g) return box.replaceChildren();
  const n = g.nodes.get(selectedId) || g.nodes.get("axa");
  const kids = [...g.nodes.values()].filter((x) => x.parent === n.id);
  const head = (txt) => `<p class="title">Selected</p><h2 style="color:${n.color}">${txt}</h2>`;
  let html = "";
  if (n.kind === "axa") {
    html = head("AXA") + kv([
      ["status", statusHtml(axaStatus(n))],
      ["agents", kids.filter((k) => k.kind === "role").map((k) => `${esc(k.role)} ×${k.calls}`).join(" · ") || "none called yet"],
      ["own calls", kids.filter((k) => k.kind === "leaf").map((k) => `${esc(k.label)} ×${k.count}`).join(" · ")],
    ]) + (n.prompt ? `<span class="k">directive</span><pre>${esc(n.prompt)}</pre>` : "") + (n.message ? `<span class="k">last report</span><pre>${esc(n.message)}</pre>` : "");
  } else if (n.kind === "role") {
    const m = roleMeta(n.role);
    html = head(esc(n.role)) + kv([["agent", esc(m.type || n.role)], ["model", esc(m.model)], ["use for", esc(m.use)], ["called", String(n.calls)]]) +
      `<span class="k">jobs</span><ul>${kids.map((k) => `<li>${statusHtml(k.status === "running" ? "working" : "done")} ${esc(k.desc || short(k.id))}</li>`).join("")}</ul>`;
  } else if (n.kind === "inst") {
    html = head(esc(n.role)) + kv([
      ["task", esc(n.desc)], ["status", statusHtml(n.status === "running" ? (n.perm ? "waiting" : n.fail ? "failed" : "working") : "done")],
      ["elapsed", dur((n.end || Date.now()) - (n.start || Date.now()))],
      ["calls", kids.map((k) => `${esc(k.label)} ×${k.count}`).join(" · ")],
    ]) + (n.prompt ? `<span class="k">assigned by axa</span><pre>${esc(n.prompt)}</pre>` : "") + (n.message ? `<span class="k">report</span><pre>${esc(n.message)}</pre>` : "");
  } else {
    html = head(esc(n.label)) + kv([["type", n.leafKind], ["calls", String(n.count)]]) +
      (n.error ? `<span class="k">last error</span><pre>${esc(n.error)}</pre>` : "") +
      `<span class="k">recent</span><ul>${n.recent.map((r) => `<li>${esc(r) || "—"}</li>`).join("")}</ul>`;
  }
  box.innerHTML = html;
}

function describe(e) {
  const isSpawn = e.tool === "Agent" || e.tool === "Task";
  switch (e.event) {
    case "UserPromptSubmit": return /^\s*<task-notification>/.test(e.prompt || "") ? ["", "background task finished"] : ["prompt", "directive: " + esc(e.prompt)];
    case "Stop": return ["", "done, waiting for you"];
    case "SessionStart": return ["", "session " + esc(e.source || "start")];
    case "SubagentStart": return ["", "online"];
    case "SubagentStop": return ["", "reported back"];
    case "PermissionRequest": return ["", `asked AXA to approve: ${esc(humanAction(e.tool, e.summary) || e.tool)}`];
    case "AxaDecision":
      return e.decision === "allow" ? ["", `AXA approved: ${esc(e.reason)}`]
        : e.decision === "deny" ? ["fail", `AXA declined: ${esc(e.reason)}`]
        : ["perm", `needs your approval (${esc(e.reason)}): ${esc(e.summary)}`];
    case "Notification": return /permission/i.test(e.notification_type || "") ? ["perm", "waiting for your approval"] : null;
    case "UserAnswer": return ["", `you answered: <b>${esc(e.answer)}</b>`];
    case "VerifyGate": return ["perm", `AXA verify gate: sent back to check its work (${esc(e.summary)})`];
    case "PostToolUseFailure": return ["fail", `${esc(toolName(e.tool))} failed: ${esc(e.error)}`];
    case "PreToolUse": {
      if (isSpawn) return ["call", `started a helper (<b>${esc(roleFor(e.subagent_type))}</b>): ${esc(e.summary)}`];
      const a = humanAction(e.tool, e.summary, e.skill);
      return a ? ["", esc(a)] : null;
    }
  }
  return null;
}
let feedFor = null, feedCount = 0;
function renderFeed(g) {
  const feed = $("feed");
  if (!g) { feed.replaceChildren(); feedFor = null; return; }
  if (feedFor !== g.id) { feed.replaceChildren(); feedFor = g.id; feedCount = 0; }
  const frag = document.createDocumentFragment();
  for (const e of g.events.slice(feedCount)) {
    const d = describe(e); if (!d) continue;
    const row = document.createElement("div");
    row.className = "row " + d[0];
    const who = e.agent_id ? roleFor(e.agent_type) : "axa";
    const color = e.agent_id ? roleMeta(who).color : C.accent;
    row.innerHTML = `<span class="t">${new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span><span class="who" style="color:${color}">${esc(who)}</span><span class="what">${d[1]}</span>`;
    row.title = row.textContent;
    if (e.agent_id) row.onclick = () => { selectedId = e.agent_id; dirty = true; };
    frag.prepend(row);
  }
  feedCount = g.events.length;
  feed.prepend(frag);
  while (feed.childElementCount > 800) feed.lastChild.remove();
}

// bottom dock: one card per job that is running or finished recently
const DOCK_KEEP_MS = 20000;
const cardEls = new Map();
function renderDock(g) {
  const dock = $("dock"), wrap = $("cards");
  // Mission view: helpers from this turn stay until your next message, so you can see what they found
  const keepDone = (n) => (mission ? n.end >= (g.turnStart || 0) : Date.now() - n.end < DOCK_KEEP_MS);
  const jobs = g ? [...g.nodes.values()].filter((n) => n.kind === "inst" && (n.status === "running" || keepDone(n))).sort((a, b) => (a.status === "running") - (b.status === "running") || (a.end || a.start) - (b.end || b.start)).reverse() : [];
  dock.classList.toggle("on", jobs.length > 0);
  const all = g ? [...g.nodes.values()].filter((n) => n.kind === "inst") : [];
  const done = all.filter((n) => n.status === "done").length;
  $("mbar").style.width = all.length ? (done / all.length) * 100 + "%" : "0";
  $("mtext").innerHTML = `<b>${done}</b> / ${all.length} jobs complete`;
  const keep = new Set(jobs.map((j) => j.id));
  for (const [id, el] of cardEls) if (!keep.has(id) || !wrap.contains(el)) { el.remove(); cardEls.delete(id); }
  for (const j of jobs) {
    let el = cardEls.get(j.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "card";
      el.innerHTML = `<div class="top"><span class="role"></span><span class="time"></span></div><div class="task"></div><div class="bar"><i></i></div><div class="now"><span></span><span class="st"></span></div>`;
      el.onclick = () => { selectedId = j.id; dirty = true; };
      wrap.appendChild(el); cardEls.set(j.id, el);
    }
    wrap.appendChild(el);
    // a helper's state in the shared vocabulary (a failed step: it's retrying)
    const state = j.status === "done" ? "done" : j.perm ? "waiting" : j.fail ? "failed" : "working";
    el.className = `card ${state}${!mission && j.status === "done" && Date.now() - j.end > DOCK_KEEP_MS / 2 ? " fading" : ""}`;
    el.style.setProperty("--c", j.color);
    el.querySelector(".role").textContent = j.role;
    el.querySelector(".time").textContent = dur((j.end || Date.now()) - j.start);
    el.querySelector(".task").textContent = j.desc || "working…";
    el.querySelector(".task").title = j.desc || "";
    el.querySelector(".now span").innerHTML = j.status === "done" ? (j.message ? esc(j.message.replace(/\s+/g, " ").slice(0, 140)) : `<b>${j.steps || 0}</b> steps`) : j.perm ? `needs ok: <b>${esc(j.perm === true ? "tool" : j.perm)}</b>` : `<b>${esc(j.now || "starting")}</b>`;
    el.querySelector(".st").innerHTML = statusHtml(state, state === "failed" ? " · retrying" : state === "working" ? ` · ${j.steps || 0} steps` : "");
    el.title = j.status === "done" ? "Click to read its full report" : "";
  }
}

function renderChrome(g) {
  renderDock(g);
  $("empty").style.display = g || mission ? "none" : "grid";
  if (!g && !locked) $("empty").innerHTML = focusCwd ? `Standing by<br><br>No activity in ${esc(focusCwd.split("/").pop())} yet` : "Standing by<br><br>Start a Claude Code session with AXA enabled — or run the demo";
  const projects = projectSessions();
  $("s-agents").textContent = projects.length;
  $("s-running").textContent = projects.filter((p) => LK.statusOf(p) === "working").length;
  $("s-calls").textContent = projects.filter((p) => LK.statusOf(p) === "done").length;
  // "Needs you": waiting on an approval, stuck long enough to need a look, or stopped by a failure
  const waiting = projects.filter(LK.needsYou).sort(LK.byUrgency);
  $("needs").classList.toggle("on", waiting.length > 0);
  $("needsg").textContent = LK.lookOf("waiting").glyph; $("needsw").textContent = LK.lookOf("waiting").word;
  $("needsn").textContent = waiting.length;
  $("needs").title = waiting.length ? waiting.map((p) => `${p.name}: ${LK.label(p)}`).join(" · ") : "";
  renderNow(g, waiting);
  const sel = $("session");
  const list = [...sessions.values()].sort((a, b) => b.last - a.last).slice(0, 30);
  const sig = list.map((s) => s.id).join();
  if (sel.dataset.sig !== sig) {
    sel.replaceChildren(...list.map((s) => {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.id === "demo" ? "Demo run" : `${(s.cwd || "").split("/").pop() || "~"} · ${new Date(s.last).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
      return o;
    }));
    sel.dataset.sig = sig;
  }
  sel.value = current || "";
}
$("session").onchange = (ev) => { current = ev.target.value; pinned = true; focusCwd = null; selectedId = "axa"; autoFit = true; dirty = true; };

let focusCwd = null; // set while a terminal tab is active: the map follows that project
function follow() {
  if (pinned && sessions.has(current)) return;
  if (mission) {
    let best = null;
    for (const s of sessions.values()) if (s.role === "commander" && (!best || s.last > best.last)) best = s;
    if (!best) for (const s of sessions.values()) if (s.role !== "worker" && (!best || s.last > best.last)) best = s;
    if (best && best.id !== current) { current = best.id; selectedId = "axa"; dirty = true; }
    return;
  }
  let best = null;
  for (const s of sessions.values()) {
    if (focusCwd && !(s.cwd || "").startsWith(focusCwd)) continue;
    if (!best || s.last > best.last) best = s;
  }
  if (best && best.id !== current) { current = best.id; selectedId = "axa"; autoFit = true; dirty = true; }
  if (!best && focusCwd && current) { current = null; dirty = true; } // this project has no activity yet
}

// ---------- loop ----------
let dirty = true, lastPanel = 0;
const idle = newGraph("idle", "");
// a new theme: every node takes its role's color in it, and the feed is drawn again in it
onTheme(() => {
  for (const g of [...sessions.values(), idle]) for (const n of g.nodes.values()) if (n.kind === "axa") n.color = C.accent; else if (n.role) n.color = roleMeta(n.role).color;
  feedFor = null; dirty = true;
});
function frame(now) {
  follow();
  const g = sessions.get(current) || (mission ? idle : undefined);
  if (g) { step(g); if (autoFit) fit(g); }
  draw(g, now);
  placePlanets();
  if (dirty || now - lastPanel > 1000) { renderDetail(g); renderFeed(g); renderChrome(g); dirty = false; lastPanel = now; }
  requestAnimationFrame(frame);
}

// ---------- map layout you choose (drag cards and AXA's tag; remembered in this browser) ----------
let mapLayout = { planets: {}, callout: null };
try { mapLayout = { planets: {}, callout: null, ...JSON.parse(localStorage.getItem("axa.mapLayout") || "{}") }; } catch {}
const saveMapLayout = () => { try { localStorage.setItem("axa.mapLayout", JSON.stringify(mapLayout)); } catch {} };
let calloutBox = null; // where AXA's tag was last drawn (world coordinates), for grabbing it
