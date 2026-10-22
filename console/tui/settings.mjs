// The app's settings file, $AXA_HOME/ui.json. The web console reads and writes two of its keys
// (theme, themeSync) through the server: with themeSync on, a theme picked there shows up here on the
// next poll (the file's mtime is checked, it's only read when it changed), and a theme picked here is
// written for the web console to pick up. A change made elsewhere is never overwritten by an older
// value here: before each save, keys changed in the file (and not here) are taken from it first.
// With syncing off the app keeps its own theme in tuiTheme and leaves the shared one alone.
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { appTheme } from "./theme.mjs";

const SHARED = ["theme", "themeSync"];
const norm = (k, v) => (k === "theme" ? appTheme(v) : !!v);

export function settingsFile(path, defaults) {
  const cfg = { ...defaults };
  let stamp = "", known = {};
  const stampOf = () => { try { const st = statSync(path); return `${st.mtimeMs}:${st.size}`; } catch { return ""; } };
  const readFile = () => { try { const f = JSON.parse(readFileSync(path, "utf8")); return f && typeof f === "object" ? f : null; } catch { return null; } };
  const remember = () => { known = Object.fromEntries(SHARED.map((k) => [k, cfg[k]])); };
  const f0 = readFile();
  if (f0) Object.assign(cfg, f0);
  if (f0 && !f0.themeSync && f0.tuiTheme) cfg.theme = f0.tuiTheme;
  delete cfg.tuiTheme;
  cfg.theme = appTheme(cfg.theme); cfg.themeSync = !!cfg.themeSync; // old names (light) keep working
  stamp = stampOf(); remember();

  // take what changed in the file since we last read or wrote it; local: keys changed here not yet saved
  function merge(local) {
    const now = stampOf();
    if (!now || now === stamp) return false;
    stamp = now;
    const f = readFile();
    if (!f) return false;
    const before = cfg.theme;
    for (const k of SHARED) {
      if (!(k in f)) continue;
      const v = norm(k, f[k]);
      if (v === known[k]) continue; // not changed there
      known[k] = v;
      if (local.has(k)) continue; // changed here too: ours is newer
      if (k === "themeSync") cfg.themeSync = v;
    }
    // the theme follows the file only while syncing is on
    if (cfg.themeSync && !local.has("theme") && "theme" in f) cfg.theme = norm("theme", f.theme);
    return cfg.theme !== before;
  }
  // on the poll: true when the theme changed (redraw)
  const sync = () => merge(new Set());
  function save() {
    merge(new Set(SHARED.filter((k) => cfg[k] !== known[k])));
    const out = { ...cfg, tuiTheme: cfg.theme };
    if (!cfg.themeSync) { const f = readFile(); if (f && "theme" in f) out.theme = f.theme; else delete out.theme; }
    // (written whole, then renamed: the server never reads half a file)
    const tmp = `${path}.${process.pid}.tmp`;
    try { writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, path); } catch {}
    stamp = stampOf(); remember();
  }
  return { cfg, save, sync, path };
}
