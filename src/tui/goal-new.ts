/**
 * /my_new — creation wizard (zero-LLM UI, single-LLM handoff to actually start
 * the engine since goal_set only exists on the server side).
 * Flow: target -> mode (goal / iterate-N / infinite) -> a small set of params
 * each offering presets plus a "自定义…" free-input -> review confirm -> submit
 * a goal_set(...) instruction to the current session (fallback: user copies).
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

interface Cfg {
  target: string
  mode: "goal" | "iterate" | "infinite"
  maxTurns?: number
  agent: number
  recovery: string
  turnTimeoutS: number
  worktreePolicy: string
  parallelSessions: number
  [k: string]: unknown
}

function toast(api: TuiPluginApi, variant: "info" | "success" | "warning" | "error", title: string, message: string) {
  api.ui.toast({ variant, title, message })
}

function buildInstruction(cfg: Cfg): string {
  const args = [`goal="${(cfg.target ?? "").replace(/"/g, '\\"')}"`, `mode="${cfg.mode}"`]
  if (cfg.mode === "iterate" && typeof cfg.maxTurns === "number" && cfg.maxTurns > 0) args.push(`max_turns=${cfg.maxTurns}`)
  if (cfg.agent) args.push(`agent=${cfg.agent}`)
  if (cfg.recovery) args.push(`recovery=${cfg.recovery}`)
  if (cfg.turnTimeoutS) args.push(`turn_timeout_s=${cfg.turnTimeoutS}`)
  if (cfg.worktreePolicy) args.push(`worktree_policy=${cfg.worktreePolicy}`)
  if (cfg.parallelSessions && cfg.parallelSessions > 1) args.push(`worktree_parallel_sessions=${cfg.parallelSessions}`)
  return `goal_set(${args.join(", ")})`
}

/** Hand the assembled goal_set(...) to the current session's agent. */
async function submit(api: TuiPluginApi, cfg: Cfg): Promise<void> {
  const instruction = buildInstruction(cfg)
  const c = api.client as any
  const sid =
    api.route.current?.name === "session"
      ? (api.route.current as any).params?.sessionID
      : undefined
  const attempts: Array<() => Promise<unknown>> = []
  if (c?.session?.prompt && typeof c.session.prompt === "function") {
    attempts.push(() =>
      c.session.prompt({
        path: { id: sid },
        body: { parts: [{ type: "text", text: instruction }] },
      })
    )
  }
  if (c?.V2SessionPrompt && typeof c.V2SessionPrompt === "function") {
    attempts.push(() => c.V2SessionPrompt({ body: { id: sid, parts: [{ type: "text", text: instruction }] } }))
  }
  for (const fn of attempts) {
    try {
      await fn()
      api.ui.dialog.clear()
      toast(api, "success", "已发送启动指令", "已把 goal_set(...) 交给当前会话执行。若未启动，请手动发送下面的文本。")
      return
    } catch {
      continue
    }
  }
  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({ title: "请手动启动", message: `未能自动发送给当前会话。请复制并在输入框发送：\n\n${instruction}`, })
  )
}

