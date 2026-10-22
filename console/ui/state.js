// AXA console: shared helpers, the agent roster and each session's call graph (fed by /events)

const $ = (id) => document.getElementById(id);

// ---------- palette: from the theme (design.js keeps C current); warn = needs you, bad = failed ----------
// helpers' roles get a family of colors made from the theme's own roles, so every theme stays legible
const roleColors = () => {
  const m = TH.mix;
  return { scout: C.accent, researcher: m(C.accent, C.text, 0.45), builder: C.ok, reviewer: m(C.accent, C.bad, 0.5), planner: m(C.warn, C.text, 0.35), generalist: m(C.accent, C.text, 0.25) };
};
const paletteOf = () => { const r = roleColors(), m = TH.mix; return [r.scout, r.researcher, r.builder, r.reviewer, m(C.ok, C.text, 0.4), m(C.accent, C.ok, 0.5)]; };
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// ---------- plain English for what a session is doing ----------
const SESSION_TOOLS = { list_sessions: "Checking on sessions", read_session: "Reading a session's screen", send_to_session: "Sending instructions to a session",
  start_goal: "Giving a session a goal", open_session: "Opening a session", close_session: "Closing a session",
  list_terminals: "Checking on sessions", read_terminal: "Reading a session's screen", send_to_terminal: "Sending instructions to a session", open_terminal: "Opening a session" };
// Claude Code's own bookkeeping: not worth showing on the map
const PLUMBING = /^(ToolSearch|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskOutput|EnterPlanMode|ExitPlanMode|ListMcpResourcesTool|ReadMcpResourceTool)$/;
function toolName(tool) {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool || "");
  if (!m) return tool;
  return SESSION_TOOLS[m[2]] || `${m[2].replace(/_/g, " ")} · ${m[1].replace(/^plugin_/, "").replace(/_/g, " ")}`;
}
function humanAction(tool, summary, skill) {
  if (skill) return `Using the ${skill} skill`;
  if (!tool || PLUMBING.test(tool)) return null;
  if (tool.startsWith("mcp__")) return toolName(tool);
  const s = summary ? String(summary) : "";
  switch (tool) {
    case "Bash": return s ? `Running: ${s}` : "Running a command";
    case "Read": return `Reading ${s || "a file"}`;
    case "Edit": case "Write": case "NotebookEdit": return `Editing ${s || "a file"}`;
    case "Grep": case "Glob": return s ? `Searching for ${s}` : "Searching";
    case "WebSearch": return `Searching the web: ${s}`;
    case "WebFetch": return `Reading a web page: ${s}`;
    case "Agent": case "Task": return `Starting a helper: ${s}`;
    case "Skill": return `Using the ${s} skill`;
  }
  return s ? `${tool}: ${s}` : tool;
}

// ---------- roster ----------
let roster = [];
const typeToRole = new Map();
function roleFor(subagentType) {
  const t = subagentType || "general-purpose";
  if (typeToRole.has(t)) return typeToRole.get(t);
  const bare = t.includes(":") ? t.split(":").pop() : t;
  return typeToRole.get(bare) || bare;
}
function roleMeta(role) {
  const r = roster.find((x) => x.role === role);
  const clean = (v) => (v && !/^[—–-]+$/.test(v) ? v : undefined);
  return { color: roleColors()[role] || paletteOf()[hash(role) % 6], model: clean(r?.model), use: clean(r?.use), type: clean(r?.subagent_type) };
}

// ---------- graph per session: nodes appear only when they are called ----------
const sessions = new Map();
let current = null, pinned = false, selectedId = "axa";
const COLLAPSE_MS = 7000; // a finished job folds its tool leaves away after this

function newGraph(id, cwd) {
  const g = { id, cwd, last: 0, calls: 0, events: [], nodes: new Map(), links: [], pending: [] };
  addNode(g, { id: "axa", kind: "axa", label: "AXA", color: C.accent, x: 0, y: 0, fixed: true, status: "idle" });
  return g;
}
function addNode(g, n, parentId) {
  const p = parentId && g.nodes.get(parentId);
  const a = Math.random() * Math.PI * 2;
  n.x ??= (p ? p.x : 0) + Math.cos(a) * 30;
  n.y ??= (p ? p.y : 0) + Math.sin(a) * 30;
  Object.assign(n, { vx: 0, vy: 0, parent: parentId || null, hotUntil: 0, count: 0, born: performance.now() });
  g.nodes.set(n.id, n);
  if (p) g.links.push({ a: p.id, b: n.id });
  return n;
}
function removeNode(g, id) {
  for (const n of [...g.nodes.values()]) if (n.parent === id) removeNode(g, n.id);
  g.nodes.delete(id);
  g.links = g.links.filter((l) => l.a !== id && l.b !== id);
}
function ensureRole(g, role) {
  const id = "role:" + role;
  return g.nodes.get(id) || addNode(g, { id, kind: "role", label: role, role, color: roleMeta(role).color, status: "idle", calls: 0 }, "axa");
}
function ensureInst(g, e) {
  let n = g.nodes.get(e.agent_id);
  if (n) return n;
  const role = roleFor(e.agent_type);
  const r = ensureRole(g, role);
  const jobs = [...g.nodes.values()].filter((x) => x.parent === r.id && x.kind === "inst");
  if (jobs.length >= 5) removeNode(g, jobs.sort((a, b) => a.start - b.start)[0].id);
  return addNode(g, { id: e.agent_id, kind: "inst", label: role, role, color: r.color, status: "running", start: e.ts }, r.id);
}
function ensureLeaf(g, parent, name, kind) {
  const id = parent.id + "|" + name;
  let n = g.nodes.get(id);
  if (!n) {
    if ([...g.nodes.values()].filter((x) => x.parent === parent.id && x.kind === "leaf").length >= 9) return null;
    n = addNode(g, { id, kind: "leaf", label: name, leafKind: kind, color: parent.color, recent: [] }, parent.id);
  }
  return n;
}

