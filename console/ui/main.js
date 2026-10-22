// AXA console: data (/api/terms polling, the /events stream) and startup

// ---------- session list: refreshed when /events says something happened, a slow safety poll while the tab is visible, nothing while hidden ----------
let termsBusy = false, termsAgain = false, termsTimer = 0, eventTimer = 0;
async function refreshTerms() {
  if (termsBusy) { termsAgain = true; return; } // never two /api/terms fetches at once: run once more when this one ends
  termsBusy = true;
  try {
    const r = await fetch("/api/terms");
    if (r.ok) {
      terms = await r.json();
      for (const t of terms) if (!tabs.has(t.id) && typeof Terminal !== "undefined") openTab(t); // sessions AXA opened show up as tabs too
      for (const [id, t] of tabs) { const info = terms.find((x) => x.id === id); if (info) { t.info = info; t.tab.classList.toggle("dead", !info.alive); tabStatus(t); } }
      renderPlanets(); renderInbox(); dirty = true;
    }
  } catch {}
  termsBusy = false;
  if (termsAgain) { termsAgain = false; if (!document.hidden) await refreshTerms(); }
}
async function pollTerms() {
  clearTimeout(termsTimer);
  if (document.hidden) return;
  await refreshTerms();
  clearTimeout(termsTimer);
  if (!document.hidden) termsTimer = setTimeout(pollTerms, 5000);
}
const pollNow = () => setTimeout(() => { if (!document.hidden) refreshTerms(); }, 400); // after an action: show its effect without waiting for the next poll
function termsSoon() { // an event arrived: refresh once ~300ms later, however many arrive meanwhile
  if (document.hidden || eventTimer) return;
  eventTimer = setTimeout(() => { eventTimer = 0; refreshTerms(); }, 300);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearTimeout(termsTimer); clearTimeout(eventTimer); eventTimer = 0; }
  else if (!locked) pollTerms();
});

// ---------- the supervisor's hourly wake limit: say so while it holds updates back ----------
let limitTimer = 0, limitShown = null;
const limitEnd = (e) => { // resets_at may be ms, seconds or an ISO date; without one, assume an hour from the event
  const v = e.resets_at ?? (e.ts ? new Date(e.ts).getTime() + 3600e3 : NaN);
  const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  return Number.isFinite(t) ? t : Date.now() + 3600e3;
};
function wakeLimit(e) {
  const end = limitEnd(e);
  if (end <= Date.now()) return; // already over (an old one replayed from history)
  if (limitShown && (limitShown.ts || 0) > (e.ts || 0)) return;
  limitShown = e;
  const pending = Array.isArray(e.pending) ? e.pending : [], el = $("limitnote");
  const at = new Date(end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  el.textContent = `AXA wake limit reached${e.limit ? ` (${e.limit}/h)` : ""}${pending.length ? ` · ${pending.length} update${pending.length > 1 ? "s" : ""} waiting` : ""} · resumes ${at}`;
  el.title = pending.length ? `Waiting: ${pending.join(", ")}` : "";
  el.hidden = false;
  clearTimeout(limitTimer);
  limitTimer = setTimeout(() => { el.hidden = true; limitShown = null; }, Math.min(end - Date.now(), 2 ** 31 - 1));
}

// ---------- data ----------
let locked = false;
async function loadRoster() {
  try { const r = await fetch("/roster"); locked = r.status === 401; roster = locked ? [] : await r.json(); } catch { roster = []; }
  typeToRole.clear();
  for (const r of roster) { typeToRole.set(r.subagent_type, r.role); typeToRole.set(r.subagent_type.split(":").pop(), r.role); }
}
function connect() {
  const es = new EventSource("/events");
  es.addEventListener("history", (m) => {
    for (const k of [...sessions.keys()]) if (k !== "demo") sessions.delete(k); feedFor = null;
    const list = JSON.parse(m.data); list.forEach(ingest); dirty = true;
    for (const e of list) if (e?.event === "SupervisorLimit") wakeLimit(e);
  });
  es.onmessage = (m) => { try { const e = JSON.parse(m.data); ingest(e); if (e?.event === "SupervisorLimit") wakeLimit(e); termsSoon(); } catch {} };
  es.onopen = () => { $("live").classList.add("on"); $("live").textContent = "online"; };
  es.onerror = () => { $("live").classList.remove("on"); $("live").textContent = "offline"; };
}
// start once the design system (theme + status vocabulary) is in: everything draws with it
designReady.then(loadRoster).then(() => {
  if (locked) { $("empty").innerHTML = "Console locked<br><br>Open it with /axa:console — or the unlock link the server prints"; $("live").textContent = "locked"; requestAnimationFrame(frame); return; }
  setView(mission); termsBusy = true; initTerms().catch(() => {}).then(() => { termsBusy = termsAgain = false; pollTerms(); }); connect(); requestAnimationFrame(frame); if (new URLSearchParams(location.search).has("demo")) demo(); });
