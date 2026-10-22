// AXA console: project sessions as planets on the map and as cards (Home's "Needs you", the Sessions view)

// ---------- mission view: project sessions around AXA ----------
let mission = true;
try { mission = localStorage.getItem("axa.view") !== "detail"; } catch {}
const PLANET_R = 300;
let terms = []; // latest /api/terms (plus the demo's sessions while it plays)
let termsLoaded = false, termsError = "", termsOffline = false; // for the loading and error states
const projectSessions = () => terms.filter((t) => t.mode !== "axa");
const planetEls = new Map();
const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
function planetPos(i, n, p) {
  if (p && mapLayout.planets[p.name]) return mapLayout.planets[p.name];
  const a = -Math.PI / 2 + (i * Math.PI * 2) / Math.max(n, 1) + (n === 2 ? Math.PI / 2 : 0);
  return [Math.cos(a) * PLANET_R, Math.sin(a) * PLANET_R * 0.78];
}
// one line on what a session is doing (or why it needs you)
function planetDetail(p) {
  const st = LK.statusOf(p), why = LK.reasonOf(p);
  if (st === "failed") return why ? `Stopped: ${why}` : p.error ? `Stopped: ${p.error}` : "Stopped by a failure";
  if (st === "waiting") return humanAction(p.tool, p.summary) ? `Wants to: ${humanAction(p.tool, p.summary)}` : "Waiting for your approval in its terminal";
  if (st === "working") return humanAction(p.tool, p.summary, p.skill) || "Thinking";
  if (st === "stuck") return why ? `Stuck: ${why}` : `No activity for a while · running ${p.stuck_minutes ?? "?"}m: ${humanAction(p.tool, p.summary, p.skill) || "a step"}`;
  if (st === "done") return p.last_report ? p.last_report.replace(/\s+/g, " ") : "Finished";
  if (st === "exited") return "Session ended";
  if (st === "starting") return "Starting up";
  return p.mode === "shell" ? "Shell" : "Ready for instructions";
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
          else openSession(terms.find((x) => x.id === p.id) || p);
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
    el.querySelector(".ps").textContent = statusText(p) + since;
    el.querySelector(".pd").textContent = planetDetail(p);
    el.querySelector(".pe").textContent = p.error && st !== "done" && st !== "failed" ? `last error: ${p.error}` : "";
    el.querySelector(".pg").innerHTML = [gitHtml(p.git), spendHtml(p)].filter(Boolean).join(" · ");
    el.title = `${p.name} · ${p.cwd}\nClick to open its terminal`;
  }
}

// "v7-polish · 3 files +40 −2 · ↑1": the session's uncommitted work, so you can tell "done" from "done and changed things"
function gitHtml(g) {
  if (!g) return "";
  const files = g.files ? `${g.files} file${g.files > 1 ? "s" : ""} <span class="add">+${g.added}</span> <span class="del">−${g.removed}</span>` : "no changes";
  return `<span class="git">⎇ ${esc(g.branch)}</span> · ${files}${g.ahead ? ` · ↑${g.ahead} not pushed` : ""}`;
}

