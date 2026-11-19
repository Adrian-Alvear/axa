// Where AXA keeps things, shared by the CLI, the daemon, the terminal UI and the MCP server.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const srcDir = dirname(fileURLToPath(import.meta.url));
export const pluginRoot = join(srcDir, "..");
export const home = process.env.AXA_HOME || join(homedir(), ".axa");
export const port = Number(process.env.AXA_PORT || 4747);

export const files = {
  log: join(home, "events.jsonl"),
  token: join(home, "console-token"),
  pid: join(home, "console.pid"),
  daemonLog: join(home, "console.log"),
  sessions: join(home, "sessions.json"),
  chains: join(home, "chains.json"),
  policy: join(home, "policy.json"),
  ui: join(home, "ui.json"),
  roster: join(home, "roster.md"),
};

export const readToken = () => (existsSync(files.token) ? readFileSync(files.token, "utf8").trim() : "");
export const webUrl = () => `http://localhost:${port}/?t=${readToken()}`;
export const rosterFile = () => [files.roster, join(pluginRoot, "roster.example.md")].find(existsSync);

// ~/x -> /home/me/x, and "inside the home folder" as a real containment check ("/home/me2" is not in "/home/me")
export const expand = (p) => resolve(String(p).replace(/^~(?=$|\/)/, homedir()));
export const inHome = (p) => {
  const rel = relative(homedir(), p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
export const tilde = (p) => (inHome(p) ? "~" + p.slice(homedir().length) : p);

export const isWsl = () => {
  try { return /microsoft/i.test(readFileSync("/proc/version", "utf8")); } catch { return false; }
};

// Open a URL in the user's browser (macOS, Windows, WSL -> the Windows browser, Linux)
export function openUrl(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : isWsl() ? ["cmd.exe", ["/c", "start", "", url.replace(/&/g, "^&")]]
    : ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
}
