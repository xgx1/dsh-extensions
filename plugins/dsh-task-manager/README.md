# dsh-task-manager

DSH Web GUI 任务管理器（纯 profile-bundle 覆盖层，**零官方源码修改**）。

点击侧边栏标题下方的 **Task Commander（任务管理）** 按钮，把中间主区域（AI 对话输入输出面板）**整区切换**成任务管理面板——不是右侧浮层，而是与官方「Automations」面板同款的主视图切换：

- **侧边栏入口**：标题下方第一行「任务管理 / Task Commander」按钮（New Session 按钮之下的第一个位置）
- **主视图替换**：点击后中央对话区整体切换为任务面板；面板左上角蓝色 **「创建新的任务 / Create New Task」** 按钮，点击显示占位提示、再点收起
- **一键返回**：点面板顶部视图标签「对话 / chat」即可切回聊天
- **流畅**：面板走官方 `conversation.view` 视图环生命周期（无 body 全局 MutationObserver），流式输出时插件零 DOM 开销

## 安装

```sh
dsh plugin --profile web add link:/home/sx/MyAI/dsh-extensions/plugins/dsh-task-manager
# 重启 web GUI 服务使 bundle 生效
systemctl --user restart dsh-web
```

## 工作原理

| 部件 | 机制 |
|---|---|
| `src/client/index.ts` | 两个加法点：① DOM 注入侧边栏入口（注入 New Session 按钮之后；放置后只窄观察 sidebar 根自愈，无全局 mutation 风暴）；② 向官方 `conversation.view` 视图环注册 `task-manager` 视图（占用第 4 槽位，chat/automation 同环，`replaceRisk:none`） |
| 视图切换 | 点击侧边栏按钮 → 找到主区域 header 中 label 匹配的 `[role="tab"]` 视图标签并 `click()`（官方 Automations 面板同款切换机制 `actions.setView`） |
| `TaskView` 组件 | React.createElement 渲染完整面板：head 区左上「创建新的任务」按钮 + 面板标题，body 区占位提示 |
| locale | 官方 `locale.register('dshTaskManager', {zh, en})` + `getLocale()` 跟随会话语言（zh「任务管理」/ en「Task Commander」） |

## 开发

```sh
pnpm install
pnpm typecheck && pnpm build
```

## 出处

- **切换机制**（注册 `conversation.view` 视图 + 侧边栏按钮点击匹配 tab）沿用官方 `dsh-automation-client` 先例（`[role="tab"]` 查找 + `slots.inject('conversation.view')`），官方源码零修改
- **「替换主区域而非右侧浮层」是用户明确要求的形态**：`conversation.view` 的 `only: active id` 渲染会让该视图占满整个会话主体区
- 侧边栏 DOM 注入沿用本机 `dsh-sidebar-taskbar` / `dsh-aionui-panel` 的 `waitForElement` 先例（但按性能教训收紧为放置后窄观察）；构建产物形态与 `web-dsh-web-extension` 一致（`__ModuleLoader__` + platform-module external）
- `dsh-task-board`（仓库现存同类）未复用：用户明确要求全新实现、且其形态（独立滑出板）与本需求（整区主视图替换）不同