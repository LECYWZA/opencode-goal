# opencode-goal-run

为 opencode 自研的工具插件：**目标模式（goal）** 与 **无限迭代 / 自我优化模式（iterate）**。

替代存在「多次触发后卡死」bug 的旧 goal 插件。核心设计目标就是**绝不卡死**：单飞锁、事件自驱动、多路刹车。

## 特性

- **目标模式**：设定目标后 AI 自动持续工作，直到调用 `goal_mark_done` 给出可验证凭证才停止。
- **无限迭代模式**：AI 反复「实现 → 自测 → 找差距 → 改进」，越做越好，直到收敛或你手动停。
- **并行 Agent 上限可配**：`max_parallel_agents`，你要 1 个就 1 个，要多可多（默认 1）。
- **多路刹车**：无进展暂停 / 单轮超时 / 轮次上限 / 完成 / 手动中断 / 收敛，绝不会死循环。
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
| `/goal 目标…` | 以目标模式启动，自动续跑到完成 |
| `/iterate 目标…` | 以迭代(自我优化)模式启动 |
| `/goal-restore` | 检查持久化的未完成任务，询问是否继续（跨重启恢复） |

## 参数配置（opencode.jsonc → plugin options）

| 参数 | 默认 | 说明 |
|---|---|---|
| `mode` | `goal` | `goal` / `iterate` / `off`（全局默认，也可由命令指定） |
| `max_parallel_agents` | `1` | 同一时刻最多并行的 subagent(task) 数量 |
| `max_auto_turns` | `-1` | 自动续跑轮次上限，`-1` = 无限 |
| `turn_timeout_s` | `300` | 单轮超时兜底（秒） |
| `no_progress_turns` | `10` | 目标模式：连续 N 轮无进展则暂停 |
| `converge_turns` | `5` | 迭代模式：连续 N 轮无改进则收敛暂停 |
| `idle_interval_ms` | `2000` | 续跑最小间隔（去抖） |
| `persist` | `true` | 状态落盘（支持跨重启恢复） |
| `complete_credential` | `true` | 强制显式完成凭证 |
| `human_gate` | `true` | 完成后暂停等你确认，可继续深挖 |
| `command_keyword` | `继续` | 完成后你回复该词触发模型继续深挖 |
| `debug` | `false` | 调试日志 |
| `state_file` | `~/.config/opencode/goal-run-state.json` | 状态文件路径 |

## 如何停下来

1. **手动**：输入 `停止` / `暂停` / `goal_pause`，立即暂停（状态保留，可 `/goal-restore` 或 `goal_resume` 恢复）。
2. **目标完成**：模型调用 `goal_mark_done`（须附证据）→ 自动停；`human_gate` 开启时再等你确认是否深挖。
3. **收敛**（迭代模式）：连续 `converge_turns` 轮无改进 → 自动暂停。
4. **兜底刹车**：`no_progress_turns` 无进展、`turn_timeout_s` 单轮超时、`max_auto_turns` 轮次上限——全部走「暂停」而非「终止」，随时可续。

## 执行流程（目标模式示例）

```
用户: /goal 完成XX
  → 模型调 goal_set(goal, mode=goal)
  → 插件注入规则到系统提示 + 落盘状态
  → 引擎自动续跑(单飞锁+去抖): client.prompt("第N轮继续…")
  → 每轮: 模型做实际工作 / 调 goal_progress 记录进展 / 可调多个 task(≤并行上限)
  → 模型调 goal_mark_done(evidence, verification)
  → 插件置完成、停止自动循环、等你确认
  → 你回“继续”→ 模型调 goal_continue(新目标) → 恢复深挖
```

## 完成判定原则

只认 **显式凭证**：模型想停必须调用 `goal_mark_done` 并提供可验证证据；否则即使它「说做完了」也会被引擎自动续跑。这从机制上避免「误报完成 / 偷偷溜」。

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
