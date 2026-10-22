// AXA console: the command palette (Ctrl/Cmd-K) and the keys (j/k, Enter, ?, g + a view), the same
// actions as the terminal app's palette: jump to a session, answer a prompt, open a diff, give a goal,
// link sessions, switch theme, open settings.

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
$("palkey").textContent = isMac ? "⌘K" : "Ctrl K";

// ---------- the palette: a list of actions, filtered as you type; some ask a second question ----------
let pal = null; // { items, placeholder, onText, sel, hits }
function actions() {
  const A = [], add = (label, run, { hint = "", ic = "arrow", keep = false } = {}) => A.push({ label, run, hint, ic, keep });
  add("Home: needs you and while you were away", () => go("home"), { hint: "g h", ic: "home" });
  add("Sessions", () => go("sessions"), { hint: "g s", ic: "list" });
  add("Map", () => go("map"), { hint: "g m", ic: "map" });
  add("Runs: every instruction and its result", () => go("runs"), { hint: "g r", ic: "runs" });
  add("Settings", () => openSettings(), { hint: "g ,", ic: "settings" });
  if (projectSessions().some(LK.needsYou)) add("Jump to whatever needs you", jumpToNeeds, { hint: "!", ic: "arrow" });
  for (const p of projectSessions().slice().sort(LK.byUrgency)) {
    const n = p.name, st = LK.statusOf(p);
    if (st === "waiting" && p.choices) add(`Answer ${n}: ${oneLine(p.choices.question, 70)}`, () => openAsk(p), { ic: "arrow" });
    add(`Open ${n} (${LK.lookOf(st).word})`, () => openSession(p), { ic: "terminal" });
    if (p.git?.files) add(`Changes in ${n}`, () => showDiff(p), { ic: "diff" });
    if (p.mode !== "shell" && p.alive !== false && !p.demo) add(`Goal for ${n}…`, () => askText(`Goal for ${n}: what should it achieve?`, (text) => giveGoal(p, text)), { ic: "goal", keep: true });
    if (p.alive !== false && !p.demo) add(`Link: when ${n} finishes, instruct…`, () => pickLinkTarget(p), { ic: "link", keep: true });
    add(`Runs of ${n}`, () => { go("runs"); $("runfilter").value = p.id; runSel = null; renderRuns(); }, { ic: "runs" });
  }
  for (const ch of chainsCache.filter((c) => !c.fired && !c.failed)) add(`Remove link: ${ch.from_name} → ${ch.to_name}`, () => removeLink(ch), { ic: "link" });
  add(document.body.classList.contains("with-terms") ? "Hide the terminals" : "Show the terminals", () => (isPhone() ? showTerminal() : setTermsOpen(!document.body.classList.contains("with-terms"))), { hint: "t", ic: "terminal" });
  add("New session in a project", () => newSession(), { ic: "plus" });
  for (const t of TH.themeList()) add(`Theme: ${t.label}${t.id === pickedTheme() ? " (current)" : ""}`, () => setTheme(t.id), { ic: "theme" });
  add(bellOn ? "Turn off desktop notifications" : "Turn on desktop notifications", () => setBell(!bellOn), { ic: "bell" });
  add("Spend: today and per session", () => $("cost").click(), { ic: "cost" });
  add("Mark everything as seen", () => $("seenbtn").click(), { ic: "ci" });
  add("Play the demo", () => { go("home"); demo(); }, { ic: "play" });
  add("Keys: all shortcuts", openHelp, { hint: "?", ic: "keyboard" });
  return A;
}
let chainsCache = [];
async function refreshChains() { try { const r = await fetch("/api/chains"); chainsCache = r.ok ? await r.json() : []; } catch { chainsCache = []; } }

