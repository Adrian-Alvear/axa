// ---------- terminals: real Claude Code sessions inside the dashboard ----------
const tabs = new Map(); // id -> { info, term, fit, ws, el, tab, search }
// terminal text size: remembered per browser; a little larger on phones
let fontPx = 12.5;
try { fontPx = Number(localStorage.getItem("axa.fontSize")) || (matchMedia("(max-width: 860px)").matches ? 14 : 12.5); } catch {}
let activeTab = null;
// the terminals' colors come from the theme (theme.mjs), and xterm.js lifts any text that would fall
// under 4.5:1 on its background; a new theme repaints every open terminal
const MONO = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace";
onTheme(() => {
  for (const t of tabs.values()) { t.term.options.theme = TH.xtermTheme(C.id); t.term.options.minimumContrastRatio = TH.XTERM_OPTIONS.minimumContrastRatio; }
  requestAnimationFrame(() => fitTab(tabs.get(activeTab)));
});

function setTermsOpen(open) {
  document.body.classList.toggle("with-terms", open);
  $("tbtn").classList.toggle("on", open);
  try { localStorage.setItem("axa.terms", open ? "1" : "0"); } catch {}
  if (open && activeTab) requestAnimationFrame(() => { const t = tabs.get(activeTab); fitTab(t); t?.term.focus(); });
  // the map follows the active terminal only while the terminal pane is open
  focusCwd = open && activeTab ? tabs.get(activeTab)?.info.cwd || null : null; pinned = false; autoFit = true; dirty = true;
}
$("tbtn").onclick = () => setTermsOpen(!document.body.classList.contains("with-terms"));
$("ibtn").onclick = () => { const off = document.body.classList.toggle("no-intel"); $("ibtn").classList.toggle("on", !off); try { localStorage.setItem("axa.intel", off ? "0" : "1"); } catch {} };

function termMsg(html) { $("termmsg").innerHTML = html; $("termmsg").style.display = html ? "grid" : "none"; }

function fitTab(t) {
  if (!t || !t.fit || !t.el.offsetWidth) return;
  try { t.fit.fit(); } catch {}
  if (t.ws?.readyState === 1) t.ws.send(JSON.stringify({ t: "r", c: t.term.cols, r: t.term.rows }));
}
new ResizeObserver(() => fitTab(tabs.get(activeTab))).observe($("termhost"));

