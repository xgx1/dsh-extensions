# dsh-task-manager

DSH Web GUI 任务管理器（纯 profile-bundle 覆盖层，**零官方源码修改**）。宿主半侧负责任务持久化与 git worktree 操作，浏览器半侧提供一个「任务管理」主视图：新建对话框 → 任务列表 → 任务详情。

点击侧边栏标题下方的 **任务管理 / Task Commander** 按钮，把中间主区域（AI 对话输入输出面板）**整区切换**成任务面板——与官方「Automations」面板同款的主视图切换（`conversation.view` 视图环）。

## 功能

- **新建任务对话框**：标题（输入内容后自动生成，也有「生成标题」按钮）、任务内容、运行位置三选一：
  - 当前目录运行
  - 创建 worktree 运行（在 git 仓库里新建分支 + worktree）
  - 选择已创建的 worktree 运行（下拉列出仓库现有 worktree）
  - 底部「创建 / 关闭」按钮，创建后回到任务列表（建单可带 `needsFinalReview` 需终审旗标，M4 GUI 提供勾选）
- **任务列表**：显示所有创建的任务 + 状态徽章（未开始 / 进行中 / 等待回复 / 发生问题 / 等待检查 / 已完成）+ 更新时间 + 所在目录
- **任务详情**（点开列表项）：任务标题、内容、任务状态（可下拉修改）、接手过此任务的对话（按会话工作目录是否等于任务目录自动匹配）、所在的 worktree（路径 + 分支）

## 编排（M1，Manager 任务编排 v1）

宿主半侧新增编排层：`taskManager` 服务（host 平面，供 M2 模型工具经 `ctx.get('taskManager')` 消费）+ `captains.json` 队长注册表 + 三条 HTTP 路由。会话形态遵循 ADR-0003：队长 = Manager 经 `ctx.subagents.startContinuable` 创建的 continuable 子会话，类别章程+任务简报走 per-child `persona`，工具面走 per-child `toolFilter`（deny 全部管理工具），全部 7 个工具行挂管理模式预设。

### 状态映射表（R4，定死）

| 事件 | 任务状态 |
|---|---|
| 建单未派发 | `not-started` |
| 派发成功（assign） | `in-progress` |
| 队长回报（自报状态，6 词表内） | 队长所报状态 |
| 回报待核 | `waiting-check` |
| 需终审单收到 done 回报 | **钳制为 `waiting-check`**（数据层强制；用户经 set-status 显式终审后才 `done`） |
| Manager 打回（缺证据/不合格） | `problem` |
| 形式核验通过关单 | `done` |

### 数据契约（t4/t5/t6/t7 依赖，勿猜接口）

`tasks.json`（TaskRecord 编排字段，旧记录读时补默认、旧字段不丢）：

```jsonc
{
  "id": "uuid", "title": "…", "content": "…",
  "status": "not-started|in-progress|waiting-reply|problem|waiting-check|done",
  "runMode": "cwd|new-worktree|existing-worktree", "directory": "/abs/path",
  "worktreeBranch?": "branch", "conversations?": [{"id","shortId","cwd?","createdAt?","origin?"}],
  "category?": "队长类别（首次 assign 写入）",
  "captainSessionId?": "队长会话 id（与 captains.json 一致）",
  "dispatchRound": 0,          // 派发轮次，0=未派发，每次成功 assign +1
  "report?": { "text": "…", "at": 0, "evidence?": ["路径或引用", …] },  // 最近一次回报（覆盖式）
  "needsFinalReview": false,   // 需终审
  "lastNudgeAt?": 0,           // 最近催办时间
  "createdAt": 0, "updatedAt": 0
}
```

`captains.json`（category → 记录，串行化原子写）：

```jsonc
{
  "<category>": {
    "charter": "类别章程全文（类别差异唯一载体，ADR-0002）",
    "sessionId?": "队长会话 id（首次建会话成功后写入，失败回滚）",
    "createdAt": 0,
    "lastDispatchAt?": 0
  }
}
```

`taskManager` 服务方法签名（错误统一抛 `OrchestratorError`，`code` ∈ TASK_NOT_FOUND / NOT_CAPTAIN / INVALID_STATUS / INVALID_INPUT / NOT_DISPATCHED / MANAGER_AGENT_REQUIRED / DELIVERY_UNAVAILABLE / CREATION_FAILED）：

