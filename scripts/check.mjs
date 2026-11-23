#!/usr/bin/env node
// `npm run check`: AXA's own checks in one command, so nobody writes shell loops or variables for them
// (Claude Code asks about those itself, even when AXA's approver would allow them).
//   1. node --check on every source file (src, hooks, mcp, lib, scripts, skills, bin/axa, the tests)
//   2. the test suite the way `npm test` runs it (node --test test/*.test.mjs)
//   3. plain `node --test` (its own file discovery: fixtures under test/ must stay quiet)
// Prints a short PASS/FAIL table, the tail of each failure, and exits 1 if anything failed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".git", ".claude"]);
function sources(dir) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    if (SKIP.has(d.name)) continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...sources(p));
    else if (/\.(?:mjs|cjs|js)$/.test(d.name)) out.push(p);
  }
  return out;
}
const nodeShebang = (f) => { try { return /^#!.*\bnode\b/.test(readFileSync(f, "utf8").slice(0, 100)); } catch { return false; } };
export function sourceFiles(base = root) {
  const files = ["src", "hooks", "mcp", "lib", "scripts", "skills", "test"].flatMap((d) => sources(join(base, d)));
  const bin = join(base, "bin");
  try { for (const f of readdirSync(bin)) if (statSync(join(bin, f)).isFile() && nodeShebang(join(bin, f))) files.push(join(bin, f)); } catch {}
  return files.sort();
}

// (as a module, for its test: nothing runs)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const results = [];
  const tail = (s) => String(s || "").trimEnd().split("\n").slice(-25).join("\n");
  const t0 = Date.now();
  const bad = [];
  const files = sourceFiles();
  for (const f of files) {
    const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    if (r.status !== 0) bad.push(`${relative(root, f)}\n${tail(r.stderr)}`);
  }
  results.push({ name: `node --check (${files.length} files)`, ok: !bad.length, secs: (Date.now() - t0) / 1000, out: bad.join("\n\n") });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // (when run from inside a test, the suites must still run)
  const tests = readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => join("test", f));
  for (const [name, args] of [["npm test (node --test test/*.test.mjs)", ["--test", ...tests]], ["node --test", ["--test"]]]) {
    const t = Date.now();
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", env, maxBuffer: 64 << 20, timeout: 15 * 60_000 });
    const counts = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(r.stdout || "");
    results.push({ name, ok: r.status === 0, secs: (Date.now() - t) / 1000, note: counts ? `${counts[1]} pass, ${counts[2]} fail` : r.error ? r.error.message : "", out: r.status === 0 ? "" : tail([...(r.stdout || "").split("\n").filter((l) => /^not ok|^# (?:pass|fail)/.test(l)), r.stderr].join("\n")) });
  }
  const w = Math.max(...results.map((r) => r.name.length));
  console.log(`${"check".padEnd(w)}  result  time`);
  for (const r of results) console.log(`${r.name.padEnd(w)}  ${r.ok ? "PASS  " : "FAIL  "}  ${r.secs.toFixed(1)}s${r.note ? `  (${r.note})` : ""}`);
  for (const r of results.filter((x) => !x.ok)) console.log(`\n--- ${r.name} ---\n${r.out}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
