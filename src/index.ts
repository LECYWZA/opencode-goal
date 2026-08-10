import type { Plugin } from "@opencode-ai/plugin";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

/* ------------------------------------------------------------------ *
 *  opencode-goal-run v4
 *  Goal mode + infinite iterate mode, robust + MULTI-SESSION /
 *  MULTI-INSTANCE SAFE (must not conflict).
 *
 *  Anti-freeze (v1-v3): single-flight, event-driven, Promise.race+abort,
 *  silence-activity watchdog, self-evolving recovery, multi-route stops.
 *
 *  NEW CONCURRENCY SAFETY (this version):
 *   A) Persistence merge-write + exclusive file lock. Never blind
 *      full-file overwrite; each flush runs inside an exclusive file
 *      lock and does read-disk -> merge-own-changes -> atomic rename.
 *      Distinct sessions/instances can never clobber each other.
 *   B) Per-worktree runtime mutex. At most one ACTIVE auto-loop advances
 *      on the same worktree at a time.
 *        - same process: in-memory token (memOwner) serializes sessions
 *          on the same worktree (round-robin).
 *        - across processes: exclusive lock file per worktree with
 *          heartbeat refresh + stale-lock takeover. Blocked instances
 *          wait; owner releasing/exiting lets them take over.
 * ------------------------------------------------------------------ */

type Mode = "goal" | "iterate" | "off";
type Recovery = "auto-research" | "pause" | "continue";
type WorktreePolicy = "serial" | "parallel";

const HEARTBEAT_MS = 5000;
const LOCK_STALE_MS = 15000;
const LOCK_TIMEOUT_MS = 8000;

interface Options {
  mode: Mode;
  max_parallel_agents: number;
  max_auto_turns: number;
  turn_timeout_s: number;
  no_progress_turns: number;
  converge_turns: number;
  idle_interval_ms: number;
  recovery: Recovery;
  recovery_attempts: number;
  worktree_policy: WorktreePolicy;
  worktree_parallel_sessions: number;
  thinking_stall_s: number; // output-only stall (no tool use) -> loop
  max_repeats: number; // identical delta streaks -> loop
  max_tool_loop: number; // identical tool+args repeats -> loop
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
  worktree_policy?: WorktreePolicy;
  worktree_parallel_sessions?: number;
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
  worktree_policy: WorktreePolicy;
  worktree_parallel_sessions: number;
}

type TurnEnd = "ok" | "no-progress" | "timeout" | "loop";

function defaultOptions(raw: Record<string, unknown> | undefined): Options {
  const home = os.homedir();
  const mkPath = (p: unknown, def: string) => (typeof p === "string" && p.length > 0 ? p : def);
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
    worktree_policy: (raw?.worktree_policy as WorktreePolicy) ?? "serial",
    worktree_parallel_sessions: Math.max(1, num(raw?.worktree_parallel_sessions, 1)),
    thinking_stall_s: Math.max(0, num(raw?.thinking_stall_s, 600)),
    max_repeats: Math.max(2, num(raw?.max_repeats, 5)),
    max_tool_loop: Math.max(2, num(raw?.max_tool_loop, 5)),
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 *  State / Persisted types
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

type Persisted = Record<string, GoalState>;

export function readBase(file: string): Persisted {
  try {
    if (fs.existsSync(file)) {
      const p = JSON.parse(fs.readFileSync(file, "utf8"));
      if (p && typeof p === "object") return p as Persisted;
    }
  } catch (e) {
    /* ignore corrupt */
  }
  return {};
}

/** Run fn under an exclusive lock file. Waits (with stale-lock recovery);
 *  degrades to lock-free after LOCK_TIMEOUT so a hung lock never deadlocks. */
export async function withFileLock(lockPath: string, fn: () => Promise<void> | void): Promise<void> {
  const until = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;
  while (!held) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      held = true;
    } catch (e: any) {
      if (e?.code === "EEXIST") {
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch (e2) {
          continue;
        }
        if (Date.now() > until) break;
        await sleep(20);
      } else {
        break;
      }
    }
  }
  try {
    await fn();
  } finally {
    if (held) {
      try {
        fs.unlinkSync(lockPath);
      } catch (e) {}
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Store — merge-write, never blind overwrite (multi-instance safe)
 * ------------------------------------------------------------------ */

export class Store {
  private file: string;
  private tmpFile: string;
  private lockFile: string;
  private pending = new Map<string, GoalState>();
  private deleted = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(file: string) {
    this.file = file;
    this.tmpFile = file + ".tmp";
    this.lockFile = file + ".wlock";
  }

  snapshot(): Persisted {
    const base = readBase(this.file);
    for (const k of this.deleted) delete base[k];
    for (const [k, v] of this.pending) base[k] = v;
    return base;
  }

  set(key: string, state: GoalState) {
    this.pending.set(key, { ...state });
    this.deleted.delete(key);
    this.queue();
  }

  remove(key: string) {
    this.deleted.add(key);
    this.pending.delete(key);
    this.queue();
  }

  get(key: string): GoalState | undefined {
    return this.snapshot()[key];
  }

  all(): Array<GoalState> {
    return Object.values(this.snapshot());
  }

  private queue() {
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, 400);
    }
  }

  async flush() {
    const write = async () => {
      const base = readBase(this.file);
      const merged: Persisted = { ...base };
      for (const k of this.deleted) delete merged[k];
      for (const [k, v] of this.pending) merged[k] = v;
      try {
        fs.writeFileSync(this.tmpFile, JSON.stringify(merged, null, 2), "utf8");
        fs.renameSync(this.tmpFile, this.file);
      } catch (e) {
        try {
          fs.rmSync(this.tmpFile, { force: true });
        } catch (e2) {}
        throw e;
      }
      this.pending.clear();
      this.deleted.clear();
    };
    await withFileLock(this.lockFile, write);
  }
}

