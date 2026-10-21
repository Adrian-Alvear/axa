// Preloaded into the console server by scripts/perf.mjs (node --import): records the event loop's
// worst delay per second into $AXA_ELD_OUT, so stalls can be measured without changing the server.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { appendFileSync } from "node:fs";

const file = process.env.AXA_ELD_OUT;
if (file) {
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  setInterval(() => {
    appendFileSync(file, JSON.stringify({ ts: Date.now(), max: h.max / 1e6, p99: h.percentile(99) / 1e6, mean: h.mean / 1e6 }) + "\n");
    h.reset();
  }, 1000).unref();
}
