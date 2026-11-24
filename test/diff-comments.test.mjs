// Part 5 of docs/tasks/landscape-build.md: comment on a diff (hub `d`, web console), the session gets the
// comments as its next task, typed through the safe send path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "../src/core/diffcomments.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = (f) => readFileSync(join(ROOT, f), "utf8");
const DIFF = `diff --git a/src/a.js b/src/a.js
index 111..222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -10,4 +10,5 @@ function f() {
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 return x;
diff --git a/README.md b/README.md
new file mode 100644
--- /dev/null
+++ b/README.md
@@ -0,0 +1,2 @@
+# Title
+text
`;

test("a diff parsed into rows with the file and line each comment is about", () => {
  const rows = C.diffLines(DIFF);
  const pick = (kind) => rows.filter((r) => r.kind === kind).map((r) => [r.file, r.line, !!r.old]);
  assert.deepEqual(pick("ctx"), [["src/a.js", 10, false], ["src/a.js", 13, false]]);
  assert.deepEqual(pick("del"), [["src/a.js", 11, true]]);
  assert.deepEqual(pick("add"), [["src/a.js", 11, false], ["src/a.js", 12, false], ["README.md", 1, false], ["README.md", 2, false]]);
  assert.equal(rows.filter((r) => r.kind === "file").length, 2);
  assert.equal(rows.filter(C.commentable).length, 7);
  assert.deepEqual(C.diffLines(""), []);
});

test("comments become one message (one line: a newline would submit early), each with file:line and the code", () => {
  const m = C.commentMessage([
    { file: "src/a.js", line: 11, code: "+const y = 3;", text: "why 3?\nit was 2" },
    { file: "src/a.js", line: 11, old: true, code: "-const y = 2;", text: "keep this one" },
    { file: "README.md", line: 1, text: "  a better title  " },
    { file: "x", text: "   " },
  ]);
  assert.equal(m, "Review comments on your changes, from the user: (1) src/a.js:11 [const y = 3;]: why 3? it was 2 (2) src/a.js:11 (a removed line) [const y = 2;]: keep this one (3) README.md:1: a better title Address each one, then say briefly what you changed for each.");
  assert.ok(!m.includes("\n"));
  assert.equal(C.commentMessage([]), null);
  assert.equal(C.commentMessage(Array.from({ length: 50 }, (_, i) => ({ file: "f", line: i + 1, text: "t" }))).match(/\(\d+\)/g).length, C.MAX_COMMENTS);
  assert.ok(C.commentMessage([{ file: "f", line: 1, text: "x".repeat(2000) }]).length < 700);
  assert.deepEqual(C.validComments({ comments: [{ file: "a", line: 1, text: "ok" }, { file: 3, text: "x" }, { file: "b", line: "2", text: "x" }, { file: "c", text: "" }] }), [{ file: "a", line: 1, text: "ok" }]);
  assert.deepEqual(C.validComments({}), []);
});

test("wiring: only the user comments; it goes through sendText (shows in the chat); the hub's c / x / S and the web console", () => {
  const s = src("src/core/server.mjs");
  assert.match(s, /\["POST", \/\^\\\/api\\\/terms\\\/\(\[\\w-\]\+\)\\\/comments\$\/, async \(m, req\) => \{\n\s*if \(!fromUser\(req\)\) return \[403/);
  assert.match(s, /const text = commentMessage\(validComments\(await readBody\(req\)\)\);[\s\S]{0,120}const r = await S\.sendText\(m\[1\], text, \{ enter: true \}\);/);
  assert.match(s, /rows: diffLines\(r\.diff\)/);
  const app = src("src/tui/app.mjs");
  assert.match(app, /else if \(k === "c" && commentable\(r\)\) \{/);
  assert.match(app, /else if \(k === "x" && commentable\(r\)\)/);
  assert.match(app, /call\(`\/api\/terms\/\$\{s\.id\}\/comments`, \{ method: "POST", body: \{ comments: notes \} \}\)/);
  const web = src("src/web/index.html");
  assert.match(web, /<button id="diffsend" hidden/);
  assert.match(web, /fetch\(`\/api\/terms\/\$\{p\.id\}\/comments`, \{ method: "POST"/);
  assert.match(web, /data-i="\$\{i\}" title="Click to comment on/);
});
