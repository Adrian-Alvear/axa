// ---------- demo: a scripted orchestration so the console can be seen without a live run ----------
function demo() {
  demoSessions();
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

// ---------- the demo's project sessions, runs, timeline and spend (every field the console can show) ----------
let demoList = [], demoRunList = [], demoActive = false;
const demoOn = () => demoActive;
const demoTerms = () => demoList;
const demoRuns = () => demoRunList;
function demoCost() {
  const days = [], now = new Date();
  const usd = [2.1, 3.4, 1.2, 0, 0.6, 4.8, 3.9, 2.2, 5.6, 3.1, 1.7, 6.2, 4.4, 4.12];
  for (let i = 13; i >= 0; i--) { const d = new Date(now - i * 864e5); days.push({ date: d.toISOString().slice(0, 10), usd: usd[13 - i], sessions: Math.max(1, Math.round(usd[13 - i])) }); }
  return { days, today_usd: 4.12, total_usd: 87.35 };
}
function demoSessions() {
  demoActive = true;
  const now = Date.now(), m = 60_000;
  const base = (id, name, extra) => ({ id: `demo-${id}`, name, cwd: `~/projects/${name}`, mode: "claude", alive: true, created: now - 3 * 3600e3, idle_seconds: 30, demo: true, last_event_at: now - 60_000, ...extra });
  demoList = [
    base("api", "api", { status: "waiting", awaiting_permission: true, tool: "Bash", summary: "npm run migrate -- --env staging", idle_seconds: 95,
      choices: { question: "Bash command\n\n  npm run migrate -- --env staging\n  Run the database migrations on staging\n\nDo you want to proceed?", options: [{ n: 1, label: "Yes" }, { n: 2, label: "Yes, and don't ask again for npm run migrate commands" }, { n: 3, label: "No, and tell Claude what to do differently (esc)" }] },
      git: { branch: "orders-v2", files: 3, added: 120, removed: 14, ahead: 2 }, usage: { tokens: 412000, budget: 2000000 },
      cost: { usd: 1.84, context_pct: 41, model: "claude-opus-5-5", at: now - m }, github: { pr: { number: 128, state: "open", url: "https://github.com/example/api/pull/128", draft: false, review: null, checks: "pending" }, ci: null } }),
    base("web", "web", { status: "stuck", stuck_minutes: 24, stuck_reason: "No output for 24m while running npm run e2e", tool: "Bash", summary: "npm run e2e", idle_seconds: 1440,
      git: { branch: "checkout-fix", files: 5, added: 64, removed: 31 }, cost: { usd: 0.62, context_pct: 88, model: "claude-sonnet-5", at: now - 20 * m }, github: null }),
    base("billing", "billing", { status: "failed", failed_reason: "API rate limit reached · resets 14:30", error: "429 rate_limit_error", idle_seconds: 600,
      git: { branch: "main", files: 0, added: 0, removed: 0 }, usage: { tokens: 2300000, budget: 2000000, over_budget: true },
      github: { pr: null, ci: { status: "completed", conclusion: "failure", name: "test", url: "https://github.com/example/billing/actions/runs/1" } } }),
    base("docs", "docs", { status: "working", tool: "Edit", summary: "README.md", idle_seconds: 2, cost: { usd: 0.31, context_pct: 22, model: "claude-haiku-5", at: now } }),
    base("infra", "infra", { status: "done", last_report: "Terraform plan is clean: 2 modules updated, nothing applied. PR #131 is ready for review.", idle_seconds: 4200,
      git: { branch: "tf-modules", files: 2, added: 38, removed: 9, ahead: 1 }, cost: { usd: 1.12, context_pct: 57, model: "claude-opus-5-5", at: now - 70 * m },
      github: { pr: { number: 131, state: "open", url: "https://github.com/example/infra/pull/131", draft: false, review: "approved", checks: "passing" }, ci: null } }),
    { id: "demo-sh", name: "scratch", cwd: "~/scratch", mode: "shell", alive: true, status: "shell", created: now - 7200e3, idle_seconds: 3600, demo: true },
  ];
  const ev = (terminal, off, e) => ({ ts: now - off * m, terminal, ...e });
  const runOf = (id, name, prompt, start, end, status, report, counts, events) => ({ id: `demo-${id}-${Math.round(start)}`, terminal: `demo-${id}`, name, prompt, start: now - start * m, end: end == null ? undefined : now - end * m, status, report, steps: 0, helpers: 0, approvals: 0, declined: 0, escalated: 0, refused: 0, gate: 0, failures: 0, answers: [], demo: true, ...counts, events });
  const steps = (t, from, tools) => tools.map(([tool, summary], i) => ev(t, from - i * 0.6, { event: "PreToolUse", tool, summary }));
  demoRunList = [
    runOf("infra", "infra", "Update the network and dns Terraform modules to the new provider and open a PR.", 95, 71, "done", "Terraform plan is clean: 2 modules updated, nothing applied. PR #131 is ready for review.", { steps: 34, helpers: 2, approvals: 6, gate: 1 }, [
      ev("demo-infra", 95, { event: "UserPromptSubmit" }), ...steps("demo-infra", 94.5, [["Read", "modules/network/main.tf"], ["Grep", "provider \"aws\""], ["Read", "modules/dns/main.tf"]]),
      ev("demo-infra", 92, { event: "PreToolUse", tool: "Agent", subagent_type: "researcher", summary: "Provider v6 breaking changes" }),
      ev("demo-infra", 86, { event: "SubagentStop", agent_id: "a1", message: "Two renamed arguments in aws_route53_record; nothing else affects these modules." }),
      ...steps("demo-infra", 85, [["Edit", "modules/dns/main.tf"], ["Edit", "modules/network/main.tf"], ["Bash", "terraform fmt -recursive"]]),
      ev("demo-infra", 82, { event: "AxaDecision", decision: "allow", tool: "Bash", summary: "terraform plan", reason: "read-only plan inside the project" }),
      ev("demo-infra", 76, { event: "VerifyGate", summary: "changed 2 files without a check" }),
      ...steps("demo-infra", 75, [["Bash", "terraform validate"], ["Bash", "gh pr create --fill"]]),
      ev("demo-infra", 71, { event: "Stop", message: "done" })]),
    runOf("api", "api", "Add a paginated /v2/orders endpoint with tests.", 130, 112, "done", "Added /v2/orders with cursor pagination; 14 new tests pass.", { steps: 41, helpers: 1, approvals: 9 }, [
      ev("demo-api", 130, { event: "UserPromptSubmit" }), ...steps("demo-api", 129, [["Read", "src/routes/orders.ts"], ["Edit", "src/routes/orders.ts"], ["Write", "test/orders.test.ts"], ["Bash", "npm test"]]),
      ev("demo-api", 112, { event: "Stop", message: "done" })]),
    runOf("api", "api", "Run the migrations on staging and check the orders table.", 20, null, "running", undefined, { steps: 8, escalated: 1 }, [ev("demo-api", 20, { event: "UserPromptSubmit" }), ...steps("demo-api", 19, [["Read", "migrations/0042_orders.sql"]]), ev("demo-api", 2, { event: "AxaDecision", decision: "escalate", tool: "Bash", summary: "npm run migrate -- --env staging", reason: "touches a shared database" })]),
    runOf("billing", "billing", "Reconcile last month's invoices against Stripe.", 48, 10, "unfinished", undefined, { steps: 12, failures: 3, refused: 1 }, [
      ev("demo-billing", 48, { event: "UserPromptSubmit" }), ...steps("demo-billing", 47, [["Read", "scripts/reconcile.ts"], ["Bash", "node scripts/reconcile.ts --month 2026-09"]]),
      ev("demo-billing", 30, { event: "PolicyDecision", decision: "deny", tool: "Bash", summary: "upload invoices.json to an outside API", reason: "sends data to an outside service" }),
      ev("demo-billing", 12, { event: "PostToolUseFailure", tool: "Bash", error: "429 rate_limit_error" })]),
    runOf("web", "web", "Fix the checkout button on Safari and run the e2e suite.", 60, 33, "replaced", undefined, { steps: 19, declined: 1 }, [
      ev("demo-web", 60, { event: "UserPromptSubmit" }), ev("demo-web", 41, { event: "AxaDecision", decision: "deny", tool: "Bash", summary: "drop the staging orders_archive table", reason: "deletes shared data" })]),
  ];
  // the timeline: what happened while you were away (the runs' own events, plus a link that fired)
  const extra = [ev("demo-docs", 70, { event: "ChainFired", from: "infra", to: "docs", text: "Document the new Terraform module inputs in README.md" }),
    ...[88, 84, 80, 79].map((o) => ev("demo-api", o, { event: "AxaDecision", decision: "allow", tool: "Bash", summary: "npm test", reason: "tests inside the project" }))];
  for (const e of [...demoRunList.flatMap((r) => r.events), ...extra]) logSeen(e);
  evlog.sort((a, b) => a.ts - b.ts);
  if (awaySince > now - 150 * m) { awaySince = now - 150 * m; awayFirst = false; }
  terms = [...terms.filter((t) => !t.demo), ...demoList];
  termsLoaded = true; termsError = "";
  renderPlanets(); renderInbox(); renderAway(); loadCost(); dirty = true;
  if (viewNow === "runs") renderRuns();
  toast("Demo: simulated sessions, runs and spend");
}
// answering a demo prompt: it carries on (or stops, if you said no)
function demoAnswer(p, opt) {
  const d = demoList.find((x) => x.id === p.id); if (!d) return;
  const no = /^no\b/i.test(opt?.label || "");
  Object.assign(d, { status: no ? "ready" : "working", choices: undefined, awaiting_permission: false, idle_seconds: 0 });
  terms = [...terms.filter((t) => !t.demo), ...demoList];
  renderPlanets(); renderInbox();
}
