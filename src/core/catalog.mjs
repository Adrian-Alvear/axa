// What you can work with: your projects (folders) and the agents Claude Code can use.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { expand, pluginRoot, rosterFile, tilde } from "../paths.mjs";
import { gitInfo } from "./git.mjs";

// ---------- projects ----------
// The roster's projects first, then git repos in ~/projects and directly in your home folder
export function listProjects() {
  const seen = new Map();
  const add = (path) => {
    const p = expand(path);
    try { if (statSync(p).isDirectory() && !seen.has(p) && !p.includes("/.claude/worktrees/")) seen.set(p, { name: basename(p), path: p }); } catch {}
  };
  const roster = rosterFile();
  if (roster) {
    let inProjects = false;
    for (const line of readFileSync(roster, "utf8").split("\n")) {
      if (line.startsWith("## ")) inProjects = /projects/i.test(line);
      if (inProjects) for (const m of line.matchAll(/`(~?\/[^`]+)`/g)) add(m[1]);
    }
  }
  for (const root of [join(homedir(), "projects"), homedir()]) {
    try {
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith(".") && (root !== homedir() || existsSync(join(root, d.name, ".git")))) add(join(root, d.name));
      }
    } catch {}
  }
  return [...seen.values()].map((p) => ({ ...p, git: gitInfo(p.path) }));
}

// ---------- agents ----------
// An agent file: markdown with front matter (name, description, model, tools)
function frontMatter(file) {
  const text = readFileSync(file, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fm = {};
  if (m) for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { fm, body: m ? text.slice(m[0].length).trim() : text.trim() };
}
function agentsIn(dir, source, prefix = "") {
  const out = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const { fm, body } = frontMatter(join(dir, f));
        const name = fm.name || f.slice(0, -3);
        out.push({ name: prefix + name, source, description: fm.description || "", model: fm.model || "inherit", tools: fm.tools || "all", file: tilde(join(dir, f)), prompt: body.slice(0, 2000) });
      } catch {}
    }
  } catch {}
  return out;
}
// Claude Code's own agents, always there
const BUILT_IN = [
  { name: "general-purpose", description: "Research, code search and multi-step tasks; the default helper." },
  { name: "Explore", description: "Fast read-only search across a codebase: finds files and code, reports conclusions." },
  { name: "Plan", description: "Designs an implementation plan: steps, critical files, trade-offs." },
].map((a) => ({ ...a, source: "built-in", model: "inherit", tools: "all" }));

// Every agent you have: AXA's, your own (~/.claude/agents), each project's (.claude/agents), Claude's built-ins
export function listAgents() {
  const all = [...agentsIn(join(pluginRoot, "agents"), "axa", "axa:"), ...agentsIn(join(homedir(), ".claude", "agents"), "yours")];
  for (const p of listProjects()) for (const a of agentsIn(join(p.path, ".claude", "agents"), `project ${p.name}`)) all.push({ ...a, project: p.name });
  return [...all, ...BUILT_IN];
}

// The roster's roles table (which agent AXA uses for what): role, subagent_type, model, use
export function readRoster() {
  const file = rosterFile();
  if (!file) return [];
  const roles = [];
  let inRoles = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("## ")) inRoles = /roles/i.test(line);
    if (!inRoles || !line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim().replace(/`/g, ""));
    if (cells.length < 4 || /^-+$/.test(cells[0]) || cells[0].toLowerCase() === "role") continue;
    roles.push({ role: cells[0], subagent_type: cells[1], model: cells[2], use: cells[3] });
  }
  return roles;
}
