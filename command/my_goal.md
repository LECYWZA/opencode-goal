---
description: 以目标模式自动运行：开始前让你确认并行度/轮次/无进展策略等，AI持续工作到完成并自我进化
---
以【目标模式】开启一个会**自动持续运行**、直到目标完成为止的任务。目标如下：

$ARGUMENTS

如果你的目标文本里**没有**带内联参数（支持：`agent=3`、`max_turns=50`、`recovery=auto-research|pause|continue`、`recovery_attempts=5`、`worktree_policy=serial|parallel`、`turn_timeout_s=120`、`no_progress_turns=10`、`converge_turns=5`、`idle_interval_ms=2000`），请**先逐一用 question 工具弹出选择让用户确认**下面每一项（不要擅自假设）：
1. 并行 agent(subagent) 数量：建议选项 `[1, 2, 3, 5, 10]`（单选）
2. 自动运行轮次策略：建议 `["无限(直到完成/收敛)", "限制轮次(例如50轮)"]`（单选；若限轮次再追问具体数字）
3. 无进展时的处理策略：建议 `["自我进化(自动分析+搜索Bing/GitHub/HF+换思路继续) ", "暂停等我", "无条件硬继续"]`（对应 recovery=auto-research / pause / continue，单选）
4. 单轮静默超时秒数（模型在此时间内无任何输出/动作才算超时，超时自动中断并进入下一轮诊断）：建议默认 `300`，可选 `[60, 120, 300, 600]`（单选）
5. 同项目并发策略：建议 `["串行(同一目录互斥,防冲突,默认)", "并行(可同时推进,需注意别互相覆盖)"]`（对应 worktree_policy=serial / parallel，单选）

然后把「用户明确给出或选择」的所有参数连同目标传给 goal_set：
`goal_set(goal=<目标>, mode="goal", agent=?, max_turns=?, recovery=?, worktree_policy=?, turn_timeout_s=?, ...)`，然后立刻开始第一轮。

规则：
- 每轮做实际工作并调用 goal_progress 记录进展；
- 真正完整达成才调用 goal_mark_done（附可验证证据），不许提前误报；
- 卡住无进展时，按所选策略处理；默认应主动分析原因、用 goal_research（Bing/GitHub/HuggingFace）与网络搜索找解法、换思路继续，而非停下；
- 运行中用户可随时用 goal_configure 调整参数。
