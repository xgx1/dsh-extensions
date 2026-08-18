# dsh-extensions

DeepSeek Harness（DSH）个人扩展集合。遵循极简原则：**一个功能一个目录**。

## 结构

- `skills/<名字>/` —— DSH 技能（`~/.dsh/skills/` 的托管副本）
- `plugins/<名字>/` —— DSH 插件（独立 npm 包，`dsh plugin --profile web add link:<目录>` 安装）

## 同步方式

本仓库是托管副本；本机生效路径为 `C:\Users\Admin\.dsh\skills\<名字>\SKILL.md`。技能改动后复制回仓库并 push。

## 已有扩展

- [`skills/dsh-extension-dev`](skills/dsh-extension-dev/SKILL.md) —— DSH 扩展开发元技能：先搜索复用 → 调 `cordis-plugin-development` 技能 → 极简（一功能一插件）→ 传 GitHub。
  - 形态分类与证据优先思路参考 [w2112515/dsh-plugin-development](https://github.com/w2112515/dsh-plugin-development)
  - 基本原理参考官方 [extension-cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)
- [`plugins/web-dsh-web-extension`](plugins/web-dsh-web-extension/README.md) —— DSH Web GUI 布局扩展：对话内容铺满、输入框左对齐、设置面板「对话布局」行。纯 profile-bundle 覆盖层（官方 `webServer.tapIndex` seam + `settings.general.item` 设置行），零官方源码修改。
- [`plugins/dsh-continual-evolve`](plugins/dsh-continual-evolve/README.md) —— 轮次结束钩子（fork [ZK-Andy/dsh-continual-evolve](https://github.com/ZK-Andy/dsh-continual-evolve)，MIT）：每 N 轮自动提炼记忆/技能，未完成任务限量自动继续；新增**项目级存储**（`<项目根>/.dsh/evolve` + 项目技能 `<项目根>/.dsh/skills`，git 根优先/无 git 用 cwd）。
- [`plugins/dsh-sidebar-taskbar`](plugins/dsh-sidebar-taskbar/README.md) —— 侧边栏会话任务栏：工作区上方显示运行结束（绿）/运行中（红）/等待回复（琥珀）会话，点击跳转；折叠自动隐藏。数据复用官方 sessions 快照，零官方源码修改。
