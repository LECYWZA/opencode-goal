---
description: 恢复历史目标任务：按当前目录优先，弹出候选会话/任务让你选择恢复（跨重启恢复）
---
这是「恢复历史任务」命令。执行以下【强约束】流程，禁止自由发挥、禁止替用户猜测、禁止把其它目录任务当默认推荐。

1. 用 Bash 工具执行下面命令（命令在项目根目录运行，(Get-Location).Path 即当前工作目录），会返回一段结构化 JSON 候选清单，原样读取它并展示给用户：
   goal-cli candidates (Get-Location).Path

2. JSON 里已按优先级分好两组，直接用：
   - `current`：worktree 与当前目录相同/同项目树的【当前项目任务】——**首选**，第二个选项前必须标 `（当前目录，推荐）`；
   - `elsewhere`：其它目录的任务——备选，排在后面。
   每组每条都带好了 `label`（会话ID+目录）与 `description`（模式/轮数/状态+目标摘要）。

3. 【必须】用 question 工具按上述顺序把 current + elsewhere 的每一条做成【单选选项】弹给用户选择（严禁只问"是否恢复某会话"；严禁漏掉 current 里的条目）：
   - 选项 label 直接用 JSON 里的 `label`；
   - 选项 description 直接用 JSON 里的 `description`；
   - 若 current 为空：明确告知"当前目录没有历史任务"，再列 elsewhere；
   - 若两组都为空：告知"没有可恢复的历史任务"并结束。

4. 用户选中某条后，取该条 JSON 的完整 `objective`（不许截断）、`mode` 以及 `overrides`（参数 key=value 逐个带上），在当前会话调用：
   goal_set(goal=<完整 objective>, mode=<该 mode>, <overrides 参数 key=value ...>)
   恢复该任务并立即继续跑下一轮。

5. 恢复后调用 goal_status 确认已激活，并明确告知恢复了哪一条（JSON 里 id+worktree）、当前生效参数。
