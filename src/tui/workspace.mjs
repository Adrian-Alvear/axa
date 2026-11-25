// The Workspace tab: several live sessions side by side (herdr-style). A sidebar on the left (SPACES: one row per
// open session, the commander first; AGENTS: the running helper agents, grouped by session) and 1-4 panes on the
// right, each a live session (LiveView) or the mini live map. Layout tabs (1 2 3 +) remember their panes and are
// saved in ui.json ("workspace"). Everything here is pure (layout math, focus, tabs, sidebar rows, the frames):
// app.mjs owns the views, the keys and the mouse.
import { I, clean, cut, fmtTok, line, look, paint, width } from "./draw.mjs";
import { segSpans } from "./mouse.mjs";

export const SIDE_W = 22; // the sidebar, its right border included
export const MAX_PANES = 4;
export const MAX_TABS = 9;
export const NEEDS = ["waiting", "needs_trust"];

// ---------- layout ----------
// The panes' outer rectangles (border included) in an area w x h (0-based, relative to the area):
//   1 full · 2 side by side ("v") or stacked ("h") · 3 one big + two stacked · 4 a 2x2 grid.
// zoom: the zoomed pane gets the whole area, the others are null (hidden).
export function paneRects(n, w, h, { split = "v", zoom = null } = {}) {
  n = Math.max(0, Math.min(MAX_PANES, n | 0));
  if (!n || w < 1 || h < 1) return [];
  if (zoom !== null && zoom >= 0 && zoom < n) return Array.from({ length: n }, (_, i) => (i === zoom ? { x: 0, y: 0, w, h } : null));
  const wl = Math.ceil(w / 2), wr = w - wl, ht = Math.ceil(h / 2), hb = h - ht;
  if (n === 1) return [{ x: 0, y: 0, w, h }];
  if (n === 2) return split === "h" ? [{ x: 0, y: 0, w, h: ht }, { x: 0, y: ht, w, h: hb }] : [{ x: 0, y: 0, w: wl, h }, { x: wl, y: 0, w: wr, h }];
  if (n === 3) return split === "h"
    ? [{ x: 0, y: 0, w, h: ht }, { x: 0, y: ht, w: wl, h: hb }, { x: wl, y: ht, w: wr, h: hb }]
    : [{ x: 0, y: 0, w: wl, h }, { x: wl, y: 0, w: wr, h: ht }, { x: wl, y: ht, w: wr, h: hb }];
  return [{ x: 0, y: 0, w: wl, h: ht }, { x: wl, y: 0, w: wr, h: ht }, { x: 0, y: ht, w: wl, h: hb }, { x: wl, y: ht, w: wr, h: hb }];
}
// inside the border
export const inner = (r) => ({ x: r.x + 1, y: r.y + 1, w: Math.max(1, r.w - 2), h: Math.max(1, r.h - 2) });

