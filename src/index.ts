import type { Plugin } from "@opencode-ai/plugin";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/* ------------------------------------------------------------------ *
 *  opencode-goal-run v3
 *  Goal mode + infinite iterate mode with robust auto-continue and
 *  SELF-EVOLVING recovery.
 *
 *  Philosophy (v3): instead of freezing or stopping on setbacks, the
 *  engine DIAGNOSES why there is no progress, RESEARCHES (Bing / GitHub
 *  / HuggingFace), changes strategy and keeps going. It only stops when
 *  a verifiable completion is produced, or the user asks, or a recovery
 *  attempt cap is exhausted (configurable), or the user-chosen max
 *  turn cap is reached.
 *
 *  Safety / anti-freeze (unchanged from v1/v2):
 *   - SINGLE-FLIGHT: one continue in flight per session.
 *   - EVENT-DRIVEN loop gated by single-flight + debounce (no storms).
 *   - NO blocking work in event callbacks (setTimeout scheduling).
 *   - Use Promise.race + abort so a hung turn can NEVER freeze our loop.
 *
 *  Activeness watchdog (v3): a turn "times out" only when the model is
 *  COMPLETELY SILENT for turn_timeout_s (no tokens emitted, no tool
 *  activity) — talking/working never counts as timeout.
 * ------------------------------------------------------------------ */

type Mode = "goal" | "iterate" | "off";
type Recovery = "auto-research" | "pause" | "continue";

interface Options {
  mode: Mode;
  max_parallel_agents: number;
  max_auto_turns: number; // -1 = infinite
  turn_timeout_s: number; // "silence" timeout (active-timeout), not wall-clock
  no_progress_turns: number;
  converge_turns: number;
  idle_interval_ms: number;
  recovery: Recovery;
  recovery_attempts: number;
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
  recovery?: Recovery;
  recovery_attempts?: number;
}

interface EffectiveRunConfig {
  mode: Exclude<Mode, "off">;
  max_parallel_agents: number;
  max_auto_turns: number;
  no_progress_turns: number;
  converge_turns: number;
  turn_timeout_s: number;
  idle_interval_ms: number;
  recovery: Recovery;
  recovery_attempts: number;
}

type TurnEnd = "ok" | "no-progress" | "timeout";

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
    recovery: (raw?.recovery as Recovery) ?? "auto-research",
    recovery_attempts: num(raw?.recovery_attempts, 4),
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
  continuePending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  watchdog: ReturnType<typeof setInterval> | null;
  turnStart: number;
  lastActivity: number;
  activity: number;
  progressedThisCycle: boolean;
  timeoutHit: boolean;
  winnerResolver: (() => void) | null;
  lastEnd: TurnEnd;
  recoveryCounter: number;
}

type Persisted = Record<string, GoalState>;

/* ------------------------------------------------------------------ *
 *  Store
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
        const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
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
 *  Research helper (aggregate Bing / GitHub / HuggingFace)
 * ------------------------------------------------------------------ */

