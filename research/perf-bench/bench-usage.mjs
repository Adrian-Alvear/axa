// usage: node bench-usage.mjs <session id> [the session's cwd, default: your home folder]
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
// the AXA checkout to measure: AXA_ROOT, else the repo this folder is in
const ROOT = process.env.AXA_ROOT ? pathToFileURL(resolve(process.env.AXA_ROOT) + "/") : new URL("../../", import.meta.url);
const [chat, cwd = homedir()] = process.argv.slice(2);
if (!chat) { console.error("usage: node bench-usage.mjs <session id> [cwd]"); process.exit(1); }
const { usageOf } = await import(new URL("src/core/claude-data.mjs", ROOT));
const t = performance.now(); const u = usageOf(chat, cwd, true);
console.log(`first usageOf on a 10 MB transcript: ${(performance.now() - t).toFixed(1)} ms (sync, blocks daemon)`, u?.tokens);
