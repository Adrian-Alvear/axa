// `axa trust <path>`: mark a project as trusted in Claude Code's own config (~/.claude.json,
// projects["<repo root>"].hasTrustDialogAccepted = true), so sessions AXA starts there don't stop on the
// folder-trust prompt. Only you run it, in your own terminal: AXA's sessions never do (the policy denies
// it), because trusting a folder is your decision. Never the home folder itself (or above it).
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// The folder Claude Code keys its trust by: the git repo (or worktree) root, else the folder itself
export function trustRoot(path) {
  const dir = realpathSync(resolve(String(path).replace(/^~(?=$|\/)/, homedir())));
  if (!statSync(dir).isDirectory()) throw new Error(`${path} is not a folder`);
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", timeout: 5000 });
  const top = r.status === 0 ? r.stdout.trim() : "";
  return top ? realpathSync(top) : dir;
}

// the home folder itself or a folder above it (trusting those would trust everything below)
const coversHome = (dir, home) => { const r = relative(dir, home); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

// Read-modify-write through a temp file and a rename (never a half-written config). Claude Code
// rewrites this file too: if it changed while we worked, start over (a few times).
export function trustProject(path, { home = homedir() } = {}) {
  const root = trustRoot(path);
  const realHome = existsSync(home) ? realpathSync(home) : resolve(home);
  if (coversHome(root, realHome)) throw new Error(`refusing to trust ${root}: that is your home folder${root === realHome ? "" : " or above it"}, and trust there would cover every project. Name a project folder.`);
  let file = join(home, ".claude.json");
  // a symlinked config (dotfiles): write the file it points to, keep the link
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) file = realpathSync(file);
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = existsSync(file) ? readFileSync(file, "utf8") : null;
    let cfg = {};
    if (raw !== null && raw.trim()) {
      try { cfg = JSON.parse(raw); } catch (e) { throw new Error(`${file} isn't valid JSON (${e.message}); not touching it`); }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(`${file} doesn't hold a JSON object; not touching it`);
    }
    const before = cfg.projects?.[root]?.hasTrustDialogAccepted;
    if (before === true) return { root, file, before, changed: false };
    cfg.projects = cfg.projects && typeof cfg.projects === "object" ? cfg.projects : {};
    cfg.projects[root] = { ...(cfg.projects[root] || {}), hasTrustDialogAccepted: true };
    const mode = raw !== null ? statSync(file).mode & 0o777 : 0o600;
    const tmp = join(dirname(file), `.claude.json.axa-trust-${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode });
    const now = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (now !== raw) { try { unlinkSync(tmp); } catch {} continue; } // changed under us: again
    renameSync(tmp, file);
    return { root, file, before, changed: true };
  }
  throw new Error(`${file} kept changing (Claude Code is writing it); try again in a moment`);
}
