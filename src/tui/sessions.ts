/**
 * /my_sessions — cross-project session browser.
 * Lists every opencode session grouped by project directory, then switches you
 * into the chosen session (and its project directory) via route.navigate.
 * Pure client-side; no LLM. Defensive client probing so a changed SDK never
 * crashes the menu.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { normalizePath } from "./util"

interface Sess {
  id: string
  title: string
  directory: string
  projectID: string
  agent?: string
  model?: string
  updated: number
}

function toast(api: TuiPluginApi, variant: "info" | "success" | "warning" | "error", title: string, message: string) {
  api.ui.toast({ variant, title, message })
}

/** Try every plausible SDK surface to list sessions across ALL projects. */
async function listSessions(api: TuiPluginApi): Promise<Sess[]> {
  const c = api.client as any
  const probes: Array<[string, () => Promise<unknown>]> = []
  const proj = { roots: true as boolean | "true" | "false", scope: "project" as const }
  if (c?.session?.list && typeof c.session.list === "function") {
    probes.push(["session.list(roots)", () => c.session.list({ query: proj })])
    probes.push(["session.list()", () => c.session.list()])
  }
  if (c?.V2SessionList && typeof c.V2SessionList === "function") {
    probes.push(["V2SessionList(roots)", () => c.V2SessionList({ query: proj })])
    probes.push(["V2SessionList()", () => c.V2SessionList()])
  }
  if (c?.listSessions && typeof c.listSessions === "function") {
    probes.push(["listSessions()", () => c.listSessions(proj)])
  }
  for (const [, fn] of probes) {
    try {
      const r = await fn()
      const arr: unknown[] =
        Array.isArray(r) ? r
        : Array.isArray((r as any)?.data) ? (r as any).data
        : Array.isArray((r as any)?.data?.sessions) ? (r as any).data.sessions
        : []
      if (!arr.length) continue
      return arr
        .map((x: any) => ({
          id: String(x?.id ?? ""),
          title: String(x?.title ?? x?.slug ?? ""),
          directory: String(x?.directory ?? x?.path ?? x?.projectID ?? ""),
          projectID: String(x?.projectID ?? ""),
          agent: x?.agent ? String(x.agent) : undefined,
          model: x?.model?.id ? String(x.model.id) : x?.model ? String(x.model) : undefined,
          updated: Number(x?.time?.updated ?? x?.updated ?? 0),
        }))
        .filter((s) => s.id && s.title)
    } catch {
      continue
    }
  }
  return []
}

async function listAndBrowse(api: TuiPluginApi): Promise<void> {
  const all = await listSessions(api)
  if (!all.length) {
    toast(api, "warning", "无会话", "未能读取任何会话（SDK 接口探测失败或暂无会话）。")
    return
  }
  // Group by normalized directory, current-first.
  const curDir = normalizePath(api.state.path.directory ?? "")
  const groups = new Map<string, Sess[]>()
  let curKey: string | undefined
  for (const s of all) {
    const d = normalizePath(s.directory) || "(未知目录)"
    if (curDir && d === curDir) curKey = d
    if (!groups.has(d)) groups.set(d, [])
    groups.get(d)!.push(s)
  }
  const entries = [...groups.entries()]
  entries.sort((a, b) => (a[0] === curKey ? -1 : b[0] === curKey ? 1 : 0))
  entries.forEach(([, v]) => v.sort((a, b) => b.updated - a.updated))

  if (entries.length === 1 && entries[0][1].length === 1) {
    openSession(api, entries[0][1][0])
    return
  }
  const dirOptions = entries.map(([d, list]) => ({
    title: `${d === curKey ? "（当前目录）" : ""} ${d}  · ${list.length} 个会话`,
    value: d,
    description: `${list[0].title}${list.length > 1 ? ` 等 ${list.length} 个` : ""}`,
  }))
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `选择项目目录（共 ${groups.size} 个）`,
      options: dirOptions,
      onSelect: (opt) => {
        if (!opt) return
        const key = String(opt.value)
        const list = groups.get(key)
        if (!list) return
        if (list.length === 1) { openSession(api, list[0]); return }
        const sessOptions = list.map((s) => ({
          title: s.title || s.id,
          value: s.id,
          description: `${s.agent ? `${s.agent} · ` : ""}${s.updated ? new Date(s.updated).toLocaleString() : ""} · ${s.model ?? ""}`,
        }))
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: `选择会话（${key}）`,
            options: sessOptions,
            onSelect: (opt2) => {
              if (!opt2) return
              const sess = list.find((x) => x.id === String(opt2.value))
              if (sess) openSession(api, sess)
            },
          })
        )
      },
    })
  )
}

function openSession(api: TuiPluginApi, s: Sess): void {
  try {
    api.route.navigate("session", { sessionID: s.id })
    api.ui.dialog.clear()
    toast(api, "success", "已切换", `已进入会话「${s.title}」(${s.directory})`)
  } catch (e) {
    toast(api, "error", "切换失败", e instanceof Error ? e.message : String(e))
  }
}

export function sessionsCommands(api: TuiPluginApi) {
  return [
    {
      name: "opencode-goal-run.sessions",
      title: "my_sessions · 跨项目会话浏览/切换（按目录分组）",
      category: "Session",
      namespace: "palette",
      slashName: "my_sessions",
      async run() {
        await listAndBrowse(api)
      },
    },
  ]
}
