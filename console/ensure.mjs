// Shared helpers: where AXA keeps its files, and starting the console server in the background
// when it isn't running yet (used by the `axa` command and the session tools).
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

export const consoleDir = dirname(fileURLToPath(import.meta.url));
export const pluginRoot = join(consoleDir, "..");
export const home = process.env.AXA_HOME || join(homedir(), ".axa");
export const port = Number(process.env.AXA_PORT || 4747);
export const tokenPath = join(home, "console-token");
export const readToken = () => (existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "");

export async function consoleUp() {
  const token = readToken();
  if (!token) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/terms`, { headers: { host: `localhost:${port}`, cookie: `axa_token=${token}` } });
    return res.ok;
  } catch {
    return false;
  }
}

// Start the console detached (it outlives the terminal that started it); logs to ~/.axa/console.log
export async function ensureConsole() {
  if (await consoleUp()) return true;
  mkdirSync(home, { recursive: true });
  if (!existsSync(join(consoleDir, "node_modules"))) {
    spawnSync("npm", ["install", "--no-fund", "--no-audit"], { cwd: consoleDir, stdio: "ignore" });
  }
  const log = openSync(join(home, "console.log"), "a");
  spawn(process.execPath, [join(consoleDir, "server.mjs")], { cwd: consoleDir, detached: true, stdio: ["ignore", log, log], env: process.env }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await consoleUp()) return true;
  }
  return false;
}

export const isWsl = () => {
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
};

// Open a URL in the user's browser (macOS, Windows, WSL → Windows browser, Linux)
export function openUrl(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : isWsl() ? ["cmd.exe", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {}
}
