// The Workspace tab: several live sessions side by side (herdr-style), calm: one line of chrome on top, a sidebar of
// spaces on the left (one row per open session, the commander first; the focused pane's running agents nested under
// its space) and 1-4 panes on the right, each a live session (LiveView) or the mini live map, with thin dim
// dividers between them and a one-line header each. Layout tabs (1 2 3 +) remember their panes and are
// saved in ui.json ("workspace"). Everything here is pure (layout math, focus, tabs, sidebar rows, the frames):
// app.mjs owns the views, the keys and the mouse.
import { I, clean, cut, line, look, mix, paint, width } from "./draw.mjs";
import { segSpans } from "./mouse.mjs";
import { FRAME_MS, GLYPHS, breath, spinFrames, wave } from "./alive.mjs";
import { laneDoing, laneGroup, laneSessions, laneTime } from "./lanes.mjs";

export const SIDE_W = 22; // the full sidebar, its divider included
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

// ---------- the look: calm (docs/tasks/workspace-clean.md) ----------
// One accent for focus, amber only for needs-you, red only for failed / stuck, green only for done; everything
// else normal or dim; no bold but the focused pane's name. No boxes: thin dim dividers between panes.
const FINISHED = ["done", "ready", "exited"];
// a status dot's colour role
export function statusRole(s) {
  if (!s) return "dim";
  if (NEEDS.includes(s.status)) return "wait";
  if (["stuck", "failed"].includes(s.status)) return "stuck";
  if (s.status === "done") return "done";
  if (["working", "starting", "limited"].includes(s.status)) return "text";
  return "dim";
}
// how wide the sidebar is (its divider included): full from 120 columns, dots + 3 letters from 90, hidden below
// (shown: an override, e.g. Ctrl-b s, or the sidebar has the focus)
export const COMPACT_W = 7;
export function sideWidth(W, shown = null) {
  const on = shown ?? W >= 90;
  return !on ? 0 : W >= 120 ? SIDE_W : COMPACT_W;
}
// an agent's short name: researcher, reviewer, builder, explore, helper (general-purpose), plan...
export function agentShort(type = "") {
  const t = String(type || "agent").split(":").pop().toLowerCase();
  return t === "general-purpose" ? "helper" : t;
}
const runningOf = (s) => (s.helpers || []).filter((h) => h.status === "running");

