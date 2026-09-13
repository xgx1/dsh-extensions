# dsh-extensions

DeepSeek Harness（DSH）个人扩展集合。遵循极简原则：**一个功能一个目录**。

## 结构

- `skills/<名字>/` —— DSH 技能**源**；由 `install-skill.sh` 软链到 `~/.dsh/skills/<名字>`
- `plugins/<名字>/` —— DSH 插件（独立 npm 包，`dsh plugin --profile web add link:<目录>` 安装）
- `vendor/<名字>/` —— 第三方上游克隆（各自带 `.git` 与远端，被本仓 `.gitignore` 忽略；改它们要在各自目录里提交）

## 技能安装：软链，不是副本

```sh
./install-skill.sh            # 扫描两个技能源，软链到 ~/.dsh/skills/
./install-skill.sh --dry-run  # 只看会做什么
./install-skill.sh --force    # 允许覆盖已存在的真实目录（先备份到 ~/.dsh/skill-backups/）
```

技能源有两处：本仓 `skills/`，以及 `~/projects/update-app/skills/`（`update-all` 技能随它的 CLI 走）。

**改动无需复制**：`~/.dsh/skills/<名字>` 是指向源目录的软链，改完即生效、提交即版本化。
这个设计是为了消灭旧「托管副本」模式下的漂移——曾经运行时那份还在教一个已被删除的仓库。

## 已有扩展

### 技能

- [`dsh-extension-dev`](skills/dsh-extension-dev/SKILL.md) —— DSH 扩展开发元技能：先搜索复用 → 调 `cordis-plugin-development` 技能 → 极简（一功能一插件）→ 传 GitHub。
  - 形态分类与证据优先思路参考 [w2112515/dsh-plugin-development](https://github.com/w2112515/dsh-plugin-development)
  - 基本原理参考官方 [extension-cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)
- 其余 6 个来自 **JetBrains [rider-skills](https://github.com/JetBrains/rider-skills)** 及本机适配：
  `debugging-code` / `finding-tests` / `refactoring-code` 取上游原样；
  `unreal-code-authoring` / `unreal-live-debugging` / `unreal-test-authoring` 由上游 `ue-*` 改名并适配本机。
  上游克隆已于 2026-09-13 删除（当时无运行时消费者）——需要对照上游时重新 clone 即可。

### 插件

- [`web-dsh-web-extension`](plugins/web-dsh-web-extension/README.md) —— DSH Web GUI 布局扩展：对话内容铺满、输入框左对齐、设置面板「对话布局」行。纯 profile-bundle 覆盖层（官方 `webServer.tapIndex` seam + `settings.general.item` 设置行），零官方源码修改。
- [`dsh-sidebar-taskbar`](plugins/dsh-sidebar-taskbar/README.md) —— 侧边栏会话任务栏：工作区上方显示运行结束（绿）/运行中（红）/等待回复（琥珀）会话，点击跳转；折叠自动隐藏。数据复用官方 sessions 快照，零官方源码修改。
- [`dsh-task-manager`](plugins/dsh-task-manager/README.md) —— 任务管理器：侧边栏标题下方「任务管理 / Task Commander」按钮，点击把中间主区域（AI 输入输出面板）**整区切换**为任务面板（官方 `conversation.view` 视图环，非右侧浮层），面板左上角「创建新的任务」按钮；header 视图标签一键切回对话。纯 profile-bundle 覆盖层，零官方源码修改。

> 这里只写**用途与来源**；目录清单以 `ls skills/ plugins/ vendor/` 为准，不在此逐目录罗列（清单会漂，`ls` 不会）。
