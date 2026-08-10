import type { Plugin } from "@opencode-ai/plugin";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/* ------------------------------------------------------------------ *
 *  opencode-goal-run
 *  Goal mode + infinite iterate mode with robust auto-continue.
 *
 *  Design goals (learning from the old plugin's freeze bug):
 *   - SINGLE-FLIGHT: only one "continue" in flight per session.
 *   - EVENT-DRIVEN, self-chaining loop gated by single-flight + debounce,
 *     so multiple triggers (idle + own completion) can never storm.
 *   - MULTI-ROUTE BRAKES: no-progress / turn-timeout / max-turns /
 *     explicit completion / pause / abort / manual interrupt.
 *   - EXPLICIT CREDENTIALS for completion (model must call goal_mark_done
 *     with evidence) — never silently stop.
 *   - NO blocking work inside event callbacks (schedule via setTimeout),
 *     to avoid freezing on Windows.
 *   - PER-RUN CONFIG: global options are DEFAULTS only; each goal can
 *     carry overrides set at launch time (goal_set / goal_configure) so
 *     the user never has to edit config to change agents/limits.
 * ------------------------------------------------------------------ */

type Mode = "goal" | "iterate" | "off";

interface Options {
  mode: Mode;
  max_parallel_agents: number;
  max_auto_turns: number; // -1 = infinite
  turn_timeout_s: number;
  no_progress_turns: number;
  converge_turns: number;
  idle_interval_ms: number;
  persist: boolean;
  state_file: string;
  complete_credential: boolean;
  human_gate: boolean;
  command_keyword: string;
  debug: boolean;
}

interface RunOverrides {
  max_parallel_agents?: number;
  max_auto_turns?: number;
  no_progress_turns?: number;
  converge_turns?: number;
  turn_timeout_s?: number;
  idle_interval_ms?: number;
}

interface EffectiveRunConfig {
  mode: Exclude<Mode, "off">;
  max_parallel_agents: number;
  max_auto_turns: number;
  no_progress_turns: number;
  converge_turns: number;
  turn_timeout_s: number;
  idle_interval_ms: number;
}

function defaultOptions(raw: Record<string, unknown> | undefined): Options {
  const home = os.homedir();
  const mkPath = (p: unknown, def: string) =>
    typeof p === "string" && p.length > 0 ? p : def;
  return {
    mode: (raw?.mode as Mode) ?? "goal",
    max_parallel_agents: num(raw?.max_parallel_agents, 1),
    max_auto_turns: num(raw?.max_auto_turns, -1),
    turn_timeout_s: num(raw?.turn_timeout_s, 300),
    no_progress_turns: num(raw?.no_progress_turns, 10),
    converge_turns: num(raw?.converge_turns, 5),
    idle_interval_ms: num(raw?.idle_interval_ms, 2000),
    persist: raw?.persist !== false,
    state_file: mkPath(raw?.state_file, path.join(home, ".config", "opencode", "goal-run-state.json")),
    complete_credential: raw?.complete_credential !== false,
    human_gate: raw?.human_gate !== false,
    command_keyword: typeof raw?.command_keyword === "string" ? raw.command_keyword : "继续",
    debug: raw?.debug === true,
  };
}

function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/* ------------------------------------------------------------------ *
 *  State
 * ------------------------------------------------------------------ */

interface GoalState {
  sessionID: string;
  worktree: string;
  directory: string;
  mode: Exclude<Mode, "off">;
  objective: string;
  startedAt: number;
  completed: boolean;
  completedReason?: string;
  paused: boolean;
  pausedReason?: string;
  turns: number;
  lastActivityAt: number;
  noProgressTurns: number;
  progressLog: string[];
  lastNote?: string;
  overrides?: RunOverrides;
}

interface Runtime {
  state: GoalState;
  running: boolean; // single-flight
  continuePending: boolean; // a continue is scheduled/queued
  timer: ReturnType<typeof setTimeout> | null;
  turnStart: number;
  activity: number; // work-tool executions this turn
  progressedThisCycle: boolean;
}

type Persisted = Record<string, GoalState>;

/* ------------------------------------------------------------------ *
 *  Store (persistence)
 * ------------------------------------------------------------------ */

