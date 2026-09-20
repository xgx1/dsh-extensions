# dsh-sidebar-taskbar

DSH Web GUI 侧边栏会话任务栏（纯 profile-bundle 覆盖层，**零官方源码修改**）：

- 工作区上方新增任务栏，三组任务：
  - **运行结束**（最上面）：会话名 + 🟢 绿点，点击跳转到该会话；**另有 ✕ 关闭按钮，只有点它才从任务栏消失**
  - **运行中**：会话名 + 🔴 红点，点击跳转
  - **等待回复**：会话名 + 🟡 琥珀点，点击跳转
- 状态实时变化（运行中→结束自动移动分组）；侧边栏折叠为窄条时任务栏自动隐藏
- 数据复用官方两个只读源：`sessions.list`（标题与更新顺序）与 `uiSession.sessionStatus`（`running` / `pendingInteraction` / `completionUnread`）。「运行结束」组另有一份本地确认态（localStorage），因为官方的 `completionUnread` 在会话成为主视图时就被清除——直接用它，点开会话的那一下就会把这一行点没

## 安装

```sh
dsh plugin --profile web add link:/home/sx/projects/MyAI/dsh-extensions/plugins/dsh-sidebar-taskbar
systemctl --user restart dsh-web
```

## 工作原理

| 部件 | 机制 |
|---|---|
| `src/client/mount.tsx` | 等待官方 `[data-slot="sidebar.workspaces"]` 容器（MutationObserver），在它之前插入任务栏锚点并 `createRoot` 挂载（aionui-panel 同款 DOM 挂载先例） |
| `src/client/TaskBar.tsx` | `useSyncExternalStore` 订阅官方 sessions 快照与统一 UI 状态快照；三组分类渲染；点击 `uiWorkspace.openSession(id)` 跳转；ResizeObserver 检测侧边栏折叠（宽度 < 100px 隐藏） |
| `src/client/tasks.ts` | 纯函数分类：等待回复优先于运行中，运行中优先于绿色结束态；结束组按 `updatedAt` 最新在前，运行/等待组最旧在前 |
| `src/client/dismissals.ts` | 「运行结束」组的本地确认态：官方 `completionUnread` 上升时入列、点 ✕ 出列，另在会话重新运行或离开列表时出列；localStorage 持久化（键 `dsh-sidebar-taskbar/done-v1`） |

### 状态语义

`uiSession.sessionStatus` 是官方对三个独立 UI 事实的统一快照，本插件沿用其语义，不自造判定：

| 分组 | 官方字段 | 含义 |
|---|---|---|
| 🟡 等待回复 | `pendingInteraction !== undefined` | 该会话有最高优先级的待用户交互请求 |
| 🔴 运行中 | `running === true` | 最近一次已知的运行状态为运行 |
| 🟢 运行结束 | `completionUnread === true` | 在主视图之外观察到停止、且尚未确认——打开会话后由官方清除 |

三者的优先级即上表顺序：欠回答的会话必须先看到。

### 结束组的确认语义

「运行结束」是通知，不是实时状态，所以它由本地确认态（`dismissals.ts`）驱动，而不是直接读官方旗标：

- **入列**：官方 `completionUnread` 由假变真（含页面刚加载时就已经为真的情况）。
- **不出列**：官方旗标由真变假——那是用户在点行跳转、官方就此「已读」，行必须活过这一下。
- **出列**：点该行的 ✕；会话重新开始运行（移入「运行中」组）；会话从列表消失。
- 关闭态写 localStorage，刷新后依然关闭；同一会话再次结束会重新入列。
- 「运行中」「等待回复」两组没有 ✕：它们是实时状态，关掉下一秒就会因状态未变而重现。

## 变更记录

- **0.3.0** — 「运行结束」组改为手动关闭。原来该组直接读官方 `completionUnread`，点一下行（跳转到会话）官方就清除旗标、行随之消失；现在结束组由本地确认态驱动，点行只跳转、行仍在，只有点该行的 ✕ 才移除，关闭态刷新后依然有效。
- **0.2.0** — 修复任务栏整体不可见。DSH 升级后旧实现读取的三个面已失效：`sessions.open` 移出 Session face（跳转改走 `uiWorkspace.openSession`），`SessionSummary.completed` 字段已删除，`uiSession.pendingInteractions` 已并入统一的 `uiSession.sessionStatus`。旧代码在 `getSnapshot()` 上调用 `undefined`，React 根渲染即抛错，任务栏锚点在 DOM 中但永远为空。
- 0.1.0 — 初版。

## 开发

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

## 出处

状态语义来自官方 `@deepseek-ai/dsh-client-ui-session`（`SessionStatus` / `SessionStatusSnapshot`），跳转 API 来自 `@deepseek-ai/dsh-client-ui-workspace`（`UiWorkspace.openSession`），标题与顺序来自 `@deepseek-ai/dsh-api-session-controller` 的 `sessions.list`；DOM 挂载模式沿用本机已装 `dsh-aionui-panel` 的 `waitForElement + createRoot` 先例；构建产物形态与 `web-dsh-web-extension` 一致（`__ModuleLoader__` + platform-module external）。
