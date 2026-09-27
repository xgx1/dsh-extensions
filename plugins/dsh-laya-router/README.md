# dsh-laya-router

DSH 宿主插件：**逐轮模型路由 + 思考档位映射 + 主动压缩**，由本机 Laya 决策模型（`convaiinnovations/laya`，跑在 RX 7900 GRE 上）判定。纯 profile-bundle 覆盖层，**零官方源码修改**，也不禁用官方任何一行。

## 它做什么

每个用户轮次的第一 step，插件把**本对话全部用户消息**拼成判断状态，向本地 Laya 侧车问三个 `choice` 问题——难度、时间预算、是否还在原任务上——然后：

1. **选模型**：按可配置的有序路由表落到四个候选之一；
2. **定档位**：只对声明了 `reasoningEffort` 的 provider 传值，其余**显式清除**（显式档位会写进 `request/header` 并持续生效，不清就会粘住后面所有 step；而不支持的档位是 loud 失败）；
3. **压不压**：判定「换任务」且上下文占用超过阈值时，在 pre-step 调 `ctx.compaction.compactIfNeeded(agent, 'context-overflow', signal)`，当前 step 的请求立刻看到压缩后的历史。

换路由时插件自己追加一条 `[model routed: …]` 通知——原生的 `[model changed: …]` 只由 `installModelSelection` 在用户手动切模型时产生，纯 `agent/request` 换模型不会触发它，不留痕就会让模型看到别的模型产出的历史却毫无标记。

## 三种模式

| mode | 行为 |
|---|---|
| `off` | 什么都不做 |
| `shadow`（默认） | 判定 + 记录，**不改动任何行为**——先用它校准 |
| `live` | 应用路由与档位，按规则压缩 |

决策逐条写进 `$DSH_HOME/laya-router.jsonl`（JSON Lines，一行一次判定），包含判断状态被裁剪了多少条消息、三个答案及其置信度、最终路由与依据、以及侧车返回的模型与耗时。`basis` 字段区分「Laya 判的」（`laya`）与「文本没说、落到未标注默认档」（`unlabeled`）。

## 判断状态为什么要自己拼

Laya 给 `state` 的预算是 **english 320 / multilingual 768 token**，而它超预算时的截断策略是**保留开头、丢弃结尾**——对「看最新那条消息」的路由来说正好是反的。所以状态由插件确定性组装：**任务起点那条 + 最近若干条 + 一条省略标记**，中间被丢掉几条写进决策记录（`state.elided`），事后能判断某次错是不是因为信息被剪了。

`lang` 每次请求显式传（默认 `zh`）：侧车的语言检测只认 en/fr/de/es/pt/it/nl，中文会被塞给 english 检查点并返回不可用结果。

## 两个上游坑（已规避）

- **裸 `noul` 是坏的**：不给 `criteria` 的 noul 被渲染成固定 false/true 对并**恒定输出第一项**（上游实测四十道平衡题 40/40，中英文皆然）。本插件所有判据都是 `choice` + `criteria`。
- **低置信 ≠ 弱信号**：Laya 的 `confidence` 是分布集中度，不是正确率。低于 `confidenceFloor`（默认 0.5）的答案一律当「文本没说」处理——不改动，除非配了未标注默认档。

## 依赖

- **本地 Laya 侧车**：`laya-sidecar.service`（`laya-mcp serve --model multilingual --port 8083`）与提供 `ctx.laya` 的 `dsh-laya` 插件。侧车不在时本插件对该轮**什么都不做**（不换模型、不压缩、不设档位），只记一条 `ctx.laya is not registered` 的记录。
- 挂载点：`agent/pre-step`（判定与压缩）与 `agent/request`（`step === 1` 应用路由，`prepend: true` 抢在用户选择之前）。`dsh-scope` 允许祖先作用域的监听器收到后代事件，所以 profile 级 bundle 行即可，**不需要改 preset**。

## 配置

```yaml
- id: laya-router
  config:
    mode: live                 # off | shadow | live
    lang: zh
    logFile: null              # null = 不记录；默认 $DSH_HOME/laya-router.jsonl
    policy:
      confidenceFloor: 0.5
      routes:
        official: { provider: deepseek-official, model: deepseek-flash }
        md:       { provider: md, model: deepseek-ai/DeepSeek-V4.1-Flash }
        deepseek: { provider: sensenova, model: deepseek-v4.1-flash }
        lite:     { provider: sensenova, model: sensenova-6.8-flash-lite }
      table:                   # 有序，第一条命中即用
        - { difficulty: hard, budget: immediate, route: official }
        - { budget: immediate, route: official }
        - { difficulty: hard, budget: can_wait, route: md }
        - { budget: can_wait, route: lite }
        - { budget: minutes, route: deepseek }
      unlabeledRoute: md       # 文本什么都没说时的落点；null = 不改动
      effort:
        byDifficulty: { hard: high, medium: medium, easy: low }
        effortRoutes: [deepseek, lite]
      compaction:
        enabled: true
        newTaskProbability: 0.65
        minOccupancy: 0.4
      stateBudgetTokens: 700
```

## 开发

```bash
pnpm install && pnpm run build      # 产物 lib/index.js 是 profile 真正加载的东西
```

改完 `src` 必须重建：`link:` 指向源码，加载的是 `lib/`，源码改了产物没重建会静默跑旧代码。装进 profile 用 `dsh plugin --profile <name> add link:<绝对路径>`（见 ADR-0007）。

## 已知限制

- 只走 `agent/request` 不会写 `model/selection` 事件，所以 UI 的模型选择器不会跟着显示路由结果；真实路由靠会话里的 `[model routed: …]` 通知与 `request/header` 记录。
- 用户手动切模型与路由在同一层瀑布上，live 模式下本插件是最后一句话；两者同时发生时会看到两条通知（原生一条、本插件一条）。
- Laya 基础检查点在它自己的 typed-decisions 基准上接近瞎猜，所以 **shadow 期的对表数据是开 live 的前提**；判断质量高度依赖问题与 `criteria` 的措辞。
- 上下文占用率取自 `ctx.tokenMeter.measure()` + `ctx.llm.resolveModelInfo()`；任一不可用时**不压缩**（宁可不压，也不按错误比例压）。
