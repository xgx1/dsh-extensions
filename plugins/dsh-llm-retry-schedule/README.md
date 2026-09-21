# dsh-llm-retry-schedule

DSH 宿主插件：**可配置的模型请求重试预算**（重试次数 + 每次重试等多久），挂在 agent loop 的 `agent/request-error` 恢复扩展点上，用 `prepend: true` 抢在官方 `@deepseek-ai/dsh-llm-retry` 之前接管失败请求。纯 profile-bundle 覆盖层，**零官方源码修改**，也不禁用官方任何一行——官方 `llm-retry` 仍挂载在下面，接住本插件让出去的一切。

## 为什么需要它

官方 `llm-retry` 的退避是**一条指数曲线**：默认 `maxRetries: 5`、`initialDelayMs: 500`、`maxDelayMs: 10000`，即 500ms → 1s → 2s → 4s → 8s。provider 侧一抖（限流、`engine is not available temporarily` 之类的 500、代理 403/超时），整轮对话在十几秒内就判死。

本机实测（2026-09-20 的会话 `session-7d2915dc`，turn 15 step 2）：

| retry | 官方延迟 |
|---|---|
| 1 | 464 ms |
| 2 | 965 ms |
| 3 | 2092 ms |
| 4 | 3609 ms |
| 5 | 8627 ms |
| — | **turn/end，整轮失败** |

指数曲线在“长时间抖动”这一档完全不够用：它把预算烧在前几秒，然后放弃。本插件把它换成**阶梯表**——前几次等短一点，之后稳住 10s，再之后 60s 兜底，总预算给到 1000 次（≈ 十几小时），让开发过程不用因为 provider 抽风而重发。

## 默认策略

| 项 | 默认值 | 说明 |
|---|---|---|
| `maxRetries` | `1000` | 每个 step 内本插件愿意重试的次数，用完就交回链路 |
| `schedule` | `[{1,5000},{5,10000},{20,60000}]` | 阶梯表：重试 1–4 等 5s，5–19 等 10s，20 及以后每次等 60s |
| `retryableCodes` | 未设（见下） | 显式设置后才覆盖 provider 路由声明的可重试码 |
| `jitterRatio` | `0` | 0 = 严格按表；>0 时在每档上下按比例抖动 |

可重试码的来源优先级：**行内 `retryableCodes` > provider 路由 `retryPolicy.retryableCodes` > 内置默认** `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / QUOTA`（与 `dsh-llm` 的默认策略一致）。

## 机制

- 监听 `agent/request-error`（waterfall），注册时 `prepend: true` → 是链上**最外层**监听器，先于官方 `llm-retry` 拿到失败。
- 归属本插件的失败：**durable 先行**——先写 `llm/retry` 会话事件（含 `retryId / retry / maxRetries / delayMs / failure`），再做可被取消的等待，等完写 `llm/retry-started`，然后返回 `{ kind: 'retry' }`。事件形状与官方完全一致，Web Chat 的「模型重试」行照旧渲染。
- 让出（调用 `next()`）的三种情况：失败码不在有效集合里；本 step 的重试预算用尽；provider 路由配了 `mode: 'always'`（先让官方策略表态，它不要才由本插件接手——这样上下文溢出压缩、图片卸载恢复仍归它们各自的 owner）。
- **计数作用域**：每个 Session 一份计数，按 provider 分开；只在 `step/start`、`step/end`、`turn/end` 归零。重试发生在同一个 step 内（不会重新走 `agent/pre-step`），所以整条重试串共享一个 `retryId` 和一张计数表。
- **`Retry-After`**：provider 明确给了 `providerRetryAfterMs` 且不超过本表最长档（默认 60s）时按它等；超过就用阶梯表，避免一条 Retry-After 把一轮卡死。
- **可取消**：turn 的 abort 与插件卸载都会打断等待；被打断时返回 `undefined`（不重试），与官方语义一致。
- 配置非法（未知字段、非递增阶梯、非正延迟、抖动越界）**在加载时抛错**，不让一行错配置静默降级。

## 配置与安装

行插入由本包的 `cordis.patch.yml` 完成（bundle 层），默认值已写在里面：

```yaml
- insert:
    - id: llm-retry-schedule
      name: 'dsh-llm-retry-schedule'
      config:
        maxRetries: 1000
        schedule:
          - fromRetry: 1
            delayMs: 5000
          - fromRetry: 5
            delayMs: 10000
          - fromRetry: 20
            delayMs: 60000
```

要改默认值，**不要改本包的 patch**，在 profile 自己的 `~/.dsh/profiles/web/cordis.patch.yml` 里按 id 覆盖（用户层最后应用、优先级最高，且改了立即热加载）：

```yaml
- id: llm-retry-schedule
  config:
    maxRetries: 200
    schedule:
      - fromRetry: 1
        delayMs: 3000
      - fromRetry: 3
        delayMs: 30000
```

安装（本机通用流程，`web` 换成目标 profile）：

```bash
cd /home/sx/projects/MyAI/dsh-extensions/plugins/dsh-llm-retry-schedule
pnpm install && pnpm build            # 产出 lib/index.js（profile 只加载构建产物）
dsh plugin --profile web add link:/home/sx/projects/MyAI/dsh-extensions/plugins/dsh-llm-retry-schedule
# 再把 "dsh-llm-retry-schedule" 追加进 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles
dsh --profile web --dump-config | grep -A6 llm-retry-schedule   # 离线确认组合结果
```

`dsh plugin` 只转发 pnpm，**不会**替你选 bundle；`dsh.profile.bundles` 必须自己加（或走 Web 侧栏 Plugins 页 / `plugin_manager` 工具）。base 层开了 HMR，所以配置改动即时生效；插件装卸由 loader 管理，无需重启 `dsh-web.service`。

卸载：从 `dsh.profile.bundles` 移除该包名（或整行 `disabled: true`），再把依赖 `pnpm remove` 掉即可——官方 `llm-retry` 从头到尾都在，卸载后行为立刻回到指数退避。

## 验证

```bash
pnpm run typecheck && pnpm test && pnpm run build
```

`tests/` 分三层，全部通过才算数：

- `schedule.test.ts`：阶梯表解析、边界（retry 4/5/19/20）、抖动、非法配置拒绝。
- `retry.test.ts`：假 ctx 上的监听器契约——prepend 选项、事件字段、预算耗尽委托、非可重试码委托、`Retry-After`、abort 中断、按 step 归零。
- `integration.test.ts`：**真** agent loop + LLM runtime + session store，脚本化 adapter 造失败：
  - 单次失败按 5s 重试并跑完整轮；
  - 21 连败在同一 step 内走完 5s×4 → 10s×15 → 60s×2，只出现一次 `step/start`；
  - `maxRetries: 2` 用尽后交回链路，整轮以 error 结束；
  - 非可重试码（`AUTH`）不重试、直接终结；
  - **与官方 `llm-retry` 同时挂载**（官方先挂、本插件后挂）时，两次重试的 `delayMs` 都是本插件的 5000 而非官方的 500，且每次尝试只产生一条 `llm/retry`。

## 已知限制

- 计数与 `retryId` 只存在于进程内：profile 热重载会从 retry 1 重新开始（等待档位退回 5s），不会丢日志也不会重复写事件。
- provider 路由若显式配了 `mode: 'always'`，本插件让官方策略先表态，因此那种路由走的是官方退避曲线，不是本表。
- 预算用尽后交回链路，官方 `llm-retry` 可能再补几次它自己的重试（默认 5 次、500ms 起）——这是刻意的，用来保留上层策略的最后兜底。
