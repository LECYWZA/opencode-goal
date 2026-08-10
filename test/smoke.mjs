import def from "../dist/index.js";

let promptCalls = 0;
const input = {
  client: {
    session: {
      prompt: async () => {
        promptCalls++;
        return { info: { id: "m" }, parts: [] };
      },
      abort: async () => {},
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hooks = await def(input, {
  mode: "goal",
  max_parallel_agents: 1,
  max_auto_turns: -1,
  idle_interval_ms: 3,
  no_progress_turns: 2,
  turn_timeout_s: 60,
  recovery: "pause",
  persist: false,
  debug: false,
});

const ctx = { sessionID: "s1", worktree: "/w", directory: "/d", agent: "build", messageID: "m1" };
const ctx2 = { sessionID: "s2", worktree: "/w2", directory: "/d2", agent: "build", messageID: "m2" };
const tools = hooks.tool;

console.log("hooks keys:", Object.keys(hooks).join(", "));
console.log("has goal_research:", !!tools.goal_research);

// s1: pause-mode brake (old behavior kept)
await tools.goal_set.execute({ goal: "build X", mode: "goal" }, ctx);
for (let i = 0; i < 3; i++) {
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  await sleep(15);
}
let st = JSON.parse(await tools.goal_status.execute({}, ctx));
console.log("s1 paused(recovery=pause):", st.paused, "|", st.pausedReason, "| turns:", st.turns);

// s2: auto-research recovery (DOES NOT stop on no-progress, continues then pauses after attempts)
const hooks2 = await def(input, {
  mode: "goal",
  max_parallel_agents: 1,
  max_auto_turns: -1,
  idle_interval_ms: 3,
  no_progress_turns: 1,
  turn_timeout_s: 60,
  recovery: "auto-research",
  recovery_attempts: 2,
  persist: false,
  debug: false,
});
const t2 = hooks2.tool;
await t2.goal_set.execute({ goal: "no-progress but keep going", mode: "goal" }, ctx2);
const callsBefore = promptCalls;
await hooks2.event({ event: { type: "session.idle", properties: { sessionID: "s2" } } });
await sleep(10);
// engine should still be running recovery rounds (not paused immediately)
let st2 = JSON.parse(await t2.goal_status.execute({}, ctx2));
const callsGrew = promptCalls - callsBefore;
console.log("s2 auto-research: paused now?=", st2.paused, "| new prompt calls so far:", callsGrew);
// wait for recovery attempts to be exhausted -> pause
await sleep(60);
st2 = JSON.parse(await t2.goal_status.execute({}, ctx2));
console.log("s2 after attempts exhausted -> paused:", st2.paused, "|", st2.pausedReason, "| recoveryCounter:", st2.recoveryCounter);

// s3: overrides + goal_configure
const ctx3 = { sessionID: "s3", worktree: "/w3", directory: "/d3", agent: "build", messageID: "m3" };
await tools.goal_set.execute({ goal: "overridable", mode: "goal", agent: 3, max_turns: -1 }, ctx3);
let st3 = JSON.parse(await tools.goal_status.execute({}, ctx3));
console.log("s3 eff agent:", st3.effectiveConfig.max_parallel_agents, "max_turns:", st3.effectiveConfig.max_auto_turns);
await tools.goal_configure.execute({ agent: 5, recovery: "continue" }, ctx3);
st3 = JSON.parse(await tools.goal_status.execute({}, ctx3));
console.log("s3 after configure agent:", st3.effectiveConfig.max_parallel_agents, "recovery:", st3.effectiveConfig.recovery);

// s4: complete stops loop
await tools.goal_resume.execute({}, ctx);
await tools.goal_progress.execute({ note: "done core", improved: true }, ctx);
console.log(await tools.goal_mark_done.execute({ evidence: "tests green", verification: "npm test" }, ctx));
const before = promptCalls;
await sleep(30);
console.log("s1 no increase after complete:", promptCalls === before);

console.log("\nSMOKE OK");
process.exit(0);
