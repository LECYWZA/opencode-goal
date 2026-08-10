---
description: 以迭代(自我优化)模式自动运行：反复实现→自测→改进→越做越好，受挫时自我进化
---
以【迭代 / 自我优化模式】开启一个会**自动反复运行**、把结果越做越好的任务。目标如下：

$ARGUMENTS

如果你的目标文本里**没有**带内联参数（支持：`agent=3`、`max_turns=100`、`recovery=auto-research|pause|continue`、`recovery_attempts=5`、`turn_timeout_s=120`、`converge_turns=5`、`no_progress_turns=10`、`idle_interval_ms=2000`），请**先逐一用 question 工具弹出选择让用户确认**下面每一项（不要擅自假设）：
1. 并行 agent(subagent) 数量：建议选项 `[1, 2, 3, 5, 10]`（单选）
2. 自动迭代轮次策略：建议 `["无限(直到收敛)", "限制轮次(例如100轮)"]`（单选）
3. 无进展时的处理策略：建议 `["自我进化(自动分析+搜索Bing/GitHub/HF+换思路继续) ", "暂停等我", "无条件硬继续"]`（对应 recovery=auto-research / pause / continue，单选）
4. 单轮静默超时秒数（模型在此时间内无任何输出/动作才算超时）：建议默认 `300`，可选 `[60, 120, 300, 600]`（单选）

然后把「用户明确给出或选择」的所有参数连同目标传给 goal_set：
`goal_set(goal=<目标>, mode="iterate", agent=?, max_turns=?, recovery=?, turn_timeout_s=?, converge_turns=?, ...)`，然后立刻开始第一轮。

规则（每轮）：
1. 实现 / 推进当前方案；
2. 自测 / 运行校验；
3. 对比目标找差距与可优化之处；
4. 调用 goal_progress(note=<本轮改进了什么>) 记录增量；
5. 引擎自动续跑下一轮。
受挫（无进展/无思路）时：主动分析原因、用 goal_research（Bing/GitHub/HuggingFace）与网络搜索找解法、换思路继续，而非常规停下。只有在真正无法继续改进（或遗reach收敛上限）时才调用 goal_mark_done。运行中可随时用 goal_configure 调整。
