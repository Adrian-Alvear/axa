const root = "/home/adrianwsl/axa/src/tui/";
const D = await import(root + "draw.mjs");
const { controlRows } = await import(root + "control.mjs");
D.setTheme("axa");
const mk = (n) => {
  const sessions = [{ id: "c", name: "AXA", mode: "axa", alive: true, status: "working", doing: "list sessions", helpers: [] }];
  for (let i = 0; i < n; i++) sessions.push({ id: "s" + i, name: "project-" + i, cwd: "/home/x/p" + i, mode: "claude", alive: true, status: ["working", "done", "ready", "waiting"][i % 4], usage: { tokens: 123456 * i }, helpers: i % 3 ? [] : [{ type: "axa:builder", status: "running", at: Date.now(), start: Date.now() - 6e4, calls: 4, doing: "Edit app.tsx" }] });
  return sessions;
};
const act = { perMinute: Array.from({ length: 60 }, (_, i) => i % 7), runs: { today: 10, done: 7, approvals: 3 }, events: Array.from({ length: 80 }, (_, i) => ({ ts: Date.now(), event: "PreToolUse", terminal: "s1", tool: "Edit", summary: "app.tsx" })) };
const msgs = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "claude" : "you", text: "Some message text with **markdown** and a list:\n- one\n- two\n".repeat(3) }));
for (const [W, H] of [[160, 45], [240, 70]]) for (const n of [1, 10, 30]) {
  const ctx = () => ({ sessions: mk(n), act, selId: "s1", focusInput: false, input: "", nameOf: (s) => s.name, question: () => "q?", yesOpt: (c) => c.options[0], noOpt: (c) => c.options[1], waiting: null, waitingCount: 0, order: [], chats: Array.from({ length: 20 }, (_, i) => ({ title: "chat " + i, project: "p", cwd: "/x", updated: Date.now() })), zone: "map", chatSel: 0, mapHits: [], chatHits: [], cmdMsgs: msgs, cmdScroll: 0 });
  for (let i = 0; i < 20; i++) controlRows(ctx(), W, H - 4);
  const N = 200, t0 = performance.now();
  let bytes = 0;
  for (let i = 0; i < N; i++) bytes = controlRows(ctx(), W, H - 4).join("").length;
  const ms = (performance.now() - t0) / N;
  console.log(`Control ${W}x${H}, ${n} sessions: ${ms.toFixed(2)} ms/frame, ${(bytes / 1024).toFixed(0)} KB full frame; at ~15 fps (150ms map + 120ms spinner timers) = ${(ms * 15 / 10).toFixed(1)}% of a core`);
}
{
  const W = 200, H = 55;
  const c = () => ({ sessions: mk(10), act, selId: "s1", focusInput: false, input: "", nameOf: (s) => s.name, question: () => "q?", yesOpt: (c) => c.options[0], noOpt: (c) => c.options[1], waiting: null, waitingCount: 0, order: [], chats: [], zone: "map", chatSel: 0, mapHits: [], chatHits: [], cmdMsgs: msgs, cmdScroll: 0 });
  let prev = controlRows(c(), W, H), tot = 0, rowsCh = 0, cellsCh = 0;
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  for (let k = 0; k < 20; k++) {
    await new Promise((r) => setTimeout(r, 150));
    const cur = controlRows(c(), W, H);
    cur.forEach((r, y) => { if (r !== prev[y]) { tot += r.length + 10; rowsCh++; const a = [...strip(r)], b = [...strip(prev[y] || "")]; for (let x = 0; x < a.length; x++) if (a[x] !== b[x]) cellsCh++; } });
    prev = cur;
  }
  console.log(`row-diff output: ${(tot / 20 / 1024).toFixed(1)} KB/frame, ${(rowsCh / 20).toFixed(1)} of ${H} rows rewritten, but only ${(cellsCh / 20).toFixed(0)} cells actually changed per frame`);
}