async function fetchText(url: string, timeoutMs = 9000): Promise<string> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: c.signal, headers: { "User-Agent": "goal-run" } });
    if (!res.ok) return "";
    return await res.text();
  } catch (e) {
    return "";
  } finally {
    clearTimeout(t);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* Multi-engine research: Bing, Google, DuckDuckGo, GitHub, HuggingFace,
 * Stack Overflow. Returns {text, reachable} where reachable is the number
 * of engines that returned usable results — 0 means nothing reachable. */
interface ResearchResult {
  text: string;
  reachable: number;
}

async function research(query: string): Promise<ResearchResult> {
  const q = encodeURIComponent(query);
  const out: string[] = [`Research: ${query}`];
  const reachable = { n: 0 };

  async function run(name: string, fn: () => Promise<string[]>): Promise<void> {
    try {
      const rows = await fn();
      if (rows.length) {
        reachable.n += 1;
        out.push(`## ${name}`);
        out.push(...rows.slice(0, 5));
      }
    } catch (e) {
      /* engine failed, ignore */
    }
  }

  // 1) Bing web search (HTML scrape)
  await run("Bing", async () => {
    const html = await fetchText(`https://www.bing.com/search?q=${q}`);
    const re = /<li class="b_algo"[\s\S]*?<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[\s\S]*?>([\s\S]*?)<\/p>/gi;
    const res: string[] = [];
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(html)) && guard++ < 5) {
      res.push(`- ${stripHtml(m[2]).slice(0, 120)} — ${m[1]} — ${stripHtml(m[3]).slice(0, 240)}`);
    }
    return res;
  });

  // 2) Google web search (HTML scrape)
  await run("Google", async () => {
    const html = await fetchText(`https://www.google.com/search?q=${q}&num=5`);
    const re = /<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<a href="(\/url\?q=[^"]+)"/gi;
    const res: string[] = [];
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(html)) && guard++ < 5) {
      const target = decodeURIComponent(m[2].replace(/^\/url\?q=/, "").split("&")[0]).replace(/^https?:\/\//, "");
      res.push(`- ${stripHtml(m[1]).slice(0, 120)} — ${target}`);
    }
    return res;
  });

  // 3) DuckDuckGo (Lite) — reliable, no API key
  await run("DuckDuckGo", async () => {
    const html = await fetchText(`https://html.duckduckgo.com/html/?q=${q}`);
    const re = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const res: string[] = [];
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(html)) && guard++ < 5) {
      res.push(`- ${stripHtml(m[2]).slice(0, 120)} — ${m[1]} — ${stripHtml(m[3]).slice(0, 240)}`);
    }
    return res;
  });

  // 4) Stack Overflow / StackExchange API (no key)
  await run("StackOverflow", async () => {
    const j = JSON.parse(await fetchText(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${query}&site=stackoverflow&pagesize=5`));
    const items: any[] = Array.isArray(j?.items) ? j.items : [];
    return items.map((it) => `- ${(it.title ?? "").slice(0, 140)} — ${it.link} (answered:${(it.answer_count ?? 0) > 0})`);
  });

  // 5) GitHub repositories
  await run("GitHub", async () => {
    const j = JSON.parse(await fetchText(`https://api.github.com/search/repositories?q=${q}&per_page=5`));
    const items: any[] = Array.isArray(j?.items) ? j.items : [];
    return items.map((it) => `- ${it.full_name} — ${(it.description ?? "").slice(0, 180)} (★${it.stargazers_count})`);
  });

  // 6) HuggingFace models
  await run("HuggingFace", async () => {
    const j = JSON.parse(await fetchText(`https://huggingface.co/api/models?search=${query}&limit=5`));
    const items: any[] = Array.isArray(j) ? j : [];
    return items.map((it) => `- ${it.id} — ${(it.pipeline_tag ?? "")} downloads:${it.downloads ?? "-"}`);
  });

  return { text: out.join("\n").slice(0, 6000), reachable: reachable.n };
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
      watchdog: null,
      turnStart: 0,
      lastActivity: Date.now(),
      activity: 0,
      progressedThisCycle: false,
      timeoutHit: false,
      winnerResolver: null,
      lastEnd: "ok",
      recoveryCounter: 0,
    };
    runtimes.set(state.sessionID, rt);
    return rt;
  }

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
      recovery: o.recovery ?? options.recovery,
      recovery_attempts: o.recovery_attempts ?? options.recovery_attempts,
    };
  }

  /* ---------- system prompt ---------- */
  function rulesBlock(rt: Runtime): string[] {
    const s = rt.state;
    const eff = effConfig(rt);
    const block: string[] = [];
    block.push(
      `[goal-run] Active objective engine (mode=${s.mode}). Objective: ${s.objective}` +
        (s.completed ? ` (COMPLETE: ${s.completedReason ?? "n/a"})` : "") +
        (s.paused ? ` (PAUSED: ${s.pausedReason})` : "") +
        `.`
    );
    block.push(
      `[goal-run] Config: agent<=${eff.max_parallel_agents}/message; turn silence-timeout ${eff.turn_timeout_s}s; max_auto_turns=${eff.max_auto_turns}; recovery=${eff.recovery}(${eff.recovery_attempts} attempts). ` +
        `Rule: only end by calling goal_mark_done with verifiable evidence, OR pause via goal_pause. When you hit a wall (stuck/no progress/no ideas), DO NOT give up: analyze why, use goal_research (Bing/GitHub/HuggingFace) plus web tools to learn, then change strategy and keep going. ` +
        (s.mode === "iterate"
          ? `(iterate) Each round: implement→self-test→find gaps→goal_progress(note=...)→engine auto-continues.`
          : `(goal) Work toward the objective each round; log via goal_progress; finish via goal_mark_done.`)
    );
    block.push(
      `[goal-run] Verification principle (MANDATORY): be SKEPTICAL of search results, docs, and second-hand claims — they are LEADS, not facts. ` +
        `Before adopting any critical conclusion, VERIFY it yourself: run the command, build/test, or open the actual source/docs. ` +
        `If you cannot verify a key assumption, mark it explicitly as "unverified (speculative)" and do not build heavier work on top of it.`
    );
    return block;
  }

  /* ---------- turn text ---------- */
  function buildTurnText(rt: Runtime, eff: EffectiveRunConfig, runs: number): string {
    const s = rt.state;
    let base: string;
    if (s.mode === "iterate") {
      base = `[goal-run] Round ${runs}. Continue improving: ${s.objective}. Implement → self-test → find gaps → call goal_progress(note=...) to log this round's increment. Finish only via goal_mark_done.`;
    } else {
      base = `[goal-run] Round ${runs}. Continue working toward: ${s.objective}. Do real work with tools. Call goal_progress when you make progress. Finish via goal_mark_done (do not stop without it).`;
    }

    if (eff.recovery === "pause") {
      return base;
    }

    if (rt.lastEnd === "timeout") {
      return (
        base +
        `\n[recovery] 上一轮因长时间静默被自动中断(可能命令无限等待或无输出)。本轮请: 先说明你上一轮可能卡在哪(用一句话诊断), 用 goal_research 或网络搜索排查正确做法, 长命令请自行加超时, 然后推进并调用 goal_progress 记录进展。别固步自封, 主动换思路。`
      );
    }
    if (rt.lastEnd === "no-progress") {
      return (
        base +
        `\n[recovery] 上一轮未产生可验证进展。本轮请: (1)冷静分析为何无进展(卡点/缺条件/方法是否错误); (2)用 goal_research(Bing/Google/DuckDuckGo/GitHub/HuggingFace/StackOverflow) 或你自己的网络搜索工具查找相关解法; (3)对搜索结果保持怀疑——基于其给出的新路线，先用最小例子/命令亲自验证方向是否正确，再放大推进，不要盲信搜索摘要; (4)调用 goal_progress 记录结果或说明仍受阻的根本原因。主动进化, 不要重复同样无效的动作。`
      );
    }
    return base;
  }

  /* ---------- completion / brakes / recovery ---------- */
  function handleTurnEnd(rt: Runtime, eff: EffectiveRunConfig) {
    const s = rt.state;

    // call-to-stop: completed or user paused during the turn
    if (s.completed) {
      persist(rt);
      return;
    }
    if (s.paused) {
      persist(rt);
      return;
    }

    const progressed = rt.progressedThisCycle || rt.activity > 0;
    if (progressed) {
      s.noProgressTurns = 0;
      s.lastActivityAt = Date.now();
      rt.recoveryCounter = 0;
      rt.lastEnd = "ok";
    } else {
      s.noProgressTurns += 1;
      rt.lastEnd = rt.timeoutHit ? "timeout" : "no-progress";
    }

    // user-chosen hard cap always stops (pause)
    if (eff.max_auto_turns >= 0 && s.turns >= eff.max_auto_turns) {
      pause(rt, `reached user-chosen max_auto_turns (${eff.max_auto_turns}).`);
      return;
    }

    const brakeTurns = eff.mode === "iterate" ? eff.converge_turns : eff.no_progress_turns;

    if (eff.recovery === "pause") {
      if (s.noProgressTurns >= brakeTurns) {
        pause(rt, `no meaningful progress for ${s.noProgressTurns} rounds (threshold ${brakeTurns}).`);
        return;
      }
      // turn timeout in pause-mode also pauses
      if (rt.lastEnd === "timeout") {
        pause(rt, `a turn was silent for >${eff.turn_timeout_s}s.`);
        return;
      }
      // otherwise continue next round
      scheduleContinue(rt.state.sessionID);
      return;
    }

    // auto-research / continue: do NOT stop on no-progress or timeout,
    // continue into a diagnosis/research round. Only give up after cap.
    if (eff.recovery === "auto-research") {
      const stuck =
        (rt.lastEnd === "no-progress" && s.noProgressTurns >= brakeTurns) ||
        rt.lastEnd === "timeout";
      if (stuck) {
        rt.recoveryCounter += 1;
        log("recovery attempt", rt.recoveryCounter, "of", eff.recovery_attempts);
        if (rt.recoveryCounter > eff.recovery_attempts) {
          pause(rt, `no progress after ${eff.recovery_attempts} recovery/research rounds.`);
          return;
        }
      }
    }
    // "continue" mode: never pause for progress (max_turns / completion only)

    scheduleContinue(rt.state.sessionID);
  }

  function pause(rt: Runtime, reason: string) {
    rt.state.paused = true;
    rt.state.pausedReason = reason;
    if (rt.timer) clearTimeout(rt.timer);
    rt.timer = null;
    rt.continuePending = false;
    stopWatchdog(rt);
    persist(rt);
  }

  function persist(rt: Runtime) {
    if (options.persist) store.set(rt.state.sessionID, { ...rt.state });
  }

  /* ---------- watchdog (silence = activity timeout) ---------- */
  function startWatchdog(rt: Runtime, eff: EffectiveRunConfig) {
    stopWatchdog(rt);
    if (eff.turn_timeout_s <= 0) return;
    rt.watchdog = setInterval(() => {
      if (!rt.running) return;
      if (Date.now() - rt.lastActivity > eff.turn_timeout_s * 1000) {
        rt.timeoutHit = true;
        log("silence timeout; aborting turn", rt.state.sessionID);
        // resolve the winner so doContinue can proceed (control flow never freezes)
        if (rt.winnerResolver) rt.winnerResolver();
        try {
          void client.session.abort({ path: { id: rt.state.sessionID } });
        } catch (e) {
          log("abort error", e);
        }
      }
    }, 1000);
  }

  function stopWatchdog(rt: Runtime) {
    if (rt.watchdog) {
      clearInterval(rt.watchdog);
      rt.watchdog = null;
    }
  }

  /* ---------- scheduling ---------- */
  function scheduleContinue(sessionID: string) {
    const rt = getRuntime(sessionID);
    if (!rt) return;
    const s = rt.state;
    if (s.completed || s.paused) return;
    if (rt.running || rt.continuePending) return; // single-flight
    const eff = effConfig(rt);
    rt.continuePending = true;
    rt.timer = setTimeout(() => {
      rt.timer = null;
      rt.continuePending = false;
      void doContinue(rt);
    }, eff.idle_interval_ms);
  }

  async function doContinue(rt: Runtime) {
    if (rt.running) return;
    const eff = effConfig(rt);
    rt.state.turns += 1;
    rt.turnStart = Date.now();
    rt.lastActivity = Date.now();
    rt.activity = 0;
    rt.progressedThisCycle = false;
    rt.timeoutHit = false;
    rt.running = true;

    const text = buildTurnText(rt, eff, rt.state.turns);
    let winnerResolve: (() => void) | null = null;
    const winner = new Promise<void>((res) => {
      winnerResolve = res;
    });
    rt.winnerResolver = winnerResolve;

    startWatchdog(rt, eff);

    try {
      const result = await Promise.race([
        client.session.prompt({
          path: { id: rt.state.sessionID },
          body: { parts: [{ type: "text", text }] },
        }),
        winner,
      ]);
      void result;
    } catch (e) {
      log("prompt error", e);
    } finally {
      stopWatchdog(rt);
      rt.winnerResolver = null;
      rt.running = false;
      handleTurnEnd(rt, eff);
    }
  }

  /* ---------- events ---------- */
  async function onEvent({ event }: { event: any }) {
    try {
      if (!event || !event.type) return;
      if (event.type === "session.idle") {
        const sessionID = event.properties?.sessionID as string;
        const rt = getRuntime(sessionID);
        if (rt) scheduleContinue(sessionID);
        return;
      }
      // model is emitting text -> it is alive, reset silence timer
      if (event.type === "message.part.updated") {
        const sessionID = event.properties?.sessionID as string | undefined;
        const delta = event.properties?.delta;
        if (sessionID && typeof delta === "string" && delta.length > 0) {
          const rt = getRuntime(sessionID);
          if (rt) rt.lastActivity = Date.now();
        }
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
      rt.recoveryCounter = 0;
      rt.lastEnd = "ok";
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

  const recoveryEnum = z.enum(["auto-research", "pause", "continue"]);

  const tools = {
    goal_set: {
      description: `Start or overwrite an autonomous objective that keeps running by itself. Requires goal. Optional per-run params (override global defaults for THIS task): agent, max_turns(-1=infinite), recovery(how to handle no-progress: auto-research=browse+change strategy and keep going / pause=wait for user / continue=never stop), recovery_attempts, no_progress_turns, converge_turns, turn_timeout_s(silence timeout), idle_interval_ms.`,
      args: {
        goal: z.string().describe("The concrete objective to pursue autonomously."),
        mode: z.enum(["goal", "iterate"]).optional(),
        agent: z.number().int().positive().optional(),
        max_turns: z.number().int().optional(),
        recovery: recoveryEnum.optional(),
        recovery_attempts: z.number().int().nonnegative().optional(),
        no_progress_turns: z.number().int().positive().optional(),
        converge_turns: z.number().int().positive().optional(),
        turn_timeout_s: z.number().positive().optional(),
        idle_interval_ms: z.number().positive().optional(),
      },
      execute: async (args: any, ctx: any) => {
        const mode: Exclude<Mode, "off"> = args.mode === "iterate" ? "iterate" : "goal";
        const rt = ensureRt(ctx.sessionID, ctx.worktree, ctx.directory, mode, args.goal);
        if (!rt.state.overrides) rt.state.overrides = {};
        applyOverrides(rt.state.overrides, args);
        persist(rt);
        const eff = effConfig(rt);
        return (
          `Objective engine ${mode === "iterate" ? "ITERATE" : "GOAL"} started. Objective: ${args.goal}\n` +
          `Effective config: agent=${eff.max_parallel_agents}, max_turns=${eff.max_auto_turns}, recovery=${eff.recovery}(${eff.recovery_attempts}), ` +
          `no_progress_turns=${eff.no_progress_turns}, converge_turns=${eff.converge_turns}, silence_timeout=${eff.turn_timeout_s}s, idle_interval=${eff.idle_interval_ms}ms.\n` +
          `Engine runs automatically. Use goal_progress to log, goal_mark_done to finish, goal_configure to change params, goal_pause/ goal_resume to pause/resume.`
        );
      },
    },

    goal_configure: {
      description: `Change per-run parameters of the active objective at any time (does NOT reset progress). Same params as goal_set.`,
      args: {
        agent: z.number().int().positive().optional(),
        max_turns: z.number().int().optional(),
        recovery: recoveryEnum.optional(),
        recovery_attempts: z.number().int().nonnegative().optional(),
        no_progress_turns: z.number().int().positive().optional(),
        converge_turns: z.number().int().positive().optional(),
        turn_timeout_s: z.number().positive().optional(),
        idle_interval_ms: z.number().positive().optional(),
      },
      execute: async (args: any, ctx: any) => {
        const rt = getRuntime(ctx.sessionID);
        if (!rt) return "No active objective; call goal_set first.";
        if (!rt.state.overrides) rt.state.overrides = {};
        applyOverrides(rt.state.overrides, args);
        persist(rt);
        const eff = effConfig(rt);
        return (
          `Per-run config updated. Effective: agent=${eff.max_parallel_agents}, max_turns=${eff.max_auto_turns}, recovery=${eff.recovery}(${eff.recovery_attempts}), ` +
          `no_progress_turns=${eff.no_progress_turns}, converge_turns=${eff.converge_turns}, silence_timeout=${eff.turn_timeout_s}s, idle_interval=${eff.idle_interval_ms}ms.`
        );
      },
    },

    goal_progress: {
      description: `Log progress / an improvement increment, and signal the engine to keep going (resets no-progress & recovery counters).`,
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
        rt.progressedThisCycle = true;
        rt.activity += 1;
        if (rt.lastActivity < Date.now()) rt.lastActivity = Date.now();
        persist(rt);
        return `Progress logged (improved=${args.improved === true}). Keep going.`;
      },
    },

    goal_mark_done: {
      description: `Declare the objective complete and STOP the loop. Provide concrete, verifiable evidence. Only call when truly done.`,
      args: {
        evidence: z.string().describe("Concrete evidence the goal is met."),
        verification: z.string().optional().describe("How it was verified."),
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
        stopWatchdog(rt);
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

    goal_research: {
      description: `Self-evolution helper: search across Bing, Google, DuckDuckGo, Stack Overflow, GitHub, and HuggingFace to unblock when stuck. Treat results as leads to verify yourself. Use it when you have no idea how to proceed.`,
      args: {
        query: z.string().describe("Search query (topic / error / library / technique)."),
      },
      execute: async (args: any) => {
        const r = await research(args.query);
        let body = r.text || "No results returned.";
        if (r.reachable === 0) {
          body +=
            `\n[goal-research note] NONE of the built-in engines were reachable right now. ` +
            `Instead use one of your own available web-search/webfetch tools or MCP servers ` +
            `(opencode typically exposes search tools such as web-search-sse / webfetch / websearch). ` +
            `Inspect your tool list and call one to research: "${args.query}".`;
        } else {
          body +=
            `\n[goal-research note] These are LEADS ONLY — be skeptical. Before adopting any critical claim, ` +
            `VERIFY it yourself: run the command, build/test, or open the linked source/docs. ` +
            `Mark anything you could not verify as "unverified(speculative)".`;
        }
        return body;
      },
    },

    goal_continue: {
      description: `Resume/continue the loop after completion, optionally with a new/refined objective.`,
      args: { objective: z.string().optional() },
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
        rt.recoveryCounter = 0;
        rt.lastEnd = "ok";
        persist(rt);
        scheduleContinue(ctx.sessionID);
        return `Loop resumed. Continuing: ${rt.state.objective}`;
      },
    },

    goal_pause: {
      description: `Pause the loop now (keep state; resume later). Use if the user wants a break.`,
      args: { reason: z.string().describe("Why pausing.") },
      execute: async (args: any, ctx: any) => {
        const rt = getRuntime(ctx.sessionID);
        if (!rt) return "No active objective.";
        pause(rt, args.reason);
        return `Loop PAUSED: ${args.reason}. Resume with goal_resume.`;
      },
    },

    goal_resume: {
      description: `Resume the loop for a paused objective.`,
      args: { objective: z.string().optional() },
      execute: async (args: any, ctx: any) => {
        const rt = getRuntime(ctx.sessionID);
        if (!rt) return "No paused objective.";
        if (args.objective) rt.state.objective = args.objective;
        rt.state.paused = false;
        rt.state.pausedReason = undefined;
        rt.state.completed = false;
        rt.state.noProgressTurns = 0;
        rt.recoveryCounter = 0;
        rt.lastEnd = "ok";
        persist(rt);
        scheduleContinue(ctx.sessionID);
        return `Loop resumed: ${rt.state.objective}`;
      },
    },

    goal_status: {
      description: `Return current engine status (incl. effective config) for this session.`,
      args: {},
      execute: async (_args: any, ctx: any) => {
        const rt = getRuntime(ctx.sessionID);
        if (!rt) return "No active objective in this session.";
        const s = rt.state;
        const eff = effConfig(rt);
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
            recoveryCounter: rt.recoveryCounter,
            lastEnd: rt.lastEnd,
            progressLog: s.progressLog,
            effectiveConfig: eff,
          },
          null,
          2
        );
      },
    },

    goal_abort: {
      description: `Abort and clear the active goal in this session (stops engine, removes state).`,
      args: {},
      execute: async (_args: any, ctx: any) => {
        const rt = getRuntime(ctx.sessionID);
        if (!rt) return "No active objective.";
        if (rt.timer) clearTimeout(rt.timer);
        stopWatchdog(rt);
        runtimes.delete(ctx.sessionID);
        if (options.persist) store.remove(ctx.sessionID);
        return "Objective aborted and cleared.";
      },
    },

    goal_list_incomplete: {
      description: `List persisted incomplete objectives for cross-restart resume.`,
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

  function applyOverrides(o: RunOverrides, args: Record<string, unknown>) {
    if (typeof args.agent === "number") o.max_parallel_agents = args.agent;
    if (typeof args.max_turns === "number") o.max_auto_turns = args.max_turns;
    if (typeof args.recovery === "string") o.recovery = args.recovery as Recovery;
    if (typeof args.recovery_attempts === "number") o.recovery_attempts = args.recovery_attempts;
    if (typeof args.no_progress_turns === "number") o.no_progress_turns = args.no_progress_turns;
    if (typeof args.converge_turns === "number") o.converge_turns = args.converge_turns;
    if (typeof args.turn_timeout_s === "number") o.turn_timeout_s = args.turn_timeout_s;
    if (typeof args.idle_interval_ms === "number") o.idle_interval_ms = args.idle_interval_ms;
  }

  /* ---------- hooks ---------- */
  return {
    event: onEvent,

    tool: tools as any,

    "tool.execute.before": async ({ sessionID }: any, output: any) => {
      void output;
      const rt = sessionID ? getRuntime(sessionID) : undefined;
      if (rt && rt.running) {
        rt.activity += 1;
        rt.lastActivity = Date.now();
      }
    },

    "experimental.chat.system.transform": async (input: any, output: any) => {
      const rt = input?.sessionID ? getRuntime(input.sessionID) : undefined;
      if (rt) {
        output.system = [...(output.system ?? []), ...rulesBlock(rt)];
      }
    },
  };
}) satisfies Plugin;
