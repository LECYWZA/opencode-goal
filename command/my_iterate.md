---
description: 以迭代(自我优化)模式自动运行：反复实现→自测→改进→越做越好，直到收敛
---
以【迭代 / 自我优化模式】开启一个会**自动反复运行**、把结果越做越好的任务。目标如下：

$ARGUMENTS

如果你的目标文本里**没有**带内联参数（支持格式：`agent=3`、`max_turns=50`、`no_progress_turns=10`、`converge_turns=5`、`turn_timeout_s=300`、`idle_interval_ms=2000`），请**先用 question 工具弹出选择让用户确认**下方参数（不要擅自假设默认值）：
- 并行 agent(subagent) 数量：建议选项 `[1, 2, 3, 5, 10]`（单选）
- 自动迭代轮次策略：建议选项 `["无限(直到收敛)", "限制轮次(例如100轮)"]`（单选）

然后把「用户明确给出或选择」的所有参数连同目标一起传给 goal_set：
`goal_set(goal=<目标>, mode="iterate", agent=?, max_turns=?, converge_turns=?, ...)`，然后立刻开始第一轮。

规则（每轮必须）：
1. 实现 / 推进当前方案；
2. 自测 / 运行校验；
3. 对比目标找出差距与可优化之处；
4. 调用 goal_progress(note=<本轮改进了什么>) 记录增量；
5. 引擎会自动续跑下一轮。
只有当真正无法再做出有意义改进（多轮无进展）时才调用 goal_mark_done（附证据）。运行中用户可随时用 goal_configure 调整参数。