/* ------------------------------------------------------------------ *
 *  Arbiter — per-worktree runtime mutex (same process + cross process)
 * ------------------------------------------------------------------ */

export class Arbiter {
  private dir: string;
  private instanceId: string;
  private memCount = new Map<string, number>(); // worktree -> in-flight sessions (this proc)
  private counted = new Set<string>(); // `${worktree}:${sessionID}` in-flight
  private fileOwned = new Set<string>(); // worktrees whose lock file this proc owns
  private heartbeats = new Map<string, ReturnType<typeof setInterval>>();

  constructor(stateDir: string) {
    this.dir = stateDir;
    this.instanceId = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  }

  private lockPath(worktree: string): string {
    const h = crypto.createHash("sha256").update(worktree).digest("hex").slice(0, 16);
    return path.join(this.dir, `goal-run-${h}.lock`);
  }

  private touch(p: string) {
    try {
      const now = new Date();
      fs.utimesSync(p, now, now);
    } catch (e) {}
  }

  private startHeartbeat(w: string, p: string) {
    this.stopHeartbeat(w);
    const t = setInterval(() => this.touch(p), HEARTBEAT_MS);
    this.heartbeats.set(w, t);
  }

  private stopHeartbeat(w: string) {
    const t = this.heartbeats.get(w);
    if (t) {
      clearInterval(t);
      this.heartbeats.delete(w);
    }
  }

