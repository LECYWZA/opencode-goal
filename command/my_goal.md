---
description: 以目标模式自动运行：开始前让你确认并行度等参数，然后AI持续工作到完成
---
以【目标模式】开启一个会**自动持续运行**、直到目标完成为止的任务。目标如下：

$ARGUMENTS

如果你的目标文本里**没有**带内联参数（支持格式：`agent=3`、`max_turns=50`、`no_progress_turns=10`、`converge_turns=5`、`turn_timeout_s=300`、`idle_interval_ms=2000`），请**先用 question 工具弹出选择让用户确认**下方参数（不要擅自假设默认值）：
- 并行 agent(subagent) 数量：建议选项 `[1, 2, 3, 5, 10]`（单选）
- 自动运行轮次策略：建议选项 `["无限(直到完成/收敛)", "限制轮次(例如50轮)"]`（单选）；若选"限制轮次"再追问具体数字。

然后把「用户明确给出或选择」的所有参数连同目标一起传给 goal_set：
`goal_set(goal=<目标>, mode="goal", agent=?, max_turns=?, ...)`，然后立刻开始第一轮。

规则：
- 每轮都要做实际工作，并调用 goal_progress 记录进展；
- 只有真正完整达成时才调用 goal_mark_done（必须附可验证证据），不许提前误报完成；
- 若确实卡住无法推进，调用 goal_pause 说明原因；
- 运行过程中用户可随时用 goal_configure 调整参数。
