// AXA console: the canvas map (physics, drawing, pointer interaction)

// collapsed = leaves of a job that finished a while ago (kept in data, hidden from the map)
const HELPER_KEEP_MS = 10000;
function hidden(g, n) {
  if (mission && n.kind !== "axa") {
    if (n.kind !== "inst") return true;
    return n.status === "done" && Date.now() - n.end > HELPER_KEEP_MS && selectedId !== n.id;
  }
  if (n.kind !== "leaf") return false;
  const p = g.nodes.get(n.parent);
  return p && p.kind === "inst" && p.status === "done" && Date.now() - p.end > COLLAPSE_MS && selectedId !== p.id;
}

// ---------- physics ----------
const W = { axa: 3.4, role: 2.2, inst: 1.4, leaf: 0.6 };
const LEN = { role: 210, inst: 110, leaf: 58 };
function step(g) {
  const ns = [...g.nodes.values()].filter((n) => !n.hide);
  for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
    const a = ns[i], b = ns[j];
    let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
    if (d2 < 1) { dx = Math.random() - .5; dy = Math.random() - .5; d2 = 1; }
    if (d2 > 250000) continue;
    const f = 2600 * W[a.kind] * W[b.kind] / d2, d = Math.sqrt(d2);
    a.vx -= dx / d * f; a.vy -= dy / d * f; b.vx += dx / d * f; b.vy += dy / d * f;
  }
  for (const l of g.links) {
    const a = g.nodes.get(l.a), b = g.nodes.get(l.b);
    if (!a || !b || b.hide) continue;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    const f = (d - (LEN[b.kind] || 80)) * 0.035;
    a.vx += dx / d * f * 0.5; a.vy += dy / d * f * 0.5; b.vx -= dx / d * f; b.vy -= dy / d * f;
  }
  for (const n of ns) {
    if (n.fixed) { n.vx = n.vy = 0; continue; }
    n.vx -= n.x * 0.0015; n.vy -= n.y * 0.0015;
    n.vx *= 0.8; n.vy *= 0.8;
    const v = Math.hypot(n.vx, n.vy); if (v > 12) { n.vx *= 12 / v; n.vy *= 12 / v; }
    if (n !== drag?.node) { n.x += n.vx; n.y += n.vy; }
  }
}

// ---------- drawing ----------
// prefers-reduced-motion: the reactor stops spinning, nothing pulses, no data packets
const calm = matchMedia("(prefers-reduced-motion: reduce)");
const still = (now) => (calm.matches ? 0 : now);
const cv = $("cv"), ctx = cv.getContext("2d");
let Wd = 0, Ht = 0, dpr = 1;
const cam = { x: 0, y: 0, k: 1 }; let autoFit = true;
function resize() {
  const r = cv.getBoundingClientRect(); dpr = window.devicePixelRatio || 1;
  Wd = r.width; Ht = r.height; cv.width = Wd * dpr; cv.height = Ht * dpr;
}
new ResizeObserver(resize).observe(cv);
const toWorld = (sx, sy) => [(sx - Wd / 2) / cam.k + cam.x, (sy - Ht / 2) / cam.k + cam.y];

function fit(g, instant) {
  if (mission) {
    const R = PLANET_R + 150, k = Math.min(1.2, Math.min(Wd / (2 * R + 40), (Ht - 50) / (2 * (PLANET_R + 90) + 40)));
    const t = instant ? 1 : 0.06;
    cam.x += (0 - cam.x) * t; cam.y += (10 - cam.y) * t; cam.k += (k - cam.k) * t;
    return;
  }
  let x0 = -160, y0 = -160, x1 = 160, y1 = 160; // keep AXA's rings in frame even when alone
  for (const n of g.nodes.values()) if (!n.hide) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
  const dockH = $("dock").classList.contains("on") ? $("dock").offsetHeight : 0;
  const k = Math.min(1.5, Math.min(Wd / (x1 - x0 + 260), (Ht - dockH) / (y1 - y0 + 220)));
  const t = instant ? 1 : 0.05;
  cam.x += ((x0 + x1) / 2 - cam.x) * t; cam.y += ((y0 + y1) / 2 + dockH / 2 / k - cam.y) * t; cam.k += (k - cam.k) * t;
}

