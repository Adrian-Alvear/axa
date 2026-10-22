// AXA console: the design system on the page. Loads the shared modules (/shared/theme.mjs: themes as
// tokens; /shared/look.mjs: one status vocabulary), applies the chosen theme and density, keeps the
// embedded terminals and the map in step, and runs the theme switcher and the settings dialog.
// Loaded first: the other scripts read TH, LK and C (the current theme's tokens) once designReady resolves.

let TH = null, LK = null; // the two shared modules
let C = {}; // current theme tokens: bg, panel, text, dim, accent, ok, warn, bad, line, line2, sel, raised, *Soft, onAccent, core
const themeHooks = []; // called after every theme change (map colors, terminals, feed)
// (a script that registers after the first theme was applied gets it right away)
const onTheme = (fn) => { themeHooks.push(fn); if (C.id) fn(C); };
const byId = (id) => document.getElementById(id);

// ---------- per-browser preferences (localStorage can be missing or throw: defaults then) ----------
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const prefs = { theme: lsGet("axa.theme") || "hud", follow: lsGet("axa.themeFollow") === "1", sync: lsGet("axa.themeSync"), density: lsGet("axa.density") === "compact" ? "compact" : "comfortable" };
const mqLight = matchMedia("(prefers-color-scheme: light)");

// The theme that's on screen: "follow system" puts Paper on a light system and your chosen dark theme
// (AXA HUD if you chose a light one) on a dark one. The terminal app's "terminal" shows as AXA HUD here.
function effectiveTheme() {
  let id = TH.themeId(prefs.theme);
  if (id === TH.TERMINAL_THEME) id = TH.DEFAULT_THEME;
  if (prefs.follow) {
    if (mqLight.matches) return "paper";
    if (TH.THEMES[id].kind === "light") return TH.DEFAULT_THEME;
  }
  return id;
}
const pickedTheme = () => { const id = TH.themeId(prefs.theme); return id === TH.TERMINAL_THEME ? TH.DEFAULT_THEME : id; };

function applyTheme() {
  const id = effectiveTheme(), t = TH.tokens(id), root = document.documentElement;
  const light = t.kind === "light";
  // the bright center of AXA's reactor and the data packets: near-white on dark, the accent on light
  C = { ...t, id, light, core: light ? t.accent : TH.mix(t.text, "#ffffff", 0.6) };
  root.dataset.theme = id; root.dataset.kind = t.kind;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.bg);
  // for the early script in index.html: no flash of the wrong colors on the next load
  lsSet("axa.themeNow", id); lsSet("axa.themeKind", t.kind);
  for (const fn of themeHooks) try { fn(C); } catch (e) { console.error(e); }
  syncControls();
}

function setDensity(d) {
  prefs.density = d === "compact" ? "compact" : "comfortable";
  document.documentElement.dataset.density = prefs.density;
  lsSet("axa.density", prefs.density);
  syncControls();
  themeHooks.forEach((fn) => { try { fn(C); } catch {} }); // terminals refit
}

