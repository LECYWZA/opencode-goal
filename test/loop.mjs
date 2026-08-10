import def from "../dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function deferred() {
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}

const activePrompts = {}; // sessionID -> deferred
const input = {
  client: {
    session: {
      prompt: async (opts) => {
        const sid = opts.path.id;
        const d = deferred();
        activePrompts[sid] = d;
        return d.p;
      },
      abort: async () => {},
    },
  },
};

async function startEnter(hooks, sessionID) {
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
  for (let i = 0; i < 60; i++) {
    if (activePrompts[sessionID]) return true;
    await sleep(5);
  }
  return false;
}

const hooks = await def(input, {
  mode: "goal", max_auto_turns: -1, max_tool_loop: 3, max_repeats: 3,
  thinking_stall_s: 0, turn_timeout_s: 600, idle_interval_ms: 2,
  recovery: "auto-research", recovery_attempts: 6, persist: false, debug: false,
});

const ctxL = { sessionID: "L1", worktree: "/L", directory: "/L", agent: "build", messageID: "m1" };
const ctxR = { sessionID: "L2", worktree: "/R", directory: "/R", agent: "build", messageID: "m2" };

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else fail++; console.log(`${c ? "PASS" : "FAIL"} ${n}`); };

// --- tool-loop (L1) ---
await hooks.tool.goal_set.execute({ goal: "loop test", mode: "goal" }, ctxL);
check("L1 entered running", (await startEnter(hooks, "L1")) === true);
for (let i = 0; i < 3; i++) {
  await hooks["tool.execute.before"]({ sessionID: "L1", tool: "bash" }, { args: { command: "echo x" }, title: "", output: "", metadata: {} });
}
await sleep(40); // let abort + handleTurnEnd microtasks settle
const stL = JSON.parse(await hooks.tool.goal_status.execute({}, ctxL));
check("L1 tool-loop lastEnd=loop", stL.lastEnd === "loop");
check("L1 noProgressTurns>=1 (not progress)", stL.noProgressTurns >= 1);

// --- repeat-output (L2) ---
await hooks.tool.goal_set.execute({ goal: "repeat test", mode: "goal" }, ctxR);
check("L2 entered running", (await startEnter(hooks, "L2")) === true);
for (let i = 0; i < 8; i++) {
  await hooks.event({ event: { type: "message.part.updated", properties: { sessionID: "L2", delta: "same-token-" } } });
}
const stR = JSON.parse(await hooks.tool.goal_status.execute({}, ctxR));
check("L2 repeat-output lastEnd=loop", stR.lastEnd === "loop");

// --- overview tool presence ---
check("goal_overview tool exists", !!hooks.tool.goal_overview);

console.log(`\nRESULT loop-detect  pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
