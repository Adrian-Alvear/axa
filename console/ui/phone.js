// AXA console: sheets (the approval sheet, the phone's "More"), the on-screen keyboard (visualViewport),
// the offline banner and the service worker (the page shell works offline)

// ---------- sheets: a bottom sheet on phones, a dialog on wide screens ----------
let sheetBack = null;
function openSheet(id) {
  const el = $(id);
  if (!el.hidden) return;
  sheetBack = document.activeElement;
  el.hidden = false; el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter");
  el.querySelector("button:not([hidden])")?.focus({ preventScroll: true });
}
function closeSheet(id) {
  const el = $(id);
  if (!el || el.hidden) return;
  el.hidden = true;
  if (id === "ask") askFor = null;
  if (sheetBack?.isConnected) sheetBack.focus({ preventScroll: true });
}
for (const w of document.querySelectorAll(".sheetwrap")) w.addEventListener("click", (ev) => { if (ev.target === w) closeSheet(w.id); });
$("more").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-act]"); if (!b) return;
  closeSheet("more");
  if (b.dataset.act === "palette") openPalette();
  if (b.dataset.act === "demo") { go("home"); demo(); }
});

// ---------- an approval: the question, its options as big buttons (tap to arm, tap again to send) ----------
let askFor = null;
function openAsk(p) {
  askFor = p.id;
  fillAsk(p);
  openSheet("ask");
}
function fillAsk(p) {
  const st = LK.statusOf(p), c = st === "waiting" ? p.choices : null;
  $("askst").innerHTML = statusHtml(p);
  $("askname").textContent = p.name;
  const sig = c ? c.question + c.options.map((o) => o.label).join("|") : "-";
  if ($("askopts").dataset.sig === sig) return;
  $("askopts").dataset.sig = sig;
  $("askq").textContent = c ? c.question : planetDetail(p);
  $("askopts").innerHTML = c ? c.options.map((o) => `<button data-n="${o.n}" title="${esc(o.label)}"><b>${o.n}</b><span>${esc(o.label)}</span></button>`).join("") : "";
  $("asknote").hidden = !c;
  $("askdiff").hidden = !p.git?.files;
}
$("askopts").onclick = (ev) => {
  const b = ev.target.closest("button[data-n]"); if (!b || !askFor) return;
  const p = termOf({ id: askFor });
  // the armed button's text is "Tap again: …": keep the number and the label apart
  answer(p, b, () => closeSheet("ask"));
};
$("askx").onclick = () => closeSheet("ask");
$("askterm").onclick = () => { const p = termOf({ id: askFor }); closeSheet("ask"); openSession(p); };
$("askdiff").onclick = () => { const p = termOf({ id: askFor }); closeSheet("ask"); showDiff(p); };
// the list refreshed: keep the open sheet current, and say so when its prompt went away
function updateAsk() {
  if (!askFor || $("ask").hidden) return;
  const p = terms.find((x) => x.id === askFor);
  if (!p || LK.statusOf(p) !== "waiting") { closeSheet("ask"); toast(p ? `${p.name} isn't waiting any more` : "That session is gone"); return; }
  fillAsk(p);
}

// ---------- the phone keyboard: keep the terminal's key bar just above it ----------
const vv = window.visualViewport;
function fitViewport() {
  if (!vv) return;
  const root = document.documentElement, kb = Math.max(0, innerHeight - vv.height - vv.offsetTop);
  root.style.setProperty("--vvh", `${vv.height}px`);
  root.style.setProperty("--vvtop", `${vv.offsetTop}px`);
  document.body.classList.toggle("kbd-open", kb > 120);
  if (document.body.classList.contains("pane-terminal")) requestAnimationFrame(() => fitTab(tabs.get(activeTab)));
}
if (vv) { vv.addEventListener("resize", fitViewport); vv.addEventListener("scroll", fitViewport); fitViewport(); }

// ---------- offline: say the console is unreachable and since when ----------
let lastSeenAt = 0, offlineTimer = 0;
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
function markOnline() {
  lastSeenAt = Date.now();
  clearTimeout(offlineTimer); offlineTimer = 0;
  if (!$("offline").hidden) { $("offline").hidden = true; document.body.classList.remove("is-offline"); }
}
function markOffline(why = "") {
  if (offlineTimer || !$("offline").hidden) return;
  // a moment's grace: a reconnecting event stream isn't an outage
  offlineTimer = setTimeout(() => {
    offlineTimer = 0;
    const el = $("offline");
    el.innerHTML = `${icon("offline")}<span>Console unreachable${lastSeenAt ? ` · last seen ${hhmm(lastSeenAt)} (${ago(Date.now() - lastSeenAt)} ago)` : ""}${why ? ` · ${esc(why)}` : ""}</span><span class="grow"></span><button class="small" id="offretry">Retry</button>`;
    el.hidden = false; document.body.classList.add("is-offline"); fitBanner();
    $("offretry").onclick = () => { refreshTerms(); };
  }, navigator.onLine === false ? 0 : 3000);
}
// the views make room for the banner, however many lines it wraps to
function fitBanner() { const el = $("offline"); if (!el.hidden) document.body.style.setProperty("--banner", el.offsetHeight + "px"); }
addEventListener("resize", fitBanner);
addEventListener("offline", () => markOffline("this device is offline"));
addEventListener("online", () => refreshTerms());

// ---------- the service worker: caches the page shell (never /api/ or the event stream) ----------
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {}));
}
