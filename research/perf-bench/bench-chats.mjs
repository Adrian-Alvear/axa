import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
// the AXA checkout to measure: AXA_ROOT, else the repo this folder is in
const ROOT = process.env.AXA_ROOT ? pathToFileURL(resolve(process.env.AXA_ROOT) + "/") : new URL("../../", import.meta.url);
const { listChats } = await import(new URL("src/core/claude-data.mjs", ROOT));
let t = performance.now(); listChats({ limit: 200 }); console.log(`listChats cold (2000 transcripts): ${(performance.now() - t).toFixed(1)} ms`);
for (let i = 0; i < 3; i++) { t = performance.now(); listChats({ limit: 200 }); console.log(`listChats warm (cached by size, still readdir+stat all): ${(performance.now() - t).toFixed(1)} ms`); }
t = performance.now(); listChats({ limit: 2000 }); console.log(`findChat path (limit 2000): ${(performance.now() - t).toFixed(1)} ms`);
