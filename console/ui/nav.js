// AXA console: the views (Home, Sessions, Map, Runs, Settings), the header orb, the map's Now bar,
// the browser-tab title and desktop notifications, toasts

// ---------- views: one at a time, crossfaded; remembered in the address (#runs) and this browser ----------
const VIEWS = ["home", "sessions", "map", "runs", "settings"];
let viewNow = "home";
function go(view, { focus = false } = {}) {
  if (!VIEWS.includes(view)) view = "home";
  const changed = view !== viewNow;
  viewNow = view;
  document.body.dataset.view = view;
  document.body.classList.remove("pane-terminal"); // phones: leave the terminal for the page
  for (const s of document.querySelectorAll("#views > .view")) {
    const on = s.dataset.view === view;
    if (on && s.hidden) { s.hidden = false; s.classList.remove("enter"); void s.offsetWidth; s.classList.add("enter"); }
    else if (!on) s.hidden = true;
  }
  for (const b of document.querySelectorAll("#tnav button")) { b.classList.toggle("on", b.dataset.view === view); b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false"); }
  markPhoneTab();
  closeSheet("more");
  try { localStorage.setItem("axa.viewNow", view); } catch {}
  if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
  if (view === "map") { autoFit = true; dirty = true; requestAnimationFrame(resize); }
  if (view === "runs" && changed && LK) loadRuns();
  if (view === "home" && changed && LK) loadAway();
  if (view === "settings") syncControls();
  if (focus) document.querySelector(`#views > .view[data-view="${view}"] [data-nav]`)?.focus();
}
for (const b of document.querySelectorAll("#tnav button, #more [data-view]")) b.onclick = () => go(b.dataset.view);
addEventListener("hashchange", () => { const v = location.hash.slice(1); if (VIEWS.includes(v) && v !== viewNow) go(v); });

// the phone's bottom tabs: Home, Sessions, Terminal, More (Map, Runs, Settings)
function markPhoneTab() {
  const term = document.body.classList.contains("pane-terminal");
  const tab = term ? "terminal" : viewNow === "home" || viewNow === "sessions" ? viewNow : "more";
  for (const x of document.querySelectorAll("#mnav button")) x.classList.toggle("on", x.dataset.go === tab);
}
for (const b of document.querySelectorAll("#mnav button")) b.onclick = () => {
  const to = b.dataset.go;
  if (to === "terminal") return showTerminal();
  if (to === "more") return openSheet("more");
  go(to);
};

// ---------- the terminal: beside the views on wide screens, a full-screen pane on phones ----------
function showTerminal(id, info) {
  if (id) { if (!tabs.has(id) && info && typeof Terminal !== "undefined") openTab(info); if (tabs.has(id)) activate(id); }
  if (isPhone()) { document.body.classList.add("pane-terminal"); markPhoneTab(); setTermsOpen(true); fitViewport(); }
  else setTermsOpen(true);
}

// ---------- the header orb: AXA's state in one dot (the reactor stays on the map) ----------
function axaState() {
  const g = sessions.get(current), axa = g?.nodes.get("axa"), list = projectSessions();
  const need = list.filter(LK.needsYou).sort(LK.byUrgency);
  if (axa?.perm) return ["waiting", "AXA needs you"];
  if (need.length) return [LK.statusOf(need[0]), `${need.length} ${need.length > 1 ? "sessions need" : "session needs"} you`];
  if (axa?.status === "running" || list.some((p) => LK.statusOf(p) === "working")) return ["working", "Working"];
  if (axa?.yourTurn) return ["done", "AXA done · your turn"];
  return ["ready", "All quiet"];
}
function renderOrb() {
  const [st, words] = axaState(), orb = $("orb");
  orb.style.setProperty("--c", roleVar(LK.lookOf(st).role === "text" ? "dim" : LK.lookOf(st).role));
  orb.dataset.state = st;
  orb.title = `AXA · ${words}`;
  orb.setAttribute("aria-label", `AXA: ${words}`);
}
$("orb").onclick = () => go("map");

function placePlanets() {
  if (!mission) return;
  const list = projectSessions();
  $("planets").classList.toggle("small", Wd < 600 || Ht < 620);
  const pos = list.map((p, i) => planetPos(i, list.length, p)); // (the cards' sizes are read before any is moved)
  list.forEach((p, i) => {
    const el = planetEls.get(p.id); if (!el) return;
    const [wx, wy] = pos[i];
    el.style.transform = `translate(${(wx - cam.x) * cam.k + Wd / 2}px, ${(wy - cam.y) * cam.k + Ht / 2}px) translate(-50%, -50%)`;
  });
}
function drawPlanetLinks(now) {
  const list = projectSessions();
  list.forEach((p, i) => {
    const st = LK.statusOf(p), [x, y] = planetPos(i, list.length, p), c = statusColor(p), on = st === "working";
    ctx.strokeStyle = rgba(c, on ? 0.55 : LK.needsYou(p) ? 0.6 : C.light ? 0.35 : 0.22); ctx.lineWidth = (on ? 1.5 : 1) / Math.max(cam.k, 0.6);
    ctx.setLineDash(st === "exited" ? [3, 6] : []);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
    if (on && !calm.matches) { // data packets flowing out to a working session
      const len = Math.hypot(x, y), ux = x / len, uy = y / len;
      ctx.strokeStyle = C.core; ctx.lineWidth = 2 / Math.max(cam.k, 0.6); ctx.shadowColor = c; ctx.shadowBlur = 8;
      for (let k = 0; k < 3; k++) { const t = ((now / 1000) * 0.5 + k / 3) % 1; ctx.beginPath(); ctx.moveTo(x * t, y * t); ctx.lineTo(x * t + ux * 10, y * t + uy * 10); ctx.stroke(); }
      ctx.shadowBlur = 0;
    }
  });
}
function renderNow(g, waiting) {
  const axa = g?.nodes.get("axa");
  const G = (s) => glyphOf(s);
  let txt = axa?.perm ? `${G("waiting")} AXA needs you: answer it in the AXA tab`
    : axa?.status === "running" ? `${G("working")} AXA working · ${g.doing || "Thinking"}`
    : axa?.yourTurn ? `${G("done")} AXA done · your turn${axa.message ? ": " + axa.message.replace(/\s+/g, " ").slice(0, 160) : ""}`
    : `${G("ready")} AXA ready for your next instruction`;
  const helpers = g ? [...g.nodes.values()].filter((n) => n.kind === "inst" && n.status === "running").length : 0;
  if (helpers) txt += ` · ${helpers} helper${helpers > 1 ? "s" : ""} working`;
  const working = projectSessions().filter((p) => LK.statusOf(p) === "working");
  if (working.length) txt += ` · ${G("working")} ${working.length} session${working.length > 1 ? "s" : ""} working (${working.map((p) => p.name).join(", ")})`;
  // each status that needs you, in its own words: "⚠ api needs you · ◷ web stuck"
  for (const st of ["waiting", "stuck", "failed"]) { const ps = waiting.filter((p) => LK.statusOf(p) === st); if (ps.length) txt += ` · ${G(st)} ${ps.map((p) => p.name).join(", ")} ${LK.lookOf(st).word}`; }
  $("nowtxt").textContent = txt;
  // the bar takes the color of the most urgent thing in it
  const st = axa?.perm ? "waiting" : waiting.length ? LK.statusOf(waiting[0]) : axa?.status === "running" ? "working" : axa?.yourTurn ? "done" : "ready";
  $("now").style.setProperty("--c", roleVar(LK.lookOf(st).role));
  $("now").className = st;
  signal(st, axa, waiting);
}
// The browser tab says whose turn it is, and (if allowed) a desktop notification fires when
// something starts needing you or AXA finishes. Same glyphs and words as the page.
let lastSignal = "", lastWaiting = "";
function signal(state, axa, waiting) {
  const names = waiting.map((p) => `${p.name} ${LK.label(p)}`).join(", ");
  document.title = state === "ready" ? "AXA Console" : `${LK.label(state)}${state === "done" ? " · your turn" : ""} · AXA`;
  const notify = (title, body) => { if (bellOn && "Notification" in window && Notification.permission === "granted" && document.hidden) new Notification(title, { body, tag: "axa", icon: "/ui/icon.svg" }); };
  if (names && names !== lastWaiting) notify(`AXA: ${LK.label("waiting")}`, names);
  if (state === "waiting" && lastSignal !== "waiting" && axa?.perm) notify(`AXA ${LK.label("waiting")}`, "Answer it in the AXA tab");
  if (state === "done" && lastSignal === "working") notify(`AXA ${LK.label("done")}`, (axa?.message || "Your turn").slice(0, 180));
  lastSignal = state; lastWaiting = names;
}
// the map's legend, from the same vocabulary
designReady.then(() => { $("legend").innerHTML = ["working", "done", "waiting", "stuck", "shell"].map((s) => statusHtml(s)).join(" "); });

// ---------- desktop notifications (Settings, the palette) ----------
let bellOn = false;
try { bellOn = localStorage.getItem("axa.bell") === "1"; } catch {}
async function setBell(on) {
  if (on && "Notification" in window && Notification.permission !== "granted") await Notification.requestPermission();
  bellOn = on && "Notification" in window && Notification.permission === "granted";
  $("setbell").checked = bellOn;
  try { localStorage.setItem("axa.bell", bellOn ? "1" : "0"); } catch {}
  if (on && !bellOn) toast("Notifications are blocked for this page in the browser's settings", "warn");
}
$("setbell").checked = bellOn;
$("setbell").onchange = (ev) => setBell(ev.target.checked);
$("sethelp").onclick = () => openHelp();

function setView(m) {
  mission = m;
  document.body.classList.toggle("detail", !m);
  $("viewbtn").classList.toggle("on", !m);
  try { localStorage.setItem("axa.view", m ? "mission" : "detail"); } catch {}
  pinned = false; autoFit = true; dirty = true;
}
$("viewbtn").onclick = () => setView(!mission);
// the "needs you" chip: the most urgent session's prompt (a sheet you can answer from), else its terminal
function jumpToNeeds() {
  const w = projectSessions().filter(LK.needsYou).sort(LK.byUrgency)[0];
  if (!w) return toast("Nothing needs you");
  if (w.status === "waiting" && w.choices) openAsk(w); else if (isPhone()) go("home"); else openSession(w);
}
$("needs").onclick = jumpToNeeds;

// ---------- toasts: a short confirmation or error, in words ----------
let toastTimer = 0;
function toast(msg, role = "") {
  const el = $("toast");
  el.textContent = msg; el.dataset.role = role; el.hidden = false;
  el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), role ? 5000 : 2600);
}
