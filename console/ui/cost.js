// AXA console: the cost meter. USD per day from /api/cost and per session from each session's `cost`
// (both Phase 4: a 404 or no field means "no cost data", and the meter falls back to tokens), with a
// daily budget kept in this browser (amber at 80%, red past it).

let costData = null; // { days: [{ date, usd, sessions }], today_usd, total_usd } or null
let budgetUsd = 0;
try { budgetUsd = Number(localStorage.getItem("axa.budgetUsd")) || 0; } catch {}
async function loadCost() {
  if (locked || document.hidden) return;
  if (demoOn()) { costData = demoCost(); return renderCost(); }
  try {
    const r = await fetch("/api/cost");
    costData = r.ok ? await r.json() : null; // 404: this console doesn't track cost
    if (costData && !Array.isArray(costData.days)) costData = null;
  } catch {}
  renderCost();
}
setInterval(loadCost, 60_000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadCost(); });

// what the meter says now: { usd, label, role, tip }
function costNow() {
  const list = projectSessions(), withUsd = list.filter((p) => p.cost && p.cost.usd != null);
  const over = list.filter((p) => p.usage?.over_budget);
  let usd = null, label = "", tip = [];
  if (costData && costData.today_usd != null) { usd = Number(costData.today_usd); label = `${fmtUsd(usd)} today`; tip.push(`Today: ${fmtUsd(usd)}`, `All time: ${fmtUsd(costData.total_usd)}`); }
  else if (withUsd.length) { usd = withUsd.reduce((n, p) => n + Number(p.cost.usd || 0), 0); label = `${fmtUsd(usd)} open sessions`; tip.push(`${withUsd.length} sessions with a cost`); }
  else { const tok = list.reduce((n, p) => n + (p.usage?.tokens || 0), 0); if (tok) { label = `${fmtTok(tok)} tok`; tip.push("Tokens used by the open sessions"); } }
  let role = "", warnText = "";
  if (budgetUsd && usd != null) { const f = usd / budgetUsd; role = f >= 1 ? "bad" : f >= 0.8 ? "warn" : ""; warnText = f >= 1 ? "over budget" : f >= 0.8 ? "near budget" : ""; tip.push(`Daily budget ${fmtUsd(budgetUsd)} · ${Math.round(f * 100)}% used`); }
  if (over.length) { role ||= "warn"; warnText ||= `${over.length} over token budget`; tip.push(`Over the token budget: ${over.map((p) => p.name).join(", ")}`); }
  return { usd, label, role, warnText, tip: tip.join("\n") };
}
function renderCost() {
  const c = costNow(), b = $("cost");
  b.hidden = !c.label;
  b.innerHTML = `${icon("cost")}<span>${esc(c.label)}</span>${c.warnText ? `<span class="cw">${esc(c.warnText)}</span>` : ""}`;
  b.dataset.role = c.role; b.title = c.tip || "Spend";
  if (!$("costview").hidden) renderCostView();
}
$("cost").onclick = () => { renderCostView(); $("costview").hidden = false; $("costx").focus(); };
$("costx").onclick = () => ($("costview").hidden = true);
$("costview").onclick = (ev) => { if (ev.target === $("costview")) $("costview").hidden = true; };
$("setbudget").value = budgetUsd || "";
$("setbudget").onchange = (ev) => { budgetUsd = Math.max(0, Number(ev.target.value) || 0); try { localStorage.setItem("axa.budgetUsd", String(budgetUsd)); } catch {} renderCost(); };
function renderCostView() {
  const c = costNow(), list = projectSessions().slice().sort((a, b) => (b.cost?.usd || 0) - (a.cost?.usd || 0) || (b.usage?.tokens || 0) - (a.usage?.tokens || 0));
  let html = `<div class="costtop"><div class="big"><small>${costData ? "Today" : "Open sessions"}</small><b>${c.usd != null ? fmtUsd(c.usd) : c.label || "—"}</b></div>`;
  if (costData?.total_usd != null) html += `<div class="big"><small>All time</small><b>${fmtUsd(costData.total_usd)}</b></div>`;
  if (budgetUsd && c.usd != null) {
    const f = c.usd / budgetUsd, role = f >= 1 ? "bad" : f >= 0.8 ? "warn" : "ok";
    html += `<div class="meter" title="${Math.round(f * 100)}% of ${fmtUsd(budgetUsd)}"><small>Daily budget · ${Math.round(f * 100)}% of ${fmtUsd(budgetUsd)}</small><span class="mbar"><i style="width:${Math.min(100, f * 100)}%;background:var(--${role})"></i></span></div>`;
  }
  html += `</div>`;
  // USD per day: one series, so one color (the accent) and no legend; each bar says its value on hover
  const days = (costData?.days || []).slice(-14);
  if (days.length) {
    const max = Math.max(...days.map((d) => Number(d.usd) || 0), 0.01);
    html += `<p class="title">Per day</p><div class="bars" role="img" aria-label="USD per day, last ${days.length} days">` + days.map((d) => {
      const v = Number(d.usd) || 0, h = Math.max(2, (v / max) * 100), lab = new Date(d.date + "T12:00").toLocaleDateString([], { month: "short", day: "numeric" });
      return `<div class="bcol" title="${esc(lab)}: ${fmtUsd(v)}${d.sessions ? ` · ${d.sessions} sessions` : ""}"><span class="bv">${v >= max * 0.999 ? fmtUsd(v) : ""}</span><span class="bar" style="height:${h}%"></span><span class="bl">${esc(lab.replace(/^\w+ /, ""))}</span></div>`;
    }).join("") + `</div>`;
  } else html += `<p class="note">${costData ? "No spend recorded yet." : "Per-day spend shows here once the console tracks cost (Claude Code's statusLine cost)."}</p>`;
  // and per session, as a table (the accessible view of the same numbers)
  html += `<p class="title">Per session</p>` + (list.length ? `<table class="ctab"><thead><tr><th>Session</th><th>USD</th><th>Context</th><th>Model</th><th>Tokens</th></tr></thead><tbody>` + list.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.cost?.usd != null ? fmtUsd(p.cost.usd) : "—"}</td><td class="num${p.cost?.context_pct >= 80 ? " warn" : ""}">${p.cost?.context_pct != null ? Math.round(p.cost.context_pct) + "%" : "—"}</td><td>${esc(p.cost?.model ? String(p.cost.model).replace(/^claude-/, "") : "—")}</td><td class="num${p.usage?.over_budget ? " warn" : ""}">${p.usage?.tokens ? fmtTok(p.usage.tokens) : "—"}</td></tr>`).join("") + `</tbody></table>` : `<p class="note">No sessions open.</p>`);
  $("costbody").innerHTML = html;
}
