// The design system: every theme's roles meet 4.5:1 on bg and panel (recomputed from the theme file),
// and each output (CSS, xterm.js, terminal SGR at every depth) is complete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, ROLES, contrast, cssVars, cssText, xtermTheme, ansi16, tuiRoles, colorDepth, to256, to16, themeId } from "../console/theme.mjs";
import { STATUS, URGENCY, STARTING_MS, statusOf, lookOf, byUrgency, reasonOf } from "../console/look.mjs";

test("contrast table: every role >= 4.5:1 on bg and panel, in every theme", () => {
  const table = [];
  for (const [id, t] of Object.entries(THEMES)) for (const role of ROLES) for (const on of ["bg", "panel"]) table.push({ id, role, on, ratio: contrast(t[role], t[on]) });
  const low = table.filter((r) => r.ratio < 4.5).map((r) => `${r.id} ${r.role} on ${r.on}: ${r.ratio.toFixed(2)}`);
  assert.deepEqual(low, []);
});

test("contrast math matches WCAG reference values", () => {
  assert.equal(contrast("#000000", "#ffffff").toFixed(2), "21.00");
  assert.equal(contrast("#777777", "#ffffff").toFixed(2), "4.48");
});

test("outputs are complete for every theme", () => {
  for (const id of Object.keys(THEMES)) {
    const v = cssVars(id);
    for (const k of ["--bg", "--panel", "--text", "--dim", "--accent", "--ok", "--warn", "--bad", "--line"]) assert.match(v[k], /^#[0-9a-f]{6}$/, `${id} ${k}`);
    const x = xtermTheme(id);
    for (const k of ["background", "foreground", "black", "red", "brightWhite", "brightMagenta"]) assert.match(x[k], /^#[0-9a-f]{6}$/, `${id} ${k}`);
    assert.equal(Object.keys(ansi16(id)).length, 16);
    for (const depth of ["truecolor", "256", "16", "mono"]) for (const role of ["title", "wait", "done", "dim", "sel", "focus"]) assert.ok(typeof tuiRoles(id, depth)[role] === "string", `${id} ${depth} ${role}`);
  }
  assert.match(cssText(), /:root\[data-theme="paper"\]\{color-scheme:light;--bg:#fbfbfa/);
});

test("terminal app color depth and quantizing", () => {
  assert.equal(colorDepth({ NO_COLOR: "1", COLORTERM: "truecolor" }), "mono");
  assert.equal(colorDepth({ TERM: "dumb" }), "mono");
  assert.equal(colorDepth({ COLORTERM: "truecolor", TERM: "xterm-256color" }), "truecolor");
  assert.equal(colorDepth({ TERM: "xterm-256color" }), "256");
  assert.equal(colorDepth({ TERM: "xterm" }), "16");
  assert.equal(to256("#ff0000"), 196);
  assert.equal(to256("#808080"), 244);
  assert.equal(to16("#ff0000"), 91);
  assert.match(tuiRoles("hud", "truecolor").done, /^38;2;94;242;194$/);
  assert.match(tuiRoles("hud", "256").done, /^38;5;\d+$/);
  assert.equal(tuiRoles("terminal", "truecolor").done, "32");
  assert.equal(themeId("light"), "paper");
  assert.equal(themeId("nope"), "hud");
});

test("one status vocabulary: glyph + word + role for every status", () => {
  for (const st of URGENCY) { const l = STATUS[st]; assert.ok(l.glyph && l.word && l.role && l.tui, st); }
  assert.equal(statusOf({ mode: "shell", status: "starting" }), "shell");
  assert.equal(lookOf({ mode: "claude", status: "waiting" }).word, "needs you");
  assert.equal(lookOf("nonsense").glyph, "?");
  // a live session with no traced events stops saying "starting" after STARTING_MS
  const t0 = 1_000_000;
  assert.equal(statusOf({ mode: "claude", status: "starting", alive: true, created: t0 }, t0 + 1000), "starting");
  assert.equal(statusOf({ mode: "claude", status: "starting", alive: true, created: t0 }, t0 + STARTING_MS + 1), "ready");
  assert.equal(statusOf({ mode: "claude", status: "starting", alive: false, created: t0 }, t0 + STARTING_MS + 1), "starting");
  assert.equal(statusOf({ status: "starting" }), "starting");
  assert.equal(reasonOf({ status: "stuck", stuck_reason: "no output 25m" }), "no output 25m");
  assert.equal(reasonOf({ status: "failed", failed_reason: "rate limit" }), "rate limit");
  assert.equal(reasonOf({ status: "working", stuck_reason: "old" }), "");
  assert.equal(reasonOf({ status: "stuck" }), "");
  const list = [{ status: "done" }, { status: "waiting" }, { mode: "shell", status: "ready" }, { status: "working" }];
  assert.deepEqual(list.sort(byUrgency).map(statusOf), ["waiting", "working", "done", "shell"]);
});