// The pane next to pane i in a direction ("left" | "right" | "up" | "down"): the nearest one on that side that
// overlaps it across (the most overlap wins a tie); -1 when there's none (left of the leftmost: the sidebar)
export function neighbor(rects, i, dir) {
  const a = rects[i];
  if (!a) return -1;
  let best = -1, bestD = Infinity, bestO = -1;
  rects.forEach((b, j) => {
    if (!b || j === i) return;
    const horiz = dir === "left" || dir === "right";
    const d = dir === "left" ? a.x - (b.x + b.w) : dir === "right" ? b.x - (a.x + a.w) : dir === "up" ? a.y - (b.y + b.h) : b.y - (a.y + a.h);
    if (d < 0) return;
    const o = horiz ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    if (o <= 0) return;
    if (d < bestD || (d === bestD && o > bestO)) { best = j; bestD = d; bestO = o; }
  });
  return best;
}
// which pane holds the (0-based, area-relative) cell x, y
export const paneAt = (rects, x, y) => rects.findIndex((r) => r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

// ---------- tabs and panes ----------
// a pane: { kind: "session", id } | { kind: "map" }
export const sameRef = (a, b) => !!a && !!b && a.kind === b.kind && (a.kind !== "session" || a.id === b.id);
const validRef = (r) => !!r && typeof r === "object" && (r.kind === "map" || (r.kind === "session" && typeof r.id === "string" && r.id));
export const newTab = () => ({ panes: [], split: "v", zoom: null, focus: -1 });
// ui.json's "workspace" -> { tabs, active }, whatever was saved (or nothing)
export function normWorkspace(saved) {
  const tabs = (Array.isArray(saved?.tabs) ? saved.tabs : []).slice(0, MAX_TABS).map((t) => {
    const panes = [];
    for (const r of Array.isArray(t?.panes) ? t.panes : []) if (validRef(r) && !panes.some((p) => sameRef(p, r)) && panes.length < MAX_PANES) panes.push(r.kind === "map" ? { kind: "map" } : { kind: "session", id: r.id });
    const focus = Number.isInteger(t?.focus) && t.focus >= 0 && t.focus < panes.length ? t.focus : panes.length ? 0 : -1;
    const zoom = Number.isInteger(t?.zoom) && t.zoom >= 0 && t.zoom < panes.length ? t.zoom : null;
    return { panes, split: t?.split === "h" ? "h" : "v", zoom, focus };
  });
  if (!tabs.length) tabs.push(newTab());
  const active = Number.isInteger(saved?.active) && saved.active >= 0 && saved.active < tabs.length ? saved.active : 0;
  return { tabs, active };
}
// What goes into ui.json (just the panes, split, zoom and focus of each tab)
export const saveWorkspace = (ws) => ({ active: ws.active, tabs: ws.tabs.map((t) => ({ panes: t.panes.map((p) => ({ ...p })), split: t.split, zoom: t.zoom, focus: t.focus })) });

// Put a session (or the map) on screen: already a pane here -> focus it; fewer than 4 -> a new pane; else it
// replaces the focused pane. Returns a new tab.
export function placeRef(tab, ref) {
  const panes = [...tab.panes], at = panes.findIndex((p) => sameRef(p, ref));
  if (at >= 0) return { ...tab, focus: at, zoom: tab.zoom === null ? null : at };
  if (panes.length < MAX_PANES) { panes.push(ref); return { ...tab, panes, focus: panes.length - 1, zoom: null }; }
  const f = tab.focus >= 0 && tab.focus < panes.length ? tab.focus : 0;
  panes[f] = ref;
  return { ...tab, panes, focus: f, zoom: tab.zoom === null ? null : f };
}
// Take pane i off the layout (the session keeps running)
export function removePane(tab, i) {
  if (i < 0 || i >= tab.panes.length) return tab;
  const panes = tab.panes.filter((_, j) => j !== i);
  const focus = !panes.length ? -1 : tab.focus > i ? tab.focus - 1 : Math.min(tab.focus === i ? i : tab.focus, panes.length - 1);
  return { ...tab, panes, focus: Math.max(panes.length ? 0 : -1, focus), zoom: null };
}
export const toggleZoom = (tab) => (tab.focus < 0 ? tab : { ...tab, zoom: tab.zoom === null ? tab.focus : null });
// next / previous pane (zoomed: the zoom follows the focus)
export function cycleFocus(tab, d = 1) {
  const n = tab.panes.length;
  if (!n) return tab;
  const focus = (((tab.focus < 0 ? 0 : tab.focus + d) % n) + n) % n;
  return { ...tab, focus, zoom: tab.zoom === null ? null : focus };
}
export function addTab(ws) {
  if (ws.tabs.length >= MAX_TABS) return ws;
  return { tabs: [...ws.tabs, newTab()], active: ws.tabs.length };
}
export function closeTab(ws, i = ws.active) {
  if (ws.tabs.length <= 1) return { tabs: [newTab()], active: 0 };
  const tabs = ws.tabs.filter((_, j) => j !== i);
  return { tabs, active: Math.min(ws.active > i ? ws.active - 1 : ws.active, tabs.length - 1) };
}
// sessions that went away leave the layouts (a pane never shows a closed session for long)
export function pruneTabs(ws, aliveIds) {
  let changed = false;
  const tabs = ws.tabs.map((t) => {
    let tab = t;
    for (let i = tab.panes.length - 1; i >= 0; i--) if (tab.panes[i].kind === "session" && !aliveIds.has(tab.panes[i].id)) { tab = removePane(tab, i); changed = true; }
    return tab;
  });
  return changed ? { ...ws, tabs } : ws;
}

// ---------- the sidebar ----------
// rows: { kind: "head", text } | { kind: "space", s } | { kind: "map" } | { kind: "group", s } | { kind: "agent", s, h } | { kind: "gap" }
// (spaces: alive sessions, the commander first, then by when they started; agents: running ones, by session)
export function sidebarRows(sessions = []) {
  const alive = sessions.filter((s) => s.alive);
  const spaces = [...alive.filter((s) => s.mode === "axa"), ...alive.filter((s) => s.mode !== "axa").sort((a, b) => (a.created || 0) - (b.created || 0))];
  const rows = [{ kind: "head", text: "SPACES" }, ...spaces.map((s) => ({ kind: "space", s })), { kind: "map" }, { kind: "gap" }, { kind: "head", text: "AGENTS" }];
  let any = false;
  for (const s of spaces) {
    const hs = (s.helpers || []).filter((h) => h.status === "running");
    if (!hs.length) continue;
    any = true;
    rows.push({ kind: "group", s }, ...hs.map((h) => ({ kind: "agent", s, h })));
  }
  if (!any) rows.push({ kind: "none", text: "none running" });
  return rows;
}
export const selectable = (r) => r && ["space", "map", "agent"].includes(r.kind);
// move the selection to the next selectable row (d = +1 / -1), staying put at the ends
export function moveSel(rows, i, d) {
  for (let j = i + d; j >= 0 && j < rows.length; j += d) if (selectable(rows[j])) return j;
  return selectable(rows[i]) ? i : rows.findIndex(selectable);
}
const branchOf = (s) => (s.git?.branch ? `${I.branch} ${s.git.branch}` : "");
// The sidebar's lines (exactly w wide, the last column its border) and which row is drawn where:
// { lines, at: [row index per line or -1] }. shown: session id -> pane number (1-based) in the active tab.
export function sidebarLines(rows, w, h, { sel = -1, focused = false, shown = new Map(), mapShown = 0, nameOf = (s) => clean(s.name), spin = () => "*" } = {}) {
  const iw = w - 1, lines = [], at = [];
  const nSpaces = rows.filter((r) => r.kind === "space").length;
  const two = nSpaces * 2 + 8 <= Math.floor(h * 0.7); // two lines a space (name, then branch) while there's room
  const push = (l, i) => { lines.push(l); at.push(i); };
  rows.forEach((r, i) => {
    const on = i === sel ? (focused ? "sel" : "selDim") : null;
    if (r.kind === "head") push(line([[` ${r.text}`, "dim"]], iw), -1);
    else if (r.kind === "gap") push(" ".repeat(iw), -1);
    else if (r.kind === "none") push(line([[`  ${r.text}`, "frame"]], iw), -1);
    else if (r.kind === "map") push(line([[` ◫ `, "accent"], ["live map", "text"]], iw, [[mapShown ? `${mapShown}` : "", "accent"]], on), i);
    else if (r.kind === "space") {
      const s = r.s, [g, word, role] = look(s), cmd = s.mode === "axa", need = NEEDS.includes(s.status);
      const nameRole = need ? "wait" : cmd ? "title" : "head", n = shown.get(s.id);
      push(line([[` ${cmd ? I.axa : g} `, need ? "wait" : cmd ? "title" : role], [cmd ? "AXA" : nameOf(s), nameRole]], iw, [[n ? `${n}` : "", "accent"]], on), i);
      if (two) push(line([[`   ${need ? word : branchOf(s) || word}`, need ? "waitSoft" : "dim"]], iw, [], on), i);
    } else if (r.kind === "group") push(line([[` ${look(r.s)[0]} `, look(r.s)[2]], [r.s.mode === "axa" ? "AXA" : nameOf(r.s), "text"]], iw), -1);
    else if (r.kind === "agent") {
      const h = r.h, type = String(h.type || "agent").split(":").pop();
      push(line([[`   ${spin()} `, "violet"], [type, "text"], [h.doing || h.desc ? ` ${clean(h.doing || h.desc)}` : "", "dim"]], iw, [], on), i);
    }
  });
  // keep the selection on screen
  let top = 0;
  const first = at.indexOf(sel), last = at.lastIndexOf(sel);
  if (last >= h) top = Math.min(first, last - h + 1);
  const shownL = lines.slice(top, top + h), shownA = at.slice(top, top + h);
  if (lines.length - top > h) shownL[h - 1] = line([[`  ↓ ${lines.length - top - h + 1} more`, "dim"]], iw);
  while (shownL.length < h) { shownL.push(" ".repeat(iw)); shownA.push(-1); }
  return { lines: shownL.map((l) => l + paint(focused ? "frameOn" : "frame", "│")), at: shownA };
}

// ---------- the panes ----------
// how full the context window is, in % (the status line's rule: a 1M model or more than 200k used -> 1M)
export function ctxPct(u) {
  if (!u?.context) return null;
  const limit = /\[1m\]/i.test(u.model || "") || u.context > 200_000 ? 1_000_000 : 200_000;
  return Math.min(100, Math.round((u.context / limit) * 100));
}
// The border role: amber when it waits on you, bright when focused, faint otherwise
export const paneRole = (s, focused) => (s && NEEDS.includes(s.status) ? "wait" : focused ? "frameOn" : "frame");
// A pane's title bar (its top border): name, status, branch, context %, and for a pane that waits on you its
// question and the y / x buttons. Returns { text, hits: [{ k: "yes" | "no" | "zoom" | "close", x0, x1 }] }
// with columns relative to the pane's left edge (0-based).
export function paneTitle({ s = null, kind = "session", w, focused = false, zoomed = false, armed = false, n = 0, nameOf = (x) => clean(x.name), label = "" }) {
  const role = paneRole(s, focused), need = s && NEEDS.includes(s.status) && s.choices;
  let segs, right = [];
  if (kind === "map") segs = [[` ${n} `, focused ? "tabOn" : "tabOff"], [" ◫ ", "accent"], ["live map", "head"], [label ? `  ${label}` : "", "dim"]];
  else if (!s) segs = [[` ${n} `, focused ? "tabOn" : "tabOff"], ["  this session has ended", "dim"]];
  else {
    const [g, word, srole] = look(s), pct = ctxPct(s.usage);
    segs = [[` ${n} `, need ? "chipWait" : focused ? "tabOn" : "tabOff"], [` ${s.mode === "axa" ? I.axa : g} `, need ? "wait" : srole], [s.mode === "axa" ? "AXA commander" : nameOf(s), need ? "wait" : "head"],
      [`  ${need ? "NEEDS YOU" : word}`, need ? "wait" : srole], [branchOf(s) ? `  ${branchOf(s)}` : "", "dim"], [pct !== null ? `  ctx ${pct}%` : s.usage?.tokens ? `  ${fmtTok(s.usage.tokens)} tok` : "", pct >= 85 ? "stuck" : pct >= 65 ? "waitSoft" : "dim"]];
    if (need) right = [[" y ", "keycap"], [armed ? " click again to approve " : " approve ", armed ? "chipWait" : "waitSoft"], [" x ", "keycap"], [" decline ", "waitSoft"]];
  }
  right.push([zoomed ? " ▣ " : " □ ", "dim"], [" ✕ ", "dim"]);
  const iw = Math.max(0, w - 2);
  const sp = segSpans(segs, iw, right, 1);
  const kinds = need ? ["yes", "yes", "no", "no", "zoom", "close"] : ["zoom", "close"];
  const hits = sp.right.map((r) => ({ k: kinds[r.i], x0: r.x0, x1: r.x1 }));
  return { text: paint(role, "┌") + line(segs, iw, right) + paint(role, "┐"), hits, role };
}
// A pane: the title bar, the body (rows exactly w - 2 wide) between side borders, the bottom border
export function paneBox(title, body, w, h, role) {
  const rows = [title.text];
  for (let i = 0; i < h - 2; i++) rows.push(paint(role, "│") + (body[i] ?? " ".repeat(w - 2)) + paint(role, "│"));
  if (h >= 2) rows.push(paint(role, "└" + "─".repeat(Math.max(0, w - 2)) + "┘"));
  return rows.slice(0, h);
}
// a body of h rows w wide with one message in the middle
export function messageBody(text, w, h, role = "dim") {
  const out = [];
  for (let i = 0; i < h; i++) out.push(i === Math.floor((h - 1) / 2) ? line([[" ".repeat(Math.max(0, Math.floor((w - width(cut(text, w))) / 2))) + text, role]], w) : " ".repeat(w));
  return out;
}
// Blocks { x, y, w, h, rows } (rows exactly w wide) that tile an area -> its W x H rows (gaps blank)
export function compose(W, H, blocks) {
  const out = [];
  for (let y = 0; y < H; y++) {
    let s = "", x = 0;
    for (const b of blocks.filter((b) => y >= b.y && y < b.y + b.h).sort((a, c) => a.x - c.x)) {
      if (b.x > x) s += " ".repeat(b.x - x);
      s += b.rows[y - b.y] ?? " ".repeat(b.w);
      x = b.x + b.w;
    }
    out.push(s + " ".repeat(Math.max(0, W - x)));
  }
  return out;
}
// The thin layout-tab bar: " WORKSPACE  1  2  +   …right". Returns { text, hits: [{ k: tab index | "+", x0, x1 }] }
// (1-based screen columns)
export function tabsBar(ws, W, right = []) {
  const segs = [[` ▦ WORKSPACE `, "barTitle"], [" ", "bar"]];
  ws.tabs.forEach((t, i) => { segs.push([` ${i + 1}${t.panes.length ? `·${t.panes.length}` : ""} `, i === ws.active ? "tabOn" : "tabOff"], [" ", "bar"]); });
  if (ws.tabs.length < MAX_TABS) segs.push([" + ", "keycap"]);
  const sp = segSpans(segs, W, right, 1);
  const hits = sp.left.filter((s) => s.i >= 2 && s.i % 2 === 0).map((s) => ({ k: s.i === 2 + ws.tabs.length * 2 ? "+" : (s.i - 2) / 2, x0: s.x0, x1: s.x1 }));
  return { text: line(segs, W, right, "bar"), hits };
}

// ---------- the mouse ----------
// What a click at screen cell x, y (1-based) hits on the Workspace, from the last frame's geometry
// geo { y0 (the tab bar's row), top (the first body row), side (sidebar row index per body line, -1 for none),
// rects (the panes, area-relative), panes [{ i, title: { hits } }] }:
//   { kind: "tab", k } (k a tab index or "+") | { kind: "bar" } | { kind: "side", i } (i -1: no row there)
//   | { kind: "title", pane, k } (k "yes" | "no" | "zoom" | "close" | null) | { kind: "body", pane, ix, iy, inside }
//   (ix, iy 0-based inside the border; inside false on the border itself) | null (not the Workspace)
export function wsHit(geo, x, y) {
  if (!geo || y < geo.y0) return null;
  if (y === geo.y0) { const h = geo.tabHits?.find((t) => x >= t.x0 && x <= t.x1); return h ? { kind: "tab", k: h.k } : { kind: "bar" }; }
  const by = y - geo.top;
  if (by < 0) return null;
  if (x <= SIDE_W) return { kind: "side", i: geo.side?.[by] ?? -1 };
  const ax = x - SIDE_W - 1, pane = paneAt(geo.rects || [], ax, by);
  if (pane < 0) return null;
  const r = geo.rects[pane];
  if (by === r.y) {
    const col = ax - r.x, hits = geo.panes?.find((p) => p.i === pane)?.title?.hits || [];
    return { kind: "title", pane, k: hits.find((h) => col >= h.x0 && col <= h.x1)?.k ?? null };
  }
  const ir = inner(r), ix = ax - ir.x, iy = by - ir.y;
  return { kind: "body", pane, ix, iy, inside: ix >= 0 && iy >= 0 && ix < ir.w && iy < ir.h };
}
