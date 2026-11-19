const SCROLLBACK = 256 * 1024;
const chunk = "\x1b[2K\x1b[1G" + "x".repeat(200) + "\r\n"; // a typical small redraw chunk (~210 B)
for (const N of [10000, 50000]) {
  let buf = "";
  const t0 = performance.now();
  for (let i = 0; i < N; i++) { buf = (buf + chunk).slice(-SCROLLBACK); if (i % 100 === 0) buf.charCodeAt(0); }
  const a = performance.now() - t0;
  // ring of chunks, trimmed by total length
  const ring = []; let len = 0;
  const t1 = performance.now();
  for (let i = 0; i < N; i++) { ring.push(chunk); len += chunk.length; while (len - ring[0].length > SCROLLBACK) len -= ring.shift().length; }
  const b = performance.now() - t1;
  console.log(`${N} chunks: concat+slice ${a.toFixed(1)} ms (${(a / N * 1000).toFixed(1)} us/chunk) vs chunk ring ${b.toFixed(1)} ms`);
}
// what flattening costs when a websocket client joins and buf is sent
