---
description: 以无限模式自动运行：永不自动停止（无收敛/无进展判定），除非你手动命令触发停止
---
以【无限迭代模式】开启一个**永不自动停止**的任务：反复实现→自测→改进→越做越好，**除非用户手动用 /my_goal_stop、/my_goal_delete 或 goal-cli 停止，否则一直迭代**。目标如下：

$ARGUMENTS

如果你的目标文本里**没有**带内联参数（支持：`agent=3`、`max_turns=-1`、`recovery=auto-research|pause|continue`、`recovery_attempts=5`、`worktree_policy=serial|parallel`、`worktree_parallel_sessions=3`、`turn_timeout_s=120`、`idle_interval_ms=2000`），请**先逐一用 question 工具弹出选择让用户确认**下面每一项（不要擅自假设）：
1. 并行 agent(subagent) 数量：建议选项 `[1, 2, 3, 5, 10]`（单选）
2. 自动运行轮次：**固定为无限-1（不自动停）**，仅在用户手动停止时结束；如确需兜底上限可填具体数字
3. 无进展时的处理策略：建议 `["自我进化(自动分析+搜索换思路继续，永不暂停) ", "纯硬继续"]`（对应 recovery=auto-research / continue，单选；infinite 模式下二者都不会自动暂停）
4. 单轮静默超时秒数（模型在此时间内无任何输出/动作才算超时，超时中断本轮进下一轮）：建议默认 `300`，可选 `[60, 120, 300, 600]`（单选）
5. 同项目并发策略：建议 `["串行(同一目录互斥,防冲突,默认)", "并行(彻底不互斥)"]`（对应 worktree_policy=serial / parallel，单选）

然后把「用户明确给出或选择」的所有参数连同目标传给 goal_set：
`goal_set(goal=<目标>, mode="infinite", agent=?, max_turns=-1, recovery=?, worktree_policy=?, turn_timeout_s=?, ...)`，然后立刻开始第一轮。

规则（每轮）：
1. 实现 / 推进当前方案；
2. 自测 / 运行校验；
3. 对比目标找差距与可优化之处；
4. 调用 goal_progress(note=<本轮改进了什么>) 记录增量；
5. 引擎自动续跑下一轮。
【无限模式铁律】：
- **不要**自行调用 goal_mark_done（即使看起来已收敛、或暂时没思路）；收敛则换方向深挖，没思路则用 goal_research（Bing/GitHub/HuggingFace）与网络搜索找解法继续；
- 引擎在设计上**忽略**「连续N轮无进展」与「恢复次数用尽」这两类自动刹车——它只会在你手动调用 /my_goal_stop、/my_goal_delete、goal-cli，或在对话里明确说"停/完成"时才停止；
- 想让它停下：告诉我停即可，或直接 `/my_goal_stop <标识> stop` / `goal-cli delete <标识>`。
