// ---------- changes viewer ----------
let diffFor = null;
async function showDiff(p) {
  diffFor = p;
  $("diffname").textContent = p.name;
  $("diffmeta").innerHTML = gitHtml(p.git) || esc(p.cwd);
  $("diffbody").textContent = "Loading…";
  $("diffview").hidden = false;
  $("diffclose").focus();
  if (p.demo) { $("diffbody").innerHTML = `<span class="f">diff --git a/src/routes/orders.ts b/src/routes/orders.ts</span>\n<span class="h">@@ -12,6 +12,14 @@</span>\n<span class="a">+export async function listOrders(cursor) {</span>\n<span class="a">+  return db.orders.page({ after: cursor, limit: 50 });</span>\n<span class="a">+}</span>\n<span class="n">(a demo session: sample changes)</span>`; return; }
  try {
    const r = await fetch(`/api/terms/${p.id}/diff`), d = await r.json();
    if (diffFor !== p) return;
    if (!r.ok || d.error) { $("diffbody").textContent = d.error || "Couldn't read the changes"; return; }
    if (d.git) $("diffmeta").innerHTML = gitHtml(d.git);
    const cls = (l) => l.startsWith("diff --git") ? "f" : l.startsWith("+++") || l.startsWith("---") || l.startsWith("index ") ? "n" : l.startsWith("@@") ? "h" : l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : "";
    const lines = (d.diff || "").split("\n").map((l) => { const c = cls(l); return c ? `<span class="${c}">${esc(l)}</span>` : esc(l); });
    const extra = d.untracked_total ? `\n<span class="f">New files (${d.untracked_total})</span>\n${d.untracked.map((f) => `<span class="a">+ ${esc(f)}</span>`).join("\n")}${d.untracked_total > d.untracked.length ? "\n…" : ""}` : "";
    $("diffbody").innerHTML = (d.diff ? lines.join("\n") : `<span class="n">No changes to tracked files.</span>`) + extra + (d.truncated ? `\n<span class="n">(cut: the diff is too long to show here)</span>` : "");
  } catch { $("diffbody").textContent = "Couldn't read the changes"; }
}
const closeDiff = () => { $("diffview").hidden = true; diffFor = null; };
$("diffclose").onclick = closeDiff;
$("diffview").onclick = (ev) => { if (ev.target === $("diffview")) closeDiff(); };
$("diffterm").onclick = () => { const p = diffFor; closeDiff(); if (p) openSession(terms.find((x) => x.id === p.id) || p); };
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !$("diffview").hidden) closeDiff(); });
