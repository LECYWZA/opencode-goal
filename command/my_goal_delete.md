---
description: 删除自动任务（先停再删，CLI直连，不经AI推理）：/my_goal_delete <任务标识>
---
CLI 直连删除任务，动作由 CLI 完成，你只负责【执行命令并原样展示输出】，不要重新分析、不要总结。
CLI 会先写停止信号让引擎停下，再移除持久化状态（满足"先停止再删除"）。

用法：`/my_goal_delete <id或关键词>`

$ARGUMENTS 即用户填入的标识，用 Bash 工具执行以下命令（若含空格请给标识加引号）：

goal-cli delete $ARGUMENTS

执行后把 CLI 输出原样展示给用户。若报"no matching"，再执行一次下面命令把现有任务清单展示给用户，提示用会话ID重跑：

goal-cli list
