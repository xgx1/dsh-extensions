---
name: dsh-extension-dev
description: DSH 功能扩展开发元技能（先搜索复用、无现成才自己写、写完传 GitHub）。触发词：扩展 DSH、DSH 插件、给 DSH 加功能、开发 DSH 扩展、DSH 扩展开发、DSH 功能扩展。四条规矩：①动手前先搜本地/网上现成扩展，大致符合就在其基础上改，禁止从零重写；②逐步实现——已有相关功能时先加载 add-software-feature 技能扩展它，没有现成才加载 cordis-plugin-development 新建，且写前先描述功能；③一个功能只做一个插件，严禁多功能糅合；④完成后直接上传 GitHub（账号 xgx1，仓库 dsh-extensions）。
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
| 持久安装插件（独立 npm 包） | 独立包：`exports ./client` + `dsh.client` manifest + `dsh.bundle.patch`（cordis.patch.yml insert 行）；`dsh plugin --profile web add link:<目录>` 本地安装（aionui-panel、web-dsh-web-extension 先例） | 持久跨会话 | 正式功能、Web GUI 扩展 |
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

## 2. 规矩二：逐步实现，先调已有技能

判定完规矩一后分两支：

- **(a) 已有相关功能（要扩展/改写现成插件）** → 第一步用 skill 工具加载 **`add-software-feature`**（用户侧「添加功能」技能），按其流程逐步把这个功能加到现成插件上，禁止推倒重写
- **(b) 没有现成功能（要新建插件）** → 第一步用 skill 工具加载 **`cordis-plugin-development`**（本机插件开发流程技能；涵盖 Inspect 查询、Host/Client 分工、Slot/主题/Tool 注册协议、版本升级、审批失败处理、故障修复全套流程，按其执行）

两条分支共用：

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
- **扩展现成功能 ≠ 改官方源码**：优先独立包/补丁形式覆盖，官方源码改动目标为 0（web-dsh-web-extension 即纯 profile-bundle 覆盖层）
- **禁止编辑部署自带的 preset 安装目录**；要改 shipped 预设就复制一份到 `~/.dsh/.agent-presets/` 改副本
- 插件代码是纯 JS：无 TypeScript/JSX/import；Client 端用 `React.createElement`；先用 `cordis_inspect_*` 查准 API 再写
- Inspect 查询结果只用于确认能力/签名，不能当业务数据缓存或展示；运行时只调真实 Service
- **Host 插件读兄弟服务必须用 `ctx.get(name)`**（全局注册表），禁止未声明属性访问 `ctx.xxx`——属性代理是拓扑敏感的，未 inject 的服务读取会**静默返回 undefined** 导致功能静默失效（dsh-continual-evolve 的 continue 钩子就栽在这：sessionProjections 属性访问 → 无日志无动作）。懒加载模式照抄 `goalServiceOf`（`(ctx as { get(name) }).get(name)`）
- **监听 agent 事件（agent/status、turn-stopping）在插件 ctx 上可行**：cordis 事件表全局共享 + scope filter 放行无标签 ctx（动态插件实测验证）
- **覆盖官方 Web UI 样式**：不能靠 hashed CSS-module 类名（不可预测）。用官方 DOM 的稳定 data 属性做锚（`[data-phase]`、`[data-composer-card]`、`[data-composer-seat]`、slot 渲染的 `[data-slot='...']`），规则以扩展自己的 `<html>` data 属性门控（`html[data-x] ...`），关 = 属性移除即还原；覆盖官方 CSS 变量用更高特异性选择器（如 `div[data-phase]` 0,1,1 > `.ConversationRoot_root` 0,1,0）
- **侧边栏等无 seat 区域的 UI 挂载**：`waitForElement('[data-slot="sidebar.workspaces"]')`（MutationObserver）+ 目标前 `insertBefore` 锚点 + `createRoot` 挂 React（aionui-panel 先例；dsh-sidebar-taskbar 用之插入任务栏）；折叠检测用 ResizeObserver 看父列宽
- **独立 client bundle 构建**：官方 `clientBundle` 预设只在官方仓库内可用；独立包复制其要点即可——`window.__ModuleLoader__.load({id, factory: require => ...})` banner/footer + platform 模块 external（react、ui-primitives、runtime/client 等）+ `define` 替换 process.env；CSS Modules 可用 lightningcss 插件或直接内联 style/常量
- **pnpm 在本机 profiles/web 装 link 包时网络失败**：设 `$env:HTTPS_PROXY/HTTP_PROXY=http://127.0.0.1:7897` 重试（`dsh plugin add` 超时/`fetch failed` 均此处理）；`--no-frozen-lockfile` 应对 lockfile 漂移
