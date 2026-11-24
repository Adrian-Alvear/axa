// Review: comment on a session's diff, and the session gets the comments as its next task (research/landscape.md:
// vibe-kanban / Superset's "inline diff comments back to the agent"). One parser for the hub (d) and the web
// console; one message, typed through the usual safe send path (sessions.mjs sendText), so it shows in the chat.
export const MAX_COMMENTS = 30, MAX_TEXT = 500;

// A unified diff -> rows: { text, kind: "file" | "meta" | "hunk" | "add" | "del" | "ctx", file, line }.
// add/ctx rows carry the new file's line number, del rows the old file's (old: true).
export function diffLines(diff) {
  const rows = [];
  if (!String(diff || "").trim()) return rows;
  let file = null, oldN = 0, newN = 0;
  for (const text of String(diff || "").replace(/\n$/, "").split("\n")) {
    if (text.startsWith("diff --git")) { file = /^diff --git a\/(.+?) b\/(.+)$/.exec(text)?.[2] || file; rows.push({ text, kind: "file", file }); continue; }
    if (text.startsWith("+++ ")) { const f = text.slice(4).replace(/^b\//, ""); if (f !== "/dev/null") file = f; rows.push({ text, kind: "meta", file }); continue; }
    if (text.startsWith("--- ") || /^(index |new file|deleted file|similarity|rename |old mode|new mode|Binary )/.test(text)) { rows.push({ text, kind: "meta", file }); continue; }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (h) { oldN = +h[1]; newN = +h[2]; rows.push({ text, kind: "hunk", file }); continue; }
    if (!file) { rows.push({ text, kind: "meta", file: null }); continue; }
    if (text.startsWith("+")) rows.push({ text, kind: "add", file, line: newN++ });
    else if (text.startsWith("-")) rows.push({ text, kind: "del", file, line: oldN++, old: true });
    else if (text.startsWith("\\")) rows.push({ text, kind: "meta", file });
    else { rows.push({ text, kind: "ctx", file, line: newN }); oldN++; newN++; }
  }
  return rows;
}
export const commentable = (r) => r && ["add", "del", "ctx"].includes(r.kind);

// Comments -> one message (one line: a newline would submit early). Each says where (file:line, "(removed)" for
// a deleted line) and quotes the code it's about.
export function commentMessage(comments) {
  const list = (comments || []).filter((c) => c && String(c.text || "").trim() && c.file).slice(0, MAX_COMMENTS);
  if (!list.length) return null;
  const one = (c, i) => {
    const code = String(c.code || "").replace(/^[+\- ]/, "").replace(/\s+/g, " ").trim().slice(0, 80);
    return `(${i + 1}) ${c.file}${c.line ? `:${c.line}${c.old ? " (a removed line)" : ""}` : ""}${code ? ` [${code}]` : ""}: ${String(c.text).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT)}`;
  };
  return `Review comments on your changes, from the user: ${list.map(one).join(" ")} Address each one, then say briefly what you changed for each.`;
}
// a body from the hub or the web: [{ file, line, old, code, text }] -> the comments that are well formed
export const validComments = (b) => (Array.isArray(b?.comments) ? b.comments : []).filter((c) => c && typeof c.file === "string" && typeof c.text === "string" && c.text.trim() && (c.line == null || Number.isInteger(c.line))).slice(0, MAX_COMMENTS);
