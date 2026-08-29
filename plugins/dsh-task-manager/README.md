# dsh-task-manager

DSH Web GUI 任务管理器（纯 profile-bundle 覆盖层，**零官方源码修改**）。宿主半侧负责任务持久化与 git worktree 操作，浏览器半侧提供一个「任务管理」主视图：新建对话框 → 任务列表 → 任务详情。

点击侧边栏标题下方的 **任务管理 / Task Commander** 按钮，把中间主区域（AI 对话输入输出面板）**整区切换**成任务面板——与官方「Automations」面板同款的主视图切换（`conversation.view` 视图环）。

## 功能

- **新建任务对话框**：标题（输入内容后自动生成，也有「生成标题」按钮）、任务内容、运行位置三选一：
  - 当前目录运行
  - 创建 worktree 运行（在 git 仓库里新建分支 + worktree）
  - 选择已创建的 worktree 运行（下拉列出仓库现有 worktree）
  - 底部「创建 / 关闭」按钮，创建后回到任务列表
- **任务列表**：显示所有创建的任务 + 状态徽章（未开始 / 进行中 / 等待回复 / 发生问题 / 等待检查 / 已完成）+ 更新时间 + 所在目录
- **任务详情**（点开列表项）：任务标题、内容、任务状态（可下拉修改）、接手过此任务的对话（按会话工作目录是否等于任务目录自动匹配）、所在的 worktree（路径 + 分支）

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
| 宿主半侧 `src/index.ts` | 在 `webServer.register` 上注册 `/plugins/dsh-task-manager/*` 同源路由（`state` / `context` / `create` / `set-status`）；任务落盘到 `~/.dsh/task-manager/tasks.json`（可用 `config.stateDir` 覆盖） |
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