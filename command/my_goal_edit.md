---
description: 修改自动任务（目标回输入框直接填）：/my_goal_edit <新目标 或 参数键=值>
---
用户要【修改】目标任务。`$ARGUMENTS` 即用户回输入框填入的修改内容。按以下规则【机械执行】，不要做多余分析、不要额外反问。

先展示当前任务清单作为对照（原样展示 CLI 输出）：

!`goal-cli list`

然后按规则执行：
1. 若 `$ARGUMENTS` 包含 `参数=值`（如 `max_turns=50`、`recovery=pause`、`turn_timeout_s=600`、`worktree_policy=parallel` 等，可多个用空格分隔，对应 key 必须是：agent / max_turns / recovery / recovery_attempts / worktree_policy / worktree_parallel_sessions / no_progress_turns / converge_turns / turn_timeout_s / idle_interval_ms）→ 逐个调用 `goal_configure(键=值)` 修改【当前会话】运行参数（保留进度）。
2. 否则 `$ARGUMENTS` 整体视为【新的任务目标文本】→ 调用 `goal_continue(objective=$ARGUMENTS)` 应用并继续（知情提示：会重置轮次计数器，进度日志保留；若当前无活动目标，改用 goal_set(goal=$ARGUMENTS)）。
3. 修改后调用 `goal_status` 回显新目标/新生效参数，并明确告知用户"已更新"。

若目标是历史遗留（不在当前会话）：提示用户先 `/my_goal_restore` 把它恢复到当前会话再编辑，或直接对其用 `/my_goal_delete` 删除。