// "1.2M tok" (amber and flagged when over the budget set in ~/.axa/policy.json)
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const usageHtml = (u) => (!u ? "" : u.over_budget ? `<span class="over">${glyphOf("waiting")} ${fmtTok(u.tokens)} tok · over ${fmtTok(u.budget)} budget</span>` : `${fmtTok(u.tokens)} tok${u.budget ? ` of ${fmtTok(u.budget)}` : ""}`);
const fmtUsd = (v) => (v == null || !Number.isFinite(Number(v)) ? "" : Number(v) >= 100 ? `$${Math.round(v)}` : `$${Number(v).toFixed(2)}`);
// a session's spend: USD and context use when the server knows them (cost, Phase 4), else tokens
function spendHtml(p) {
  const c = p.cost, parts = [];
  if (c && typeof c === "object") {
    if (c.usd != null) parts.push(`<span class="usd">${fmtUsd(c.usd)}</span>`);
    if (c.context_pct != null) { const pct = Math.round(c.context_pct); parts.push(pct >= 80 ? `<span class="over">ctx ${pct}%</span>` : `ctx ${pct}%`); }
    if (c.model) parts.push(esc(String(c.model).replace(/^claude-/, "")));
  }
  const u = usageHtml(p.usage);
  if (u && (!parts.length || p.usage?.over_budget)) parts.push(u);
  return parts.join(" · ");
}
// GitHub, read-only (Phase 4): the branch's pull request and its checks, or the latest CI run
const CHECK_ROLE = { passing: "ok", failing: "bad", pending: "warn" };
function githubHtml(gh) {
  if (!gh || typeof gh !== "object") return "";
  const out = [], link = (url, html, title) => (/^https:\/\//.test(url || "") ? `<a class="ghl" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${html}</a>` : `<span class="ghl" title="${esc(title)}">${html}</span>`);
  const pr = gh.pr;
  if (pr && typeof pr.number === "number") {
    const state = pr.draft ? "draft" : pr.state || "open";
    const checks = pr.checks ? ` · <span style="color:var(--${CHECK_ROLE[pr.checks] || "dim"})">checks ${esc(pr.checks)}</span>` : "";
    const review = pr.review ? ` · ${esc(String(pr.review).replace(/_/g, " "))}` : "";
    out.push(link(pr.url, `${icon("pr")}#${pr.number} ${esc(state)}${checks}${review}`, `Pull request #${pr.number}: ${state}${pr.checks ? `, checks ${pr.checks}` : ""}`));
  }
  const ci = gh.ci;
  if (ci && (!pr || !pr.checks)) {
    const word = ci.conclusion || ci.status || "unknown", role = /success/.test(word) ? "ok" : /fail|cancel|timed/.test(word) ? "bad" : "warn";
    out.push(link(ci.url, `${icon("ci")}<span style="color:var(--${role})">CI ${esc(word.replace(/_/g, " "))}</span>`, `${ci.name || "CI"}: ${word}`));
  }
  return out.join(" ");
}

// Answer a session's prompt: first tap arms the option (so a stray tap on a phone does nothing), the
// second sends it. The server checks the same prompt is still on screen before typing the number.
async function answer(p, b, done) {
  // (the button's own markup is kept and put back: the sheet's buttons hold a number badge and a label)
  const restore = (x) => { x.classList.remove("armed"); if (x._html != null) { x.innerHTML = x._html; x._html = null; } };
  if (!b.classList.contains("armed")) {
    for (const x of b.parentElement.querySelectorAll("button")) restore(x);
    const o = p.choices?.options.find((v) => v.n === Number(b.dataset.n));
    b._html = b.innerHTML; b.classList.add("armed"); b.textContent = `Tap again to send: ${o ? `${o.n}. ${o.label}` : b.textContent}`;
    clearTimeout(b._t); b._t = setTimeout(() => restore(b), 4000);
    return;
  }
  clearTimeout(b._t); b.disabled = true;
  const opt = p.choices?.options.find((o) => o.n === Number(b.dataset.n));
  let ok = false, error = "";
  if (p.demo) { ok = true; demoAnswer(p, opt); } // the demo's sessions answer themselves
  else {
    try {
      const r = await fetch(`/api/terms/${p.id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: opt?.n, label: opt?.label, question: p.choices?.question }) });
      const body = await r.json().catch(() => ({}));
      ok = r.ok; error = body.error || "Couldn't answer it";
    } catch { error = "The console is unreachable"; }
  }
  b.disabled = false; restore(b);
  if (ok) { toast(`Answered ${p.name}: ${opt?.label || ""}`); done?.(); } else toast(error, "bad");
  pollNow();
}

// ---------- session cards: Home's "Needs you" and the Sessions view, urgency first (look.mjs) ----------
const isPhone = () => matchMedia("(max-width: 860px)").matches;
const termOf = (p) => terms.find((x) => x.id === p.id) || p;
function openSession(p) {
  if (p.demo) return toast("A demo session: it has no terminal");
  showTerminal(p.id, p);
}
// a session newly needing you flashes once (not on the first load)
let needsKnown = null;
function freshNeeds(list) {
  const now = new Set(list.filter(LK.needsYou).map((p) => p.id + ":" + LK.statusOf(p)));
  const fresh = needsKnown ? new Set([...now].filter((k) => !needsKnown.has(k)).map((k) => k.split(":")[0])) : new Set();
  needsKnown = now;
  return fresh;
}
function cardEl(id) {
  const el = document.createElement("div");
  el.className = "sess"; el.tabIndex = 0; el.dataset.nav = "1"; el.dataset.id = id;
  el.innerHTML = `<div class="sh"><span class="chip"></span><b class="nm"></b><span class="md"></span><span class="ago"></span></div><div class="sd"></div><div class="sg"></div><div class="gh"></div><div class="sq"></div><div class="sc"></div><div class="sa"><button data-a="answer" class="hot">${icon("arrow")}Answer</button><button data-a="open">${icon("terminal")}<span>Open</span></button><button data-a="diff">${icon("diff")}Changes</button></div>`;
  el.onclick = (ev) => {
    if (ev.target.closest("a")) return; // a GitHub link opens on its own
    const cur = termOf({ id }), b = ev.target.closest("button");
    if (b?.dataset.n) return answer(cur, b);
    if (b?.dataset.a === "answer") return openAsk(cur);
    if (b?.dataset.a === "diff") return showDiff(cur);
    if (!b && cur.status === "waiting" && cur.choices && isPhone()) return openAsk(cur);
    openSession(cur);
  };
  el.addEventListener("animationend", () => el.classList.remove("flash"));
  return el;
}
function fillCard(el, p, fresh) {
  const st = LK.statusOf(p);
  if (el.dataset.state && el.dataset.state !== st) el.classList.add("changed");
  el.dataset.state = st;
  el.classList.toggle("hot", LK.needsYou(p));
  if (fresh?.has(p.id)) el.classList.add("flash");
  el.style.setProperty("--c", roleVar(LK.lookOf(st).role));
  el.querySelector(".chip").textContent = statusText(p);
  el.querySelector(".nm").textContent = p.name;
  el.querySelector(".md").textContent = p.mode === "shell" ? "sh" : p.worktree ? "worktree" : "";
  el.querySelector(".ago").textContent = st === "working" ? "" : ago((p.idle_seconds || 0) * 1000);
  el.querySelector(".sd").textContent = planetDetail(p) + (p.error && st !== "done" && st !== "failed" ? ` · last error: ${p.error}` : "");
  el.querySelector(".sg").innerHTML = [gitHtml(p.git), spendHtml(p)].filter(Boolean).join(" · ");
  el.querySelector(".gh").innerHTML = githubHtml(p.github);
  // The prompt it's waiting on, answerable here: a tap arms an option, a second tap sends it
  const c = st === "waiting" ? p.choices : null, sig = c ? c.question + c.options.map((o) => o.label).join("|") : "";
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.querySelector(".sq").textContent = c ? c.question : "";
    el.querySelector(".sc").innerHTML = c ? c.options.map((o) => `<button data-n="${o.n}" title="${esc(o.label)}">${o.n}. ${esc(o.label)}</button>`).join("") : "";
  }
  el.querySelector("[data-a=answer]").hidden = !c;
  el.querySelector("[data-a=open] span").textContent = st === "waiting" ? (c ? "Terminal" : "Answer in terminal") : st === "stuck" || st === "failed" ? "Look" : "Open";
  el.querySelector("[data-a=open]").classList.toggle("hot", LK.needsYou(p) && !c);
  el.querySelector("[data-a=diff]").hidden = !p.git?.files;
  el.title = `${p.name} · ${p.cwd || ""}`;
}
// keyed render: the same element per session, in sorted order
function renderCards(host, list, els, fresh) {
  for (const s of host.querySelectorAll(":scope > .skel")) s.remove(); // the first paint's placeholders
  const keep = new Set(list.map((p) => p.id));
  for (const [id, el] of els) if (!keep.has(id)) { el.remove(); els.delete(id); }
  for (const p of list) {
    let el = els.get(p.id);
    if (!el) { el = cardEl(p.id); els.set(p.id, el); }
    host.appendChild(el);
    fillCard(el, p, fresh);
  }
}

// the designed states: loading, can't reach the console, locked, nothing yet
function stateHtml(kind, title, body = "", actions = "") {
  return `<div class="state ${kind}"><span class="sicon">${icon({ loading: "runs", error: "offline", locked: "shield", empty: "ci", quiet: "ci" }[kind] || "ci")}</span><b>${title}</b>${body ? `<p>${body}</p>` : ""}${actions ? `<div class="sact">${actions}</div>` : ""}</div>`;
}
function placeState(host, html) {
  let s = host.querySelector(":scope > .stateslot");
  if (!html) { s?.remove(); return; }
  if (!s) { s = document.createElement("div"); s.className = "stateslot"; host.appendChild(s); }
  if (s.dataset.html !== html) { s.innerHTML = html; s.dataset.html = html; }
  host.appendChild(s);
}
const inboxEls = new Map();
function renderInbox() {
  const list = projectSessions().slice().sort(LK.byUrgency), host = $("sesslist");
  const fresh = freshNeeds(list);
  renderCards(host, list, inboxEls, fresh);
  placeState(host, list.length ? "" : !termsLoaded ? stateHtml("loading", "Loading sessions…") : termsError ? stateHtml("error", "Can't list the sessions", esc(termsError), `<button data-act="retry">Try again</button>`)
    : stateHtml("empty", "No project sessions yet", "Ask AXA to start one, or open one here.", `<button data-act="new">${icon("plus")}New session</button><button data-act="demo">${icon("play")}Play the demo</button>`));
  const count = (s) => list.filter((p) => LK.statusOf(p) === s).length;
  const needs = list.filter(LK.needsYou).length;
  $("inboxsum").innerHTML = [needs && `<span class="stx" style="--c:var(--warn)">${glyphOf("waiting")} ${needs} ${LK.lookOf("waiting").word}</span>`, count("working") && statusHtml("working", "").replace("working", `${count("working")} working`), count("done") && statusHtml("done").replace("done", `${count("done")} done`), list.length && `${list.length} in all`].filter(Boolean).join(" · ");
  $("mbadge").textContent = $("nbadge").textContent = needs || "";
  renderHome(list, fresh);
}
// buttons inside the designed states
document.addEventListener("click", (ev) => {
  const b = ev.target.closest(".state [data-act]"); if (!b) return;
  if (b.dataset.act === "retry") { termsError = ""; refreshTerms(); }
  if (b.dataset.act === "new") newSession();
  if (b.dataset.act === "demo") { go("map"); demo(); }
  if (b.dataset.act === "since") { awaySince = Date.now() - 864e5; loadAway(); }
});
$("newsess").onclick = () => newSession();
