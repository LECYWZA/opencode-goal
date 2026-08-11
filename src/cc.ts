import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

/* Concurrency core, isolated so the plugin bundle stays default-only
 * (opencode's loader can be confused by named class exports). This file
 * is also built separately for the concurrency tests. */

export type Mode = "goal" | "iterate" | "infinite" | "off";
export type Recovery = "auto-research" | "pause" | "continue";
export type WorktreePolicy = "serial" | "parallel";

export const HEARTBEAT_MS = 5000;
export const LOCK_STALE_MS = 15000;
export const LOCK_TIMEOUT_MS = 8000;

export interface RunOverrides {
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

export interface GoalState {
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

export type Persisted = Record<string, GoalState>;

export interface RuntimeLike {
  state: GoalState;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Run fn under an exclusive lock. Waits (with stale-lock recovery);
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

/* Store — merge-write, never blind overwrite (multi-instance safe) */

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

/* Arbiter — per-worktree runtime mutex (same process + cross process) */

export class Arbiter {
  private dir: string;
  private instanceId: string;
  private memCount = new Map<string, number>();
  private counted = new Set<string>();
  private fileOwned = new Set<string>();
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

  /** policy="parallel" -> no coordination; "serial" -> cross-process mutex
   *  (1 instance) plus same-process slot limit parallelN. */
  canRun(rt: RuntimeLike, policy: WorktreePolicy, parallelN = 1): boolean {
    if (policy === "parallel") return true;
    const w = rt.state.worktree;
    const key = `${w}:${rt.state.sessionID}`;
    if (this.counted.has(key)) return true;
    if (!this.fileOwned.has(w)) {
      if (!this.tryAcquireFile(rt)) return false;
    }
    const cur = this.memCount.get(w) ?? 0;
    if (cur >= parallelN) return false;
    this.memCount.set(w, cur + 1);
    this.counted.add(key);
    return true;
  }

  releaseLocal(rt: RuntimeLike) {
    const w = rt.state.worktree;
    const key = `${w}:${rt.state.sessionID}`;
    if (this.counted.delete(key)) {
      const cur = this.memCount.get(w) ?? 1;
      this.memCount.set(w, Math.max(0, cur - 1));
    }
  }

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