function openTab(info) {
  if (tabs.has(info.id)) return tabs.get(info.id);
  const el = document.createElement("div"); el.className = "xt"; $("termhost").appendChild(el);
  const term = new Terminal({ fontFamily: MONO, fontSize: fontPx, lineHeight: 1.15, cursorBlink: true, theme: TH.xtermTheme(C.id), ...TH.XTERM_OPTIONS, allowProposedApi: true, scrollback: 5000 });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(el);
  // Optional add-ons (an older install may not have them yet): clickable links, search, GPU drawing
  let search = null;
  if (window.WebLinksAddon) try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}
  if (window.SearchAddon) try { search = new SearchAddon.SearchAddon(); term.loadAddon(search); search.onDidChangeResults((r) => { if (activeTab === info.id) showFindCount(r); }); } catch {}
  // GPU drawing on desktop screens only (phones keep the standard renderer, which is the one tested
  // there); "axa.webgl" in localStorage: "0" turns it off, "1" turns it on anywhere
  let gpu = matchMedia("(min-width: 861px) and (pointer: fine)").matches;
  try { const pref = localStorage.getItem("axa.webgl"); if (pref) gpu = pref === "1"; } catch {}
  if (gpu && window.WebglAddon) try { const gl = new WebglAddon.WebglAddon(); gl.onContextLoss(() => gl.dispose()); term.loadAddon(gl); } catch {}
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") { openFind(); return false; }
    // the page's palette: Cmd-K, or Ctrl-Shift-K (plain Ctrl-K stays the shell's); the page's handler opens it
    if (e.key?.toLowerCase() === "k" && (e.metaKey || (e.ctrlKey && e.shiftKey))) return false;
    return true;
  });
  const tab = document.createElement("div"); tab.className = "tab";
  tab.innerHTML = `<span class="stx tg"></span><span>${esc(info.name)}</span><span class="mode">${{ claude: "claude", axa: "commander", shell: "sh" }[info.mode] || "sh"}</span><span class="x" title="Close" role="button" aria-label="Close ${esc(info.name)}">${icon("close")}</span>`;
  if (info.mode === "axa") { tab.classList.add("axa"); $("tablist").prepend(tab); }
  tab.onclick = (ev) => { if (ev.target.closest(".x")) closeTab(info.id); else activate(info.id); };
  if (info.mode !== "axa") $("tablist").appendChild(tab);
  const t = { info, term, fit, el, tab, ws: null, search };
  tabs.set(info.id, t);
  const connectWs = () => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/pty/${info.id}`);
    t.ws = ws;
    let replay = true;
    ws.onopen = () => { term.reset(); fitTab(t); };
    // The first message replays the session's recent output. Terminal queries inside it (tmux asks
    // "what terminal are you?") make xterm answer again, and those answers would be typed into the
    // session as junk like "1;2c0;276;0c": drop them while the replay is being drawn.
    ws.onmessage = (m) => {
      if (!replay) return term.write(m.data);
      replay = false; t.muted = true;
      term.write(m.data, () => { t.muted = false; });
    };
    ws.onclose = () => { if (tabs.has(info.id)) { tab.classList.add("dead"); tabStatus(t); } };
  };
  const REPLY = /^(?:\x1b\[[?>]?[\d;]*[cRn]|\x1b\][\d;]*rgb:[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[IO])+$/;
  term.onData((d) => {
    if (t.muted && REPLY.test(d)) return;
    if (ctrlArmed && d.length === 1) { d = ctrlOf(d); armCtrl(false); } // the phone key bar's Ctrl
    sendInput(t, d);
  });
  // a demo session has no terminal behind it: its tab keeps the demo's status instead of "exited"
  if (info.demo) term.write("(a demo session: there is no terminal behind it)\r\n"); else connectWs();
  tabStatus(t);
  return t;
}

// a tab's status: glyph + word (in its tooltip) + color, from look.mjs; a closed one is "exited"
function tabStatus(t) {
  const st = t.tab.classList.contains("dead") || t.info.alive === false ? "exited" : LK.statusOf(t.info) || "starting", l = LK.lookOf(st);
  const g = t.tab.querySelector(".tg");
  g.textContent = glyphOf(st); g.style.setProperty("--c", roleVar(l.role));
  t.tab.dataset.state = st; t.tab.title = `${t.info.name} · ${l.word}`;
}

function activate(id) {
  activeTab = id;
  for (const [k, t] of tabs) { t.el.classList.toggle("active", k === id); t.tab.classList.toggle("active", k === id); }
  if (tabs.size) termMsg(""); else showEmpty();
  const t = tabs.get(id);
  if (t) {
    requestAnimationFrame(() => { fitTab(t); t.term.focus(); });
    // the map follows the project this terminal is in
    focusCwd = t.info.cwd; pinned = false; autoFit = true; dirty = true;
  }
  try { localStorage.setItem("axa.activeTab", id || ""); } catch {}
}

// ---------- terminal comfort: text size, search, phone keys, right size on every screen ----------
const sendInput = (t, d) => { if (t?.ws?.readyState === 1) t.ws.send(JSON.stringify({ t: "i", d })); };
function setFont(px) {
  fontPx = Math.max(9, Math.min(24, Math.round(px * 2) / 2));
  for (const t of tabs.values()) t.term.options.fontSize = fontPx;
  fitTab(tabs.get(activeTab));
  try { localStorage.setItem("axa.fontSize", String(fontPx)); } catch {}
}
$("fontdown").onclick = () => setFont(fontPx - 1);
$("fontup").onclick = () => setFont(fontPx + 1);

// search highlights in the theme's own colors (xterm.js wants #rrggbb)
const findLook = () => ({ matchBackground: TH.mix(C.bg, C.warn, 0.35), activeMatchBackground: TH.mix(C.bg, C.accent, 0.45), matchOverviewRuler: C.warn, activeMatchColorOverviewRuler: C.accent });
function openFind() { if (!tabs.get(activeTab)?.search) return; $("findbar").hidden = false; $("findq").focus(); $("findq").select(); }
function closeFind() { $("findbar").hidden = true; $("findn").textContent = ""; const t = tabs.get(activeTab); t?.search?.clearDecorations(); t?.term.focus(); }
function find(back, incremental = false) {
  const t = tabs.get(activeTab), q = $("findq").value;
  if (!t?.search) return;
  if (!q) { t.search.clearDecorations(); $("findn").textContent = ""; return; }
  const found = back ? t.search.findPrevious(q, { decorations: findLook() }) : t.search.findNext(q, { decorations: findLook(), incremental });
  if (!found) $("findn").textContent = "no match";
}
const showFindCount = (r) => { $("findn").textContent = r.resultCount ? `${r.resultIndex + 1}/${r.resultCount}` : "no match"; };
$("findbtn").onclick = () => ($("findbar").hidden ? openFind() : closeFind());
$("findq").oninput = () => find(false, true);
$("findq").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); find(e.shiftKey); } if (e.key === "Escape") closeFind(); };
$("findnext").onclick = () => find(false);
$("findprev").onclick = () => find(true);
$("findx").onclick = closeFind;
if (!window.SearchAddon) $("findbtn").hidden = true;

// Phone key bar. pointerdown + preventDefault keeps focus (and the phone keyboard) on the terminal.
let ctrlArmed = false;
const ctrlOf = (ch) => (/^[a-z@\[\]\\^_]$/i.test(ch) ? String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f) : ch);
const armCtrl = (on) => { ctrlArmed = on; document.querySelector('#keybar [data-k="ctrl"]').classList.toggle("on", on); };
const KEYS = { esc: "\x1b", tab: "\t", stab: "\x1b[Z", c: "\x03", enter: "\r", up: "A", down: "B", right: "C", left: "D" };
for (const b of document.querySelectorAll("#keybar button")) b.onpointerdown = (ev) => {
  ev.preventDefault();
  const t = tabs.get(activeTab), k = b.dataset.k;
  if (!t) return;
  if (k === "kbd") return t.term.focus();
  if (k === "ctrl") return armCtrl(!ctrlArmed);
  let d = KEYS[k];
  if (/^[A-D]$/.test(d)) d = (t.term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[") + d;
  sendInput(t, d);
};

// Coming back to this window: claim the terminal's size again (another screen may have resized it)
window.addEventListener("focus", () => fitTab(tabs.get(activeTab)));
document.addEventListener("visibilitychange", () => { if (!document.hidden) fitTab(tabs.get(activeTab)); });

async function closeTab(id) {
  const t = tabs.get(id); if (!t) return;
  if (t.info.alive && !t.tab.classList.contains("dead") && !confirm(`Close ${t.info.name}? This ends its process.`)) return;
  await fetch(`/api/terms/${id}`, { method: "DELETE" });
  t.ws?.close(); t.term.dispose(); t.el.remove(); t.tab.remove(); tabs.delete(id);
  if (activeTab === id) { const next = [...tabs.keys()].pop(); if (next) activate(next); else { activeTab = null; focusCwd = null; showEmpty(); } }
}

async function launch(cwd, mode, extra = {}) {
  $("picker").hidden = true;
  const r = await fetch("/api/terms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, mode, ...extra }) });
  const body = await r.json();
  if (!r.ok) return alert(body.error || "Could not start terminal");
  openTab(body); activate(body.id); showTerminal();
}

// project list with Claude / Shell launch buttons (used by the + popover and the empty pane)
async function renderProjects(el, onEscape) {
  const [r, rc] = await Promise.all([fetch("/api/projects"), fetch("/api/chats")]);
  const projects = r.ok ? await r.json() : [];
  const chats = rc.ok ? await rc.json() : [];
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
  el.innerHTML = `<div class="proj axa-row"><div><b>AXA commander</b><small>one Claude session that sees and drives every terminal</small></div><button class="axa-go" data-m="axa">Launch</button><span></span></div>` +
    (chats.length ? `<p class="title" style="margin-top:12px">Continue a chat as AXA</p><small class="hint">Close it wherever else it's open first: a chat runs in one place at a time.</small>` +
      chats.map((c, i) => `<div class="proj"><div><b>${esc(c.title)}</b><small>${esc(c.cwd.replace(/^\/(Users|home)\/[^/]+/, "~"))} · ${ago(c.updated)}</small></div><button data-c="${i}">Continue</button><span></span></div>`).join("") : "") + `
    <p class="title" style="margin-top:12px">Launch in project</p>` + projects.map((p, i) => `
    <div class="proj"><div><b>${esc(p.name)}</b><small>${esc(p.path.replace(/^\/(Users|home)\/[^/]+/, "~"))}</small></div>
    <button data-i="${i}" data-m="claude">Claude</button><button data-i="${i}" data-m="shell">Shell</button></div>`).join("") +
    `<input class="custompath" placeholder="or type a path, e.g. ~/projects/n2s-platform/dashboard  ↵">`;
  el.querySelectorAll("button[data-i]").forEach((b) => (b.onclick = () => launch(projects[b.dataset.i].path, b.dataset.m)));
  el.querySelectorAll("button[data-c]").forEach((b) => (b.onclick = () => launch(null, "axa", { resume: chats[b.dataset.c].id })));
  el.querySelector(".axa-go").onclick = () => { const open = [...tabs.values()].find((t) => t.info.mode === "axa" && t.info.alive); if (open) { activate(open.info.id); $("picker").hidden = true; } else launch("~", "axa"); };
  el.querySelector(".custompath").onkeydown = (ev) => { if (ev.key === "Enter" && ev.target.value.trim()) launch(ev.target.value.trim(), "claude"); if (ev.key === "Escape") onEscape?.(); };
}
async function showPicker() {
  const pk = $("picker");
  if (!pk.hidden) { pk.hidden = true; return; }
  await renderProjects(pk, () => (pk.hidden = true));
  pk.hidden = false;
}
function showEmpty() {
  termMsg(`No terminal open<div class="list" id="emptylist"></div>`);
  renderProjects($("emptylist"));
}
$("newterm").onclick = showPicker;