function rgba(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
function text(str, x, y, { size = 10, color = C.text, weight = 400, spacing = 0, align = "center", alpha = 1 } = {}) {
  ctx.font = `${weight} ${size}px ${FONT_UI}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = spacing + "px";
  ctx.textAlign = align; ctx.globalAlpha = alpha;
  ctx.lineJoin = "round"; ctx.lineWidth = 4; ctx.strokeStyle = C.bg; ctx.strokeText(str, x, y);
  ctx.fillStyle = color; ctx.fillText(str, x, y);
  ctx.globalAlpha = 1; if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
}
function arc(x, y, r, a0, a1, color, w, alpha = 1) {
  ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = w;
  ctx.beginPath(); ctx.arc(x, y, r, a0, a1); ctx.stroke(); ctx.globalAlpha = 1;
}
// label "types in" over its first moments on screen
const typed = (s, n, now) => s.slice(0, Math.max(1, Math.floor((now - n.born) / 22)));
const active = (n, now) => n.status === "running" || n.hotUntil > now;

function drawBackdrop(now) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const grd = ctx.createRadialGradient(Wd / 2, Ht / 2, 0, Wd / 2, Ht / 2, Math.max(Wd, Ht) * 0.7);
  grd.addColorStop(0, TH.mix(C.bg, C.accent, C.light ? 0.05 : 0.06)); grd.addColorStop(1, C.bg);
  ctx.fillStyle = grd; ctx.fillRect(0, 0, Wd, Ht);
  // HUD corner brackets
  ctx.strokeStyle = rgba(C.accent, 0.35); ctx.lineWidth = 1;
  const m = 14, L = 22;
  for (const [x, y, sx, sy] of [[m, m, 1, 1], [Wd - m, m, -1, 1], [m, Ht - m, 1, -1], [Wd - m, Ht - m, -1, -1]]) {
    ctx.beginPath(); ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y); ctx.stroke();
  }
  text(new Date().toLocaleTimeString([], { hour12: false }), Wd - 22, Ht - 22, { size: 9, color: C.dim, spacing: 2, align: "right", alpha: 0.8 });
}

function drawRange(now) {
  // range rings + bearing ticks around AXA
  for (const r of [210, 330, 450]) {
    ctx.setLineDash([2, 8]); arc(0, 0, r, 0, Math.PI * 2, C.accent, 1 / cam.k, C.light ? 0.25 : 0.12); ctx.setLineDash([]);
  }
  ctx.strokeStyle = rgba(C.accent, C.light ? 0.3 : 0.18); ctx.lineWidth = 1 / cam.k;
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2, r0 = 450, r1 = i % 6 ? 456 : 464;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.stroke();
  }
}

// AXA's own state in the shared vocabulary: waiting on you, working, done (your turn), ready
const axaStatus = (n) => (n.perm ? "waiting" : n.status === "running" ? "working" : n.yourTurn ? "done" : "ready");
// the page's text font, for labels drawn on the canvas
const FONT_UI = getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim() || "system-ui, sans-serif";
function drawAxa(n, now) {
  const t = still(now) / 1000, on = n.status === "running", pulse = calm.matches ? 0.5 : 0.5 + 0.5 * Math.sin(t * 3);
  const st = axaStatus(n), ACCENT = statusColor(st) === C.text ? C.accent : statusColor(st);
  ctx.save(); ctx.translate(n.x, n.y);
  // core glow
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 60);
  glow.addColorStop(0, rgba(ACCENT, on ? 0.45 + pulse * 0.2 : 0.25)); glow.addColorStop(1, rgba(ACCENT, 0));
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, 60, 0, 7); ctx.fill();
  ctx.fillStyle = C.core; ctx.shadowColor = ACCENT; ctx.shadowBlur = 20;
  ctx.beginPath(); ctx.arc(0, 0, 9 + (on ? pulse * 2 : 0), 0, 7); ctx.fill(); ctx.shadowBlur = 0;
  arc(0, 0, 17, 0, 7, ACCENT, 1.5, 0.9);
  // segmented reactor ring
  for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2 + t * 0.15; arc(0, 0, 26, a + 0.08, a + Math.PI / 5 - 0.08, ACCENT, 5, 0.55); }
  // rotating arcs
  const sp = on ? 1.1 : 0.35;
  for (let i = 0; i < 3; i++) { const a = t * sp + (i * Math.PI * 2) / 3; arc(0, 0, 38, a, a + 1.2, ACCENT, 1.5, 0.85); }
  for (let i = 0; i < 2; i++) { const a = -t * sp * 0.6 + i * Math.PI; arc(0, 0, 46, a, a + 2.2, ACCENT, 1, 0.45); }
  // tick ring
  ctx.strokeStyle = rgba(ACCENT, 0.35); ctx.lineWidth = 1;
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2 - t * 0.08, r1 = i % 5 ? 54 : 58;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * 52, Math.sin(a) * 52); ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.stroke();
  }
  ctx.restore();
  text("AXA", n.x, n.y + 78, { size: 13, weight: 500, color: ACCENT, spacing: 7 });
  const state = LK.label(st) + (st === "done" ? " · your turn" : "");
  text(state.toUpperCase(), n.x, n.y + 93, { size: 9, weight: 600, color: st === "ready" ? C.dim : statusColor(st), spacing: 2.5 });
}

// A tag on a branch off AXA saying, in words, what state it's in: waiting on you, or what it's doing
function drawAxaCallout(n, g, now) {
  calloutBox = null;
  let label, c, urgent = false;
  const st = axaStatus(n), l = LK.lookOf(st);
  if (st === "waiting") { label = `${LK.label(st)} · approve it in the AXA tab`; urgent = true; }
  else if (st === "working") label = `${l.glyph} ` + trunc(g.doing || "Thinking", 52);
  else if (st === "done") { label = `${LK.label(st)} · your turn to reply`; urgent = true; }
  else return;
  c = statusColor(st);
  const pulse = urgent && !calm.matches ? 0.5 + 0.5 * Math.sin(now / 260) : 1;
  // The tag sits where you put it (drag it; default up and to the right). The branch leaves the
  // ring toward it, then runs a short horizontal step into the tag's nearest side.
  const { dx, dy } = mapLayout.callout || { dx: 118, dy: -96 };
  const ax = n.x + dx, ay = n.y + dy, right = dx >= 0, side = right ? 1 : -1;
  const a = Math.atan2(dy, dx), x0 = n.x + Math.cos(a) * 62, y0 = n.y + Math.sin(a) * 62;
  ctx.strokeStyle = rgba(c, 0.75); ctx.lineWidth = 1.2 / Math.max(cam.k, 0.6);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(ax - side * 14, ay); ctx.lineTo(ax, ay); ctx.stroke();
  ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x0, y0, 2.5, 0, 7); ctx.fill();
  ctx.font = `500 11px ${FONT_UI}`;
  const w = ctx.measureText(label).width + 20, h = 24, bx = right ? ax : ax - w, by = ay - h / 2;
  calloutBox = { x: bx, y: by, w, h, ax, ay };
  ctx.shadowColor = c; ctx.shadowBlur = urgent ? 6 + pulse * 12 : 4;
  ctx.fillStyle = rgba(C.panel, 0.94); ctx.fillRect(bx, by, w, h);
  ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.strokeRect(bx, by, w, h); ctx.shadowBlur = 0;
  ctx.fillStyle = c; ctx.fillRect(bx, by, 3, h);
  text(label, bx + 12, by + 16, { size: 11, weight: 500, color: urgent ? c : C.text, align: "left", alpha: urgent ? 0.75 + 0.25 * pulse : 1 });
}

function drawRole(g, n, now) {
  const t = still(now) / 1000, on = n.status === "running", hot = n.hotUntil > now, c = n.color;
  const appear = ease((now - n.born) / 600), r = 15 * appear;
  const jobs = [...g.nodes.values()].filter((x) => x.parent === n.id && x.status === "running").length;
  if (on || hot) { const gl = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, 40); gl.addColorStop(0, rgba(c, 0.28)); gl.addColorStop(1, rgba(c, 0)); ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(n.x, n.y, 40, 0, 7); ctx.fill(); }
  ctx.fillStyle = C.bg; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7); ctx.fill();
  arc(n.x, n.y, r, 0, 7, c, 1.5, on ? 1 : 0.6);
  ctx.fillStyle = c; ctx.globalAlpha = on ? 1 : 0.55; ctx.beginPath(); ctx.arc(n.x, n.y, 4, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
  if (on) for (let i = 0; i < 2; i++) { const a = t * 1.6 + i * Math.PI; arc(n.x, n.y, r + 7, a, a + 1.4, c, 1.5, 0.9); }
  else arc(n.x, n.y, r + 7, 0, 7, c, 0.75, 0.18 * appear);
  const label = typed(n.role.toUpperCase(), n, now);
  text(label, n.x, n.y + 36, { size: 11, weight: 500, color: c, spacing: 3, alpha: on ? 1 : 0.75 });
  const m = roleMeta(n.role);
  text([m.model, jobs ? `${jobs} ACTIVE` : `${n.calls} CALL${n.calls === 1 ? "" : "S"}`].filter(Boolean).join("  ·  ").toUpperCase(), n.x, n.y + 50, { size: 8, color: C.dim, spacing: 2, alpha: appear });
}

function drawInst(n, now) {
  const on = n.status === "running", c = n.fail ? C.bad : n.color, appear = ease((now - n.born) / 500);
  const pulse = calm.matches ? 0.5 : 0.5 + 0.5 * Math.sin(now / 250 + hash(n.id));
  if (on) { ctx.shadowColor = c; ctx.shadowBlur = 10 + pulse * 8; }
  ctx.fillStyle = on ? c : C.bg; ctx.beginPath(); ctx.arc(n.x, n.y, 6 * appear, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
  arc(n.x, n.y, 6 * appear, 0, 7, c, 1.2, on ? 1 : 0.5);
  if (on) arc(n.x, n.y, 11, still(now) / 300, still(now) / 300 + 1.6, c, 1, 0.7);
  text(trunc(typed(n.label, n, now), 34), n.x, n.y - 15, { size: 10, color: on ? C.text : C.dim });
}

function drawLeaf(n, now) {
  const hot = n.hotUntil > now, c = n.fail ? C.bad : hot ? C.text : n.color, appear = ease((now - n.born) / 400);
  const s = Math.min(2.5 + Math.sqrt(n.count) * 1.1, 6) * appear;
  if (hot || n.fail) { ctx.shadowColor = n.fail ? C.bad : n.color; ctx.shadowBlur = 14; }
  ctx.fillStyle = c; ctx.globalAlpha = hot || n.fail ? 1 : 0.7;
  if (n.leafKind === "skill") { ctx.beginPath(); ctx.moveTo(n.x, n.y - s - 1.5); ctx.lineTo(n.x + s + 1.5, n.y); ctx.lineTo(n.x, n.y + s + 1.5); ctx.lineTo(n.x - s - 1.5, n.y); ctx.closePath(); ctx.fill(); }
  else { ctx.beginPath(); ctx.arc(n.x, n.y, s, 0, 7); ctx.fill(); }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  if (cam.k > 0.7 || hot) {
    const lbl = (n.leafKind === "skill" ? "◆ " : "") + n.label + (n.count > 1 ? `  ${n.count}` : "");
    text(typed(lbl, n, now), n.x, n.y + s + 12, { size: 9, color: n.fail ? C.bad : hot ? C.text : n.leafKind === "skill" ? n.color : C.dim });
  }
}

function draw(g, now) {
  drawBackdrop(now);
  if (!g) return;
  for (const n of g.nodes.values()) n.hide = hidden(g, n);
  ctx.save();
  ctx.translate(Wd / 2, Ht / 2); ctx.scale(cam.k, cam.k); ctx.translate(-cam.x, -cam.y);
  drawRange(now);

  // links: draw outward from the parent as the node appears, then carry data packets while active
  if (mission) drawPlanetLinks(now);
  if (mission) text("click to talk", 0, 108, { size: 8, color: C.dim, spacing: 2, alpha: 0.8 });
  for (const l of g.links) {
    let a = g.nodes.get(l.a);
    const b = g.nodes.get(l.b);
    if (!a || !b || b.hide) continue;
    if (a.hide) a = g.nodes.get("axa");
    const grow = ease((now - b.born) / 500), on = active(b, now);
    const ex = a.x + (b.x - a.x) * grow, ey = a.y + (b.y - a.y) * grow;
    ctx.strokeStyle = rgba(b.fail ? C.bad : b.color, on ? 0.6 : b.kind === "leaf" ? 0.16 : 0.26);
    ctx.lineWidth = (on ? 1.4 : 1) / Math.max(cam.k, 0.6);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(ex, ey); ctx.stroke();
    if (on && b.kind !== "leaf" && grow >= 1 && !calm.matches) {
      const len = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      ctx.strokeStyle = C.core; ctx.lineWidth = 2 / Math.max(cam.k, 0.6); ctx.shadowColor = b.color; ctx.shadowBlur = 8;
      for (let i = 0; i < 3; i++) {
        const p = ((now / 1000) * 0.7 + i / 3) % 1, px = a.x + (b.x - a.x) * p, py = a.y + (b.y - a.y) * p;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + ux * 9, py + uy * 9); ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }
  }

  const order = { leaf: 0, inst: 1, role: 2, axa: 3 };
  for (const n of [...g.nodes.values()].filter((n) => !n.hide).sort((a, b) => order[a.kind] - order[b.kind])) {
    if (n.kind === "axa") { drawAxa(n, now); drawAxaCallout(n, g, now); }
    else if (n.kind === "role") drawRole(g, n, now);
    else if (n.kind === "inst") drawInst(n, now);
    else drawLeaf(n, now);
    if (n.id === selectedId && n.kind !== "axa") {
      const r = n.kind === "role" ? 30 : n.kind === "inst" ? 14 : 9;
      ctx.strokeStyle = rgba(C.text, 0.8); ctx.lineWidth = 1 / cam.k;
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; ctx.beginPath(); ctx.arc(n.x, n.y, r, a - 0.3, a + 0.3); ctx.stroke(); }
    }
    if (n.perm) {
      const by = n.y - (n.kind === "inst" ? 34 : n.kind === "role" ? 44 : 24);
      const pulse = calm.matches ? 0.5 : 0.5 + 0.5 * Math.sin(now / 180);
      ctx.strokeStyle = C.warn; ctx.lineWidth = 1; ctx.shadowColor = C.warn; ctx.shadowBlur = 6 + pulse * 8;
      ctx.fillStyle = rgba(C.warnSoft, 0.94); ctx.beginPath(); ctx.rect(n.x - 52, by - 9, 104, 16); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
      text(LK.label("waiting").toUpperCase(), n.x, by + 3, { size: 8, weight: 600, color: C.warn, spacing: 1.5 });
    }
  }
  ctx.restore();
}

// ---------- interaction ----------
let drag = null;
function hit(g, sx, sy) {
  const [x, y] = toWorld(sx, sy);
  let best = null, bd = Infinity;
  for (const n of g.nodes.values()) {
    if (n.hide) continue;
    const r = (n.kind === "axa" ? 50 : n.kind === "role" ? 22 : n.kind === "inst" ? 10 : 7) + 6 / cam.k;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < r && d < bd) { best = n; bd = d; }
  }
  return best;
}
cv.addEventListener("pointerdown", (ev) => {
  const g = sessions.get(current) || (mission ? idle : null); if (!g) return;
  // AXA's status tag can be dragged anywhere around it
  if (mission && calloutBox) {
    const [wx, wy] = toWorld(ev.offsetX, ev.offsetY), b = calloutBox;
    if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) {
      drag = { callout: true, grab: [wx - b.ax, wy - b.ay], sx: ev.offsetX, sy: ev.offsetY, moved: false };
      cv.setPointerCapture(ev.pointerId); cv.classList.add("drag");
      return;
    }
  }
  const n = hit(g, ev.offsetX, ev.offsetY);
  drag = { node: n && !n.fixed ? n : null, sx: ev.offsetX, sy: ev.offsetY, cx: cam.x, cy: cam.y, moved: false, clicked: n };
  cv.setPointerCapture(ev.pointerId); cv.classList.add("drag");
});
cv.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  const dx = ev.offsetX - drag.sx, dy = ev.offsetY - drag.sy;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.callout) {
    const axa = (sessions.get(current) || idle).nodes.get("axa"), [wx, wy] = toWorld(ev.offsetX, ev.offsetY);
    mapLayout.callout = { dx: wx - drag.grab[0] - axa.x, dy: wy - drag.grab[1] - axa.y };
    return;
  }
  if (drag.node) { const [x, y] = toWorld(ev.offsetX, ev.offsetY); drag.node.x = x; drag.node.y = y; }
  else if (drag.moved) { autoFit = false; cam.x = drag.cx - dx / cam.k; cam.y = drag.cy - dy / cam.k; }
});
cv.addEventListener("pointerup", () => {
  if (drag?.callout) { if (drag.moved) saveMapLayout(); drag = null; cv.classList.remove("drag"); return; }
  if (drag && !drag.moved) { selectedId = drag.clicked ? drag.clicked.id : "axa"; dirty = true; }
  // In the mission view, clicking AXA opens the commander's terminal: that's where you talk to it
  if (drag && !drag.moved && mission && drag.clicked?.kind === "axa") {
    const cmd = [...tabs.values()].find((t) => t.info.mode === "axa" && t.info.alive);
    if (cmd) { setTermsOpen(true); activate(cmd.info.id); }
  }
  drag = null; cv.classList.remove("drag");
});
cv.addEventListener("wheel", (ev) => {
  ev.preventDefault(); autoFit = false;
  const [wx, wy] = toWorld(ev.offsetX, ev.offsetY);
  cam.k = Math.max(0.25, Math.min(3, cam.k * Math.exp(-ev.deltaY * 0.0015)));
  cam.x = wx - (ev.offsetX - Wd / 2) / cam.k; cam.y = wy - (ev.offsetY - Ht / 2) / cam.k;
}, { passive: false });
$("fit").onclick = () => { autoFit = true; };
$("fit").ondblclick = () => { mapLayout = { planets: {}, callout: null }; saveMapLayout(); autoFit = true; };
