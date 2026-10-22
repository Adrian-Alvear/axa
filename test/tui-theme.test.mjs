// The terminal app's look (console/tui/theme.mjs): themes from the shared design system at each color
// depth, the shared status vocabulary, the settings file synced with the web console, text helpers
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { look, URGENCY, byUrgency, width, cut, pad, theme, appTheme, rolesFor, THEME_NAMES, DEFAULTS, themeLabel } from "../console/tui/theme.mjs";
import { STATUS } from "../console/look.mjs";
import { THEMES, rgb, to256, colorDepth } from "../console/theme.mjs";
import { settingsFile } from "../console/tui/settings.mjs";

test("shell sessions show as shell, dim, never starting", () => {
  assert.deepEqual(look({ status: "shell", mode: "shell" }), [STATUS.shell.glyph, "shell", "dim"]);
  // older consoles reported starting/ready for shells
  assert.equal(look({ status: "starting", mode: "shell" })[1], "shell");
  assert.equal(look({ status: "ready", mode: "shell" })[1], "shell");
  // a shell that's doing something keeps that status
  assert.equal(look({ status: "waiting", mode: "shell" })[1], "needs you");
  assert.equal(look({ status: "starting", mode: "claude" })[1], "starting");
});

test("shell sorts after ready and before starting", () => {
  assert.ok(URGENCY.indexOf("ready") < URGENCY.indexOf("shell"));
  assert.ok(URGENCY.indexOf("shell") < URGENCY.indexOf("starting"));
  const sorted = ["starting", "shell", "exited", "ready", "waiting"].map((status, i) => ({ status, created: i })).sort(byUrgency).map((s) => s.status);
  assert.deepEqual(sorted, ["waiting", "ready", "shell", "starting", "exited"]);
  // an older console's "starting" shell sorts as a shell too
  const mixed = [{ status: "starting", mode: "claude", created: 1 }, { status: "starting", mode: "shell", created: 2 }, { status: "ready", mode: "claude", created: 3 }].sort(byUrgency).map((s) => s.mode);
  assert.deepEqual(mixed, ["claude", "shell", "claude"]);
});

test("width-aware cut and pad", () => {
  assert.equal(width("ab界"), 4);
  assert.equal(cut("abcdef", 4), "abc…");
  assert.equal(pad("ab", 4), "ab  ");
  assert.equal(width(pad("界界界", 5)), 5);
});

test("every status comes from look.mjs: glyph + word + role", () => {
  for (const [st, l] of Object.entries(STATUS)) assert.deepEqual(look({ status: st, mode: "claude" }), [l.glyph, l.word, l.tui]);
  assert.deepEqual(URGENCY, Object.keys(STATUS).sort((a, b) => URGENCY.indexOf(a) - URGENCY.indexOf(b)));
  // every role a status uses exists in every theme at every depth
  for (const name of THEME_NAMES) for (const depth of ["truecolor", "256", "16", "mono"]) for (const l of Object.values(STATUS)) assert.ok(rolesFor(name, depth)[l.tui] !== undefined, `${name} ${depth} ${l.tui}`);
  // unknown statuses still show a word
  assert.equal(look({ status: "weird" })[1], "weird");
});

test("theme names: the app's list, old saved names, unknown ones", () => {
  assert.deepEqual(THEME_NAMES, ["terminal", "hud", "graphite", "paper", "solar", "contrast", "mono"]);
  assert.equal(DEFAULTS.theme, "terminal");
  assert.equal(DEFAULTS.themeSync, false);
  assert.equal(appTheme("light"), "paper");
  assert.equal(appTheme("mono"), "mono");
  assert.equal(appTheme("hud"), "hud");
  assert.equal(appTheme("nope"), "terminal");
  assert.equal(appTheme(undefined), "terminal");
  assert.equal(themeLabel("light"), "Paper");
  assert.equal(themeLabel("terminal"), "Terminal colors");
});

