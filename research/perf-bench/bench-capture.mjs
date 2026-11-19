import { spawnSync } from "node:child_process";
const S = "axa-perftest";
const t0 = performance.now();
let n = 0;
for (let r = 0; r < 5; r++) for (let i = 1; i <= 30; i++) { spawnSync("tmux", ["-L", S, "capture-pane", "-p", "-J", "-t", `=axa-p${i}:`, "-S", "-60"], { encoding: "utf8", timeout: 5000 }); n++; }
const per = (performance.now() - t0) / n;
console.log(`spawnSync capture-pane: ${per.toFixed(2)} ms/call; 30 sessions = ${(per * 30).toFixed(0)} ms blocking per listSessions`);
const t1 = performance.now();
for (let r = 0; r < 5; r++) for (let i = 1; i <= 30; i++) spawnSync("tmux", ["-L", S, "display-message", "-p", "-t", `=axa-p${i}:`, "#{pane_width}"], { encoding: "utf8" });
console.log(`spawnSync display-message: ${((performance.now() - t1) / 150).toFixed(2)} ms/call`);
// one batched call: list-panes with format for all
const t2 = performance.now();
for (let r = 0; r < 5; r++) spawnSync("tmux", ["-L", S, "list-panes", "-a", "-F", "#{session_name} #{pane_width} #{pane_dead} #{cursor_y} #{history_size}"], { encoding: "utf8" });
console.log(`one list-panes -a for all 30: ${((performance.now() - t2) / 5).toFixed(2)} ms`);
// async parallel capture
const { execFile } = await import("node:child_process");
const t3 = performance.now();
await Promise.all(Array.from({ length: 30 }, (_, i) => new Promise((ok) => execFile("tmux", ["-L", S, "capture-pane", "-p", "-J", "-t", `=axa-p${i + 1}:`, "-S", "-60"], ok))));
console.log(`30 async execFile captures in parallel: ${(performance.now() - t3).toFixed(1)} ms wall (event loop free)`);
