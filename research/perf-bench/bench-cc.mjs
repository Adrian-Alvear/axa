import { spawn } from "node:child_process";
const S = "axa-perftest";
// one control-mode client; commands written to stdin, replies framed by %begin/%end
const p = spawn("tmux", ["-L", S, "-C", "attach-session", "-t", "=axa-p1"], { stdio: ["pipe", "pipe", "ignore"] });
let buf = "", waiters = [];
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n%end ")) >= 0 || (i = buf.indexOf("\n%error ")) >= 0) {
    const j = buf.indexOf("\n", i + 1); if (j < 0) break;
    const block = buf.slice(0, j + 1); buf = buf.slice(j + 1);
    const b = block.lastIndexOf("%begin ");
    if (b >= 0 && waiters.length) waiters.shift()(block.slice(block.indexOf("\n", b) + 1, i));
  }
});
const cmd = (c) => new Promise((ok) => { waiters.push(ok); p.stdin.write(c + "\n"); });
await new Promise((r) => setTimeout(r, 300)); buf = ""; waiters = [];
const t0 = performance.now();
for (let r = 0; r < 5; r++) for (let i = 1; i <= 30; i++) await cmd(`capture-pane -p -J -t =axa-p${i}: -S -60`);
console.log(`control-mode capture-pane: ${((performance.now() - t0) / 150).toFixed(3)} ms/call (no process spawn)`);
const t1 = performance.now();
const all = await Promise.all(Array.from({ length: 30 }, (_, i) => cmd(`capture-pane -p -J -t =axa-p${i + 1}: -S -60`)));
console.log(`30 pipelined captures: ${(performance.now() - t1).toFixed(2)} ms total, ${all[0].split("\n").length} lines in first`);
p.kill();
process.exit(0);
