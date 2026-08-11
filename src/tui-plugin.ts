/**
 * opencode-goal-run — TUI plugin entry (client-side, zero LLM).
 * Registers /my_* slash commands that operate through goal-cli + persisted
 * state, so task management never depends on the model.
 */
import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { goalManagerCommands } from "./tui/goal-manager"

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-goal-run-tui",
  async tui(api) {
    const commands = [...goalManagerCommands(api)]
    api.keymap.registerLayer({ commands })
  },
}

export default plugin
