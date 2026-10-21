// AXA console: project sessions as planets on the map and as the sessions list

// ---------- mission view: project sessions around AXA ----------
let mission = true;
try { mission = localStorage.getItem("axa.view") !== "detail"; } catch {}
const PLANET_R = 300;
let terms = []; // latest /api/terms
const projectSessions = () => terms.filter((t) => t.mode !== "axa");
const planetEls = new Map();
const STATUS_TEXT = { starting: "starting", ready: "ready", shell: "$ shell", working: "working", done: "✓ done", waiting: "⚠ needs you", stuck: "⏳ stuck", exited: "exited" };
const ago = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };
function planetPos(i, n, p) {
  if (p && mapLayout.planets[p.name]) return mapLayout.planets[p.name];
  const a = -Math.PI / 2 + (i * Math.PI * 2) / Math.max(n, 1) + (n === 2 ? Math.PI / 2 : 0);
  return [Math.cos(a) * PLANET_R, Math.sin(a) * PLANET_R * 0.78];
}
function planetDetail(p) {
  if (p.status === "waiting") return humanAction(p.tool, p.summary) ? `Wants to: ${humanAction(p.tool, p.summary)}` : "Waiting for your approval in its terminal";
  if (p.status === "working") return humanAction(p.tool, p.summary, p.skill) || "Thinking";
  if (p.status === "stuck") return `No activity for a while · running ${p.stuck_minutes ?? "?"}m: ${humanAction(p.tool, p.summary, p.skill) || "a step"}`;
  if (p.status === "done") return p.last_report ? p.last_report.replace(/\s+/g, " ") : "Finished";
  if (p.status === "exited") return "Session ended";
  return p.mode === "shell" ? "Shell" : "Waiting for instructions";
}
function renderPlanets() {
  const host = $("planets"), list = projectSessions();
  const keep = new Set(list.map((p) => p.id));
  for (const [id, el] of planetEls) if (!keep.has(id)) { el.remove(); planetEls.delete(id); }
  for (const p of list) {
    let el = planetEls.get(p.id);
    if (!el) {
      el = document.createElement("div");
      el.innerHTML = `<div class="pn"><span class="name"></span><span class="mode"></span></div><div class="ps"></div><div class="pd"></div><div class="pg"></div><div class="pe"></div>`;
      // Drag to move it (remembered per project); a plain click opens its terminal
      el.onpointerdown = (ev) => {
        if (ev.button !== 0) return;
        const start = { x: ev.clientX, y: ev.clientY, moved: false };
        el.setPointerCapture(ev.pointerId);
        el.onpointermove = (e) => {
          if (!start.moved && Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) < 5) return;
          start.moved = true; el.classList.add("dragging");
          const r = cv.getBoundingClientRect();
          mapLayout.planets[p.name] = toWorld(e.clientX - r.left, e.clientY - r.top);
        };
        el.onpointerup = () => {
          el.onpointermove = el.onpointerup = null; el.classList.remove("dragging");
          if (start.moved) saveMapLayout();
          else { setTermsOpen(true); if (!tabs.has(p.id)) openTab(p); activate(p.id); }
        };
      };
      host.appendChild(el); planetEls.set(p.id, el);
    }
    el.className = `planet ${p.status}`;
    el.querySelector(".name").textContent = p.name;
    el.querySelector(".mode").textContent = p.mode === "shell" ? "sh" : "";
    const since = p.status === "working" ? "" : ` · ${ago(p.idle_seconds * 1000)}`;
    el.querySelector(".ps").textContent = (STATUS_TEXT[p.status] || p.status) + since;
    el.querySelector(".pd").textContent = planetDetail(p);
    el.querySelector(".pe").textContent = p.error && p.status !== "done" ? `last error: ${p.error}` : "";
    el.querySelector(".pg").innerHTML = [gitHtml(p.git), usageHtml(p.usage)].filter(Boolean).join(" · ");
    el.title = `${p.name} · ${p.cwd}\nClick to open its terminal`;
  }
}

// "⎇ v7-polish · 3 files +40 −2 · ↑1": the session's uncommitted work, so you can tell "done" from "done and changed things"
function gitHtml(g) {
  if (!g) return "";
  const files = g.files ? `${g.files} file${g.files > 1 ? "s" : ""} <span class="add">+${g.added}</span> <span class="del">−${g.removed}</span>` : "no changes";
  return `⎇ ${esc(g.branch)} · ${files}${g.ahead ? ` · ↑${g.ahead} not pushed` : ""}`;
}

// "1.2M tok" (amber and flagged when over the budget set in ~/.axa/policy.json)
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const usageHtml = (u) => (!u ? "" : u.over_budget ? `<span class="over">⚠ ${fmtTok(u.tokens)} tok · over ${fmtTok(u.budget)} budget</span>` : `${fmtTok(u.tokens)} tok${u.budget ? ` of ${fmtTok(u.budget)}` : ""}`);

