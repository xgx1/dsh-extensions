# dsh-sidebar-taskbar

DSH Web GUI 侧边栏会话任务栏（纯 profile-bundle 覆盖层，**零官方源码修改**）：

- 工作区上方新增任务栏，三组任务：
  - **运行结束**（最上面）：会话名 + 🟢 绿点，点击跳转到该会话
  - **运行中**：会话名 + 🔴 红点，点击跳转
  - **等待回复**：会话名 + 🟡 琥珀点，点击跳转
- 状态实时变化（运行中→结束自动移动分组）；侧边栏折叠为窄条时任务栏自动隐藏
- 数据完全复用官方 `sessions.list` 快照（`running` / `pendingInteraction` / `completed`），零重复状态

## 安装

```sh
dsh plugin --profile web add link:C:\Users\Admin\Project\Other\dsh-sidebar-taskbar
pm2 restart dsh-web
```

## 工作原理

| 部件 | 机制 |
|---|---|
| `src/client/mount.tsx` | 等待官方 `[data-slot="sidebar.workspaces"]` 容器（MutationObserver），在它之前插入任务栏锚点并 `createRoot` 挂载（aionui-panel 同款 DOM 挂载先例） |
| `src/client/TaskBar.tsx` | `useSyncExternalStore` 订阅官方 sessions 快照；三组分类渲染；点击 `sessions.open(id)` 跳转；ResizeObserver 检测侧边栏折叠（宽度 < 100px 隐藏） |
| `src/client/tasks.ts` | 纯函数分类：等待回复优先于绿色完成态；结束组按 `updatedAt` 最新在前，运行/等待组最旧在前 |

## 开发

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

## 出处

数据语义（`running`/`pendingInteraction`/`completed`）与跳转 API（`sessions.open`）来自官方 `dsh-client-runtime`；DOM 挂载模式沿用本机已装 `dsh-aionui-panel` 的 `waitForElement + createRoot` 先例；构建产物形态与 `web-dsh-web-extension` 一致（`__ModuleLoader__` + platform-module external）。
