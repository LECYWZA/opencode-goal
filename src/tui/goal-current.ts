/**
 * Current-session management commands (zero-LLM). Each operates ONLY on the
 * goal record whose worktree matches the current session's directory, never on
 * other sessions/projects; global management stays on /my_goal_manager.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { runCLI, readState, writeState, describeGoal, normalizePath, short } from "./util"

function toast(api: TuiPluginApi, variant: "info" | "success" | "warning" | "error", title: string, message: string) {
  api.ui.toast({ variant, title, message })
}

/** Find the current session's goal: the persisted record whose worktree matches cwd. */
function currentGoal(api: TuiPluginApi): { id: string; rec: any } | null {
  const st = readState()
  const cwd = normalizePath(api.state.path.directory ?? api.state.path.worktree ?? "")
  if (!cwd) return null
  let best: { id: string; rec: any } | null = null
  let bestT = -1
  for (const [id, rec] of Object.entries(st) as Array<[string, any]>) {
    const wt = normalizePath(rec?.worktree ?? "")
    if (!wt) continue
    // worktree equals cwd (or cwd is under the worktree root / vice versa)
    if (wt === cwd || wt.startsWith(cwd + "\\") || cwd.startsWith(wt + "\\")) {
      const t = Number(rec?.lastActivityAt ?? 0)
      if (t > bestT) { bestT = t; best = { id, rec } }
    }
  }
  return best
}

function noGoalHint(api: TuiPluginApi): void {
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title: "当前会话没有 Goal",
      message: "当前目录没有匹配的 Goal 记录。可用 /my_new 新建，或用 /my_goal_manager 列出全部任务。",
    })
  )
}

interface Cmd {
  name: string
  title: string
  category: string
  namespace: string
  slashName: string
  run: () => void | Promise<void>
}

export function goalCurrentCommands(api: TuiPluginApi): Cmd[] {
  const status: Cmd = {
    name: "opencode-goal-run.goal-status",
    title: "my_goal_status · 查看当前会话 Goal 状态",
    category: "Goal",
    namespace: "palette",
    slashName: "my_goal_status",
    run() {
      const g = currentGoal(api)
      if (!g) { noGoalHint(api); return }
      api.ui.dialog.setSize("xlarge")
      api.ui.dialog.replace(() =>
        api.ui.DialogAlert({ title: `当前会话 Goal（${short(g.id)}）`, message: describeGoal(g.id), })
      )
    },
  }

  const stop: Cmd = {
    name: "opencode-goal-run.goal-stop",
    title: "my_goal_stop · 停止当前会话 Goal",
    category: "Goal",
    namespace: "palette",
    slashName: "my_goal_stop",
    run() {
      const g = currentGoal(api)
      if (!g) { noGoalHint(api); return }
      api.ui.dialog.setSize("medium")
      api.ui.dialog.replace(() =>
        api.ui.DialogSelect({
          title: `停止当前 Goal（${short(g.id)}）`,
          options: [
            { title: "暂停保留（可恢复）", value: "pause" },
            { title: "彻底停止（清状态）", value: "stop" },
          ],
          onSelect: (opt) => {
            if (!opt) return
            const mode = String(opt.value)
            api.ui.dialog.replace(() =>
              api.ui.DialogConfirm({
                title: mode === "pause" ? "暂停任务" : "彻底停止",
                message: `${mode === "pause" ? "暂停" : "彻底停止并清除"} ${short(g.id)}？${mode === "pause" ? "进度与状态保留。" : "不可恢复。"}`,
                onConfirm: () => {
                  const r = runCLI(mode, g.id)
                  api.ui.dialog.clear()
                  toast(api, r.ok ? "success" : "error", mode === "pause" ? "暂停" : "停止",
                    r.ok ? `${short(g.id)} 已${mode === "pause" ? "暂停" : "停止"}` : `失败: ${r.err}`)
                },
              })
            )
          },
        })
      )
    },
  }

  const del: Cmd = {
    name: "opencode-goal-run.goal-delete",
    title: "my_goal_delete · 删除当前会话 Goal（先停再删）",
    category: "Goal",
    namespace: "palette",
    slashName: "my_goal_delete",
    run() {
      const g = currentGoal(api)
      if (!g) { noGoalHint(api); return }
      api.ui.dialog.setSize("medium")
      api.ui.dialog.replace(() =>
        api.ui.DialogConfirm({
          title: "删除任务",
          message: `先停再删 ${short(g.id)} ？此操作不可恢复。`,
          onConfirm: () => {
            const r = runCLI("delete", g.id)
            api.ui.dialog.clear()
            toast(api, r.ok ? "success" : "error", "删除", r.ok ? `已删除 ${short(g.id)}` : `失败: ${r.err}`)
          },
        })
      )
    },
  }

  const edit: Cmd = {
    name: "opencode-goal-run.goal-edit",
    title: "my_goal_edit · 编辑当前会话 Goal 目标",
    category: "Goal",
    namespace: "palette",
    slashName: "my_goal_edit",
    run() {
      const g = currentGoal(api)
      if (!g) { noGoalHint(api); return }
      const cur = (readState()[g.id]?.objective ?? "") as string
      api.ui.dialog.setSize("large")
      api.ui.dialog.replace(() =>
        api.ui.DialogPrompt({
          title: `编辑目标（${short(g.id)}）`,
          value: cur,
          onConfirm: (value) => {
            const st = readState()
            if (!st[g.id]) { toast(api, "error", "未找到", `记录 ${short(g.id)} 不存在`); return }
            if (!value || !value.trim()) { toast(api, "warning", "目标为空", "未修改。"); return }
            st[g.id].objective = value.trim()
            if (st[g.id].completed) { st[g.id].completed = false; st[g.id].completedReason = undefined }
            writeState(st)
            api.ui.dialog.clear()
            toast(api, "success", "已更新", `目标已更新 ${short(g.id)}`)
          },
          onCancel: () => api.ui.dialog.clear(),
        })
      )
    },
  }

  const restore: Cmd = {
    name: "opencode-goal-run.goal-restore",
    title: "my_goal_restore · 恢复当前会话 Goal",
    category: "Goal",
    namespace: "palette",
    slashName: "my_goal_restore",
    run() {
      const g = currentGoal(api)
      if (!g) { noGoalHint(api); return }
      api.ui.dialog.setSize("medium")
      api.ui.dialog.replace(() =>
        api.ui.DialogConfirm({
          title: "恢复当前 Goal",
          message: `将 ${short(g.id)} 标记为可继续（解除暂停/完成）？`,
          onConfirm: () => {
            const st = readState()
            if (!st[g.id]) { toast(api, "error", "未找到", `记录 ${short(g.id)} 不存在`); return }
            st[g.id].paused = false
            st[g.id].pausedReason = undefined
            if (st[g.id].completed) { st[g.id].completed = false; st[g.id].completedReason = undefined }
            writeState(st)
            api.ui.dialog.clear()
            toast(api, "success", "已恢复", `${short(g.id)} 已标记可继续；若需在当前会话立即运行，/my_new 或交给会话执行 goal_set。`)
          },
        })
      )
    },
  }

  return [status, stop, del, edit, restore]
}