// Answer a session's prompt: first tap arms the option (so a stray tap on a phone does nothing), the
// second sends it. The server checks the same prompt is still on screen before typing the number.
async function answer(p, b) {
  if (!b.classList.contains("armed")) {
    for (const x of b.parentElement.querySelectorAll("button")) { x.classList.remove("armed"); if (x.dataset.label) x.textContent = x.dataset.label; }
    b.dataset.label = b.textContent; b.classList.add("armed"); b.textContent = `Tap again: ${b.dataset.label}`;
    clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove("armed"); b.textContent = b.dataset.label; }, 4000);
    return;
  }
  clearTimeout(b._t); b.disabled = true;
  const opt = p.choices?.options.find((o) => o.n === Number(b.dataset.n));
  const r = await fetch(`/api/terms/${p.id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: opt?.n, label: opt?.label, question: p.choices?.question }) });
  const body = await r.json().catch(() => ({}));
  b.disabled = false; b.classList.remove("armed"); b.textContent = b.dataset.label;
  if (!r.ok) alert(body.error || "Couldn't answer it");
  pollNow();
}

// ---------- sessions list: urgency first (needs you, stuck, working, done, idle, ended) ----------
const URGENCY = { waiting: 0, stuck: 1, working: 2, done: 3, ready: 4, shell: 4, starting: 5, exited: 6 };
const inboxEls = new Map();
const isPhone = () => matchMedia("(max-width: 860px)").matches;
function openSession(p) {
  setTermsOpen(true); if (!tabs.has(p.id)) openTab(p); activate(p.id);
  if (isPhone()) requestAnimationFrame(() => $("terms").scrollIntoView({ behavior: "smooth" }));
}
function renderInbox() {
  const list = projectSessions().slice().sort((a, b) => (URGENCY[a.status] ?? 9) - (URGENCY[b.status] ?? 9) || (b.last_event_at || b.created) - (a.last_event_at || a.created));
  const host = $("sesslist");
  const keep = new Set(list.map((p) => p.id));
  for (const [id, el] of inboxEls) if (!keep.has(id)) { el.remove(); inboxEls.delete(id); }
  for (const p of list) {
    let el = inboxEls.get(p.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "sess"; el.tabIndex = 0;
      el.innerHTML = `<div class="sh"><span class="chip"></span><b class="nm"></b><span class="ago"></span></div><div class="sd"></div><div class="sg"></div><div class="sq"></div><div class="sc"></div><div class="sa"><button data-a="open">Open</button><button data-a="diff">Changes</button></div>`;
      el.onclick = (ev) => {
        const cur = terms.find((x) => x.id === p.id) || p, b = ev.target.closest("button");
        if (b?.dataset.n) return answer(cur, b);
        if (b?.dataset.a === "diff") showDiff(cur); else openSession(cur);
      };
      el.onkeydown = (ev) => { if (ev.key === "Enter" && ev.target === el) openSession(terms.find((x) => x.id === p.id) || p); };
      inboxEls.set(p.id, el);
    }
    host.appendChild(el); // keeps the sorted order
    el.dataset.state = p.status;
    el.querySelector(".chip").textContent = STATUS_TEXT[p.status] === "working" ? "● working" : STATUS_TEXT[p.status] || p.status;
    el.querySelector(".nm").textContent = p.name + (p.mode === "shell" ? " · sh" : "");
    el.querySelector(".ago").textContent = p.status === "working" ? "" : ago(p.idle_seconds * 1000);
    el.querySelector(".sd").textContent = planetDetail(p) + (p.error && p.status !== "done" ? ` · last error: ${p.error}` : "");
    el.querySelector(".sg").innerHTML = [gitHtml(p.git), usageHtml(p.usage)].filter(Boolean).join(" · ");
    // The prompt it's waiting on, answerable here: a tap arms an option, a second tap sends it
    const c = p.status === "waiting" ? p.choices : null, sig = c ? c.question + c.options.map((o) => o.label).join("|") : "";
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.querySelector(".sq").textContent = c ? c.question : "";
      el.querySelector(".sc").innerHTML = c ? c.options.map((o) => `<button data-n="${o.n}" title="${esc(o.label)}">${o.n}. ${esc(o.label)}</button>`).join("") : "";
    }
    el.querySelector("[data-a=open]").textContent = p.status === "waiting" ? (c ? "Terminal" : "Answer it") : p.status === "stuck" ? "Look" : "Open";
    el.querySelector("[data-a=open]").classList.toggle("hot", p.status === "waiting" || p.status === "stuck");
    el.querySelector("[data-a=diff]").hidden = !p.git?.files;
    el.title = `${p.name} · ${p.cwd}`;
  }
  let none = host.querySelector(".none");
  if (!list.length && !none) { none = document.createElement("div"); none.className = "none"; none.textContent = "No project sessions yet. Ask AXA, or open one with Terminals → +"; host.appendChild(none); }
  if (list.length && none) none.remove();
  const count = (s) => list.filter((p) => p.status === s).length;
  const needs = count("waiting") + count("stuck");
  $("inboxsum").innerHTML = [needs && `<span class="w">⚠ ${needs} need${needs > 1 ? "" : "s"} you</span>`, count("working") && `${count("working")} working`, count("done") && `${count("done")} done`].filter(Boolean).join(" · ");
  $("mbadge").textContent = needs || "";
}
