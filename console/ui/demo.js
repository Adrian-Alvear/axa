// ---------- demo: a scripted orchestration so the console can be seen without a live run ----------
function demo() {
  sessions.delete("demo"); feedFor = null;
  pinned = true; current = "demo"; selectedId = "axa"; autoFit = true;
  const base = { session: "demo", cwd: "~/projects/n2s-platform" };
  const ids = { scout: "agent-sc0ut1", research: "agent-r3s3a1", b1: "agent-bu1ld1", b2: "agent-bu1ld2", review: "agent-r3v13w" };
  const type = (r) => roster.find((x) => x.role === r)?.subagent_type || r;
  const steps = [
    [0, { event: "UserPromptSubmit", prompt: "Wire the Launches app into N2S as the Aerospace Hangar node and get it reviewed." }],
    [800, { event: "PreToolUse", tool: "Skill", skill: "axa", summary: "axa" }],
    [1500, { event: "PreToolUse", tool: "Read", summary: "roster.md" }],
    [2400, { event: "PreToolUse", tool: "Agent", subagent_type: type("scout"), summary: "Map Launches feature folder", prompt: "Map ~/projects/launches/src/features/launches: entry points, env vars, assets." }],
    [2450, { event: "SubagentStart", agent_id: ids.scout, agent_type: type("scout") }],
    [3300, { event: "PreToolUse", tool: "Agent", subagent_type: type("researcher"), summary: "Check R3F version compat", prompt: "Is @react-three/fiber in Launches compatible with N2S's version?" }],
    [3350, { event: "SubagentStart", agent_id: ids.research, agent_type: type("researcher") }],
    ...[["Glob", "src/features/**"], ["Read", "index.ts"], ["Grep", "process.env"], ["Read", "LaunchScene.tsx"], ["Glob", "public/launches/**"]].map(([t, s], i) => [3000 + i * 800, { event: "PreToolUse", agent_id: ids.scout, agent_type: type("scout"), tool: t, summary: s }]),
    ...[["WebSearch", "react-three-fiber v9 changelog"], ["WebFetch", "github.com/pmndrs/react-three-fiber"], ["WebSearch", "next 16 r3f"]].map(([t, s], i) => [4000 + i * 1200, { event: "PreToolUse", agent_id: ids.research, agent_type: type("researcher"), tool: t, summary: s }]),
    [7400, { event: "SubagentStop", agent_id: ids.scout, agent_type: type("scout"), message: "Feature is self-contained in src/features/launches (100 files). Needs NEXT_PUBLIC_LAUNCHES_ASSET_BASE." }],
    [8000, { event: "SubagentStop", agent_id: ids.research, agent_type: type("researcher"), message: "Both on R3F 9.x — compatible. No upgrade needed." }],
    [9000, { event: "PreToolUse", tool: "Agent", subagent_type: type("builder"), summary: "Port feature into dashboard/", prompt: "Copy src/features/launches into N2S dashboard, scope styles, add /aerospace route." }],
    [9050, { event: "SubagentStart", agent_id: ids.b1, agent_type: type("builder") }],
    [9700, { event: "PreToolUse", tool: "Agent", subagent_type: type("builder"), summary: "Register Aerospace route", prompt: "Register /aerospace in components/ecosystem/routes.ts and the orrery node." }],
    [9750, { event: "SubagentStart", agent_id: ids.b2, agent_type: type("builder") }],
    ...[["Bash", "cp -r features"], ["Edit", "page.tsx"], ["Write", "aerospace/layout.tsx"], ["Edit", "globals.css"], ["Skill", "cloudflare"], ["Bash", "npx opennextjs-cloudflare build"]].map(([t, s], i) => [9700 + i * 900, { event: "PreToolUse", agent_id: ids.b1, agent_type: type("builder"), tool: t, skill: t === "Skill" ? s : undefined, summary: s }]),
    ...[["Read", "routes.ts"], ["Edit", "routes.ts"], ["Edit", "Orrery.tsx"]].map(([t, s], i) => [10300 + i * 1000, { event: "PreToolUse", agent_id: ids.b2, agent_type: type("builder"), tool: t, summary: s }]),
    [13400, { event: "PermissionRequest", agent_id: ids.b2, agent_type: type("builder"), tool: "Bash", summary: "git checkout -b aerospace-node" }],
    [15400, { event: "PreToolUse", agent_id: ids.b2, agent_type: type("builder"), tool: "Bash", summary: "git checkout -b aerospace-node" }],
    [15000, { event: "PostToolUseFailure", agent_id: ids.b1, agent_type: type("builder"), tool: "Bash", error: "Type error: 'scene' is possibly null" }],
    [15800, { event: "PreToolUse", agent_id: ids.b1, agent_type: type("builder"), tool: "Edit", summary: "LaunchScene.tsx" }],
    [16600, { event: "PreToolUse", agent_id: ids.b1, agent_type: type("builder"), tool: "Bash", summary: "npx opennextjs-cloudflare build" }],
    [17200, { event: "SubagentStop", agent_id: ids.b2, agent_type: type("builder"), message: "Route registered; orrery node links to /aerospace." }],
    [18200, { event: "SubagentStop", agent_id: ids.b1, agent_type: type("builder"), message: "Ported 100 files; build passes after null-check fix." }],
    [19000, { event: "PreToolUse", tool: "Agent", subagent_type: type("reviewer"), summary: "Review aerospace-node diff", prompt: "Review the aerospace-node branch diff; run build + typecheck." }],
    [19050, { event: "SubagentStart", agent_id: ids.review, agent_type: type("reviewer") }],
    ...[["Bash", "git diff main"], ["Read", "routes.ts"], ["Read", "LaunchScene.tsx"], ["Bash", "npx tsc --noEmit"]].map(([t, s], i) => [19600 + i * 900, { event: "PreToolUse", agent_id: ids.review, agent_type: type("reviewer"), tool: t, summary: s }]),
    [23500, { event: "SubagentStop", agent_id: ids.review, agent_type: type("reviewer"), message: "Clean. One nit: asset base env var missing from .env.example." }],
    [24200, { event: "PreToolUse", tool: "Bash", summary: "verify build" }],
    [25500, { event: "Stop", message: "Aerospace Hangar wired in on branch aerospace-node. Scout mapped, researcher confirmed R3F compat, 2 builders ported + routed, reviewer clean. Not pushed." }],
  ];
  const t0 = Date.now();
  for (const [at, e] of steps) setTimeout(() => ingest({ ...base, ts: t0 + at, ...e }), at);
}
$("demo").onclick = demo;
