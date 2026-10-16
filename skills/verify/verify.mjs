#!/usr/bin/env node
// Runs a project's own checks and prints one PASS/FAIL table, so "done" comes with evidence.
//   node verify.mjs [folder] [--list]
// Finds the checks from the project's files: package.json scripts (typecheck, lint, test, build) with the
// right package manager, Cargo, Go, pytest, `make test`, and a syntax check of changed JavaScript files.
// --list prints the plan without running it. Exit code 1 if any check fails. Zero dependencies.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const start = resolve(args.find((a) => !a.startsWith("--")) || ".");
const run = (cmd, argv, cwd, timeout = 10 * 60_000) => spawnSync(cmd, argv, { cwd, encoding: "utf8", timeout, maxBuffer: 32 << 20, env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" } });
const top = run("git", ["rev-parse", "--show-toplevel"], start, 5000);
const root = top.status === 0 ? top.stdout.trim() : start;
const has = (f) => existsSync(join(root, f));

const checks = []; // { name, cmd, args }
if (has("package.json")) {
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); } catch (e) { console.log(`package.json couldn't be read (${e.message}): its scripts were skipped. Fix it; that's a failure too.`); process.exitCode = 1; }
  const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
  const scripts = pkg.scripts || {};
  for (const want of [["typecheck", "type-check", "tsc", "check-types"], ["lint"], ["test"], ["build"]]) {
    const name = want.find((s) => scripts[s]);
    if (!name || /no test specified/.test(scripts[name])) continue;
    checks.push({ name, cmd: pm, args: ["run", name] });
  }
}
if (has("Cargo.toml")) checks.push({ name: "cargo check", cmd: "cargo", args: ["check", "--quiet"] }, { name: "cargo test", cmd: "cargo", args: ["test", "--quiet"] });
if (has("go.mod")) checks.push({ name: "go vet", cmd: "go", args: ["vet", "./..."] }, { name: "go test", cmd: "go", args: ["test", "./..."] });
if ((has("pyproject.toml") || has("pytest.ini") || has("setup.cfg")) && (has("tests") || has("test"))) checks.push({ name: "pytest", cmd: "python3", args: ["-m", "pytest", "-q"] });
if (has("Makefile") && /^test:/m.test(readFileSync(join(root, "Makefile"), "utf8")) && !checks.length) checks.push({ name: "make test", cmd: "make", args: ["test"] });

// Changed JavaScript files (uncommitted + new): at least a syntax check
const changed = top.status === 0
  ? [...new Set([...(run("git", ["diff", "--name-only", "HEAD"], root, 5000).stdout || "").split("\n"), ...(run("git", ["ls-files", "--others", "--exclude-standard"], root, 5000).stdout || "").split("\n")])]
  : readdirSync(root);
// (extensionless scripts count when their first line is a node shebang, e.g. bin/ tools)
const nodeScript = (f) => { try { return /^#!.*\bnode\b/.test(readFileSync(join(root, f), "utf8").slice(0, 100)); } catch { return false; } };
for (const f of changed.filter((f) => f && existsSync(join(root, f)) && (/\.(?:mjs|cjs|js)$/.test(f) || (!/\.\w+$/.test(f) && nodeScript(f))))) checks.push({ name: `node --check ${f}`, cmd: process.execPath, args: ["--check", f] });

if (!checks.length) { console.log(`No checks found in ${root}. Say so in your report, and verify by hand (run it, or take a screenshot for UI).`); process.exit(0); }
if (listOnly) { for (const c of checks) console.log(`${c.name}: ${c.cmd} ${c.args.join(" ")}`); process.exit(0); }

const rows = [];
for (const c of checks) {
  const t0 = Date.now(), r = run(c.cmd, c.args, root);
  const ok = r.status === 0;
  const secs = ((Date.now() - t0) / 1000).toFixed(1) + "s";
  const why = r.error ? (r.error.code === "ETIMEDOUT" ? "timed out after 10 min" : r.error.message) : "";
  rows.push({ c, ok, secs, why });
  if (!ok) {
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n").slice(-30).join("\n");
    console.log(`\n--- ${c.name} failed (${c.cmd} ${c.args.join(" ")}) ---\n${why || out}`);
  }
}
console.log(`\n| Check | Result | Time | Notes |\n|---|---|---|---|`);
for (const { c, ok, secs, why } of rows) console.log(`| ${c.name} | ${ok ? "PASS" : "FAIL"} | ${secs} | ${why || (ok ? "" : "output above")} |`);
process.exit(rows.every((r) => r.ok) && !process.exitCode ? 0 : 1);
