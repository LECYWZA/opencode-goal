# opencode-goal-run

为 opencode 自研的工具插件：**目标模式（goal）** 与 **无限迭代 / 自我优化模式（iterate）**。

替代存在「多次触发后卡死」bug 的旧 goal 插件。核心设计目标就是**绝不卡死**：单飞锁、事件自驱动、多路刹车。

## 特性

- **目标模式**：设定目标后 AI 自动持续工作，直到调用 `goal_mark_done` 给出可验证凭证才停止。
- **无限迭代模式**：AI 反复「实现 → 自测 → 找差距 → 改进」，越做越好，直到收敛或你手动停。
- **并行 Agent 上限可配**：`max_parallel_agents`，你要 1 个就 1 个，要多可多（默认 1）。
- **自我进化，拒绝固步自封**：无进展/卡住时**不停下**，而是自动分析原因 → 用 `goal_research`（聚合 Bing / Google / DuckDuckGo / Stack Overflow / GitHub / HuggingFace 搜索）查解法 → 换思路继续。（可选 `pause` 等旧行为）
- **静默活性超时**：单轮只在模型长时间**完全无输出/无动作**时才判定超时（说话/干活都不算），超时自动中断该轮并进入"上一轮为何没进展"的诊断轮。
- **多路停止**：可验证完成 / 手动 / 收敛 / 用户可选轮次上限 / 恢复尝试上限。绝不会死循环或无限空转。
- **持久化 + 指令式恢复**：目标状态落盘，跨重启用 `/goal-restore` 检查未完成任务并询问是否继续。
- **防卡死机制**：单飞锁（同一时刻仅一个续跑在飞）+ 事件自驱动去抖，杜绝触发风暴。

## 安装 / 启用

```bash
cd C:\Users\Administrator\opencode-goal-run
npm install
npm run build      # 改源码后必须重新构建
```

构建产物在 `dist/index.js`。已注册到 `~/.config/opencode/opencode.jsonc` 的 `plugin` 数组（用绝对 `file://` 路径指向）。

**改完源码 / 配置后必须重启 opencode 才生效**（opencode 启动时加载一次）。

## 使用

| 命令 | 作用 |
|---|---|
| `/my_goal 目标…` | 以目标模式启动，开始前弹选并行度/轮次等参数，自动续跑到完成 |
| `/my_iterate 目标…` | 以迭代(自我优化)模式启动，自动反复改进到收敛 |
| `/my_goal_restore` | 检查持久化的未完成任务，询问是否继续（跨重启恢复） |

> 全部命令统一 `/my_` 前缀。也可不用命令，直接让模型调用 `goal_set` 工具。

## 运行时配置（不用改 config）

config 里的参数只是**全局默认值**。每个任务实际生效的参数可以在运行时单独设置，优先级：**本次任务的覆盖 > 全局默认**。三种方式：

1. **内联参数**（目标里直接带，如）：`/my_goal 做一个XX agent=3 max_turns=50 recovery=auto-research worktree_policy=parallel`
   - 支持：`agent`(并行数) `max_turns`(-1=无限) `recovery`(auto-research/pause/continue) `recovery_attempts` `worktree_policy`(serial/parallel) `no_progress_turns` `converge_turns` `turn_timeout_s`(静默超时) `idle_interval_ms`
2. **启动时弹选**：未在命令行指定时，命令会用 question 工具**逐项弹出选择**让你确认（并行 agent 数、是否限轮次、无进展处理策略、静默超时秒数、同项目并发策略），无需接触配置文件。
3. **运行中调整**：随时让模型调用 `goal_configure(agent=…, max_turns=…, recovery=…, …)` 即可改动当前任务参数，不重置进度。

任务级配置随状态一起落盘，跨重启恢复时保持。

## 参数（config 仅作全局默认）

| 参数 | 默认 | 说明 |
|---|---|---|
| `mode` | `goal` | `goal` / `iterate` / `off`（全局默认，命令会按需覆盖） |
| `max_parallel_agents` | `1` | 同一时刻最多并行的 subagent(task) 数量 |
| `max_auto_turns` | `-1` | 自动续跑轮次上限，`-1` = 无限 |
| `turn_timeout_s` | `300` | **静默**超时秒数（模型在此期间无输出/动作才算超时；非整轮墙钟时长） |
| `no_progress_turns` | `10` | 目标模式：连续 N 轮无进展视为受阻 |
| `converge_turns` | `5` | 迭代模式：连续 N 轮无改进视为收敛 |
| `recovery` | `auto-research` | 受挫时策略：自动分析+搜索+换思路继续 / 暂停等我 / 无条件硬继续 |
| `recovery_attempts` | `4` | 自我进化恢复轮次上限，用尽仍无进展才暂停 |
| `worktree_policy` | `serial` | 同项目并发：`serial`=同一工作目录互斥防冲突(默认) / `parallel`=可并行推进不互斥 |
| `idle_interval_ms` | `2000` | 续跑最小间隔（去抖） |
| `persist` | `true` | 状态落盘（支持跨重启恢复） |
| `complete_credential` | `true` | 强制显式完成凭证 |
| `human_gate` | `true` | 完成后暂停等你确认，可继续深挖 |
| `command_keyword` | `继续` | 完成后你回复该词触发模型继续深挖 |
| `debug` | `false` | 调试日志 |
| `state_file` | `~/.config/opencode/goal-run-state.json` | 状态文件路径 |

