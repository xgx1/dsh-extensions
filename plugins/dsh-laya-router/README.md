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

## 谁会被路由：模型选择器里的 `auto`

插件注册一个只含一个模型的 LLM provider（`auto/auto`），于是模型选择器里多出一组「**自动（判断层逐轮选择）**」——浏览器目录是 LLM 注册表的投影（`listProviders()` → `listModels()`），这是唯一受支持的入口方式。

- **选中 `auto` 的会话**：每轮由判断层决定模型、档位，必要时压缩。
- **选中具体模型的会话**：判断层完全不插手（不会为它花掉一次 Laya 调用）。
- 会话没有显式选择时，看部署默认 `agent-default-model`：它是 `auto` 就等于选中了 auto。
- `auto` 会话**不会**被写 `model/selection`——选择器继续显示 `auto`（那正是它的长期选择）；这一轮真实跑在哪个模型，看会话里的 `[model routed: …]` 通知、`/route status`，或 `request/header`。
- 保留旧行为的开关：`applyWhen: always` 时 `mode: live` 会路由**所有**会话（旧的「全局自动」语义）。

模式与效果（`off` 时不问 Laya；`shadow` 时问了也不照它办）：

| 会话 | mode | 是否问 Laya | 实际应用 |
|---|---|---|---|
| auto | `off` | 否 | 静态默认档（`unlabeledRoute`） |
| auto | `shadow` | 是（只记录） | 静态默认档 |
| auto | `live` | 是 | Laya 选的路由 + 档位 + 压缩 |
| 具体模型 | `off` / `shadow` | 否 | 不改动 |
| 具体模型 | `live` + `applyWhen: always` | 是 | Laya 选的路由 + 档位 + 压缩 |

任何情况下 `auto` 都会被解析成一个真实模型——插件在 `agent/request` 兜底，绝不会把请求发给占位适配器（真发过去会 loud 失败并给出可操作的报错）。

**为什么是每一步都解析**：harness 只在「写出的 `request/header` 与它完全一致」时才把用户的选择标记为已消费；而路由会把 `auto` 换成真实模型，于是这条选择**永远不会被消费**，harness 会在这一步之后重新应用它。所以 `auto` 必须按 step 解析（首步用本轮决策，后续步沿用本轮已经跑的路由，不中途换模型）。

**那条 `[model changed: … continues with auto/auto]` 通知**：同上原因——harness 比较「本会话的选择（auto）」与「上一个请求头（真实路由）」，两者必然不同，于是每个 step 都追加一条。插件无法改这个私有选择（`selectForNextRequest` 是 session-controller 内部的，不是服务），因此改用**我们自己的通知把话说清楚**：`[model routed: …; a "[model changed: … continues with auto/auto]" notice reports the harness re-applying the placeholder selection, not the model actually serving the request]`。要彻底消掉它，需要在切换 auto 后的第一轮先让一个 `auto/auto` 请求头落地把选择消费掉（用兜底适配器执行），代价是那一轮的请求头不accurate——目前没做。

## `/route` 命令

| 命令 | 作用 |
|---|---|
| `/route` 或 `/route status` | 当前模式、决策日志路径、最近一次决策（路由/依据/耗时/压缩） |
| `/route shadow` `/route live` `/route off` | 运行时切换，持久化到 `$DSH_HOME/laya-router-state.json`，**重启后仍生效** |
| `/route stats [n]` | 最近 n 条（默认 50）的分布：各路由次数、依据（`laya` / `unlabeled`）、压缩判定与执行次数、平均判定耗时、判断状态被裁剪的次数 |
| `/route reset` | 丢掉运行时覆盖，回到配置里的 `mode` |

启动时插件往**服务日志**打两行启动事实——`ready (mode=…)` 与 `/route registered (…)`：静默挂载失败与正常工作否则无法区分（这两行也解释了为什么 `/route` 没生效时该先去看 `journalctl --user -u <service>`）。

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
    stateFile: null            # null = /route 的切换不持久化；默认 $DSH_HOME/laya-router-state.json
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
