const { usageOf } = await import("/home/adrianwsl/axa/src/core/claude-data.mjs");
const t = performance.now(); const u = usageOf("3bc30849-1f66-43d3-8773-6803aa9729ae", "/home/adrianwsl", true);
console.log(`first usageOf on a 10 MB transcript: ${(performance.now() - t).toFixed(1)} ms (sync, blocks daemon)`, u?.tokens);
