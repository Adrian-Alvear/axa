// AXA console: phone nav, the Now bar, browser-tab title and desktop notifications, view switch

// ---------- phone nav ----------
for (const b of document.querySelectorAll("#mnav button")) b.onclick = () => {
  if (b.dataset.go === "terms") setTermsOpen(true);
  for (const x of document.querySelectorAll("#mnav button")) x.classList.toggle("on", x === b);
  requestAnimationFrame(() => $(b.dataset.go).scrollIntoView({ behavior: "smooth" }));
};
function placePlanets() {
  if (!mission) return;
  const list = projectSessions();
  list.forEach((p, i) => {
    const el = planetEls.get(p.id); if (!el) return;
    const [wx, wy] = planetPos(i, list.length, p);
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
    if (on) { // data packets flowing out to a working session
      const len = Math.hypot(x, y), ux = x / len, uy = y / len;
      ctx.strokeStyle = C.core; ctx.lineWidth = 2 / Math.max(cam.k, 0.6); ctx.shadowColor = c; ctx.shadowBlur = 8;
      for (let k = 0; k < 3; k++) { const t = ((now / 1000) * 0.5 + k / 3) % 1; ctx.beginPath(); ctx.moveTo(x * t, y * t); ctx.lineTo(x * t + ux * 10, y * t + uy * 10); ctx.stroke(); }
      ctx.shadowBlur = 0;
    }
  });
}
function renderNow(g, waiting) {
  if (!mission) return;
  const axa = g?.nodes.get("axa");
  const G = (s) => LK.lookOf(s).glyph;
  let txt = axa?.perm ? `${G("waiting")} AXA needs you: answer it in the AXA tab`
    : axa?.status === "running" ? `${G("working")} AXA working · ${g.doing || "Thinking"}`
    : axa?.yourTurn ? `${G("done")} AXA done · your turn${axa.message ? ": " + axa.message.replace(/\s+/g, " ").slice(0, 160) : ""}`
    : `${G("ready")} AXA ready for your next instruction`;
  const helpers = g ? [...g.nodes.values()].filter((n) => n.kind === "inst" && n.status === "running").length : 0;
  if (helpers) txt += ` · ${helpers} helper${helpers > 1 ? "s" : ""} working`;
  const working = projectSessions().filter((p) => LK.statusOf(p) === "working");
  if (working.length) txt += ` · ${G("working")} ${working.length} session${working.length > 1 ? "s" : ""} working (${working.map((p) => p.name).join(", ")})`;
  // each status that needs you, in its own words: "⚠ api needs you · ◷ web stuck"
  for (const st of ["waiting", "stuck", "failed"]) { const ps = waiting.filter((p) => LK.statusOf(p) === st); if (ps.length) txt += ` · ${LK.lookOf(st).glyph} ${ps.map((p) => p.name).join(", ")} ${LK.lookOf(st).word}`; }
  $("nowtxt").textContent = txt;
  // the bar takes the color of the most urgent thing in it
  const st = axa?.perm ? "waiting" : waiting.length ? LK.statusOf(waiting[0]) : axa?.status === "running" ? "working" : axa?.yourTurn ? "done" : "ready";
  $("now").style.setProperty("--c", roleVar(LK.lookOf(st).role));
  $("now").className = st;
  signal(st, axa, waiting);
}
// The browser tab says whose turn it is, and (if allowed) a desktop notification fires when
// something starts needing you or AXA finishes.
// The tab title and the notifications use the same glyphs and words as the page.
let lastSignal = "", lastWaiting = "";
function signal(state, axa, waiting) {
  const names = waiting.map((p) => `${p.name} ${LK.label(p)}`).join(", ");
  document.title = state === "ready" ? "AXA Console" : `${LK.label(state)}${state === "done" ? " · your turn" : ""} · AXA`;
  const notify = (title, body) => { if (bellOn && "Notification" in window && Notification.permission === "granted" && document.hidden) new Notification(title, { body, tag: "axa" }); };
  if (names && names !== lastWaiting) notify(`AXA: ${LK.label("waiting")}`, names);
  if (state === "waiting" && lastSignal !== "waiting" && axa?.perm) notify(`AXA ${LK.label("waiting")}`, "Answer it in the AXA tab");
  if (state === "done" && lastSignal === "working") notify(`AXA ${LK.label("done")}`, (axa?.message || "Your turn").slice(0, 180));
  lastSignal = state; lastWaiting = names;
}
// the map's legend, from the same vocabulary
designReady.then(() => { $("legend").innerHTML = ["working", "done", "waiting", "stuck", "shell"].map((s) => statusHtml(s)).join(" "); });
let bellOn = false;
try { bellOn = localStorage.getItem("axa.bell") === "1"; } catch {}
$("bell").classList.toggle("on", bellOn);
$("bell").onclick = async () => {
  if (!bellOn && "Notification" in window && Notification.permission !== "granted") await Notification.requestPermission();
  bellOn = !bellOn && "Notification" in window && Notification.permission === "granted";
  $("bell").classList.toggle("on", bellOn);
  try { localStorage.setItem("axa.bell", bellOn ? "1" : "0"); } catch {}
};

function setView(m) {
  mission = m;
  document.body.classList.toggle("detail", !m);
  $("viewbtn").classList.toggle("on", !m);
  try { localStorage.setItem("axa.view", m ? "mission" : "detail"); } catch {}
  pinned = false; autoFit = true; dirty = true;
}
$("viewbtn").onclick = () => setView(!mission);
$("needs").onclick = () => {
  const w = projectSessions().filter(LK.needsYou).sort(LK.byUrgency)[0];
  if (w) openSession(w);
};