// ---------- the sidebar ----------
// rows: { kind: "head", text } | { kind: "space", s, n (running agents) } | { kind: "agent", s, h } | { kind: "more", n }
//   | { kind: "gap" } | { kind: "map" }
// Spaces: alive sessions, the commander first, then by when they started. The focused pane's space (current) shows
// its running agents nested under it (up to 4, "+N" for the rest); the others only count them.
export const AGENTS_SHOWN = 4;
export function sidebarRows(sessions = [], current = null) {
  const alive = sessions.filter((s) => s.alive);
  const spaces = [...alive.filter((s) => s.mode === "axa"), ...alive.filter((s) => s.mode !== "axa").sort((a, b) => (a.created || 0) - (b.created || 0))];
  const rows = [{ kind: "head", text: "spaces" }];
  for (const s of spaces) {
    const hs = runningOf(s);
    rows.push({ kind: "space", s, n: hs.length });
    if (s.id !== current || !hs.length) continue;
    rows.push(...hs.slice(0, AGENTS_SHOWN).map((h) => ({ kind: "agent", s, h })));
    if (hs.length > AGENTS_SHOWN) rows.push({ kind: "more", n: hs.length - AGENTS_SHOWN });
  }
  rows.push({ kind: "gap" }, { kind: "map" });
  return rows;
}
export const selectable = (r) => r && ["space", "map", "agent"].includes(r.kind);
// move the selection to the next selectable row (d = +1 / -1), staying put at the ends
export function moveSel(rows, i, d) {
  for (let j = i + d; j >= 0 && j < rows.length; j += d) if (selectable(rows[j])) return j;
  return selectable(rows[i]) ? i : rows.findIndex(selectable);
}
// The sidebar's lines (exactly w wide, the last column a dim divider) and which row each line is:
// { lines, at: [row index or -1] }. current: the focused pane's session id (its row gets the accent bar).
// w COMPACT_W: a dot and 3 letters a space, no agents.
export function sidebarLines(rows, w, h, { sel = -1, focused = false, current = null, nameOf = (s) => clean(s.name) } = {}) {
  const iw = w - 1, compact = w <= COMPACT_W, lines = [], at = [];
  const push = (l, i) => { lines.push(l); at.push(i); };
  rows.forEach((r, i) => {
    const on = focused && i === sel ? "sel" : null;
    if (r.kind === "head") { if (!compact) push(line([[` ${r.text}`, "dim"]], iw), -1); }
    else if (r.kind === "gap") push(" ".repeat(iw), -1);
    else if (r.kind === "map") push(line([[compact ? " ◫" : " ◫ live map", "dim"]], iw, [], on), i);
    else if (r.kind === "space") {
      const s = r.s, role = statusRole(s), need = role === "wait";
      const nm = s.mode === "axa" ? "axa" : nameOf(s);
      const nameRole = need ? "waitSoft" : FINISHED.includes(s.status) ? "dim" : "text";
      const bar = [s.id === current ? "▎" : " ", "accent"];
      if (compact) push(line([bar, ["● ", role], [[...nm].slice(0, 3).join(""), nameRole]], iw, [], on), i);
      else push(line([bar, ["● ", role], [nm, nameRole]], iw, [[r.n ? `·${r.n}` : "", "dim"]], on), i);
    } else if (compact) return;
    else if (r.kind === "agent") {
      const h = r.h, step = clean(h.doing || h.desc || "");
      push(line([[`    ${agentShort(h.type)}`, "text"], [step ? ` ${step}` : "", "dim"]], iw, [], on), i);
    } else if (r.kind === "more") push(line([[`    +${r.n} more`, "dim"]], iw), -1);
  });
  // keep the selection on screen
  let top = 0;
  const first = at.indexOf(sel), last = at.lastIndexOf(sel);
  // (one row above the last: a "↓ more" line may take that one)
  if (last >= h - 1 && lines.length > h) top = Math.max(0, Math.min(first, last - h + 2));
  const shownL = lines.slice(top, top + h), shownA = at.slice(top, top + h);
  if (lines.length - top > h) { shownL[h - 1] = line([[compact ? " ↓" : `  ↓ ${lines.length - top - h + 1} more`, "dim"]], iw); shownA[h - 1] = -1; }
  while (shownL.length < h) { shownL.push(" ".repeat(iw)); shownA.push(-1); }
  return { lines: shownL.map((l) => l + paint("frame", "│")), at: shownA };
}

