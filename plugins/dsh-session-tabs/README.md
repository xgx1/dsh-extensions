# dsh-session-tabs（DSH 会话标签页，适配版）

浏览器式会话标签页导航栏：每打开一个会话一个标签，点击切换、关闭、新建，当前会话高亮，状态点指示运行/等待/完成。

## 出处与许可

基于 [seekerwxy/dsh-session-tabs](https://github.com/seekerwxy/dsh-session-tabs)（MIT，© 2025 seekerwxy）适配本机 DSH 部署。UI、CSS、交互逻辑保持上游原样，仅做两处适配：

1. **关最后一个标签**：上游调用 `sessions.clear()`，本部署 `sessions` 服务无此方法 → 改为 `workspaces.startSession()`（浏览器式「关完开新页」）。
2. 动态插件包装：`client.js` 为 `cordis_define` 的 Client 半函数体（`return { apply(ctx) {...} }`）。

## 技术要点（经 Inspect 验证）

- 席位：`shell.overlay`（list 槽位，`{id:'session-tabs', order:-50}`），不替换任何出厂 UI
- 数据：标准 prop `useSessions`（`current` + `byId`），标签顺序为页面内 MRU
- 动作：`sessions.open(id)` 切换、`workspaces.startSession()` 新建/关空
- 空间预留：`#root { padding-top: 34px }`（本机 apps/web/index.html 确认 `#root` 存在）
- 主题：`--dsw-alias-*` token 全带 fallback，亮/暗自动适配

## 用法

动态插件：把 `client.js` 内容作为 `cordis_define` 的 Client 半 → `cordis_run`。
