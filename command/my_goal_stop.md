---
description: 停止自动任务（CLI直连，不经AI推理）：/my_goal_stop <任务标识> pause|stop
---
CLI 直连停止任务，动作由 CLI 完成，你只负责【执行命令并原样展示输出】，不要重新分析、不要总结。

用法：`/my_goal_stop <id或关键词> <动作>`
- 动作 `pause`：暂停保留（可恢复），记录保留，引擎停止
- 动作 `stop`：彻底终止（清状态），等同 abort
- 未给动作默认为 `stop`。

$ARGUMENTS 即用户填入的 `<标识> <动作>`，用 Bash 工具执行以下命令（若含空格请给标识加引号）：

goal-cli $ARGUMENTS

执行后把 CLI 输出原样展示给用户。若报"no matching"，再执行一次下面命令把现有任务清单展示给用户，提示用会话ID重跑：

goal-cli list