// terminal along the bottom (default) or beside the map
function setLayout(mode) {
  const bottom = mode === "bottom";
  document.body.classList.toggle("term-bottom", bottom);
  $("layoutbtn").innerHTML = icon(bottom ? "layoutSide" : "layout");
  $("layoutbtn").title = bottom ? "Put terminal beside the map" : "Put terminal along the bottom";
  try { localStorage.setItem("axa.layout", mode); } catch {}
  requestAnimationFrame(() => { const t = tabs.get(activeTab); fitTab(t); t?.term.focus(); });
}
$("layoutbtn").onclick = () => setLayout(document.body.classList.contains("term-bottom") ? "side" : "bottom");

// draggable divider between terminals and the map
$("splitter").addEventListener("pointerdown", (ev) => {
  const sp = $("splitter"); sp.classList.add("drag"); sp.setPointerCapture(ev.pointerId);
  const bottom = document.body.classList.contains("term-bottom");
  const move = (e) => bottom
    ? document.body.style.setProperty("--th", Math.max(160, Math.min(window.innerHeight - 220, window.innerHeight - e.clientY)) + "px")
    : document.body.style.setProperty("--tw", Math.max(320, Math.min(window.innerWidth - 420, e.clientX)) + "px");
  const up = () => {
    sp.classList.remove("drag"); sp.removeEventListener("pointermove", move); sp.removeEventListener("pointerup", up); fitTab(tabs.get(activeTab));
    try { localStorage.setItem(bottom ? "axa.th" : "axa.tw", document.body.style.getPropertyValue(bottom ? "--th" : "--tw")); } catch {}
  };
  sp.addEventListener("pointermove", move); sp.addEventListener("pointerup", up);
});

