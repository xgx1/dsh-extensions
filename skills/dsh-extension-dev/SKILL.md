---
name: dsh-extension-dev
description: DSH 功能扩展开发元技能（先搜索复用、无现成才自己写、写完传 GitHub）。触发词：扩展 DSH、DSH 插件、给 DSH 加功能、开发 DSH 扩展、DSH 扩展开发、DSH 功能扩展。四条规矩：①动手前先搜本地/网上现成扩展，大致符合就在其基础上改，禁止从零重写；②自己写必须先加载 cordis-plugin-development 技能（即本机「add feature」类技能）再描述功能并实现；③一个功能只做一个插件，严禁多功能糅合；④完成后直接上传 GitHub（账号 xgx1，仓库 dsh-extensions）。
---

# DSH 扩展开发（基本原理 + 四条规矩）

## 0. 扩展的本质（原理速览）

DSH 是微内核 + Cordis 插件树：一切功能都是挂在文档化扩展点上的插件。Host 跑在 Node 进程里（文件/网络/命令/Tool），Client 跑在浏览器页面里（Slot UI/主题/页面状态），两者经包私有 JSON RPC 通信。

动手前必须先做**形态分类**——不同形态的源码格式、装载器、持久模型完全不同，规则不能跨形态混用：

| 形态 | 落点 | 生命周期 | 何时用 |
|---|---|---|---|
| 动态 Cordis 插件 | `cordis_define`/`cordis_run`，会话内 | 当前进程，重启即失 | 临时功能、原型试水、一次性界面 |
| Agent 预设 / 宿主组合 | `~/.dsh/.agent-presets/<id>/cordis.yml` | 持久 | 改会话工具集/人设/模型路由 |
| 技能 | `~/.dsh/skills/<名字>/SKILL.md` | 持久 | 教 agent「怎么做」（本技能即此形态） |
| 持久安装插件 | dsh-web-ui 全家桶 `packages/`（dsh-ssh、dsh-task-board、dsh-aionui-panel） | 持久跨会话 | 正式功能 |
| MCP 工具 | 组合里挂 mcp 行 | 持久 | 接入外部工具生态 |

权威资料（以当前仓库证据为准，不靠记忆）：

- 本机 checkout：`I:\Project\Other\deepseek-harness\docs\cookbook\extension-cookbook.md`、`docs\cordis-primer.md`（有 .zh 中文版）
- 官方 GitHub：deepseek-ai/deepseek-harness 的 `docs/` 与 `packages/`
- 社区同类技能参考：`w2112515/dsh-plugin-development`（本技能的「形态分类 + 证据优先」思路吸收自它；它的 dsh.bundle/Loader 内容针对旧版部署，本机不适用，勿照搬）

## 1. 规矩一：先搜索与复用（优先级最高的步骤）

动手前按序排查，并把排查证据写进最终报告：

1. **本地已装插件**：dsh-liangshen（锚定预设）、dsh-ssh、dsh-task-board、dsh-aionui-panel、web-ui-all —— 已覆盖就直接用或改配置
2. **本地技能与预设**：`~/.dsh/skills/`、`~/.dsh/.agent-presets/`
3. **网上**：`web_search`「DeepSeek Harness <功能关键词>」；GitHub 搜 deepseek-ai/deepseek-harness 的 `packages/`、`docs/` 及社区仓库
4. **判定**：
   - 完全符合 → 直接用（安装/挂载即可）
   - 大致符合 → clone 到本地**在其基础上改**（fork/适配），禁止从零重写
   - 没有 → 才进入规矩二

禁止假装搜过：报告必须写「搜了什么、找到了什么、为什么用/不用」。

## 2. 规矩二：自己写之前先调已有技能

- 第一步用 skill 工具加载 **`cordis-plugin-development`**（即本机「add feature」类技能的实际名称；它涵盖 Inspect 查询、Host/Client 分工、Slot/主题/Tool 注册协议、版本升级、审批失败处理、故障修复全套流程，按其执行）
- 改的是预设/宿主组合 → 加载 `editing-cordis-compositions`
- 在 dsh-web-ui 全家桶里加包 → 照该仓库 `packages/` 现有包的结构做
- 写代码前先**描述功能**：一句话目标 + 目标形态（上表五选一）+ 验收标准，再实现

## 3. 规矩三：极简原则（硬约束）

- **一个功能 = 一个插件/包/技能**，严禁把多个功能糅进一个插件
- 拆分判据：能否独立启停？能否独立版本升级？能否独立复用？任一为是 → 必须独立
- 动态插件副作用必须可逆：用 `ctx.effect()`/`ctx.on()`/官方 disposer，stop/update/undefine 不留痕；Host/Client 之间只传无损 JSON，不序列化活对象

## 4. 规矩四：代码托管 GitHub

- 账号 `xgx1`（gh CLI 已登录）；统一仓库 **`xgx1/dsh-extensions`**（monorepo 分层：`skills/<名字>/`、`plugins/<名字>/`——插件粒度独立、仓库集中管理）
- 流程：本地工作区建目录 → `git init` → commit → `gh repo create xgx1/dsh-extensions --public --source .` → push
- 默认公开（与账号现有仓库一致）；要私有说一声
- 每个扩展完成即推送，不留本地散件；README 写清功能/用法/出处（复用谁的必须注明）

## 5. 完成报告

输出：改了什么、落在哪种形态、复用了什么（或为什么没有现成可用）、GitHub 地址、验证方式。

## 常见坑

- 动态插件是进程内扩展：重启即失；要持久必须落到预设/安装插件形态
- **禁止编辑部署自带的 preset 安装目录**；要改 shipped 预设就复制一份到 `~/.dsh/.agent-presets/` 改副本
- 插件代码是纯 JS：无 TypeScript/JSX/import；Client 端用 `React.createElement`；先用 `cordis_inspect_*` 查准 API 再写
- Inspect 查询结果只用于确认能力/签名，不能当业务数据缓存或展示；运行时只调真实 Service