// ---------- the panes ----------
// how full the context window is, in % (the status line's rule: a 1M model or more than 200k used -> 1M)
export function ctxPct(u) {
  if (!u?.context) return null;
  const limit = /\[1m\]/i.test(u.model || "") || u.context > 200_000 ? 1_000_000 : 200_000;
  return Math.min(100, Math.round((u.context / limit) * 100));
}
// A pane's parts inside its rectangle r (area-relative): a divider column on the left when it isn't at the left
// edge, a divider row on top when it isn't at the top; then c (the content: a header line, then the body) and b
// (the body: under the header, one column of padding each side)
export function paneParts(r) {
  const dl = r.x > 0 ? 1 : 0, dt = r.y > 0 ? 1 : 0;
  const c = { x: r.x + dl, y: r.y + dt, w: Math.max(1, r.w - dl), h: Math.max(1, r.h - dt) };
  const b = { x: c.x + 1, y: c.y + 1, w: Math.max(1, c.w - 2), h: Math.max(1, c.h - 1) };
  return { c, b, dl, dt };
}
// where a pane's top and left dividers meet: ┼ with a divider above and to the left, ├ above only, ┬ left only
export function cornerOf(r, rects) {
  const up = rects.some((o) => o && o !== r && o.x === r.x && o.y + o.h === r.y && o.x > 0);
  const left = rects.some((o) => o && o !== r && o.y === r.y && o.x + o.w === r.x && o.y > 0);
  return up && left ? "┼" : up ? "├" : left ? "┬" : "┌";
}
// A pane's one-line header (c.w wide): the focused pane gets an accent bar (▎) and its name in bold, the others
// are dim; status as a coloured dot + a dim word, the branch dim. A pane that waits on you turns amber with
// "needs you · y approve · x decline". Zoom / close only on the focused pane. Returns { text, hits: [{ k:
// "yes" | "no" | "zoom" | "close", x0, x1 }] } (columns relative to the header's start, 0-based).
export function paneHeader({ s = null, kind = "session", w, focused = false, zoomed = false, armed = false, nameOf = (x) => clean(x.name), label = "" }) {
  const need = !!s && NEEDS.includes(s.status) && !!s.choices;
  const bar = [focused ? "▎" : " ", need ? "wait" : "accent"];
  let segs, right = [], kinds = [];
  if (kind === "map") segs = [bar, [" live map", focused ? "head" : "dim"], [label ? ` · ${label}` : "", "dim"]];
  else if (!s) segs = [bar, [" this session has ended", "dim"]];
  else {
    const name = s.mode === "axa" ? "AXA commander" : nameOf(s);
    if (need) {
      segs = [bar, [` ${name}`, focused ? "wait" : "waitSoft"], [" · needs you", "waitSoft"]];
      right = [[" y ", "chipWait"], [armed ? " click again to approve " : " approve ", armed ? "wait" : "waitSoft"], [" x ", "chipWait"], [" decline ", "waitSoft"]];
      kinds = ["yes", "yes", "no", "no"];
    } else {
      const pct = ctxPct(s.usage), role = statusRole(s);
      segs = [bar, [` ${name}`, focused ? "head" : "dim"], ["  ● ", role], [look(s)[1], "dim"], [s.git?.branch ? `  ${I.branch} ${s.git.branch}` : "", "dim"], [pct >= 65 ? `  ctx ${pct}%` : "", pct >= 85 ? "stuck" : "dim"]];
    }
  }
  if (focused) { right.push([zoomed ? " ▣ " : " □ ", "dim"], [" ✕ ", "dim"]); kinds.push("zoom", "close"); }
  const sp = segSpans(segs, w, right, 0);
  return { text: line(segs, w, right), hits: sp.right.map((r) => ({ k: kinds[r.i], x0: r.x0, x1: r.x1 })) };
}
// A pane's rows (exactly r.w wide, r.h tall): its dividers, the header, the body rows (b.w wide) padded
export function paneBlock(r, rects, header, body) {
  const { c, b, dl, dt } = paneParts(r), rows = [];
  if (dt) rows.push(paint("frame", (dl ? cornerOf(r, rects) : "") + "─".repeat(c.w)));
  const left = dl ? paint("frame", "│") : "", padR = " ".repeat(Math.max(0, c.w - b.w - 1));
  rows.push(left + header.text);
  for (let i = 0; i < c.h - 1; i++) rows.push(left + " " + (body[i] ?? " ".repeat(b.w)) + padR);
  return rows.slice(0, r.h);
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
// The Workspace's one line of chrome: "◆ workspace  1 2 +" on the left; "▲ 2 need you", a note (a toast, the
// prefix waiting) or a dim "Ctrl-b ? keys", and the clock on the right.
// Returns { text, hits: [{ k: tab index | "+" | "home" | "needs" | "help", x0, x1 }] } (1-based screen columns)
export function topLine(ws, W, { needs = 0, clock = "", note = null, prefix = "Ctrl-b" } = {}) {
  const segs = [[" ◆ ", "dim"], ["workspace", "dim"], ["  ", ""]];
  ws.tabs.forEach((t, i) => segs.push([` ${i + 1} `, i === ws.active ? "accent" : "dim"]));
  if (ws.tabs.length < MAX_TABS) segs.push([" + ", "dim"]);
  const right = [[needs ? ` ▲ ${needs} need${needs === 1 ? "s" : ""} you ` : "", "chipWait"], [needs ? "   " : "", ""], note || [`${prefix} ? keys`, "dim"], [clock ? `   ${clock}` : "", "dim"]];
  const sp = segSpans(segs, W, right, 1), hits = [];
  for (const s of sp.left) {
    if (s.i <= 1) hits.push({ k: "home", x0: s.x0, x1: s.x1 });
    else if (s.i >= 3) hits.push({ k: s.i - 3 < ws.tabs.length ? s.i - 3 : "+", x0: s.x0, x1: s.x1 });
  }
  for (const s of sp.right) if (s.i === 0) hits.push({ k: "needs", x0: s.x0, x1: s.x1 }); else if (s.i === 2 && !note) hits.push({ k: "help", x0: s.x0, x1: s.x1 });
  return { text: line(segs, W, right, "bar"), hits };
}

// ---------- the mouse ----------
// What a click at screen cell x, y (1-based) hits on the Workspace, from the last frame's geometry
// geo { y0 (the top line's row), top (the first body row), sideW, side (sidebar row index per body line, -1 none),
// rects (the panes, area-relative), panes [{ i, header: { hits } }], tabHits (the top line's) }:
//   { kind: "tab", k } (k a tab index, "+", "home", "needs" or "help") | { kind: "bar" } | { kind: "side", i }
//   | { kind: "title", pane, k } (k "yes" | "no" | "zoom" | "close" | null) | { kind: "body", pane, ix, iy, inside }
//   (ix, iy 0-based in the body; inside false on a divider or the padding) | null (not the Workspace)
export function wsHit(geo, x, y) {
  if (!geo || y < geo.y0) return null;
  if (y === geo.y0) { const h = geo.tabHits?.find((t) => x >= t.x0 && x <= t.x1); return h ? { kind: "tab", k: h.k } : { kind: "bar" }; }
  const by = y - geo.top, sw = geo.sideW ?? SIDE_W;
  if (by < 0) return null;
  if (x <= sw) return { kind: "side", i: geo.side?.[by] ?? -1 };
  const ax = x - sw - 1, pane = paneAt(geo.rects || [], ax, by);
  if (pane < 0) return null;
  const { c, b } = paneParts(geo.rects[pane]);
  if (by === c.y && ax >= c.x) {
    const col = ax - c.x, hits = geo.panes?.find((p) => p.i === pane)?.header?.hits || [];
    return { kind: "title", pane, k: hits.find((h) => col >= h.x0 && col <= h.x1)?.k ?? null };
  }
  const ix = ax - b.x, iy = by - b.y;
  return { kind: "body", pane, ix, iy, inside: ix >= 0 && iy >= 0 && ix < b.w && iy < b.h };
}

// ---------- the mini live map: slim (docs/tasks/workspace-clean.md) ----------
// A small map pane shows one calm row per session instead of the full lanes squeezed in:
//   ● billing   deploy:preview?            waiting 2m
//   ✶ api       Bash npm test                  for 1m
//   ● notes     README updated                5m ago
// a status dot in the sidebar's colours (breathing while it works, a slow amber pulse while it needs you), the name,
// a short dim "doing" and the time on the right; needs-you first, then working, then the rest; "+N more" when they
// don't fit. No strips, packets or branches. The full lanes come back when the pane is zoomed or big enough.
export const SLIM_FULL = { w: 120, h: 30 };
export const slimWanted = ({ w, h }, zoomed = false) => !zoomed && !(w >= SLIM_FULL.w && h >= SLIM_FULL.h);
const BUSY = ["working", "starting"];
// 0 needs you, 1 working, 2 the rest (failed / stuck first among them, as in the lanes); stable by start
const slimGroup = (s) => (NEEDS.includes(s.status) ? 0 : BUSY.includes(s.status) ? 1 : 2);
export const slimOrder = (sessions, selId) => laneSessions(sessions, selId).lanes
  .map((s, i) => [s, i])
  .sort(([a, i], [b, j]) => slimGroup(a) - slimGroup(b) || laneGroup({ ...a, mode: "" }) - laneGroup({ ...b, mode: "" }) || i - j)
  .map(([s]) => s);
const pad = (t, n) => t + " ".repeat(Math.max(0, n - width(t)));
const phase = (id) => { let h = 7; for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 2654435761); return (h >>> 0) % 4000; };
// ctx as laneRows' (sessions, selId, motion, glyphs, question, mapHits) -> rows exactly `cols` wide; fills
// ctx.mapHits (one per row) and ctx.next (ms until the next frame differs, null = still)
export function slimRows(ctx, cols, rows, now = Date.now()) {
  const order = slimOrder(ctx.sessions || [], ctx.selId), hidden = laneSessions(ctx.sessions || [], ctx.selId).hidden;
  const motion = ctx.motion || "full", full = motion === "full", color = motion !== "off";
  const set = ctx.glyphs || "safe", G = GLYPHS[set] || GLYPHS.safe, frames = spinFrames(set);
  const hits = ctx.mapHits || (ctx.mapHits = []), out = [];
  let next = Infinity;
  const blank = " ".repeat(cols);
  if (!order.length) {
    out.push(line([["  No sessions yet", "dim"]], cols));
  } else {
    const fits = order.length + (hidden ? 1 : 0) <= rows, per = fits ? order.length : Math.max(1, rows - 1);
    const sel = Math.max(0, order.findIndex((s) => s.id === ctx.selId));
    const start = fits ? 0 : Math.max(0, Math.min(order.length - per, sel - per + 1));
    const shown = order.slice(start, start + per);
    const nameOf = (s) => (s.mode === "axa" ? "AXA" : clean(s.name));
    const nameW = Math.min(14, Math.max(4, ...shown.map((s) => width(nameOf(s)))));
    const times = shown.map((s) => laneTime(s, now));
    const timeW = cols >= 36 ? Math.min(14, Math.max(0, ...times.map(width))) : 0;
    const doingW = cols - 3 - nameW - 2 - (timeW ? timeW + 2 : 0) - 1;
    shown.forEach((s, k) => {
      const role = statusRole(s);
      let dot = "●", dRole = role;
      if (BUSY.includes(s.status) || (s.mode === "axa" && s.status === "working")) { dot = full ? breath(now + phase(s.id), frames) : G.still; if (full) next = Math.min(next, FRAME_MS); }
      if (NEEDS.includes(s.status) && color) { dRole = mix("wait", "waitHi", wave(now + phase(s.id))); next = Math.min(next, FRAME_MS); }
      const doing = doingW >= 6 ? laneDoing(s, ctx.question) : "";
      const segs = [[" ", ""], [dot, dRole], [" ", ""], [pad(cut(nameOf(s), nameW), nameW), role === "wait" ? "waitSoft" : "text"]];
      if (doingW >= 6) { const d = cut(doing, doingW); segs.push(["  ", ""], [d + " ".repeat(doingW - width(d)), "dim"]); }
      const right = timeW ? [[cut(times[k], timeW), role === "wait" ? "waitSoft" : "dim"]] : [];
      out.push(line(segs, cols, right, s.id === ctx.selId ? "selDim" : null));
      hits.push({ col0: 0, col1: cols, row0: out.length - 1, row1: out.length - 1, id: s.id });
    });
    const more = order.length - start - shown.length;
    const note = [start ? `↑ ${start} above` : "", more > 0 ? `+${more} more` : "", hidden ? `${hidden} idle` : ""].filter(Boolean).join(" · ");
    if (note) out.push(line([[`   ${note}`, "dim"]], cols));
  }
  while (out.length < rows) out.push(blank);
  ctx.next = next === Infinity ? null : next;
  ctx.anim = next <= FRAME_MS;
  return out.slice(0, rows);
}