  private tryAcquireFile(rt: RuntimeLike): boolean {
    const w = rt.state.worktree;
    const p = this.lockPath(w);
    try {
      fs.writeFileSync(p, JSON.stringify({ pid: process.pid, inst: this.instanceId, ts: Date.now(), session: rt.state.sessionID }), { flag: "wx" });
      this.fileOwned.add(w);
      this.startHeartbeat(w, p);
      return true;
    } catch (e: any) {
      if (e?.code === "EEXIST") {
        try {
          const st = fs.statSync(p);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            try {
              fs.unlinkSync(p);
            } catch (e2) {}
            this.fileOwned.delete(w);
            this.stopHeartbeat(w);
            return this.tryAcquireFile(rt);
          }
        } catch (e2) {
          return this.tryAcquireFile(rt);
        }
        return false;
      }
      return false;
    }
  }

  /** May this runtime advance its auto-loop right now?
   *  policy="parallel" -> no coordination (each run advances freely).
   *  policy="serial"   -> at most one advances per worktree (existing mutex). */
  /** May this runtime advance its auto-loop right now?
   *  policy="parallel"        -> no coordination (each run advances freely).
   *  policy="serial"          -> cross-process mutex via lock file (1 instance),
   *                              plus same-process slot limit = parallelN
   *                              (N-way in-flight on the same worktree).
   */
  canRun(rt: RuntimeLike, policy: WorktreePolicy, parallelN = 1): boolean {
    if (policy === "parallel") return true;
    const w = rt.state.worktree;
    const key = `${w}:${rt.state.sessionID}`;
    if (this.counted.has(key)) return true; // idempotent (already counted)
    if (!this.fileOwned.has(w)) {
      if (!this.tryAcquireFile(rt)) return false; // another process holds the sit
    }
    const cur = this.memCount.get(w) ?? 0;
    if (cur >= parallelN) return false; // same-process slot limit reached
    this.memCount.set(w, cur + 1);
    this.counted.add(key);
    return true;
  }

  /** Clear one local in-flight slot for a worktree (call when a turn ends). */
  releaseLocal(rt: RuntimeLike) {
    const w = rt.state.worktree;
    const key = `${w}:${rt.state.sessionID}`;
    if (this.counted.delete(key)) {
      const cur = this.memCount.get(w) ?? 1;
      this.memCount.set(w, Math.max(0, cur - 1));
    }
  }

  /** Fully release a worktree sit (pause/complete/abort). */
  releaseAll(rt: RuntimeLike) {
    this.releaseLocal(rt);
    const w = rt.state.worktree;
    if (this.fileOwned.has(w)) {
      this.stopHeartbeat(w);
      try {
        fs.unlinkSync(this.lockPath(w));
      } catch (e) {}
      this.fileOwned.delete(w);
    }
  }

  /** Current holding status of a worktree sit. */
  held(worktree: string): { ours: boolean; other: boolean } {
    const p = this.lockPath(worktree);
    const ours = this.fileOwned.has(worktree);
    let other = false;
    try {
      if (fs.existsSync(p)) {
        const st = fs.statSync(p);
        other = !ours && Date.now() - st.mtimeMs < LOCK_STALE_MS;
      }
    } catch (e) {}
    return { ours, other };
  }
}

interface RuntimeLike {
  state: GoalState;
}