// ---------- sync with the terminal app ($AXA_HOME/ui.json through /api/ui-settings) ----------
const syncOn = () => prefs.sync === "1";
async function uiSettings(body) {
  try {
    const r = await fetch("/api/ui-settings", body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
async function pullTheme() {
  const s = await uiSettings();
  if (!s) return;
  // syncing is one shared switch: turned off in the terminal app, it's off here too
  prefs.sync = s.themeSync ? "1" : "0"; lsSet("axa.themeSync", prefs.sync);
  if (syncOn() && s.theme && s.theme !== prefs.theme) { prefs.theme = s.theme; lsSet("axa.theme", s.theme); applyTheme(); }
  syncControls();
}

function setTheme(id) {
  prefs.theme = TH.themeId(id); lsSet("axa.theme", prefs.theme);
  applyTheme();
  if (syncOn()) uiSettings({ theme: prefs.theme });
}
function setFollow(on) { prefs.follow = on; lsSet("axa.themeFollow", on ? "1" : "0"); applyTheme(); }
function setSync(on) {
  prefs.sync = on ? "1" : "0"; lsSet("axa.themeSync", prefs.sync);
  // turning it on adopts the shared theme (the terminal app's "terminal" or "mono" stay as they are and
  // show as AXA HUD here); this page's theme becomes the shared one only if none was saved yet
  uiSettings({ themeSync: on }).then((r) => { if (on && r && !r.theme) uiSettings({ theme: pickedTheme() }); else if (on) pullTheme(); });
  syncControls();
}

// ---------- controls: the header picker and the settings dialog ----------
function syncControls() {
  if (!TH) return;
  const box = byId("settings"); if (!box) return;
  for (const r of box.querySelectorAll("input[name=theme]")) r.checked = r.value === pickedTheme();
  for (const r of box.querySelectorAll("input[name=density]")) r.checked = r.value === prefs.density;
  byId("setfollow").checked = prefs.follow;
  byId("setsync").checked = syncOn();
  byId("setnow").textContent = prefs.follow ? `On screen now: ${TH.THEMES[effectiveTheme()].label} (system is ${mqLight.matches ? "light" : "dark"})` : "";
}
function buildControls() {
  const list = TH.themeList();
  // each choice shows its own colors (the swatch is drawn in that theme, whatever is on screen)
  byId("setthemes").innerHTML = list.map((t) => {
    const k = TH.tokens(t.id);
    return `<label class="swatch" style="--sw-bg:${k.bg};--sw-panel:${k.panel};--sw-text:${k.text};--sw-dim:${k.dim};--sw-line:${k.line2};--sw-a:${k.accent};--sw-ok:${k.ok};--sw-w:${k.warn};--sw-b:${k.bad}">
      <input type="radio" name="theme" value="${t.id}"><span class="sw-card"><b>${t.label}</b><small>${t.kind}</small><span class="sw-dots"><i style="background:var(--sw-a)"></i><i style="background:var(--sw-ok)"></i><i style="background:var(--sw-w)"></i><i style="background:var(--sw-b)"></i></span></span></label>`;
  }).join("");
  for (const r of document.querySelectorAll("#settings input[name=theme]")) r.onchange = () => setTheme(r.value);
  for (const r of document.querySelectorAll("#settings input[name=density]")) r.onchange = () => setDensity(r.value);
  byId("setfollow").onchange = (ev) => setFollow(ev.target.checked);
  byId("setsync").onchange = (ev) => setSync(ev.target.checked);
}
// Settings is a view now (nav.js): opening it just shows it with the controls up to date
function openSettings() { syncControls(); if (typeof go === "function") go("settings"); }

// ---------- status vocabulary helpers (look.mjs): glyph + word + color role, never color alone ----------
const roleVar = (role) => `var(--${role})`;
// a status glyph always drawn as text, never as a color emoji (U+FE0E asks for the text form of ⚠)
const glyphOf = (s) => LK.lookOf(s).glyph + "\uFE0E";
// <span class="stx" style="--c:var(--warn)">⚠ needs you</span>
const statusHtml = (s, extra = "") => { const l = LK.lookOf(s); return `<span class="stx" style="--c:${roleVar(l.role)}">${glyphOf(s)} ${l.word}${extra}</span>`; };
const statusText = (s) => `${glyphOf(s)} ${LK.lookOf(s).word}`;
const statusColor = (s) => C[LK.lookOf(s).role] || C.dim;

// ---------- startup ----------
const designReady = Promise.all([import("/shared/theme.mjs"), import("/shared/look.mjs")]).then(([t, l]) => {
  TH = t; LK = l;
  // the page's theme rules, kept for the early script in index.html (no flash on the next load)
  const css = TH.cssText();
  let style = byId("themecss");
  if (!style) { style = document.createElement("style"); style.id = "themecss"; document.head.appendChild(style); }
  style.textContent = css; lsSet("axa.themeCss", css);
  document.documentElement.dataset.density = prefs.density;
  buildControls();
  applyTheme();
  mqLight.addEventListener("change", () => { if (prefs.follow) applyTheme(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pullTheme(); });
  pullTheme();
});
