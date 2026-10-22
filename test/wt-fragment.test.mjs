// `axa setup terminal` (console/wtfragment.mjs): the Windows Terminal fragment, written only to a
// temp dir here (AXA_WT_FRAGMENTS); never anywhere under /mnt/c
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fragment, fragmentsDir, writeFragment, wslCommandline, schemeTheme, PROFILE_GUID } from "../console/wtfragment.mjs";
import { tokens, ansi16, THEMES } from "../console/theme.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");

test("the fragment: an AXA profile and the theme as a 16-color scheme", () => {
  const f = fragment({ theme: "paper", commandline: "wsl.exe -d Ubuntu axa" });
  assert.equal(f.profiles.length, 1);
  const p = f.profiles[0], s = f.schemes[0];
  assert.equal(p.name, "AXA");
  assert.equal(p.guid, PROFILE_GUID);
  assert.match(p.guid, /^\{[0-9a-f-]{36}\}$/);
  assert.equal(p.commandline, "wsl.exe -d Ubuntu axa");
  assert.equal(p.colorScheme, "AXA Paper");
  assert.equal(s.name, "AXA Paper");
  assert.equal(s.background, tokens("paper").bg);
  assert.equal(s.foreground, tokens("paper").text);
  for (const k of ["black", "red", "green", "yellow", "blue", "purple", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightPurple", "brightCyan", "brightWhite"]) assert.match(s[k], /^#[0-9a-f]{6}$/, k);
  assert.equal(s.red, ansi16("paper").red);
  // terminal / mono (your own colors) export AXA HUD; old names resolve
  assert.equal(schemeTheme("terminal"), "hud");
  assert.equal(schemeTheme("mono"), "hud");
  assert.equal(schemeTheme("light"), "paper");
  assert.equal(fragment({ theme: "terminal" }).schemes[0].name, "AXA HUD");
});

test("the profile runs AXA by absolute paths inside the distro", () => {
  assert.equal(wslCommandline({ distro: "Ubuntu", node: "/usr/bin/node", axa: "/home/me/axa/bin/axa" }), "wsl.exe -d Ubuntu --cd ~ -- /usr/bin/node /home/me/axa/bin/axa");
  assert.equal(wslCommandline({ distro: "My Distro", node: "/n", axa: "/a" }), 'wsl.exe -d "My Distro" --cd ~ -- /n /a');
});

test("the folder: AXA_WT_FRAGMENTS wins; nothing is asked of Windows then", () => {
  let asked = false;
  const run = () => { asked = true; return { status: 1, stdout: "" }; };
  assert.equal(fragmentsDir({ AXA_WT_FRAGMENTS: "/tmp/x" }, run), "/tmp/x");
  assert.equal(asked, false);
  // not WSL and not Windows: no folder
  if (process.platform !== "win32") assert.equal(fragmentsDir({}, run), null);
  // WSL: %LOCALAPPDATA% from cmd.exe, through wslpath (both stubbed here)
  const calls = [];
  const fake = (cmd, args) => { calls.push(cmd); return cmd === "cmd.exe" ? { status: 0, stdout: "C:\\Users\\me\\AppData\\Local\r\n" } : { status: 0, stdout: "/fake/Local\n" }; };
  if (process.platform !== "win32") assert.equal(fragmentsDir({ WSL_DISTRO_NAME: "Ubuntu" }, fake), "/fake/Local/Microsoft/Windows Terminal/Fragments/AXA");
});

test("written as UTF-8 JSON without a BOM, replacing the previous one", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "axa-wt-")), "Fragments", "AXA");
  const file = writeFragment(dir, fragment({ theme: "hud", commandline: "wsl.exe axa" }));
  assert.equal(file, join(dir, "axa.json"));
  const bytes = readFileSync(file);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(JSON.parse(bytes.toString("utf8")).schemes[0].name, "AXA HUD");
  writeFragment(dir, fragment({ theme: "paper" }));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).schemes[0].name, "AXA Paper");
});

test("axa setup terminal writes to AXA_WT_FRAGMENTS with the theme from ui.json", () => {
  const home = mkdtempSync(join(tmpdir(), "axa-wt-home-")), out = join(home, "frag");
  writeFileSync(join(home, "ui.json"), JSON.stringify({ theme: "hud", tuiTheme: "solar" }));
  const env = { ...process.env, AXA_HOME: home, AXA_PORT: "4889", AXA_WT_FRAGMENTS: out, WSL_DISTRO_NAME: "TestDistro" };
  const r = spawnSync(process.execPath, [join(root, "bin", "axa"), "setup", "terminal"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const f = JSON.parse(readFileSync(join(out, "axa.json"), "utf8"));
  assert.equal(f.schemes[0].name, "AXA Solar Night"); // the app's own theme (sync off)
  assert.match(f.profiles[0].commandline, /^wsl\.exe -d TestDistro --cd ~ -- .+ .+bin\/axa$/);
  // --print writes nothing
  const out2 = join(home, "frag2");
  const p = spawnSync(process.execPath, [join(root, "bin", "axa"), "setup", "terminal", "--print", "--theme=paper"], { env: { ...env, AXA_WT_FRAGMENTS: out2 }, encoding: "utf8" });
  assert.equal(JSON.parse(p.stdout).schemes[0].name, "AXA Paper");
  assert.equal(existsSync(out2), false);
});