class Store {
  private file: string;
  private cache: Persisted = {};

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") this.cache = parsed;
      }
    } catch (e) {
      this.cache = {};
    }
  }

  saveDebounced: ReturnType<typeof setTimeout> | null = null;

  set(key: string, state: GoalState) {
    this.cache[key] = state;
    this.queueSave();
  }

  remove(key: string) {
    delete this.cache[key];
    this.queueSave();
  }

  get(key: string): GoalState | undefined {
    return this.cache[key];
  }

  all(): Array<GoalState> {
    return Object.values(this.cache);
  }

  private queueSave() {
    if (!this.saveDebounced) {
      this.saveDebounced = setTimeout(() => {
        this.saveDebounced = null;
        this.flush();
      }, 500);
    }
  }

  flush() {
    try {
      if (!fs.existsSync(path.dirname(this.file))) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
      }
      fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2), "utf8");
    } catch (e) {
      /* best-effort */
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Plugin
 * ------------------------------------------------------------------ */

export default (async function plugin(input, rawOptions) {
  const { client } = input;
  const options = defaultOptions(rawOptions as Record<string, unknown> | undefined);
  const store = new Store(options.state_file);
  const runtimes = new Map<string, Runtime>();
  const log = (...args: unknown[]) => {
    if (options.debug) console.log("[goal-run]", ...args);
  };

  function getRuntime(sessionID: string): Runtime | undefined {
    return runtimes.get(sessionID);
  }

  function createRuntime(state: GoalState): Runtime {
    const rt: Runtime = {
      state,
      running: false,
      continuePending: false,
      timer: null,
      turnStart: 0,
      activity: 0,
      progressedThisCycle: false,
    };
    runtimes.set(state.sessionID, rt);
    return rt;
  }

  /* merge per-run overrides over global defaults */
  function effConfig(rt: Runtime): EffectiveRunConfig {
    const o = rt.state.overrides ?? {};
    return {
      mode: rt.state.mode,
      max_parallel_agents: o.max_parallel_agents ?? options.max_parallel_agents,
      max_auto_turns: o.max_auto_turns ?? options.max_auto_turns,
      no_progress_turns: o.no_progress_turns ?? options.no_progress_turns,
      converge_turns: o.converge_turns ?? options.converge_turns,
      turn_timeout_s: o.turn_timeout_s ?? options.turn_timeout_s,
      idle_interval_ms: o.idle_interval_ms ?? options.idle_interval_ms,
    };
  }

  /* ---------- system prompt injection ---------- */
  function rulesBlock(rt: Runtime): string[] {
    const s = rt.state;
    const eff = effConfig(rt);
    const maxAgents = eff.max_parallel_agents;
    const block: string[] = [];
    block.push(
      `[goal-run] Active objective engine (mode=${s.mode}). Current objective: ${s.objective}` +
        (s.completed ? ` (marked complete: ${s.completedReason ?? "n/a"})` : "") +
        (s.paused ? ` (PAUSED: ${s.pausedReason})` : "") +
        `.`
    );
    if (s.mode === "goal") {
      block.push(
        `[goal-run] You are in GOAL mode. Work autonomously toward the objective in rounds. ` +
          `You may launch at most ${maxAgents} concurrent subagent (task) call(s) per message; if you would need more, run them sequentially. ` +
          `Each round, if you did work, call goal_progress(note=...) to log it. ` +
          `When the objective is fully achieved, call goal_mark_done(evidence=..., verification=...) to stop. ` +
          `Do NOT stop without calling goal_mark_done. If stuck with no way to progress for several rounds, call goal_pause(reason=...) instead.`
      );
    } else {
      block.push(
        `[goal-run] You are in ITERATE (self-improvement) mode. Loop repeatedly to make the outcome better and better. ` +
          `Each round you MUST: (1) implement/advance the work, (2) self-test / run checks, (3) assess gaps and identify concrete improvements, ` +
          `(4) call goal_progress(note=<what you improved this round>) to log the increment, (5) the engine continues automatically. ` +
          `You may launch at most ${maxAgents} concurrent subagent (task) call(s) per message. ` +
          `Only stop improving when you genuinely cannot make further meaningful progress (after several rounds of no improvement), and call goal_mark_done(evidence=..., verification=...).`
      );
    }
    block.push(
      `[goal-run] Completion rule: you may only stop the loop by calling goal_mark_done with concrete, verifiable evidence. ` +
        `To pause/temporarily stop use goal_pause. To change per-run parameters at any time use goal_configure. To query state use goal_status. To extend an already-completed objective, call goal_continue(extra=...).`
    );
    return block;
  }

  /* ---------- brakes ---------- */
  function brakeReason(rt: Runtime): string | undefined {
    const s = rt.state;
    if (s.completed) return undefined; // handled elsewhere
    if (s.paused) return undefined;
    const eff = effConfig(rt);
    const brakeTurns = eff.mode === "iterate" ? eff.converge_turns : eff.no_progress_turns;
    if (s.noProgressTurns >= brakeTurns) {
      return `no meaningful progress for ${s.noProgressTurns} consecutive rounds (threshold ${brakeTurns}).`;
    }
    if (eff.max_auto_turns >= 0 && s.turns >= eff.max_auto_turns) {
      return `reached configured max_auto_turns (${eff.max_auto_turns}).`;
    }
    if (rt.running && eff.turn_timeout_s > 0 && Date.now() - rt.turnStart > eff.turn_timeout_s * 1000) {
      return `turn exceeded ${eff.turn_timeout_s}s timeout.`;
    }
    return undefined;
  }

  function pause(rt: Runtime, reason: string) {
    rt.state.paused = true;
    rt.state.pausedReason = reason;
    if (rt.timer) clearTimeout(rt.timer);
    rt.timer = null;
    rt.continuePending = false;
    persist(rt);
  }

  /* ---------- persistence sync ---------- */
  function persist(rt: Runtime) {
    if (options.persist) store.set(rt.state.sessionID, { ...rt.state });
  }

  /* ---------- continue scheduling (single-flight + debounce) ---------- */
  function scheduleContinue(sessionID: string) {
    const rt = getRuntime(sessionID);
    if (!rt) return;
    const s = rt.state;
    if (s.completed || s.paused) return;
    if (rt.running || rt.continuePending) return; // single-flight + no storm
    const eff = effConfig(rt);
    rt.continuePending = true;
    rt.timer = setTimeout(() => {
      rt.timer = null;
      rt.continuePending = false;
      void doContinue(rt);
    }, eff.idle_interval_ms);
  }

  function continueText(rt: Runtime): string {
    const s = rt.state;
    if (s.mode === "iterate") {
      return (
        `[goal-run] Round ${s.turns + 1}. Continue the improvement loop on: ${s.objective}. ` +
        `Implement, self-test, find improvements, then call goal_progress(note=...) to log this round's increment. ` +
        `When truly done, call goal_mark_done(evidence=..., verification=...).`
      );
    }
    return (
      `[goal-run] Round ${s.turns + 1}. Continue working toward the objective: ${s.objective}. ` +
      `Do useful work with tools each round. Call goal_progress(note=...) if you made progress. ` +
      `When the objective is fully achieved, call goal_mark_done(evidence=..., verification=...).`
    );
  }

  async function doContinue(rt: Runtime) {
    if (rt.running) return;
    rt.state.turns += 1;
    rt.turnStart = Date.now();
    rt.activity = 0;
    rt.progressedThisCycle = false;
    rt.running = true;
    try {
      const result = await client.session.prompt({
        path: { id: rt.state.sessionID },
        body: { parts: [{ type: "text", text: continueText(rt) }] },
      });
      void result;
    } catch (e) {
      log("prompt error", e);
    } finally {
      rt.running = false;
      if (rt.progressedThisCycle || rt.activity > 0) {
        rt.state.noProgressTurns = 0;
        rt.state.lastActivityAt = Date.now();
      } else {
        rt.state.noProgressTurns += 1;
        log("no progress in turn", rt.state.turns, "count", rt.state.noProgressTurns);
      }
      persist(rt);

      const brake = brakeReason(rt);
      if (brake) {
        pause(rt, brake);
      } else if (rt.state.completed || rt.state.paused) {
        // stop
      } else {
        scheduleContinue(rt.state.sessionID);
      }
    }
  }

  /* ---------- event hook ---------- */
  async function onEvent({ event }: { event: any }) {
    try {
      if (!event || !event.type) return;
      if (event.type === "session.idle") {
        const sessionID = event.properties?.sessionID as string;
        const rt = getRuntime(sessionID);
        if (!rt) return;
        scheduleContinue(sessionID);
      }
    } catch (e) {
      log("event error", e);
    }
  }

  /* ---------- tools ---------- */
  function ensureRt(
    sessionID: string,
    worktree: string,
    directory: string,
    mode: Exclude<Mode, "off">,
    objective: string
  ): Runtime {
    let rt = getRuntime(sessionID);
    if (rt) {
      rt.state.mode = mode;
      rt.state.objective = objective;
      rt.state.paused = false;
      rt.state.completed = false;
      rt.state.pausedReason = undefined;
      rt.state.completedReason = undefined;
      rt.state.turns = 0;
      rt.state.noProgressTurns = 0;
      rt.state.progressLog = [];
      return rt;
    }
    const state: GoalState = {
      sessionID,
      worktree,
      directory,
      mode,
      objective,
      startedAt: Date.now(),
      completed: false,
      paused: false,
      turns: 0,
      lastActivityAt: Date.now(),
      noProgressTurns: 0,
      progressLog: [],
    };
    rt = createRuntime(state);
    persist(rt);
    return rt;
  }

  const tools = {
    goal_set: {
      description: `Start or overwrite an autonomous objective. Use when the user wants the AI to keep working by itself until done. Requires goal. Optionally set per-run parameters here (they override global defaults for THIS task only). Available per-run params: agent (concurrent subagents), max_turns (-1=infinite), no_progress_turns, converge_turns, turn_timeout_s, idle_interval_ms.`,
      args: {
        goal: z.string().describe("The concrete objective to pursue autonomously."),
        mode: z.enum(["goal", "iterate"]).optional().describe('"goal" = run until complete; "iterate" = keep improving until convergence.'),
        agent: z.number().int().positive().optional().describe("Max concurrent subagent(task) calls for this task."),
        max_turns: z.number().int().optional().describe("Auto-run turn cap, -1 = unlimited."),
        no_progress_turns: z.number().int().positive().optional().describe("Goal mode: pause after this many consecutive no-progress rounds."),
        converge_turns: z.number().int().positive().optional().describe("Iterate mode: pause after this many consecutive no-improvement rounds."),
        turn_timeout_s: z.number().positive().optional().describe("Per-turn timeout in seconds."),
        idle_interval_ms: z.number().positive().optional().describe("Minimum interval between auto-continues (ms)."),
      },
      execute: async (args: any, ctx: any) => {
        const mode: Exclude<Mode, "off"> = args.mode === "iterate" ? "iterate" : "goal";
        const rt = ensureRt(ctx.sessionID, ctx.worktree, ctx.directory, mode, args.goal);
        if (!rt.state.overrides) rt.state.overrides = {};
        if (args.agent !== undefined) rt.state.overrides.max_parallel_agents = args.agent;
        if (args.max_turns !== undefined) rt.state.overrides.max_auto_turns = args.max_turns;
        if (args.no_progress_turns !== undefined) rt.state.overrides.no_progress_turns = args.no_progress_turns;
        if (args.converge_turns !== undefined) rt.state.overrides.converge_turns = args.converge_turns;
        if (args.turn_timeout_s !== undefined) rt.state.overrides.turn_timeout_s = args.turn_timeout_s;
        if (args.idle_interval_ms !== undefined) rt.state.overrides.idle_interval_ms = args.idle_interval_ms;
        persist(rt);
        const eff = effConfig(rt);
        return (
          `Objective engine ${mode === "iterate" ? "ITERATE" : "GOAL"} started. Objective: ${args.goal}.\n` +
          `Per-run config (effective): agent=${eff.max_parallel_agents}, max_turns=${eff.max_auto_turns}, ` +
          `no_progress_turns=${eff.no_progress_turns}, converge_turns=${eff.converge_turns}, ` +
          `turn_timeout_s=${eff.turn_timeout_s}, idle_interval_ms=${eff.idle_interval_ms}.\n` +
          `The engine will keep running automatically. Log progress with goal_progress; finish with goal_mark_done; change params anytime with goal_configure.`
        );
      },
    },

    goal_configure: {
      description: `Change per-run parameters of the active objective at any time (does NOT reset progress). Supported: agent, max_turns, no_progress_turns, converge_turns, turn_timeout_s, idle_interval_ms.`,
      args: {
        agent: z.number().int().positive().optional(),
        max_turns: z.number().int().optional(),
        no_progress_turns: z.number().int().positive().optional(),
        converge_turns: z.number().int().positive().optional(),
        turn_timeout_s: z.number().positive().optional(),
        idle_interval_ms: z.number().positive().optional(),
      },
      execute: async (args: any, ctx: any) => {
        const rt = getRuntime(ctx.sessionID);
        if (!rt) return "No active objective; call goal_set first.";
        if (!rt.state.overrides) rt.state.overrides = {};
        if (args.agent !== undefined) rt.state.overrides.max_parallel_agents = args.agent;
        if (args.max_turns !== undefined) rt.state.overrides.max_auto_turns = args.max_turns;
        if (args.no_progress_turns !== undefined) rt.state.overrides.no_progress_turns = args.no_progress_turns;
        if (args.converge_turns !== undefined) rt.state.overrides.converge_turns = args.converge_turns;
        if (args.turn_timeout_s !== undefined) rt.state.overrides.turn_timeout_s = args.turn_timeout_s;
        if (args.idle_interval_ms !== undefined) rt.state.overrides.idle_interval_ms = args.idle_interval_ms;
        persist(rt);
        const eff = effConfig(rt);
        return (
          `Per-run config updated. Effective: agent=${eff.max_parallel_agents}, max_turns=${eff.max_auto_turns}, ` +
          `no_progress_turns=${eff.no_progress_turns}, converge_turns=${eff.converge_turns}, ` +
          `turn_timeout_s=${eff.turn_timeout_s}, idle_interval_ms=${eff.idle_interval_ms}.`
        );
      },
    },

    goal_progress: {
      description: `Log progress / an improvement increment for the current objective, and signal the engine to keep going (resets the no-progress counter).`,
      args: {
        note: z.string().describe("What was accomplished or improved this round (concrete)."),
        improved: z.boolean().optional().describe("For iterate mode: true if this round produced a real improvement."),
      },
      execute: async (args: any, ctx: any) => {
        const rt = getRuntime(ctx.sessionID);
        if (!rt) return "No active objective; call goal_set first.";
        rt.state.noProgressTurns = 0;
        rt.state.lastActivityAt = Date.now();
        rt.state.lastNote = args.note;
        rt.state.progressLog.push(`[r${rt.state.turns}] ${args.note}`);
        if (rt.progressedThisCycle === false) rt.progressedThisCycle = true;
        rt.activity += 1;
        persist(rt);
        return `Progress logged (improved=${args.improved === true}). Keep going.`;
      },
    },

    goal_mark_done: {
      description: `Declare the objective complete and STOP the automatic loop. Provide concrete, verifiable evidence. Only call when truly finished.`,
      args: {
        evidence: z.string().describe("Concrete evidence the goal is met (e.g. tests pass, files produced, concrete result)."),
        verification: z.string().optional().describe("How the result was verified (e.g. 'npm test passes', 'curl returns 200')."),
      },
      execute: async (args: any, ctx: any) => {
        const rt = getRuntime(ctx.sessionID);
        if (!rt) return "No active objective; call goal_set first.";
        if (rt.state.completed) return "Already completed.";
        rt.state.completed = true;
        rt.state.completedReason = `${args.evidence}${args.verification ? ` [verified: ${args.verification}]` : ""}`;
        rt.state.paused = false;
        if (rt.timer) clearTimeout(rt.timer);
        rt.timer = null;
        rt.continuePending = false;
        persist(rt);
        let reply = `Objective marked COMPLETE. Evidence: ${args.evidence}`;
        if (args.verification) reply += ` | Verified: ${args.verification}`;
        reply += `. The loop has stopped.`;
        if (options.human_gate) {
          reply += ` Reply "${options.command_keyword}" for the model to deepen/extend it via goal_continue, or start something new with goal_set.`;
        }
        return reply;
      },
    },

    goal_continue: {
      description: `Resume the loop after a completed objective (deepen/extend it), optionally with a new/refined objective.`,
      args: {
        objective: z.string().optional().describe("Optional new or refined objective to pursue."),
      },
      execute: async (args: any, ctx: any) => {
        let rt = getRuntime(ctx.sessionID);
        if (!rt) return "No active objective; call goal_set first.";
        if (args.objective) rt.state.objective = args.objective;
        rt.state.completed = false;
        rt.state.completedReason = undefined;
        rt.state.paused = false;
        rt.state.pausedReason = undefined;
        rt.state.turns = 0;
        rt.state.noProgressTurns = 0;
        persist(rt);
        scheduleContinue(ctx.sessionID);
        return `Loop resumed. Continuing: ${rt.state.objective}`;
      },
    },

    goal_pause: {
      description: `Pause the automatic loop now (keep state; resume later with goal_resume). Use if you are genuinely stuck and cannot progress.`,
      args: {
        reason: z.string().describe("Why you are pausing."),
      },
      execute: async (args: any, ctx: any) => {
        const rt = getRuntime(ctx.sessionID);
        if (!rt) return "No active objective.";
        pause(rt, args.reason);
        return `Loop PAUSED: ${args.reason}. Resume with goal_resume.`;
      },
    },

    goal_resume: {
      description: `Resume the automatic loop for a paused objective.`,
      args: {
        objective: z.string().optional().describe("Optional new objective to override."),
      },
      execute: async (args: any, ctx: any) => {
        const rt = getRuntime(ctx.sessionID);
        if (!rt) return "No paused objective.";
        if (args.objective) rt.state.objective = args.objective;
        rt.state.paused = false;
        rt.state.pausedReason = undefined;
        rt.state.completed = false;
        rt.state.noProgressTurns = 0;
        persist(rt);
        scheduleContinue(ctx.sessionID);
        return `Loop resumed: ${rt.state.objective}`;
      },
    },

    goal_status: {
      description: `Return the current goal-run engine status (including effective config) for this session.`,
      args: {},
      execute: async (_args: any, ctx: any) => {
        const rt = getRuntime(ctx.sessionID);
        if (!rt) return "No active objective in this session.";
        const s = rt.state;
        const eff = effConfig(rt);
        const brake = brakeReason(rt);
        return JSON.stringify(
          {
            mode: s.mode,
            objective: s.objective,
            completed: s.completed,
            paused: s.paused,
            pausedReason: s.pausedReason,
            completedReason: s.completedReason,
            turns: s.turns,
            noProgressTurns: s.noProgressTurns,
            brakeActive: !!brake,
            progressLog: s.progressLog,
            effectiveConfig: eff,
          },
          null,
          2
        );
      },
    },

    goal_abort: {
      description: `Abort and clear the active goal in this session (engine stops, state removed).`,
      args: {},
      execute: async (_args: any, ctx: any) => {
        const rt = getRuntime(ctx.sessionID);
        if (!rt) return "No active objective.";
        if (rt.timer) clearTimeout(rt.timer);
        runtimes.delete(ctx.sessionID);
        if (options.persist) store.remove(ctx.sessionID);
        return "Objective aborted and cleared.";
      },
    },

    goal_list_incomplete: {
      description: `List persisted incomplete (paused / not-completed) objectives across sessions, for cross-restart resume.`,
      args: {},
      execute: async () => {
        const recs = store
          .all()
          .filter((s) => !s.completed)
          .map((s) => ({
            objective: s.objective,
            mode: s.mode,
            worktree: s.worktree,
            turns: s.turns,
            progressLog: s.progressLog.slice(-5),
            paused: s.paused,
            pausedReason: s.pausedReason,
            effectiveConfig: s.overrides,
          }));
        if (recs.length === 0) return "No incomplete persisted objectives.";
        return JSON.stringify(recs, null, 2);
      },
    },
  };

  /* ---------- hooks ---------- */
  return {
    event: onEvent,

    tool: tools as any,

    "tool.execute.before": async ({ sessionID, tool: t }: any, output: any) => {
      void output;
      const rt = sessionID ? getRuntime(sessionID) : undefined;
      if (rt && rt.running) rt.activity += 1;
    },

    "experimental.chat.system.transform": async (input: any, output: any) => {
      const rt = input?.sessionID ? getRuntime(input.sessionID) : undefined;
      if (rt) {
        output.system = [...(output.system ?? []), ...rulesBlock(rt)];
      }
    },
  };
}) satisfies Plugin;