function ingest(e) {
  if (!e || !e.session) return;
  let g = sessions.get(e.session);
  if (!g) { g = newGraph(e.session, e.cwd); sessions.set(e.session, g); }
  g.last = e.ts; g.cwd = e.cwd || g.cwd;
  if (e.role) g.role = e.role;
  if (e.terminal) g.terminal = e.terminal;
  if (e.event === "PreToolUse" && !e.agent_id) { const a = humanAction(e.tool, e.summary, e.skill); if (a) g.doing = a; }
  if (e.event === "UserPromptSubmit") g.doing = "Thinking";
  if (e.event === "Stop") g.doing = null;
  const axa = g.nodes.get("axa");
  const owner = e.agent_id ? ensureInst(g, e) : axa;
  const isSpawn = e.tool === "Agent" || e.tool === "Task";
  const now = performance.now();

  switch (e.event) {
    case "UserPromptSubmit":
      if (!/^\s*<task-notification>/.test(e.prompt || "")) { axa.prompt = e.prompt; g.turnStart = e.ts; }
      axa.status = "running"; axa.yourTurn = false; axa.perm = null; break;
    case "Stop": axa.status = "idle"; axa.message = e.message; axa.yourTurn = true; axa.perm = null; axa.doneAt = e.ts; break;
    // A permission request goes to AXA's approver first; it only needs you if AXA escalates it
    // (or the prompt is actually on screen)
    case "PermissionRequest": owner.reviewing = e.tool || true; break;
    case "AxaDecision": owner.reviewing = null; owner.perm = e.decision === "escalate" ? e.tool || true : null; break;
    case "Notification": if (/permission/i.test(e.notification_type || e.message || "")) owner.perm = owner.reviewing || owner.perm || true; break;
    case "PreToolUse": {
      g.calls++; owner.perm = null;
      if (isSpawn && !e.agent_id) {
        const role = roleFor(e.subagent_type);
        const r = ensureRole(g, role);
        r.calls++; r.hotUntil = now + 1600;
        g.pending.push({ role, prompt: e.prompt, desc: e.summary });
        break;
      }
      if (!e.skill && PLUMBING.test(e.tool || "")) break;
      const name = e.skill ? e.skill : toolName(e.tool);
      if (owner.kind === "inst") { owner.steps = (owner.steps || 0) + 1; owner.now = humanAction(e.tool, e.summary, e.skill); owner.fail = false; }
      const leaf = ensureLeaf(g, owner, name, e.skill ? "skill" : "tool");
      if (leaf) { leaf.count++; leaf.hotUntil = now + 1100; leaf.fail = false; leaf.recent.unshift(e.summary || ""); leaf.recent.length = Math.min(leaf.recent.length, 5); }
      break;
    }
    case "PostToolUse": owner.perm = null; break;
    case "PostToolUseFailure": {
      const leaf = g.nodes.get(owner.id + "|" + (e.skill || toolName(e.tool)));
      if (leaf) { leaf.fail = true; leaf.hotUntil = 0; leaf.error = e.error; }
      if (owner.kind === "inst") owner.fail = e.error || true;
      owner.perm = null;
      break;
    }
    case "SubagentStart": {
      const role = roleFor(e.agent_type);
      const i = g.pending.findIndex((p) => p.role === role);
      const spawn = i >= 0 ? g.pending.splice(i, 1)[0] : null;
      if (!spawn) ensureRole(g, role).calls++; // started without a visible dispatch (e.g. background agents)
      const n = ensureInst(g, e);
      n.status = "running"; n.start = e.ts;
      if (spawn) { n.prompt = spawn.prompt; n.desc = spawn.desc; n.label = spawn.desc || n.label; }
      break;
    }
    case "SubagentStop": {
      const n = g.nodes.get(e.agent_id);
      if (n) { n.status = "done"; n.message = e.message; n.end = e.ts; n.perm = null; }
      break;
    }
  }
  for (const r of g.nodes.values()) if (r.kind === "role")
    r.status = [...g.nodes.values()].some((x) => x.parent === r.id && x.status === "running") ? "running" : "idle";
  g.events.push(e);
  if (g.events.length > 3000) g.events.splice(0, g.events.length - 3000);
  dirty = true;
}

