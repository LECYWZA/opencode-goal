/**
 * Smoke test for the TUI plugin (no real opencode TUI).
 * Instantiates the plugin with a minimal fake api, asserts the three /my_*
 * commands register, and invokes each run() to ensure the logic path does not
 * throw. TUI rendering / real load is validated in-process only by structure.
 */
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const repo = process.env.GOAL_RUN_REPO ?? "C:/Users/Administrator/opencode-goal-run"
const pluginMod = await import(`file:///${repo.replace(/\\/g, "/")}/dist/tui.js`)
const plugin = pluginMod.default

if (plugin?.id !== "opencode-goal-run-tui" || typeof plugin?.tui !== "function") {
  console.error("FAIL module shape wrong:", plugin)
  process.exit(1)
}

const log = []
const fakeDialog = {
  open: true,
  depth: 0,
  size: "medium",
  replace(fn) { try { this.last = fn() } catch (e) { log.push("replace-err:" + e.message) } },
  clear() {},
  setSize() {},
}

const ui = {
  Dialog: () => ({}),
  DialogAlert: (p) => (log.push("alert:" + (p.title ?? "")) || {}),
  DialogConfirm: (p) => (log.push("confirm:" + (p.title ?? "")) || {}),
  DialogPrompt: (p) => (log.push("prompt:" + (p.title ?? "")) || {}),
  DialogSelect: (p) => (log.push("select:" + (p.title ?? "")) || ({})),
  Slot: () => null,
  Prompt: () => ({}),
  toast: (t) => log.push("toast:" + (t?.title ?? "") + (t?.message ?? "")),
  dialog: fakeDialog,
}

const api = {
  keymap: { registerLayer({ commands }) { api.__commands = commands } },
  route: {
    current: { name: "session", params: { sessionID: "ses_test" } },
    navigate: (n, p) => log.push("navigate:" + n),
  },
  state: {
    path: { directory: "E:/Codex/论文", worktree: "E:/Codex/论文", state: "", config: "" },
    session: { count: () => 0, get: () => undefined, diff: () => [], messages: () => [], status: () => undefined, permission: () => [], question: () => [] },
  },
  client: {
    session: {
      list: async () => ({ data: [] }),
      prompt: async () => ({}),
    },
    V2SessionList: async () => ({ data: [] }),
    V2SessionPrompt: async () => ({}),
  },
  ui,
}
api.state.session.diff = api.state.session.diff.bind(api.state.session)

await plugin.tui(api)
const commandNames = (api.__commands ?? []).map((c) => c.slashName || c.name)
console.log("registered:", JSON.stringify(commandNames))

for (const want of ["my_new", "my_goal_manager", "my_sessions"]) {
  if (!commandNames.includes(want)) {
    console.error(`FAIL missing command ${want}`)
    process.exit(1)
  }
}

// Invoke each run() defensively.
for (const c of api.__commands ?? []) {
  const before = log.length
  try {
    await c.run()
  } catch (e) {
    console.error(`FAIL run() threw for ${c.slashName}:`, e && e.message)
    process.exit(1)
  }
  log.push(`ran:${c.slashName || c.name}`)
  void before
}

console.log("OK all commands registered and run() executed without throwing")
console.log("(dialog/toast interactions:)", log.filter((l) => /^(select|prompt|confirm|alert|toast):/.test(l)).slice(0, 12))
process.exit(0)
