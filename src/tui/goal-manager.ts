/**
 * /my_goal_manager — zero-LLM task management panel.
 * Reuses goal-cli (candidates/pause/stop/delete) for all state mutations and
 * the persisted state file, so it never touches the LLM. "Edit objective" and
 * "resume" operate on the persisted record directly.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { runCLI, readState, writeState, describeGoal, short, normalizePath } from "./util"

interface GoalRec {
  id: string
  mode: string
  worktree: string
  turns: number
  paused: boolean
  completed: boolean
  objective: string
  overrides: Record<string, unknown>
  label: string
  description: string
}

function candidates(api: TuiPluginApi): { current: GoalRec[]; elsewhere: GoalRec[] } {
  const cwd = api.state.path.directory ?? api.state.path.worktree ?? ""
  const r = runCLI("candidates", cwd)
  if (!r.ok) return { current: [], elsewhere: [] }
  try {
    const j = JSON.parse(r.out)
    return { current: j.current ?? [], elsewhere: j.elsewhere ?? [] }
  } catch {
    return { current: [], elsewhere: [] }
  }
}

function toast(api: TuiPluginApi, variant: "info" | "success" | "warning" | "error", title: string, message: string) {
  api.ui.toast({ variant, title, message })
}

/** Recursive action menu for a chosen goal id. */
function showActions(api: TuiPluginApi, id: string): void {
  const s = readState()[id]
  if (!s) {
    api.ui.dialog.replace(() =>
      api.ui.DialogAlert({ title: "未找到任务", message: `state 中不存在 ${id}。`, })
    )
    return
  }
  const actions = [
    { title: "查看详情", value: "detail", description: "显示完整目标与参数" },
    { title: "暂停保留（可恢复）", value: "pause" },
    { title: "彻底停止（清状态）", value: "stop" },
    { title: "先停再删", value: "delete" },
    { title: "解除暂停 / 标记继续", value: "resume" },
    { title: "编辑目标", value: "edit" },
  ]
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `操作任务 ${short(id)}`,
      options: actions,
      onSelect: (opt) => {
        if (!opt) return
        dispatchAction(api, id, String(opt.value))
      },
    })
  )
}

function dispatchAction(api: TuiPluginApi, id: string, action: string): void {
  switch (action) {
    case "detail": {
      api.ui.dialog.setSize("xlarge")
      api.ui.dialog.replace(() =>
        api.ui.DialogAlert({ title: `任务详情 ${short(id)}`, message: describeGoal(id), })
      )
      return
    }
    case "pause": {
      api.ui.dialog.replace(() =>
        api.ui.DialogConfirm({
          title: "暂停任务",
          message: `暂停 ${short(id)}？进度与状态保留，可稍后恢复。`,
          onConfirm: () => {
            const r = runCLI("pause", id)
            api.ui.dialog.clear()
            toast(api, r.ok ? "success" : "error", "暂停", r.ok ? `已暂停 ${short(id)}` : `暂停失败: ${r.err}`)
          },
        })
      )
      return
    }
    case "stop": {
      api.ui.dialog.replace(() =>
        api.ui.DialogConfirm({
          title: "彻底停止",
          message: `彻底停止并清除 ${short(id)} 的状态？不可恢复。`,
          onConfirm: () => {
            const r = runCLI("stop", id)
            api.ui.dialog.clear()
            toast(api, r.ok ? "success" : "error", "停止", r.ok ? `已停止 ${short(id)}` : `停止失败: ${r.err}`)
          },
        })
      )
      return
    }
    case "delete": {
      api.ui.dialog.replace(() =>
        api.ui.DialogConfirm({
          title: "删除任务",
          message: `删除 ${short(id)}（先停再删，含历史记录）？`,
          onConfirm: () => {
            const r = runCLI("delete", id)
            api.ui.dialog.clear()
            toast(api, r.ok ? "success" : "error", "删除", r.ok ? `已删除 ${short(id)}` : `删除失败: ${r.err}`)
          },
        })
      )
      return
    }
    case "resume": {
      const r = { ok: true, err: "" }
      const st = readState()
      const rec = st[id]
      if (rec) {
        rec.paused = false
        rec.pausedReason = undefined
        if (rec.completed) { rec.completed = false; rec.completedReason = undefined }
        writeState(st)
      }
      api.ui.dialog.clear()
      toast(api, r.ok ? "success" : "error", "继续",
        rec ? `已标记 ${short(id)} 为可继续。若其在运行中的会话/引擎会自动续跑；否则可用 /my_goal_restore 在当前会话恢复。` : `未找到 ${short(id)}`)
      return
    }
    case "edit": {
      const cur = (readState()[id]?.objective ?? "") as string
      api.ui.dialog.setSize("large")
      api.ui.dialog.replace(() =>
        api.ui.DialogPrompt({
          title: `编辑目标（${short(id)}）`,
          value: cur,
          onConfirm: (value) => {
            const st = readState()
            if (st[id]) {
              st[id].objective = value
              if (st[id].completed) { st[id].completed = false; st[id].completedReason = undefined }
              writeState(st)
            }
            api.ui.dialog.clear()
            toast(api, "success", "已更新", `目标已更新 ${short(id)}`)
          },
        })
      )
      return
    }
  }
}

export function goalManagerCommands(api: TuiPluginApi) {
  void normalizePath
  return [
    {
      name: "opencode-goal-run.goal-manager",
      title: "my_goal_manager · Goal 管理面板（查看/暂停/停止/删除/编辑）",
      category: "Goal",
      namespace: "palette",
      slashName: "my_goal_manager",
      run() {
        api.ui.dialog.setSize("medium")
        const { current, elsewhere } = candidates(api)
        const options = [
          ...current.map((r) => ({ title: `${r.label}（当前目录）`, value: r.id, description: r.description })),
          ...elsewhere.map((r) => ({ title: r.label, value: r.id, description: r.description })),
        ]
        if (options.length === 0) {
          toast(api, "info", "无任务", "当前没有任何持久化的 Goal 任务。")
          return
        }
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: `选择要管理的 Goal 任务（共 ${options.length}）`,
            options,
            onSelect: (opt) => {
              if (!opt) return
              showActions(api, String(opt.value))
            },
          })
        )
      },
    },
  ]
}