function openPalette(step) {
  if (!TH) return;
  if (!step) { refreshChains().then(() => { if (pal && !pal.onText && !pal.sub) { pal.items = actions(); renderPal(); } }); step = { items: actions(), placeholder: "Jump to a session, answer, open a diff, give a goal…" }; }
  pal = { sel: 0, ...step };
  $("palq").value = ""; $("palq").placeholder = pal.placeholder;
  $("palette").hidden = false; $("palette").classList.remove("enter"); void $("palette").offsetWidth; $("palette").classList.add("enter");
  renderPal();
  $("palq").focus();
}
function closePalette() { $("palette").hidden = true; pal = null; }
// fuzzy: every typed character in order; earlier and tighter matches first
const fuzzy = (label, q) => { if (!q) return 0; const l = label.toLowerCase(); let i = 0, s = 0, last = -1; for (const ch of q.toLowerCase()) { if (ch === " ") continue; const j = l.indexOf(ch, i); if (j < 0) return -1; s += j - last - 1; last = j; i = j + 1; } return s + l.indexOf(q[0].toLowerCase()) * 0.1; };
function renderPal() {
  if (!pal) return;
  const q = $("palq").value.trim(), host = $("pallist");
  if (pal.onText) { host.innerHTML = `<div class="palhint">${esc(pal.hintText || "Type, then Enter")}</div>`; return; }
  pal.hits = pal.items.map((a) => ({ a, s: fuzzy(a.label, q) })).filter((x) => x.s >= 0).sort((x, y) => x.s - y.s).map((x) => x.a);
  pal.sel = Math.min(pal.sel, Math.max(0, pal.hits.length - 1));
  host.innerHTML = pal.hits.length ? pal.hits.slice(0, 60).map((a, i) => `<div class="palitem${i === pal.sel ? " on" : ""}" role="option" aria-selected="${i === pal.sel}" data-i="${i}">${icon(a.ic)}<span>${esc(a.label)}</span>${a.hint ? `<kbd>${esc(a.hint)}</kbd>` : ""}</div>`).join("") : `<div class="palhint">No match</div>`;
  host.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}
function runPal(i = pal?.sel) {
  if (!pal) return;
  if (pal.onText) { const t = $("palq").value.trim(); if (!t) return; const fn = pal.onText; closePalette(); fn(t); return; }
  const a = pal.hits?.[i]; if (!a) return;
  if (!a.keep) closePalette();
  a.run();
}
$("palq").oninput = () => { if (pal) { pal.sel = 0; renderPal(); } };
$("palq").onkeydown = (ev) => {
  if (ev.key === "ArrowDown" || (ev.ctrlKey && ev.key === "n")) { ev.preventDefault(); pal.sel = Math.min((pal.hits?.length || 1) - 1, pal.sel + 1); renderPal(); }
  else if (ev.key === "ArrowUp" || (ev.ctrlKey && ev.key === "p")) { ev.preventDefault(); pal.sel = Math.max(0, pal.sel - 1); renderPal(); }
  else if (ev.key === "Enter") { ev.preventDefault(); runPal(); }
  else if (ev.key === "Escape") { ev.preventDefault(); closePalette(); }
};
$("pallist").onclick = (ev) => { const it = ev.target.closest(".palitem"); if (it) runPal(Number(it.dataset.i)); };
$("palette").onclick = (ev) => { if (ev.target === $("palette")) closePalette(); };
$("palbtn").onclick = () => openPalette();

