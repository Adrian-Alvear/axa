// AXA console: project sessions as planets on the map and as the sessions list

// ---------- mission view: project sessions around AXA ----------
let mission = true;
try { mission = localStorage.getItem("axa.view") !== "detail"; } catch {}
const PLANET_R = 300;
let terms = []; // latest /api/terms
const projectSessions = () => terms.filter((t) => t.mode !== "axa");
const planetEls = new Map();
const ago = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };
function planetPos(i, n, p) {
  if (p && mapLayout.planets[p.name]) return mapLayout.planets[p.name];
  const a = -Math.PI / 2 + (i * Math.PI * 2) / Math.max(n, 1) + (n === 2 ? Math.PI / 2 : 0);
  return [Math.cos(a) * PLANET_R, Math.sin(a) * PLANET_R * 0.78];
}
function planetDetail(p) {
  if (LK.statusOf(p) === "failed") return p.error ? `Stopped: ${p.error}` : "Stopped by a failure";
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
    const st = LK.statusOf(p);
    el.className = `planet ${st}${LK.needsYou(p) ? " hot" : ""}`;
    el.style.setProperty("--c", roleVar(LK.lookOf(st).role));
    el.querySelector(".name").textContent = p.name;
    el.querySelector(".mode").textContent = p.mode === "shell" ? "sh" : "";
    const since = st === "working" ? "" : ` · ${ago(p.idle_seconds * 1000)}`;
    el.querySelector(".ps").textContent = LK.label(p) + since;
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

// ---------- sessions list: urgency first (needs you, stuck, working, done, idle, ended; look.mjs) ----------
const inboxEls = new Map();
const isPhone = () => matchMedia("(max-width: 860px)").matches;
function openSession(p) {
  setTermsOpen(true); if (!tabs.has(p.id)) openTab(p); activate(p.id);
  if (isPhone()) requestAnimationFrame(() => $("terms").scrollIntoView({ behavior: "smooth" }));
}
function renderInbox() {
  const list = projectSessions().slice().sort(LK.byUrgency);
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
    const st = LK.statusOf(p);
    el.dataset.state = st;
    el.classList.toggle("hot", LK.needsYou(p));
    el.style.setProperty("--c", roleVar(LK.lookOf(st).role));
    el.querySelector(".chip").textContent = LK.label(p);
    el.querySelector(".nm").textContent = p.name;
    el.querySelector(".ago").textContent = st === "working" ? "" : ago(p.idle_seconds * 1000);
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
    el.querySelector("[data-a=open]").classList.toggle("hot", LK.needsYou(p));
    el.querySelector("[data-a=diff]").hidden = !p.git?.files;
    el.title = `${p.name} · ${p.cwd}`;
  }
  let none = host.querySelector(".none");
  if (!list.length && !none) { none = document.createElement("div"); none.className = "none"; none.textContent = "No project sessions yet. Ask AXA, or open one with Terminals → +"; host.appendChild(none); }
  if (list.length && none) none.remove();
  const count = (s) => list.filter((p) => LK.statusOf(p) === s).length, G = (s) => LK.lookOf(s).glyph;
  const needs = list.filter(LK.needsYou).length;
  $("inboxsum").innerHTML = [needs && `<span class="stx" style="--c:var(--warn)">${G("waiting")} ${needs} ${LK.lookOf("waiting").word}</span>`, count("working") && `<span class="stx" style="--c:var(--accent)">${G("working")} ${count("working")} working</span>`, count("done") && `<span class="stx" style="--c:var(--ok)">${G("done")} ${count("done")} done</span>`].filter(Boolean).join(" · ");
  $("mbadge").textContent = needs || "";
}