```ts
assign(taskId, category, options?: { charter?, managerSessionId? }):
  Promise<{ taskId, category, captainSessionId, dispatchRound, created, charter }>
report(sessionId, taskId, status, text, evidence?): Promise<TaskRecord>   // 身份校验线（ADR-0003）
applyReportHuman(taskId, { status, text, evidence? }): Promise<TaskRecord> // GUI 手动补录（无身份语义）
listMine(sessionId): Promise<TaskRecord[]>
nudge(taskId, options?: { managerSessionId? }): Promise<{ taskId, lastNudgeAt }>
captains(): Promise<Array<CaptainRecord & { category, taskCount }>>
setCharter(category, charter): Promise<CaptainRecord & { category }>
```

派发语义：`assign` 新类别/无会话 → `startContinuable({provider:'spawn', label:'队长·<类别>', childId, request:{prompt, parent: managerAgent, persona: 章程+简报, toolFilter: {deny: [管理工具×5]}}, signal})`（managerSessionId 必填）；已有会话 → live 走 `Agent.followup`（唤醒）、不 live 走 `subagents.followup(managerAgent, …)` 冷恢复。`charter` 仅创建分支生效（persona 建会话时定型）。

### HTTP 路由（GUI 用，无身份语义）

| 路由 | 语义 |
|---|---|
| `GET /plugins/dsh-task-manager/captains` | 注册表快照（含 taskCount） |
| `PUT /plugins/dsh-task-manager/captains` | 章程编辑（upsert，可先于首派预写） |
| `POST /plugins/dsh-task-manager/assign` | 派发 `{taskId, category, charter?, managerSessionId?}` |
| `POST /plugins/dsh-task-manager/report` | 人类手动补录 `{taskId, status, text, evidence?}`（写最近回报；需终审钳制同服务层） |

## 安装

```sh
dsh plugin --profile web add link:/home/sx/MyAI/dsh-extensions/plugins/dsh-task-manager
# 重启 web GUI 服务使 bundle 生效
systemctl --user restart dsh-web
# 浏览器刷新页面加载新的 client bundle
```

## 工作原理

| 部件 | 机制 |
|---|---|
| 宿主半侧 `src/index.ts` | 在 `webServer.register` 上注册 `/plugins/dsh-task-manager/*` 同源路由（`state` / `context` / `create` / `set-status` / `captains` / `assign` / `report`）；任务落盘到 `~/.dsh/task-manager/tasks.json`（可用 `config.stateDir` 覆盖） |
| 编排数据层 `src/records.ts` + `src/stores.ts` | TaskRecord 编排字段 + 旧记录迁移容忍；tasks.json / captains.json 双 store，各自串行化 mutate + `.tmp`→`rename` 原子写 |
| 编排服务 `src/orchestrator.ts` | `taskManager` 服务（`ctx.provide('taskManager')`）：assign 创建/复用队长子会话（M0 结论 1/2 调用面）、report 身份校验（ADR-0003 强制线）、listMine、nudge、captains 读写；`OrchestratorError` 携稳定错误码 |
| 编排路由 `src/orchestration-routes.ts` | /captains、/assign、/report，错误码→HTTP 状态映射（404/403/400/409/502） |
| worktree 操作 | 直接调用 `git` CLI：`worktree list --porcelain` 枚举、`worktree add <path> -b <branch>` 创建；仓库根用 `git rev-parse --show-toplevel` 从「当前目录」（活跃会话 cwd → 首个 workspace → 进程 cwd）向上解析 |
| 「接手过此任务的对话」 | 读时派生：枚举 `ctx.sessions.list()`，匹配 `header.cwd` 等于（或位于）任务目录的会话 |
| 浏览器半侧 `src/client/index.tsx` | 侧边栏入口（DOM 注入 New Session 之后）+ `conversation.view` 视图（`TaskView`：NewTaskDialog / TaskList / TaskDetail 三个 React 组件）；与宿主经同源 `fetch('/plugins/dsh-task-manager/...')` 通信 |
| 视图切换 | 点击侧边栏按钮 → 找到主区域 header 中 label 匹配的 `[role="tab"]` 并 `click()`（官方 Automations 同款 `actions.setView` 机制） |
| locale | 官方 `locale.register('dshTaskManager', {zh, en})` + `getLocale()` 跟随会话语言 |

## 开发

```sh
pnpm install
pnpm typecheck && pnpm build
```

## 出处

- **切换机制**（注册 `conversation.view` 视图 + 侧边栏按钮点击匹配 tab）沿用官方 `dsh-automation-client` 先例
- **Client↔Host 通信**沿用 `dsh-agent-teams` 的 `webServer.register('/plugins/...')` + 浏览器同源 fetch 模式
- 侧边栏 DOM 注入沿用本机 `dsh-sidebar-taskbar` / `dsh-aionui-panel` 的 `waitForElement` 先例（放置后窄观察，流式输出零 DOM 开销）