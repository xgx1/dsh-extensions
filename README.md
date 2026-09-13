# dsh-extensions

DeepSeek Harness（DSH）个人扩展集合。遵循极简原则：**一个功能一个目录**。

## 结构

- `plugins/<名字>/` —— **自研插件**（独立 npm 包，`dsh plugin --profile web add link:<目录>` 安装），受本仓版本控制。
- `skills/<上游仓库名>/` —— **技能分组仓**：一个上游仓库一组，各自是独立 git 仓、登记为本仓的 submodule。有上游的是 `xgx1` 下的公开 fork，无上游的是自建仓。分组理由与 fork 策略见 `../docs/adr/0006`。
  - **组内目录与上游一一对应**（2026-09-13 起）：fork 的树 = 上游最新树 + 我们的本地改动移植到对应文件。上游把技能放在 `skills/<名>/`、`.agents/skills/<名>/`、`skills/engineering/<名>/`、`plugins/<插件>/skills/<名>/`……**本仓不再把技能拍平到组根**；我们的分组 README 以 `README.dsh-local.md` 存在（避免覆盖上游 README）。
- `vendor/<名字>/` —— **第三方上游克隆**（生产 `link:` 目标），同样是 submodule，远端指各自上游。

三处都**不再被 `.gitignore` 忽略**：`skills/` 与 `vendor/` 由 `.gitmodules` 记录，本仓只保存指向各自提交的指针（见 `../docs/adr/0005`）。改子模块里的内容要**在各自目录里**提交、推送，再回本仓更新指针。

## 技能安装：软链，不是副本

```sh
./install-skill.sh            # 扫描三个技能源，软链到 ~/.dsh/skills/
./install-skill.sh --dry-run  # 只看会做什么
./install-skill.sh --list     # 只列出受管技能及来源
./install-skill.sh --force    # 允许覆盖已存在的真实目录（先备份到 ~/.dsh/skill-backups/）
```

**技能源有三处**：

1. 本仓 `skills/<分组>/**/SKILL.md`（**递归发现、不限深度**：技能目录 = 含 `SKILL.md` 的目录。上游层级不一——`skills/<名>/`、`skills/<分类>/<名>/`、`.agents/skills/<名>/`、`plugins/<插件>/skills/<名>/`——硬编码层数会静默漏技能。排除 `tests/`/`fixtures/`/`examples/`/`sample*` 噪音并**把跳过的打印出来**；同名副本取路径最浅的那份（故 `skills/`、`.agents/skills/` 优先于 `.openclaw/skills/` 之类的分发副本）。技能名优先取 frontmatter 的 `name:`，没有才用目录名）
2. `~/projects/update-app/skills/`（`update-all` 技能随它的 CLI 走）
3. `~/projects/<项目>/.dsh/skills/`（**项目专用技能**放各项目自己的仓里，不进主库）

**改动无需复制**：`~/.dsh/skills/<名字>` 是指向源目录的软链，改完即生效、提交即版本化。
这个设计是为了消灭旧「托管副本」模式下的漂移——曾经运行时那份还在教一个已被删除的仓库。

> 自检：`./install-skill.sh --dry-run` 输出里的「新建 N」应为 0，否则说明有技能没被纳入受管源。

## 已有扩展

### 技能（按来源分组）

| 分组 | 来源 | 技能数 |
| --- | --- | --- |
| `dotnet-skills` | [dotnet/skills](https://github.com/dotnet/skills) | 110 |
| `mattpocock-skills` | [mattpocock/skills](https://github.com/mattpocock/skills) | 37 |
| `obra-superpowers` | [obra/superpowers](https://github.com/obra/superpowers) | 34 |
| `quodsoler-unreal-engine-skills` | [quodsoler/unreal-engine-skills](https://github.com/quodsoler/unreal-engine-skills) | 33 |
| `self-ue` / `self-ops` / `self-dsh` | 本机自写（无上游） | 26 / 7 / 6 |
| `sipherxyz-universal-ue-skills` | [sipherxyz/universal-ue-skills](https://github.com/sipherxyz/universal-ue-skills) | 15 |
| `unrealxu-ue5-skills` | [UnrealXu/UnrealEngine5-Skills](https://github.com/UnrealXu/UnrealEngine5-Skills) | 11 |
| `rider-skills` / `dietrichgebert-ponytail` | JetBrains / DietrichGebert 的 fork | 各 6 |
| `epicgames-ue-skills` / `clawic-marketplace` | EpicGames 官方 / clawic | 各 3 |

（技能名以下载进 `~/.dsh/skills/` 的为准；数字会随安装器发现结果变化，权威值是 `./install-skill.sh --list`。）

**关于上游与本地版本**：分组仓的**目录结构与文件数与上游一致**，本地改动（改名、中文化、平台分节、本机适配）叠在对应文件上——判断某处是你改的还是上游的，`git diff upstream/<分支>` 即可。唯一例外是 `README.dsh-local.md`（我们的分组说明）。改名类改动只在 frontmatter 的 `name:` 上（如上游 `ue-cpp-foundations` 目录里放的是我们的 `unreal-cpp-foundations`），所以**技能名不随上游目录名变**。判断一个技能是否自研，看 `agents/openai.yaml` 与残存的 `license:`/`compatibility:` 键，**不要**看 `author: Sx` 或中文 frontmatter（那是本地化层批量盖的章）。

### 插件

- [`web-dsh-web-extension`](plugins/web-dsh-web-extension/README.md) —— DSH Web GUI 布局扩展：对话内容铺满、输入框左对齐、设置面板「对话布局」行。纯 profile-bundle 覆盖层（官方 `webServer.tapIndex` seam + `settings.general.item` 设置行），零官方源码修改。
- [`dsh-sidebar-taskbar`](plugins/dsh-sidebar-taskbar/README.md) —— 侧边栏会话任务栏：工作区上方显示运行结束（绿）/运行中（红）/等待回复（琥珀）会话，点击跳转；折叠自动隐藏。数据复用官方 sessions 快照，零官方源码修改。
- [`dsh-task-manager`](plugins/dsh-task-manager/README.md) —— 任务管理器：侧边栏标题下方「任务管理 / Task Commander」按钮，点击把中间主区域（AI 输入输出面板）**整区切换**为任务面板（官方 `conversation.view` 视图环，非右侧浮层），面板左上角「创建新的任务」按钮；header 视图标签一键切回对话。纯 profile-bundle 覆盖层，零官方源码修改。

### 元技能

- [`dsh-extension-dev`](skills/self-dsh/dsh-extension-dev/SKILL.md) —— DSH 扩展开发元技能：先搜索复用 → 调 `cordis-plugin-development` 技能 → 极简（一功能一插件）→ 传 GitHub。
  - 形态分类与证据优先思路参考 [w2112515/dsh-plugin-development](https://github.com/w2112515/dsh-plugin-development)
  - 基本原理参考官方 [extension-cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)

> 这里只写**用途与来源**；分组清单以 `ls skills/` 与各组 README 为准，不在此逐技能罗列（清单会漂，`ls` 不会）。
