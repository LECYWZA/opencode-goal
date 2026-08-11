/**
 * opencode-goal-run — TUI plugin entry (client-side, zero LLM for management;
 * only assigning a running engine hands a goal_set(...) back to the session).
 * Registers /my_new, /my_goal_manager, /my_sessions.
 */
import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { goalNewCommands } from "./tui/goal-new"
import { goalManagerCommands } from "./tui/goal-manager"
import { sessionsCommands } from "./tui/sessions"

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-goal-run-tui",
  async tui(api) {
    const commands = [
      ...goalNewCommands(api),
      ...goalManagerCommands(api),
      ...sessionsCommands(api),
    ]
    api.keymap.registerLayer({ commands })
  },
}

export default plugin
