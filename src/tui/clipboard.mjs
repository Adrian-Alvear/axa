// Your clipboard, from the terminal UI: copy text out (OSC 52 plus the system tool), and paste an image
// into a session (saved as a PNG in the project's .claude/axa-pastes, its path typed in for Claude to read).
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const has = (c) => spawnSync("which", [c], { stdio: "ignore" }).status === 0;
const wsl = () => has("powershell.exe") && has("wslpath");

export function copyToClipboard(text) {
  // tests: AXA_CLIPBOARD_FILE takes the text instead of the real clipboard
  if (process.env.AXA_CLIPBOARD_FILE) { try { writeFileSync(process.env.AXA_CLIPBOARD_FILE, text); } catch {} return; }
  // OSC 52: Windows Terminal, iTerm2, kitty, WezTerm... copy for us
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  const tool = has("clip.exe") ? ["clip.exe", []] : process.platform === "darwin" ? ["pbcopy", []] : has("wl-copy") ? ["wl-copy", []] : has("xclip") ? ["xclip", ["-selection", "clipboard"]] : null;
  if (!tool) return;
  try { const c = spawn(tool[0], tool[1], { stdio: ["pipe", "ignore", "ignore"] }); c.on("error", () => {}); c.stdin.end(text); } catch {}
}

// Read the clipboard: { image: true } (saved to `file`), { text }, or null
export function readClipboard(file) {
  return new Promise((done) => {
    if (process.env.AXA_PASTE_IMAGE_FROM) { try { copyFileSync(process.env.AXA_PASTE_IMAGE_FROM, file); return done({ image: true }); } catch {} }
    let cmd, args, viaStdout = false;
    if (wsl()) {
      const win = spawnSync("wslpath", ["-w", file], { encoding: "utf8" }).stdout.trim().replace(/'/g, "''");
      cmd = "powershell.exe";
      args = ["-NoProfile", "-STA", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $i = [System.Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${win}', [System.Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write('IMG') } else { [Console]::Out.Write('TXT' + [System.Windows.Forms.Clipboard]::GetText()) }`];
    } else if (process.platform === "darwin") {
      cmd = "osascript"; args = ["-e", `set f to open for access POSIX file "${file.replace(/"/g, "")}" with write permission`, "-e", "write (the clipboard as «class PNGf») to f", "-e", "close access f"];
    } else if (has("wl-paste")) { cmd = "wl-paste"; args = ["--type", "image/png"]; viaStdout = true; }
    else if (has("xclip")) { cmd = "xclip"; args = ["-selection", "clipboard", "-t", "image/png", "-o"]; viaStdout = true; }
    else return done(null);
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }), chunks = [];
    c.stdout.on("data", (d) => chunks.push(d));
    const timer = setTimeout(() => { try { c.kill(); } catch {} done(null); }, 15000);
    c.on("error", () => { clearTimeout(timer); done(null); });
    c.on("close", (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (cmd === "powershell.exe") {
        const s = buf.toString("utf8");
        return done(s.startsWith("IMG") ? { image: true } : s.startsWith("TXT") && s.length > 3 ? { text: s.slice(3).replace(/\r\n/g, "\n") } : null);
      }
      if (viaStdout) {
        if (code === 0 && buf.length > 8 && buf[0] === 0x89) { writeFileSync(file, buf, { mode: 0o600 }); return done({ image: true }); }
        const t = process.platform === "darwin" ? ["pbpaste", []] : has("wl-paste") ? ["wl-paste", ["-n"]] : ["xclip", ["-selection", "clipboard", "-o"]];
        const r = spawnSync(t[0], t[1], { encoding: "utf8", timeout: 5000 });
        return done(r.status === 0 && r.stdout ? { text: r.stdout } : null);
      }
      try { if (statSync(file).size > 0) return done({ image: true }); } catch {}
      const r = spawnSync("pbpaste", [], { encoding: "utf8", timeout: 5000 });
      done(r.status === 0 && r.stdout ? { text: r.stdout } : null);
    });
  });
}

// Where a pasted image goes: <project>/.claude/axa-pastes/paste-<time>.png
export function pasteFile(cwd) {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  const base = top.status === 0 ? top.stdout.trim() : cwd;
  const dir = join(base, ".claude", "axa-pastes");
  mkdirSync(dir, { recursive: true });
  return { repo: top.status === 0 ? base : null, file: join(dir, `paste-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`) };
}