/** stepwise param editing: each offers presets + a 自定义… free input. */
function runParams(api: TuiPluginApi, cfg: Cfg, idx: number): void {
  const steps: Array<{
    key: keyof Cfg
    title: string
    presets: Array<{ title: string; value: string }>
    apply: (raw: string) => string | undefined
    norm: (raw: string) => string
  }> = [
    {
      key: "agent",
      title: "并行 agent 数量",
      presets: [{ title: "1", value: "1" }, { title: "2", value: "2" }, { title: "3", value: "3" }, { title: "5", value: "5" }, { title: "10", value: "10" }],
      norm: (s) => s,
      apply: (v) => { cfg.agent = parseInt(v, 10) || 1; return undefined },
    },
    {
      key: "recovery",
      title: "无进展处理策略",
      presets: [
        { title: "自我进化(分析+搜索+换思路继续)", value: "auto-research" },
        { title: "暂停等我", value: "pause" },
        { title: "无条件硬继续", value: "continue" },
      ],
      norm: (s) => s.trim(),
      apply: (v) => { cfg.recovery = v; return undefined },
    },
    {
      key: "turnTimeoutS",
      title: "单轮静默超时(秒)",
      presets: [{ title: "60", value: "60" }, { title: "120", value: "120" }, { title: "300", value: "300" }, { title: "600", value: "600" }, { title: "1200", value: "1200" }],
      norm: (s) => s.trim(),
      apply: (v) => { cfg.turnTimeoutS = parseInt(v, 10) || 300; return undefined },
    },
    {
      key: "worktreePolicy",
      title: "同项目并发策略",
      presets: [
        { title: "串行(互斥,默认)", value: "serial" },
        { title: "串行但同实例内N路并行(将再输入N)", value: "serialN" },
        { title: "并行(彻底不互斥)", value: "parallel" },
      ],
      norm: (s) => s.trim(),
      apply: (v) => {
        if (v === "serialN") {
          cfg.worktreePolicy = "serial"
          return "askN"
        }
        cfg.worktreePolicy = v
        return undefined
      },
    },
  ]
  if (idx >= steps.length) {
    review(api, cfg)
    return
  }
  const step = steps[idx]
  const options = [...step.presets.map((p) => ({ title: p.title, value: p.value })), { title: "自定义…", value: "__custom__" }]
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `${step.title}（步骤 ${idx + 1}/${steps.length}）`,
      options,
      onSelect: (opt) => {
        if (!opt) return
        if (opt.value === "__custom__") {
          api.ui.dialog.replace(() =>
            api.ui.DialogPrompt({
              title: `手动输入：${step.title}`,
              onConfirm: (v) => {
                const a = step.apply(step.norm(v))
                if (a === "askN") {
                  api.ui.dialog.replace(() =>
                    api.ui.DialogPrompt({
                      title: "同实例内并行 N 路（1=纯串行）",
                      onConfirm: (n) => {
                        cfg.parallelSessions = parseInt(n, 10) || 1
                        runParams(api, cfg, idx + 1)
                      },
                      onCancel: () => runParams(api, cfg, idx + 1),
                    })
                  )
                  return
                }
                runParams(api, cfg, idx + 1)
              },
              onCancel: () => runParams(api, cfg, idx + 1),
            })
          )
          return
        }
        const a = step.apply(String(opt.value))
        if (a === "askN") {
          api.ui.dialog.replace(() =>
            api.ui.DialogPrompt({
              title: "同实例内并行 N 路（1=纯串行）",
              onConfirm: (n) => {
                cfg.parallelSessions = parseInt(n, 10) || 1
                runParams(api, cfg, idx + 1)
              },
              onCancel: () => runParams(api, cfg, idx + 1),
            })
          )
          return
        }
        runParams(api, cfg, idx + 1)
      },
    })
  )
}

function review(api: TuiPluginApi, cfg: Cfg): void {
  const text = buildInstruction(cfg).replace(/^goal_set\(/, "").replace(/\)$/, "")
  const summary = `目标: ${(cfg.target ?? "").slice(0, 120)}\n\n${text.split(", ").join("\n")}`
  api.ui.dialog.replace(() =>
    api.ui.DialogConfirm({
      title: "确认创建任务",
      message: summary,
      onConfirm: () => void submit(api, cfg),
      onCancel: () => api.ui.dialog.clear(),
    })
  )
}

export function goalNewCommands(api: TuiPluginApi) {
  return [
    {
      name: "opencode-goal-run.goal-new",
      title: "新建 Goal 任务（目标/固定迭代/无限，参数可选项或手输）",
      category: "Goal",
      namespace: "palette",
      slashName: "my_new",
      async run() {
        const cfg: Cfg = {
          target: "",
          mode: "goal",
          agent: 1,
          recovery: "auto-research",
          turnTimeoutS: 300,
          worktreePolicy: "serial",
          parallelSessions: 1,
        }
        api.ui.dialog.replace(() =>
          api.ui.DialogPrompt({
            title: "任务目标",
            placeholder: "描述你想让 AI 自动完成/优化的事情…",
            onConfirm: (t) => {
              if (!t || !t.trim()) {
                toast(api, "warning", "目标为空", "请输入目标后再开始。")
                return
              }
              cfg.target = t.trim()
              chooseMode(api, cfg)
            },
            onCancel: () => api.ui.dialog.clear(),
          })
        )
      },
    },
  ]
}

function chooseMode(api: TuiPluginApi, cfg: Cfg): void {
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "选择模式",
      placeholder: "模式",
      options: [
        { title: "目标模式（达成即停）", value: "goal" },
        { title: "固定迭代（输入次数，0=无限）", value: "iterate" },
        { title: "无限迭代（永不自动停，仅手动停）", value: "infinite" },
      ],
      onSelect: (opt) => {
        if (!opt) return
        const mode = String(opt.value)
        if (mode === "iterate") {
          api.ui.dialog.replace(() =>
            api.ui.DialogPrompt({
              title: "固定迭代次数（0 = 无限）",
              value: "0",
              onConfirm: (n) => {
                const num = parseInt(n, 10)
                if (Number.isNaN(num) || num < 0) {
                  toast(api, "warning", "次数无效", "请输入 ≥0 的整数。")
                  return
                }
                if (num === 0) {
                  cfg.mode = "infinite"
                } else {
                  cfg.mode = "iterate"
                  cfg.maxTurns = num
                }
                runParams(api, cfg, 0)
              },
              onCancel: () => api.ui.dialog.clear(),
            })
          )
          return
        }
        cfg.mode = mode as Cfg["mode"]
        runParams(api, cfg, 0)
      },
    })
  )
}
