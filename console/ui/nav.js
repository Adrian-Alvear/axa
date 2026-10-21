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
const STATUS_COLOR = { working: "#4fd8ff", done: "#5ef2c2", waiting: "#ffb547", stuck: "#ff8a5c", shell: "#6c8a99", exited: "#4f6b7a" };
function drawPlanetLinks(now) {
  const list = projectSessions();
  list.forEach((p, i) => {
    const [x, y] = planetPos(i, list.length, p), c = STATUS_COLOR[p.status] || "#8fb3c4", on = p.status === "working";
    ctx.strokeStyle = rgba(c, on ? 0.55 : p.status === "waiting" ? 0.6 : 0.22); ctx.lineWidth = (on ? 1.5 : 1) / Math.max(cam.k, 0.6);
    ctx.setLineDash(p.status === "exited" ? [3, 6] : []);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
    if (on) { // data packets flowing out to a working session
      const len = Math.hypot(x, y), ux = x / len, uy = y / len;
      ctx.strokeStyle = "#eaffff"; ctx.lineWidth = 2 / Math.max(cam.k, 0.6); ctx.shadowColor = c; ctx.shadowBlur = 8;
      for (let k = 0; k < 3; k++) { const t = ((now / 1000) * 0.5 + k / 3) % 1; ctx.beginPath(); ctx.moveTo(x * t, y * t); ctx.lineTo(x * t + ux * 10, y * t + uy * 10); ctx.stroke(); }
      ctx.shadowBlur = 0;
    }
  });
}
function renderNow(g, waiting) {
  if (!mission) return;
  const axa = g?.nodes.get("axa");
  let txt = axa?.perm ? "⚠ AXA needs your approval: answer it in the AXA tab"
    : axa?.status === "running" ? `● AXA · ${g.doing || "Thinking"}`
    : axa?.yourTurn ? `◆ Your turn · AXA finished${axa.message ? ": " + axa.message.replace(/\s+/g, " ").slice(0, 160) : ""}`
    : "AXA is ready for your next instruction";
  const helpers = g ? [...g.nodes.values()].filter((n) => n.kind === "inst" && n.status === "running").length : 0;
  if (helpers) txt += ` · ${helpers} helper${helpers > 1 ? "s" : ""} working`;
  const working = projectSessions().filter((p) => p.status === "working");
  if (working.length) txt += ` · ${working.length} session${working.length > 1 ? "s" : ""} working (${working.map((p) => p.name).join(", ")})`;
  const approvals = waiting.filter((p) => p.status === "waiting"), stuck = waiting.filter((p) => p.status === "stuck");
  if (approvals.length) txt += ` · ⚠ ${approvals.map((p) => p.name).join(", ")} needs your approval`;
  if (stuck.length) txt += ` · ⏳ ${stuck.map((p) => p.name).join(", ")} looks stuck`;
  $("nowtxt").textContent = txt;
  $("now").className = axa?.perm || waiting.length ? "needs" : axa?.status === "running" ? "working" : axa?.yourTurn ? "turn" : "";
  signal(axa?.perm || waiting.length ? "needs" : axa?.status === "running" ? "working" : axa?.yourTurn ? "turn" : "ready", axa, waiting);
}
// The browser tab says whose turn it is, and (if allowed) a desktop notification fires when
// something starts needing you or AXA finishes.
let lastSignal = "", lastWaiting = "";
function signal(state, axa, waiting) {
  const names = waiting.map((p) => p.name).join(", ");
  document.title = state === "needs" ? `⚠ Needs you · AXA` : state === "turn" ? `◆ Your turn · AXA` : state === "working" ? `● Working · AXA` : "AXA Console";
  const notify = (title, body) => { if (bellOn && "Notification" in window && Notification.permission === "granted" && document.hidden) new Notification(title, { body, tag: "axa" }); };
  if (names && names !== lastWaiting) notify("AXA: a session needs you", `${names} is waiting for your approval`);
  if (state === "needs" && lastSignal !== "needs" && axa?.perm) notify("AXA needs your approval", "Answer it in the AXA tab");
  if (state === "turn" && lastSignal === "working") notify("AXA finished", (axa?.message || "Your turn").slice(0, 180));
  lastSignal = state; lastWaiting = names;
}
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
  const w = projectSessions().find((p) => p.status === "waiting") || projectSessions().find((p) => p.status === "stuck");
  if (w) openSession(w);
};