## 自我进化与"无进展"处理（recovery）

这是 v3 的核心理念转变：**受挫不停下，而是诊断、研究、换思路继续**。

- 无进展/无思路时进入恢复轮：模型先**冷静分析为何没进展** → 用 `goal_research`（插件聚合 Bing / Google / DuckDuckGo / Stack Overflow / GitHub / HuggingFace 搜索；内置引擎全不可达时，会自动提示模型改用其自身的 web-search / webfetch 等 MCP 搜索工具）或 web 工具找解法 → **提出并实施修正** → 继续。
- **怀疑并亲自验证（强制原则）**：对搜索结果、文档、二手结论一律视为**线索而非事实**。采纳任何关键结论前必须**亲自验证**（运行命令、构建/测试、打开真实源码/文档）；无法验证的关键假设须明确标注 `未验证(推测)`，不得在未证实的结论上继续加重工作。此原则固化在系统提示与恢复轮指令中。
- 单轮**静默超时**（模型在 `turn_timeout_s` 内既无 token 输出也无工具动作）时，插件自动中断该轮、开下一轮，并让模型**分析上一轮为何没进展**。说话/干活都不算超时。
- 三档策略（启动时可选或内联 `recovery=`）：
  - `auto-research`（推荐）：自我进化优先；连续 `recovery_attempts` 个恢复轮仍无进展，才暂停等你。
  - `pause`：退化为旧行为——无进展即暂停等你。
  - `continue`：无条件硬继续，除非完成或达到轮次上限。
- 任务级策略随状态落盘，跨重启保持；可随时 `goal_configure(recovery=…)` 改。

## 如何停下来

1. **手动**：输入 `停止` / `暂停` / `goal_pause`，立即暂停（状态保留，可用 `/my_goal_restore` 或 `goal_resume` 恢复）。
2. **目标完成**：模型调用 `goal_mark_done`（须附证据）→ 自动停；`human_gate` 开启时再等你确认是否深挖。
3. **收敛**（迭代模式）：连续 `converge_turns` 轮无改进，或 `recovery_attempts` 恢复轮用尽 → 自动暂停。
4. **轮次上限**（启动时你选择）：达到 `max_auto_turns` → 暂停（不是终止，随时可续）。

## 执行流程（目标模式示例）

```
用户: /my_goal 完成XX
  → 模型先用 question 弹选确认并行度/轮次等参数
  → 模型调 goal_set(goal, mode=goal, agent=…, max_turns=…)
  → 插件注入规则到系统提示 + 落盘状态(含本次参数)
  → 引擎自动续跑(单飞锁+去抖): client.prompt("第N轮继续…")
  → 每轮: 模型做实际工作 / 调 goal_progress 记录进展 / 可调多个 task(≤该任务并行上限)
  → 模型调 goal_mark_done(evidence, verification)
  → 插件置完成、停止自动循环、等你确认
  → 你回“继续”→ 模型调 goal_continue(新目标) → 恢复深挖
```

## 完成判定原则

只认 **显式凭证**：模型想停必须调用 `goal_mark_done` 并提供可验证证据；否则即使它「说做完了」也会被引擎自动续跑。这从机制上避免「误报完成 / 偷偷溜」。

## 多会话 / 多实例并发安全

设计目标：**无论多少会话、多少 opencode 实例同时启用目标，都不得冲突。** 两层机制保证：

### A) 持久化合并写 + 排他写锁（防数据丢失）
- 绝不做整文件的"盲覆盖"。每次落盘都在**排他写锁**临界区内执行：`读磁盘最新 → 合并本实例变更 → 原子替换（临时文件 + rename）`。
- 多实例各只写自己的会话条目，读盘合并，**互不覆盖、条目不丢**。
- 写锁带陈旧检测与超时降级：进程崩溃残留的锁会超时被清，不会造成死锁。

### B) 按"工作目录(worktree)"的运行时互斥（默认 serial，防同时改文件）
同一工作目录同一时刻**只允许一个活跃自动循环在推进**（`worktree_policy=serial`，默认）：
- **同实例多会话**：进程内"在飞令牌"串行化——同 worktree 的不同会话轮流推进（不会同时编辑同一项目）。
- **跨 opencode 实例**：每 worktree 一把**排他锁文件 + 心跳刷新 + 陈旧抢占**。被他人持有的实例自动等待；持有者暂停/完成/退出后自动让出，等待者接管。
- 不同 worktree 完全互不影响，可并行。

> 可切换 `worktree_policy=parallel`（内联、启动弹选或 `goal_configure`）：**不做互斥、同项目可并行推进**，适合想同时改不同文件的激进场景，但需自行注意别互相覆盖。默认 `serial` 保证防冲突。二者为运行时策略，随任务状态落盘。

## 防卡死设计（学习自旧插件的 bug）

- **单飞锁**：同一会话最多一个续跑在飞，`running` / `continuePending` 双标志位阻止重入。
- **不阻塞事件回调**：续跑用 `setTimeout` 调度到事件循环，绝不在 event 回调内 `await` 长任务（Windows 友好）。
- **事件自驱动 + 自链**：以本体续跑完成后自链为主、`session.idle` 事件为辅，两者都汇入受单飞锁保护的调度，天然去抖，杜绝「触发很多次→卡死」。

## 开发

```bash
npm run typecheck   # 类型检查
npm run build       # 构建到 dist/index.js
npm run watch       # 监听重建
```
