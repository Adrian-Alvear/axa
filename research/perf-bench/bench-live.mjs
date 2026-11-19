import { createRequire } from "node:module";
const require = createRequire("/home/adrianwsl/axa/package.json");
const { Terminal } = require("@xterm/headless");
const { LiveView } = await import("/home/adrianwsl/axa/src/tui/live.mjs");
for (const [cols, rows] of [[120, 40], [200, 55]]) {
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  let s = ""; for (let y = 0; y < rows; y++) s += `\x1b[38;2;${y};100;200m` + "colored text ".repeat(Math.floor(cols / 13)) + "\x1b[0m\r\n";
  await new Promise((r) => term.write(s, r));
  const v = Object.create(LiveView.prototype); Object.assign(v, { term, cols, rows, noColor: false });
  for (let i = 0; i < 50; i++) v.rowsAnsi();
  const N = 300, t0 = performance.now();
  for (let i = 0; i < N; i++) v.rowsAnsi();
  const ms = (performance.now() - t0) / N;
  console.log(`live rowsAnsi ${cols}x${rows}: ${ms.toFixed(2)} ms/frame -> at 60 fps (16ms debounce while Claude streams) ${(ms * 60 / 10).toFixed(1)}% of a core`);
}
process.exit(0);