async function initTerms() {
  let prefs = {};
  try { prefs = { open: localStorage.getItem("axa.terms"), intel: localStorage.getItem("axa.intel"), tw: localStorage.getItem("axa.tw"), th: localStorage.getItem("axa.th"), layout: localStorage.getItem("axa.layout"), active: localStorage.getItem("axa.activeTab") }; } catch {}
  if (prefs.tw) document.body.style.setProperty("--tw", prefs.tw);
  if (prefs.th) document.body.style.setProperty("--th", prefs.th);
  setLayout(prefs.layout || "bottom");
  if (prefs.intel === "0") { document.body.classList.add("no-intel"); $("ibtn").classList.remove("on"); }
  if (typeof Terminal === "undefined") { $("tbtn").title = "Terminals need: npm install in the console folder"; termMsg("Terminals unavailable<br><br>Run npm install in the AXA console folder, then restart it"); return; }
  const r = await fetch("/api/terms");
  if (!r.ok) { termMsg(esc((await r.json().catch(() => ({}))).error || "Terminals unavailable")); return; }
  const list = await r.json();
  list.forEach(openTab);
  if (list.length) activate(list.some((t) => t.id === prefs.active) ? prefs.active : list[list.length - 1].id); else showEmpty();
  setTermsOpen(prefs.open === "1" || (prefs.open === null && list.length > 0));
}