/* ------------------------------------------------------------------ *
 *  Research (multi-engine)
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
    } catch (e) {}
  }

  await run("Bing", async () => {
    const html = await fetchText(`https://www.bing.com/search?q=${q}`);
    const re = /<li class="b_algo"[\s\S]*?<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[\s\S]*?>([\s\S]*?)<\/p>/gi;
    const res: string[] = [];
    let m: RegExpExecArray | null;
    let g = 0;
    while ((m = re.exec(html)) && g++ < 5) res.push(`- ${stripHtml(m[2]).slice(0, 120)} — ${m[1]} — ${stripHtml(m[3]).slice(0, 240)}`);
    return res;
  });

  await run("Google", async () => {
    const html = await fetchText(`https://www.google.com/search?q=${q}&num=5`);
    const re = /<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<a href="(\/url\?q=[^"]+)"/gi;
    const res: string[] = [];
    let m: RegExpExecArray | null;
    let g = 0;
    while ((m = re.exec(html)) && g++ < 5) {
      const target = decodeURIComponent(m[2].replace(/^\/url\?q=/, "").split("&")[0]).replace(/^https?:\/\//, "");
      res.push(`- ${stripHtml(m[1]).slice(0, 120)} — ${target}`);
    }
    return res;
  });

  await run("DuckDuckGo", async () => {
    const html = await fetchText(`https://html.duckduckgo.com/html/?q=${q}`);
    const re = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const res: string[] = [];
    let m: RegExpExecArray | null;
    let g = 0;
    while ((m = re.exec(html)) && g++ < 5) res.push(`- ${stripHtml(m[2]).slice(0, 120)} — ${m[1]} — ${stripHtml(m[3]).slice(0, 240)}`);
    return res;
  });

  await run("StackOverflow", async () => {
    const j = JSON.parse(await fetchText(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${query}&site=stackoverflow&pagesize=5`));
    const items: any[] = Array.isArray(j?.items) ? j.items : [];
    return items.map((it) => `- ${(it.title ?? "").slice(0, 140)} — ${it.link} (answered:${(it.answer_count ?? 0) > 0})`);
  });

  await run("GitHub", async () => {
    const j = JSON.parse(await fetchText(`https://api.github.com/search/repositories?q=${q}&per_page=5`));
    const items: any[] = Array.isArray(j?.items) ? j.items : [];
    return items.map((it) => `- ${it.full_name} — ${(it.description ?? "").slice(0, 180)} (★${it.stargazers_count})`);
  });

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

interface Runtime extends RuntimeLike {
  state: GoalState;
  running: boolean;
  continuePending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  watchdog: ReturnType<typeof setInterval> | null;
  turnStart: number;
  lastActivity: number;
  activity: number;
  progressedThisCycle: boolean;
  loopHit: string | null; // reason a loop/stall/timeout was detected this turn
  lastToolAt: number;
  lastOutputAt: number;
  lastDelta: string;
  repeatStreak: number;
  prevToolSig: string;
  toolLoopCount: number;
  winnerResolver: (() => void) | null;
  lastEnd: TurnEnd;
  recoveryCounter: number;
}

export default (async function plugin(input, rawOptions) {
  const { client } = input;
  const options = defaultOptions(rawOptions as Record<string, unknown> | undefined);
  const store = new Store(options.state_file);
  const arbiter = new Arbiter(path.dirname(options.state_file));
  const runtimes = new Map<string, Runtime>();
  const recentEdits = new Map<string, number>(); // file -> ts (real file.edited events)
  const log = (...args: unknown[]) => {
    if (options.debug) console.log("[goal-run]", ...args);
  };

  const getRuntime = (sessionID: string) => runtimes.get(sessionID);

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
      loopHit: null,
      lastToolAt: Date.now(),
      lastOutputAt: Date.now(),
      lastDelta: "",
      repeatStreak: 0,
      prevToolSig: "",
      toolLoopCount: 0,
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
      worktree_policy: o.worktree_policy ?? options.worktree_policy,
      worktree_parallel_sessions: Math.max(1, o.worktree_parallel_sessions ?? options.worktree_parallel_sessions),
    };
  }

  function rulesBlock(rt: Runtime): string[] {
    const s = rt.state;
    const eff = effConfig(rt);
    const lines: string[] = [
      `[goal-run] Active objective engine (mode=${s.mode}). Objective: ${s.objective}` +
        (s.completed ? ` (COMPLETE: ${s.completedReason ?? "n/a"})` : "") +
        (s.paused ? ` (PAUSED: ${s.pausedReason})` : "") +
        `.`,
      `[goal-run] Config: agent<=${eff.max_parallel_agents}/message; turn silence-timeout ${eff.turn_timeout_s}s; max_auto_turns=${eff.max_auto_turns}; recovery=${eff.recovery}(${eff.recovery_attempts}); worktree=${eff.worktree_policy}(parallel_sessions=${eff.worktree_parallel_sessions}). ` +
        `Rule: only end by calling goal_mark_done with verifiable evidence, OR pause via goal_pause. When stuck, analyze why, use goal_research + web tools to learn, change strategy and keep going. ` +
        (s.mode === "iterate"
          ? `(iterate) Each round: implement→self-test→find gaps→goal_progress(note=...)→engine auto-continues.`
          : `(goal) Work toward the objective each round; log via goal_progress; finish via goal_mark_done.`),
      `[goal-run] Verification principle (MANDATORY): be SKEPTICAL of search results/docs/claims — they are LEADS, not facts. Verify critical conclusions yourself (run command, build/test, open source). Mark unverifiable assumptions as "unverified (speculative)".`,
      `[goal-run] Concurrency: this worktree's auto-loop may be shared across sessions/instances. If another run appears to hold it, wait — do not duplicate edits. This session advances in rounds; if paused, just continue when resumed.`,
    ];
    const risk = eff.worktree_policy === "parallel" || eff.worktree_parallel_sessions > 1;
    if (risk) {
      lines.push(
        `[goal-run] PARALLEL-WORK GUIDELINES (active: worktree=${eff.worktree_policy}, parallel_sessions=${eff.worktree_parallel_sessions}): ` +
          `multiple sessions/instances may be editing this project at once. To avoid clobbering each other: ` +
          `(1) before editing/changing an existing file, READ its latest content first and edit based on that; ` +
          `(2) prefer dividing work so concurrent runs touch different files or non-overlapping regions; ` +
          `(3) after making changes, run git status/diff to check you haven't overwritten someone else's edits; ` +
          `(4) if a file changed underneath you, re-read and re-apply your intended change rather than force-overwriting.`
      );
    }
    return lines;
  }

  function buildTurnText(rt: Runtime, eff: EffectiveRunConfig, runs: number): string {
    const s = rt.state;
    let base =
      s.mode === "iterate"
        ? `[goal-run] Round ${runs}. Continue improving: ${s.objective}. Implement → self-test → find gaps → call goal_progress(note=...) to log this round's increment. Finish only via goal_mark_done.`
        : `[goal-run] Round ${runs}. Continue working toward: ${s.objective}. Do real work with tools. Call goal_progress when you make progress. Finish via goal_mark_done (do not stop without it).`;

    if (eff.worktree_policy === "parallel" || eff.worktree_parallel_sessions > 1) {
      const _now = Date.now();
      const _files = [...recentEdits.entries()]
        .filter(([, _t]) => _now - _t < 30000)
        .map(([_f]) => _f)
        .slice(0, 6);
      base +=
        `\n[parallel] 同项目可能被其它会话/实例并行编辑。` +
        (_files.length
          ? ` 最近30s内有文件被改动(可能来自其它运行，操作前请先 read 最新内容再 Edit): ${_files.join("、")}。`
          : "") +
        ` 改现有文件前先读取最新内容，分工避重，改后 git status/diff 检查是否覆盖他人改动。`;
    }

    if (eff.recovery === "pause") return base;

    if (rt.lastEnd === "loop") {
      return (
        base +
        `\n[recovery] 上一轮检测到疑似死循环(思考空转/重复输出/重复工具调用)，已自动中断。本轮请: 直奔能产生确定进展的动作(编辑/运行命令/写文件/查询), 避免空想; 若上一轮在重复做同一件事, 改变做法; 每完成一个可验证小步就立即调用 goal_progress 记录, 让引擎确认进展。`
      );
    }
    if (rt.lastEnd === "timeout") {
      return base + `\n[recovery] 上一轮因长时间静默被自动中断(可能命令无限等待或无输出)。本轮请: 先说明你上一轮可能卡在哪(诊断一句), 用 goal_research 或你已有的网络搜索工具排查正确做法, 长命令请自行加超时, 然后推进并调用 goal_progress 记录进展。别固步自封, 主动换思路。`;
    }
    if (rt.lastEnd === "no-progress") {
      return base + `\n[recovery] 上一轮未产生可验证进展。本轮请: (1)冷静分析为何无进展(卡点/缺条件/方法是否错误); (2)用 goal_research(Bing/Google/DuckDuckGo/GitHub/HuggingFace/StackOverflow) 或你自己的网络搜索工具查找解法; (3)对搜索结果保持怀疑——先用最小例子/命令亲自验证方向正确再放大推进, 不盲信摘要; (4)调用 goal_progress 记录结果或说明仍受阻原因。主动进化, 别重复无效动作。`;
    }
    return base;
  }

  function handleTurnEnd(rt: Runtime, eff: EffectiveRunConfig) {
    const s = rt.state;
    if (s.completed) {
      arbiter.releaseAll(rt);
      persist(rt);
      return;
    }
    if (s.paused) {
      arbiter.releaseAll(rt);
      persist(rt);
      return;
    }

    const progressed = rt.progressedThisCycle || (rt.activity > 0 && !rt.loopHit);
    if (progressed) {
      s.noProgressTurns = 0;
      s.lastActivityAt = Date.now();
      rt.recoveryCounter = 0;
      rt.lastEnd = "ok";
    } else {
      s.noProgressTurns += 1;
      rt.lastEnd = rt.loopHit ? "loop" : "no-progress";
    }

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
      if (rt.lastEnd === "loop") {
        pause(rt, `a turn stalled (loop:${rt.loopHit}); aborting.`);
        return;
      }
      scheduleContinue(rt.state.sessionID);
      return;
    }

    if (eff.recovery === "auto-research") {
      const stuck =
        (rt.lastEnd === "no-progress" && s.noProgressTurns >= brakeTurns) ||
        rt.lastEnd === "loop";
      if (stuck) {
        rt.recoveryCounter += 1;
        log("recovery attempt", rt.recoveryCounter, "of", eff.recovery_attempts);
        if (rt.recoveryCounter > eff.recovery_attempts) {
          pause(rt, `no progress after ${eff.recovery_attempts} recovery/research rounds.`);
          return;
        }
      }
    }
    scheduleContinue(rt.state.sessionID);
  }

  function pause(rt: Runtime, reason: string) {
    rt.state.paused = true;
    rt.state.pausedReason = reason;
    if (rt.timer) clearTimeout(rt.timer);
    rt.timer = null;
    rt.continuePending = false;
    stopWatchdog(rt);
    arbiter.releaseAll(rt);
    persist(rt);
  }

  function persist(rt: Runtime) {
    if (options.persist) store.set(rt.state.sessionID, { ...rt.state });
  }

  function triggerLoop(rt: Runtime, kind: string) {
    if (!rt.running || rt.loopHit) return; // already flagged
    rt.loopHit = kind;
    log("loop detected (" + kind + ") on", rt.state.sessionID, "; aborting turn");
    if (rt.winnerResolver) rt.winnerResolver();
    try {
      void client.session.abort({ path: { id: rt.state.sessionID } });
    } catch (e) {
      log("abort error", e);
    }
  }

  function startWatchdog(rt: Runtime, eff: EffectiveRunConfig) {
    stopWatchdog(rt);
    if (eff.turn_timeout_s <= 0) return;
    rt.watchdog = setInterval(() => {
      if (!rt.running || rt.loopHit) return;
      const now = Date.now();
      // 1) hard silence timeout (no output AND no tool activity)
      if (now - rt.lastActivity > eff.turn_timeout_s * 1000) {
        triggerLoop(rt, "silence");
        return;
      }
      // 2) thinking/replying stall: the model keeps producing tokens but has
      //    done NO tool work for a long window -> it is spinning in thought.
      if (
        options.thinking_stall_s > 0 &&
        now - rt.lastToolAt > options.thinking_stall_s * 1000 &&
        now - rt.lastOutputAt < 5000 // it IS still talking right now
      ) {
        triggerLoop(rt, "thinking-stall");
      }
    }, 1000);
  }

  function stopWatchdog(rt: Runtime) {
    if (rt.watchdog) {
      clearInterval(rt.watchdog);
      rt.watchdog = null;
    }
  }

  function scheduleContinue(sessionID: string) {
    const rt = getRuntime(sessionID);
    if (!rt) return;
    const s = rt.state;
    if (s.completed || s.paused) return;
    if (rt.running || rt.continuePending) return;
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
    if (rt.state.completed || rt.state.paused) return; // no stray turn after stop

    const eff = effConfig(rt);

    // Concurrency gate: serial policy limits in-flight slots per worktree.
    if (!arbiter.canRun(rt, eff.worktree_policy, eff.worktree_parallel_sessions)) {
      scheduleContinue(rt.state.sessionID);
      return;
    }

    rt.state.turns += 1;
    rt.turnStart = Date.now();
    rt.lastActivity = Date.now();
    rt.lastToolAt = Date.now();
    rt.lastOutputAt = Date.now();
    rt.activity = 0;
    rt.progressedThisCycle = false;
    rt.loopHit = null;
    rt.lastDelta = "";
    rt.repeatStreak = 0;
    rt.prevToolSig = "";
    rt.toolLoopCount = 0;
    rt.running = true;

    const text = buildTurnText(rt, eff, rt.state.turns);
    let winnerResolve: (() => void) | null = null;
    const winner = new Promise<void>((res) => {
      winnerResolve = res;
    });
    rt.winnerResolver = winnerResolve;

    startWatchdog(rt, eff);

    try {
      await Promise.race([
        client.session.prompt({ path: { id: rt.state.sessionID }, body: { parts: [{ type: "text", text }] } }),
        winner,
      ]).catch((e) => log("prompt error", e));
    } finally {
      stopWatchdog(rt);
      rt.winnerResolver = null;
      rt.running = false;
      arbiter.releaseLocal(rt);
      handleTurnEnd(rt, eff);
    }
  }

  async function onEvent({ event }: { event: any }) {
    try {
      if (!event || !event.type) return;
      if (event.type === "session.idle") {
        const sessionID = event.properties?.sessionID as string;
        if (getRuntime(sessionID)) scheduleContinue(sessionID);
        return;
      }
      if (event.type === "file.edited") {
        const f = event.properties?.file;
        if (typeof f === "string" && f) {
          recentEdits.set(f, Date.now());
          if (recentEdits.size > 200) {
            const _n = Date.now();
            for (const [k, v] of recentEdits) if (_n - v > 5 * 60 * 1000) recentEdits.delete(k);
          }
        }
        return;
      }
      if (event.type === "message.part.updated") {
        const sessionID = event.properties?.sessionID as string | undefined;
        const delta = event.properties?.delta;
        if (sessionID && typeof delta === "string" && delta.length > 0) {
          const rt = getRuntime(sessionID);
          if (rt) {
            rt.lastActivity = Date.now();
            rt.lastOutputAt = Date.now();
            if (rt.running && !rt.loopHit) {
              if (delta === rt.lastDelta) {
                rt.repeatStreak += 1;
                if (rt.repeatStreak >= options.max_repeats) triggerLoop(rt, "repeat-output");
              } else {
                rt.repeatStreak = 0;
              }
              rt.lastDelta = delta;
            }
          }
        }
      }
    } catch (e) {
      log("event error", e);
    }
  }

  function ensureRt(sessionID: string, worktree: string, directory: string, mode: Exclude<Mode, "off">, objective: string): Runtime {
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

  function applyOverrides(o: RunOverrides, args: Record<string, unknown>) {
    if (typeof args.agent === "number") o.max_parallel_agents = args.agent;
    if (typeof args.max_turns === "number") o.max_auto_turns = args.max_turns;
    if (typeof args.recovery === "string") o.recovery = args.recovery as Recovery;
    if (typeof args.recovery_attempts === "number") o.recovery_attempts = args.recovery_attempts;
    if (typeof args.worktree_policy === "string") o.worktree_policy = args.worktree_policy as WorktreePolicy;
    if (typeof args.worktree_parallel_sessions === "number") o.worktree_parallel_sessions = Math.max(1, Math.floor(args.worktree_parallel_sessions));
    if (typeof args.no_progress_turns === "number") o.no_progress_turns = args.no_progress_turns;
    if (typeof args.converge_turns === "number") o.converge_turns = args.converge_turns;
    if (typeof args.turn_timeout_s === "number") o.turn_timeout_s = args.turn_timeout_s;
    if (typeof args.idle_interval_ms === "number") o.idle_interval_ms = args.idle_interval_ms;
  }

  const tools = {
    goal_set: {
      description: `Start or overwrite an autonomous objective that keeps running by itself. Requires goal. Optional per-run params: agent, max_turns(-1=infinite), recovery(auto-research/pause/continue), recovery_attempts, no_progress_turns, converge_turns, turn_timeout_s(silence timeout), idle_interval_ms. Multi-session/instance safe.`,
      args: {
        goal: z.string().describe("The concrete objective to pursue autonomously."),
        mode: z.enum(["goal", "iterate"]).optional(),
        agent: z.number().int().positive().optional(),
        max_turns: z.number().int().optional(),
        recovery: recoveryEnum.optional(),
        recovery_attempts: z.number().int().nonnegative().optional(),
        worktree_policy: z.enum(["serial", "parallel"]).optional().describe("serial=同一工作目录互斥防冲突(默认); parallel=不互斥、可并行推进"),
        worktree_parallel_sessions: z.number().int().positive().optional().describe("serial 下同实例内同一工作目录最多并行的会话数(默认1=纯串行)"),
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
        scheduleContinue(ctx.sessionID);
        return (
          `Objective engine ${mode === "iterate" ? "ITERATE" : "GOAL"} started. Objective: ${args.goal}\n` +
          `Effective config: agent=${eff.max_parallel_agents}, max_turns=${eff.max_auto_turns}, recovery=${eff.recovery}(${eff.recovery_attempts}), worktree=${eff.worktree_policy}(parallel=${eff.worktree_parallel_sessions}), ` +
          `no_progress_turns=${eff.no_progress_turns}, converge_turns=${eff.converge_turns}, silence_timeout=${eff.turn_timeout_s}s, idle_interval=${eff.idle_interval_ms}ms.\n` +
          `Engine runs automatically (shared safely across sessions/instances on this worktree). Use goal_progress/goal_mark_done/goal_configure/goal_pause.`
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
        worktree_policy: z.enum(["serial", "parallel"]).optional(),
        worktree_parallel_sessions: z.number().int().positive().optional(),
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
        return `Per-run config updated. Effective: agent=${eff.max_parallel_agents}, max_turns=${eff.max_auto_turns}, recovery=${eff.recovery}(${eff.recovery_attempts}), worktree=${eff.worktree_policy}(parallel=${eff.worktree_parallel_sessions}), no_progress_turns=${eff.no_progress_turns}, converge_turns=${eff.converge_turns}, silence_timeout=${eff.turn_timeout_s}s, idle_interval=${eff.idle_interval_ms}ms.`;
      },
    },

    goal_progress: {
      description: `Log progress / an improvement increment, signal the engine to keep going (resets no-progress & recovery counters).`,
      args: {
        note: z.string().describe("What was accomplished or improved this round."),
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
        rt.lastActivity = Date.now();
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
      description: `Self-evolution helper: search Bing, Google, DuckDuckGo, Stack Overflow, GitHub, HuggingFace to unblock when stuck. Treat results as leads to verify yourself.`,
      args: {
        query: z.string().describe("Search query (topic / error / library / technique)."),
      },
      execute: async (args: any) => {
        const r = await research(args.query);
        const body = r.text || "No results returned.";
        if (r.reachable === 0) {
          return (
            body +
            `\n[goal-research note] NONE of the built-in engines were reachable. Use one of your own available web-search/webfetch tools or MCP servers (e.g. web-search-sse / webfetch / websearch) to research: "${args.query}".`
          );
        }
        return body + `\n[goal-research note] These are LEADS ONLY — be skeptical. Verify critical claims yourself (run/build/test/open source). Mark unverifiable items as "unverified (speculative)".`;
      },
    },

    goal_continue: {
      description: `Resume the loop after a completed objective (deepen/extend), optionally with a new/refined objective.`,
      args: { objective: z.string().optional() },
      execute: async (args: any, ctx: any) => {
        const rt = getRuntime(ctx.sessionID);
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
      description: `Pause the loop now (keeps state and releases the worktree sit for others; resume later).`,
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

    goal_overview: {
      description: `Return a project-wide overview: all active objective sessions on this worktree, recent concurrent file edits, and whether this worktree's run-sit is held locally or by another process. Use for supervision.`,
      args: { worktree: z.string().optional().describe("Optional worktree to focus; defaults to current session's worktree.") },
      execute: async (_args: any, ctx: any) => {
        const focus = _args.worktree || ctx.worktree;
        const now = Date.now();
        const matched = [...runtimes.values()].filter((r) => !focus || r.state.worktree === focus);
        const active = matched.map((r) => ({
          sessionID: r.state.sessionID,
          worktree: r.state.worktree,
          mode: r.state.mode,
          objective: r.state.objective.slice(0, 120),
          completed: r.state.completed,
          paused: r.state.paused,
          turns: r.state.turns,
          lastEnd: r.lastEnd,
          loopDetected: r.loopHit,
        }));
        const recentFiles = [...recentEdits.entries()]
          .filter(([, t]) => now - t < 120000)
          .map(([f]) => f)
          .slice(0, 20);
        const held = arbiter.held(focus);
        const eff0 = matched[0] ? effConfig(matched[0]) : null;
        return JSON.stringify(
          {
            activeSessions: active,
            recentConcurrentEdits_2min: recentFiles,
            worktreeSit: {
              policy: eff0 ? `${eff0.worktree_policy}(${eff0.worktree_parallel_sessions})` : "none-active",
              heldByThisProcess: held.ours,
              heldByOtherProcess: held.other,
            },
          },
          null,
          2
        );
      },
    },

    goal_abort: {
      description: `Abort and clear the active goal in this session (stops engine, releases sit, removes state).`,
      args: {},
      execute: async (_args: any, ctx: any) => {
        const rt = getRuntime(ctx.sessionID);
        if (!rt) return "No active objective.";
        if (rt.timer) clearTimeout(rt.timer);
        stopWatchdog(rt);
        arbiter.releaseAll(rt);
        runtimes.delete(ctx.sessionID);
        if (options.persist) store.remove(ctx.sessionID);
        return "Objective aborted and cleared.";
      },
    },

    goal_list_incomplete: {
      description: `List persisted incomplete objectives for cross-restart resume (merge of current disk state).`,
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

  return {
    event: onEvent,

    tool: tools as any,

    "tool.execute.before": async ({ sessionID, tool: t }: any, output: any) => {
      void output;
      const rt = sessionID ? getRuntime(sessionID) : undefined;
      if (rt && rt.running) {
        rt.activity += 1;
        rt.lastActivity = Date.now();
        rt.lastToolAt = Date.now();
        rt.lastDelta = "";
        rt.repeatStreak = 0;
        // tool-loop detection: identical (tool + args) repeated without change
        if (!rt.loopHit) {
          let sig: string;
          try {
            sig = `${t}:${JSON.stringify(output?.args ?? {}).slice(0, 200)}`;
          } catch (e) {
            sig = String(t);
          }
          if (sig === rt.prevToolSig) {
            rt.toolLoopCount += 1;
            if (rt.toolLoopCount >= options.max_tool_loop) triggerLoop(rt, "tool-loop");
          } else {
            rt.prevToolSig = sig;
            rt.toolLoopCount = 1;
          }
        }
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
