/**
 * Shared helpers for the opencode-goal-run TUI plugin (client-side, no LLM).
 * We use plain function calls to api.ui.* (no JSX) and reuse goal-cli as the
 * script backend, keeping parity with the server plugin's persisted state.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { homedir } from "node:os"

export const GOAL_STATE =
  process.env.GOAL_RUN_STATE ?? join(homedir(), ".config", "opencode", "goal-run-state.json")

// Repository root. Overridable so a cloned install under a different path works.
const REPO = process.env.GOAL_RUN_REPO ?? "C:\\Users\\Administrator\\opencode-goal-run"
const CLI = join(REPO, "dist", "cli.js")

export function runCLI(...args: string[]): { ok: boolean; out: string; err: string } {
  try {
    const r = spawnSync("node", [CLI, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    })
    return { ok: r.status === 0, out: (r.stdout ?? "").toString(), err: (r.stderr ?? "").toString() }
  } catch (e: unknown) {
    return { ok: false, out: "", err: e instanceof Error ? e.message : String(e) }
  }
}

export function readState(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(GOAL_STATE, "utf8"))
  } catch {
    return {}
  }
}

/** Atomic-ish replace (tmp + rename), matching goal-cli's write strategy. */
export function writeState(s: Record<string, any>): void {
  const tmp = GOAL_STATE + ".tui.tmp"
  writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8")
  try {
    renameSync(tmp, GOAL_STATE)
  } catch {
    // fallback if rename fails across some FS
    writeFileSync(GOAL_STATE, JSON.stringify(s, null, 2), "utf8")
  }
}

export function normalizePath(p: string): string {
  return (p || "").replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase()
}

export function short(id: string, n = 12): string {
  return id.length <= n ? id : id.slice(0, n) + "…"
}

/** Read a goal record's full text (objective + effective params) for display. */
export function describeGoal(id: string): string {
  const s = readState()[id]
  if (!s) return "(record not found)"
  const lines = [
    `ID: ${id}`,
    `工作目录: ${s.worktree ?? "?"}`,
    `模式: ${s.mode ?? "?"}  轮数: ${s.turns ?? 0}`,
    `状态: ${s.completed ? "已完成" : s.paused ? "已暂停" : "运行中"}`,
  ]
  if (s.pausedReason) lines.push(`暂停原因: ${s.pausedReason}`)
  if (s.completedReason) lines.push(`完成原因: ${s.completedReason}`)
  if (s.overrides && Object.keys(s.overrides).length) {
    lines.push(`参数: ${Object.entries(s.overrides).map(([k, v]) => `${k}=${v}`).join(" ")}`)
  }
  lines.push(`目标:\n${s.objective ?? "(无)"}`)
  return lines.join("\n")
}