test("theme by color depth: exact on truecolor, quantized on 256, named basics on 16, none on mono", () => {
  const hud = THEMES.hud;
  assert.equal(rolesFor("hud", "truecolor").accent, `38;2;${rgb(hud.accent).join(";")}`);
  assert.equal(rolesFor("hud", "256").accent, `38;5;${to256(hud.accent)}`);
  assert.equal(rolesFor("paper", "256").wait, `1;38;5;${to256(THEMES.paper.warn)}`);
  // 16 colors: the basic named colors, the same as the terminal theme
  assert.deepEqual(rolesFor("hud", "16"), rolesFor("terminal", "16"));
  assert.equal(rolesFor("terminal", "truecolor").accent, "36");
  // NO_COLOR / TERM=dumb: mono whatever the theme; "mono" is mono at any depth
  assert.equal(colorDepth({ NO_COLOR: "1", COLORTERM: "truecolor" }), "mono");
  assert.equal(colorDepth({ TERM: "dumb" }), "mono");
  assert.equal(colorDepth({ TERM: "xterm-256color" }), "256");
  assert.equal(colorDepth({ TERM: "xterm-256color", COLORTERM: "truecolor" }), "truecolor");
  assert.deepEqual(rolesFor("hud", "mono"), rolesFor("mono", "truecolor"));
  assert.ok(!/38;/.test(Object.values(rolesFor("mono", "truecolor")).join(" ")));
  // the app's sgr follows the live setting
  const c = { cfg: { ...DEFAULTS, theme: "hud" }, depth: "truecolor" }, t = theme(c);
  assert.equal(t.sgr("accent", "x"), `\x1b[38;2;${rgb(hud.accent).join(";")}mx\x1b[0m`);
  c.cfg.theme = "terminal";
  assert.equal(t.sgr("accent", "x"), "\x1b[36mx\x1b[0m");
  c.cfg.theme = "light";
  assert.equal(t.sgr("accent", "x"), `\x1b[38;2;${rgb(THEMES.paper.accent).join(";")}mx\x1b[0m`);
});

// the web console writes theme/themeSync into ui.json (through the server); bump the mtime so a
// same-millisecond write is still seen
const webWrites = (path, patch, bump) => { const f = JSON.parse(readFileSync(path, "utf8")); writeFileSync(path, JSON.stringify({ ...f, ...patch })); const t = new Date(Date.now() + bump * 1000); utimesSync(path, t, t); };

test("settings: old names load, saves keep the rest of the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "axa-ui-")), path = join(dir, "ui.json");
  writeFileSync(path, JSON.stringify({ theme: "light", bell: false, labels: { a: "x" } }));
  const st = settingsFile(path, DEFAULTS);
  assert.equal(st.cfg.theme, "paper");
  assert.equal(st.cfg.bell, false);
  assert.equal(st.cfg.themeSync, false);
  st.cfg.prefix = "C-a"; st.save();
  const f = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(f.prefix, "C-a"); assert.equal(f.theme, "paper"); assert.deepEqual(f.labels, { a: "x" });
  // a missing file is the defaults
  assert.equal(settingsFile(join(dir, "none.json"), DEFAULTS).cfg.theme, "terminal");
});

test("settings: with sync on, a theme changed in the web console is picked up; with it off, not", () => {
  const dir = mkdtempSync(join(tmpdir(), "axa-ui-")), path = join(dir, "ui.json");
  writeFileSync(path, JSON.stringify({ theme: "terminal", themeSync: true }));
  const st = settingsFile(path, DEFAULTS);
  assert.equal(st.sync(), false); // nothing changed
  webWrites(path, { theme: "paper" }, 1);
  assert.equal(st.sync(), true);
  assert.equal(st.cfg.theme, "paper");
  assert.equal(st.sync(), false); // the file is read only when it changed
  // the app's own pick is written for the web console
  st.cfg.theme = "hud"; st.save();
  assert.equal(JSON.parse(readFileSync(path, "utf8")).theme, "hud");
  // sync turned off (here or there): web changes stay there
  webWrites(path, { themeSync: false, theme: "graphite" }, 2);
  assert.equal(st.sync(), false);
  assert.equal(st.cfg.themeSync, false);
  assert.equal(st.cfg.theme, "hud");
  // turned back on in the web console with a theme: both are taken
  webWrites(path, { themeSync: true, theme: "solar" }, 3);
  assert.equal(st.sync(), true);
  assert.equal(st.cfg.theme, "solar");
});

test("settings: a save never overwrites a newer web change with an old value", () => {
  const dir = mkdtempSync(join(tmpdir(), "axa-ui-")), path = join(dir, "ui.json");
  writeFileSync(path, JSON.stringify({ theme: "hud", themeSync: true }));
  const st = settingsFile(path, DEFAULTS);
  webWrites(path, { theme: "contrast" }, 1);
  st.cfg.lastSeenAt = 123; st.save(); // the minute timer saves before the next poll
  assert.equal(st.cfg.theme, "contrast");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).theme, "contrast");
  // but a theme picked here just now wins over the file
  webWrites(path, { theme: "graphite" }, 2);
  st.cfg.theme = "paper"; st.save();
  assert.equal(JSON.parse(readFileSync(path, "utf8")).theme, "paper");
});