// second questions: free text, or a session to pick
function askText(placeholder, onText, hintText = "Enter to send · Esc to cancel") { openPalette({ items: [], placeholder, onText, hintText }); }
function pickLinkTarget(from) {
  const others = projectSessions().filter((x) => x.id !== from.id && x.alive !== false && !x.demo);
  if (!others.length) { closePalette(); return toast("Open another session first"); }
  openPalette({ sub: true, placeholder: `When ${from.name} finishes, send the next instruction to…`, items: others.map((to) => ({ label: `${to.name} (${LK.lookOf(LK.statusOf(to)).word})`, ic: "link", keep: true, run: () => askText(`When ${from.name} finishes, tell ${to.name}:`, (text) => addLink(from, to, text)) })) });
}
async function giveGoal(p, goal) {
  try {
    const r = await fetch(`/api/terms/${p.id}/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `/goal ${goal.replace(/\s*\n\s*/g, " ")}` }) });
    const b = await r.json().catch(() => ({}));
    toast(r.ok ? `Goal sent to ${p.name}` : b.error || "Couldn't send the goal", r.ok ? "" : "bad");
  } catch { toast("The console is unreachable", "bad"); }
  pollNow();
}
async function addLink(from, to, text) {
  try {
    const r = await fetch("/api/chains", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: from.id, to: to.id, text }) });
    const b = await r.json().catch(() => ({}));
    toast(r.ok ? `Linked: when ${from.name} finishes, AXA tells ${to.name}` : b.error || "Couldn't link them", r.ok ? "" : "bad");
  } catch { toast("The console is unreachable", "bad"); }
  refreshChains();
}
async function removeLink(ch) {
  try { const r = await fetch(`/api/chains/${ch.id}`, { method: "DELETE" }); toast(r.ok ? "Link removed" : "Couldn't remove it", r.ok ? "" : "bad"); } catch { toast("The console is unreachable", "bad"); }
  refreshChains();
}
// a new session: the project picker (in the terminal pane)
function newSession() { showTerminal(); requestAnimationFrame(() => { if ($("picker").hidden) showPicker(); }); }

// ---------- help ----------
function openHelp() { $("help").hidden = false; $("helpx").focus(); }
const closeHelp = () => ($("help").hidden = true);
$("helpx").onclick = closeHelp;
$("help").onclick = (ev) => { if (ev.target === $("help")) closeHelp(); };

// ---------- keys ----------
const typing = (el) => !!el && (el.closest?.(".xterm") || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
const navItems = () => [...document.querySelectorAll(`#views > .view[data-view="${viewNow}"] [data-nav]`)].filter((el) => el.offsetParent !== null);
function moveSel(d) {
  const items = navItems(); if (!items.length) return;
  let i = items.indexOf(document.activeElement.closest?.("[data-nav]"));
  i = i < 0 ? (d > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + d));
  items[i].focus(); items[i].scrollIntoView({ block: "nearest" });
}
let gPending = 0;
document.addEventListener("keydown", (ev) => {
  // Ctrl/Cmd-K: the palette, anywhere but inside a terminal (there Ctrl-K is the shell's; use Cmd-K or Ctrl-Shift-K)
  if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "k" && !(ev.ctrlKey && !ev.shiftKey && ev.target.closest?.(".xterm"))) {
    ev.preventDefault(); if ($("palette").hidden) openPalette(); else closePalette(); return;
  }
  if (ev.key === "Escape") {
    for (const id of ["help", "costview"]) if (!$(id).hidden) { $(id).hidden = true; return; }
    for (const id of ["ask", "more"]) if (!$(id).hidden) { closeSheet(id); return; }
    // phones: Esc in the terminal belongs to Claude; elsewhere it leaves a focused card
    return;
  }
  if (ev.metaKey || ev.ctrlKey || ev.altKey || typing(ev.target) || !$("palette").hidden || !$("diffview").hidden) return;
  if (gPending) {
    clearTimeout(gPending); gPending = 0;
    const v = { h: "home", s: "sessions", m: "map", r: "runs", ",": "settings" }[ev.key];
    if (v) { ev.preventDefault(); go(v, { focus: true }); }
    return;
  }
  const sel = document.activeElement?.closest?.("[data-nav]"), p = sel?.dataset.id && terms.find((t) => t.id === sel.dataset.id);
  switch (ev.key) {
    case "j": case "ArrowDown": if (ev.key === "j" || sel) { ev.preventDefault(); moveSel(1); } break;
    case "k": case "ArrowUp": if (ev.key === "k" || sel) { ev.preventDefault(); moveSel(-1); } break;
    case "Enter": if (sel && ev.target === sel) { ev.preventDefault(); sel.click(); } break;
    case "?": ev.preventDefault(); openHelp(); break;
    case "g": gPending = setTimeout(() => (gPending = 0), 1200); break;
    case "t": ev.preventDefault(); isPhone() ? showTerminal() : setTermsOpen(!document.body.classList.contains("with-terms")); break;
    case "!": ev.preventDefault(); jumpToNeeds(); break;
    case "a": if (p?.choices && LK.statusOf(p) === "waiting") { ev.preventDefault(); openAsk(p); } break;
    case "d": if (p?.git?.files) { ev.preventDefault(); showDiff(p); } break;
    case "/": ev.preventDefault(); openPalette(); break;
  }
});
