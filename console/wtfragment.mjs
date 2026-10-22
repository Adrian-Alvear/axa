// `axa setup terminal`: a Windows Terminal JSON fragment with an "AXA" profile (it opens mission
// control in WSL) and AXA's current theme as a color scheme. Windows Terminal reads fragments from
// %LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\<app>\*.json at start; nothing in your own
// settings.json is changed, and deleting the folder removes the profile again. Written only when you
// run the command. AXA_WT_FRAGMENTS overrides the folder (tests write to a temp dir that way).
// Docs: https://learn.microsoft.com/en-us/windows/terminal/json-fragment-extensions
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { THEMES, TERMINAL_THEME, DEFAULT_THEME, themeId, tokens, ansi16 } from "./theme.mjs";

// fixed, so running it again updates the same profile instead of adding another
export const PROFILE_GUID = "{5a1f3c2e-8b7d-4e61-9f0a-a8a0c0de2026}";
export const FRAGMENT_FILE = "axa.json";

// The theme the scheme is made from: a named theme; "terminal" and "mono" (your own colors) use AXA HUD
export const schemeTheme = (id) => { const t = themeId(id); return THEMES[t] && t !== TERMINAL_THEME ? t : DEFAULT_THEME; };

// The fragment (pure). commandline: what the profile runs (from WSL: wsl.exe -d <distro> ... axa)
export function fragment({ theme, commandline, startingDirectory } = {}) {
  const id = schemeTheme(theme), t = tokens(id), a = ansi16(id), name = THEMES[id].label.startsWith("AXA") ? THEMES[id].label : `AXA ${THEMES[id].label}`;
  const scheme = {
    name, background: t.bg, foreground: t.text, cursorColor: t.accent, selectionBackground: t.sel,
    black: a.black, red: a.red, green: a.green, yellow: a.yellow, blue: a.blue, purple: a.purple, cyan: a.cyan, white: a.white,
    brightBlack: a.brightBlack, brightRed: a.brightRed, brightGreen: a.brightGreen, brightYellow: a.brightYellow, brightBlue: a.brightBlue, brightPurple: a.brightPurple, brightCyan: a.brightCyan, brightWhite: a.brightWhite,
  };
  const profile = { guid: PROFILE_GUID, name: "AXA", commandline: commandline || "wsl.exe axa", colorScheme: name, tabTitle: "AXA", suppressApplicationTitle: false };
  if (startingDirectory) profile.startingDirectory = startingDirectory;
  return { $help: "https://aka.ms/terminal-documentation", $schema: "https://aka.ms/terminal-profiles-schema", profiles: [profile], schemes: [scheme] };
}

// What the profile runs, from WSL. wsl.exe doesn't load your shell's PATH for a command, so AXA is
// started by absolute paths (this Node and this checkout's bin/axa), in your home folder.
export function wslCommandline({ distro, node, axa }) {
  const q = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return ["wsl.exe", ...(distro ? ["-d", q(distro)] : []), "--cd", "~", "--", q(node), q(axa)].join(" ");
}

// Where fragments go: AXA_WT_FRAGMENTS, else %LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\AXA
// (found by asking Windows, only when the command is run). null when it can't be found.
export function fragmentsDir(env = process.env, run = spawnSync) {
  if (env.AXA_WT_FRAGMENTS) return env.AXA_WT_FRAGMENTS;
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "Microsoft", "Windows Terminal", "Fragments", "AXA");
  if (!env.WSL_DISTRO_NAME) return null;
  const win = run("cmd.exe", ["/d", "/c", "echo %LOCALAPPDATA%"], { encoding: "utf8", cwd: "/mnt/c", timeout: 10_000 });
  const local = String(win.stdout || "").replace(/\r/g, "").trim();
  if (win.status !== 0 || !local || local.includes("%")) return null;
  const p = run("wslpath", ["-u", local], { encoding: "utf8", timeout: 5000 });
  const dir = String(p.stdout || "").trim();
  return p.status === 0 && dir ? join(dir, "Microsoft", "Windows Terminal", "Fragments", "AXA") : null;
}

// Write it (UTF-8, no BOM, whole file then rename). Returns the file's path.
export function writeFragment(dir, frag) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, FRAGMENT_FILE), tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(frag, null, 2) + "\n", { encoding: "utf8" });
  renameSync(tmp, file);
  return file;
}
