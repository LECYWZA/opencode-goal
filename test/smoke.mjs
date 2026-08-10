import def from "../dist/index.js";

let promptCalls = 0;
const input = {
  client: {
    session: {
      prompt: async () => { promptCalls++; return { info: { id: "m" }, parts: [] }; },
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hooks = await def(input, {
  mode: "goal",
  max_parallel_agents: 1,
  max_auto_turns: -1,
  idle_interval_ms: 5,
  no_progress_turns: 2,
  persist: false,
  debug: true,
});

const ctx = { sessionID: "s1", worktree: "/w", directory: "/d", agent: "build", messageID: "m1" };
const tools = hooks.tool;

console.log("hooks keys:", Object.keys(hooks).join(", "));

// 1. start
console.log("--- goal_set ---");
const r1 = await tools.goal_set.execute({ goal: "build X, test it, improve", mode: "goal" }, ctx);
console.log(r1);

// 2. simulate session going idle (validation that engine auto-runs loop)
console.log("--- fire idle x3 (should not storm due to single-flight) ---");
for (let i = 0; i < 3; i++) {
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  await sleep(20);
}
const afterIdle = promptCalls;
console.log("prompt calls after 3 idle + wait:", afterIdle);

// 3. no-progress brake test: wait enough rounds that no-progress counter trips
await sleep(60);
console.log("--- status after no progress ---");
console.log(await tools.goal_status.execute({}, ctx));

// confirmed paused due to no progress? check via status again
const st1 = JSON.parse(await tools.goal_status.execute({}, ctx));
console.log("paused:", st1.paused, st1.pausedReason);

// 4. resume then complete
console.log("--- goal_resume then goal_progress then goal_mark_done ---");
await tools.goal_resume.execute({}, ctx);
await tools.goal_progress.execute({ note: "implemented core; tests pass", improved: true }, ctx);
console.log(await tools.goal_mark_done.execute({ evidence: "all tests green", verification: "npm test" }, ctx));

const before = promptCalls;
await sleep(40);
console.log("prompt calls did NOT increase after completion:", promptCalls === before);

const st2 = JSON.parse(await tools.goal_status.execute({}, ctx));
console.log("completed:", st2.completed, "| turns:", st2.turns, "| brakeActive:", st2.brakeActive);

// 5. system prompt injection
console.log("--- system.transform ---");
const out = { system: [] };
await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, out);
console.log("system injected lines:", out.system.length);

// 6. stop/pause brand-new scenario in another session
const ctx2 = { sessionID: "s2", worktree: "/w2", directory: "/d2", agent: "build", messageID: "m2" };
await tools.goal_set.execute({ goal: "pause me", mode: "iterate" }, ctx2);
await tools.goal_pause.execute({ reason: "blocked on infra" }, ctx2);
const st3 = JSON.parse(await tools.goal_status.execute({}, ctx2));
console.log("s2 paused:", st3.paused, st3.pausedReason);

// 7. per-run overrides + goal_configure
console.log("--- overrides: goal_set with agent=3 max_turns=-1 ---");
const ctx3 = { sessionID: "s3", worktree: "/w3", directory: "/d3", agent: "build", messageID: "m3" };
await tools.goal_set.execute({ goal: "overridable", mode: "goal", agent: 3, max_turns: -1 }, ctx3);
let st4 = JSON.parse(await tools.goal_status.execute({}, ctx3));
console.log("effective agent:", st4.effectiveConfig.max_parallel_agents, "| max_turns:", st4.effectiveConfig.max_auto_turns);

console.log("--- goal_configure(agent=5, converge_turns=2) ---");
await tools.goal_configure.execute({ agent: 5, converge_turns: 2 }, ctx3);
st4 = JSON.parse(await tools.goal_status.execute({}, ctx3));
console.log("after configure agent:", st4.effectiveConfig.max_parallel_agents, "| converge:", st4.effectiveConfig.converge_turns);

console.log("\nSMOKE OK");
process.exit(0);
