# update all —— 更新所有软件（源码项目 + Scoop 应用 + 特殊配置/DSH 插件）

## 何时使用

用户说「更新所有软件 / 全部更新 / 跑一下 update all / 更新一下所有东西 / 检查更新」等时使用。

## 一句话架构

**update-app** CLI（.NET 10，`C:\Users\Admin\Project\Other\update-app`）读取 `applist.toml`，
执行三类更新并把逐项结果写成结构化 JSON；本技能负责：跑 CLI → 读日志 → 分类处理 →
把新问题的解法固化成规则（下次 CLI 自己就能处理，不再需要 AI）。

## 更新逻辑（applist.toml 三类配置）

| 类别 | 配置 | 默认动作 |
|---|---|---|
| 源码型项目 | `[source.projects]`：本地源码目录 | `git -C <path> pull --ff-only`（可自定义 command / post_commands） |
| Scoop 应用 | `[scoop]`：`update_all = true` 则 `scoop update *`；false 则更新 `apps` 列表 | 按配置执行 |
| 特殊配置 | `[special.items]`：如 DSH 插件源码（paths 单仓库或含多仓库的目录） | 逐路径 `git pull` + 可选后置命令（如同步技能到 `~/.dsh/skills`） |

## 前置检查

1. **配置文件**：`C:\Users\Admin\Project\Other\update-app\applist.toml`
   （修改后请向用户确认再动；路径建议正斜杠 `C:/...`）
2. **CLI 自举**：优先读 `C:\Users\Admin\Project\Other\update-app\bin\current.json` 里的 `exe` 路径；
   文件不存在或 exe 跑不动 → 按下方「自更新」先发布一次。
3. **环境坑（本机实测）**：
   - 手工用 dotnet CLI 构建前务必清掉两个会坏事的用户级环境变量：
     `Remove-Item Env:MSBuildSDKsPath,Env:Version`
     （`MSBuildSDKsPath` 指向 dotnet9-sdk 会强改用错 SDK targets；`version=N/A` 会让 NuGet 报版本错误）
   - update-app 内部已自动剥离这两个变量，但你自己跑 `dotnet build/publish` 时要手动处理。
   - dotnet 用 scoop 的：`C:\Users\Admin\scoop\apps\dotnet-sdk\current\dotnet.exe`（.NET 10，
     Program Files 的 dotnet 只有 host 没有 SDK）。

## 标准流程

### 1. 运行

```powershell
$exe = (Get-Content 'C:\Users\Admin\Project\Other\update-app\bin\current.json' -Raw | ConvertFrom-Json).exe
& $exe run --config 'C:\Users\Admin\Project\Other\update-app\applist.toml'   # 可后台运行
```

常用子命令：`run`（执行）、`list`（看配置）、`validate`（校验路径/依赖）、`self`（自更新发布）；
选项：`--dry-run`（只预览）、`--only <关键字>`（只跑匹配项，如 `--only dsh` 只更新 DSH 插件源码）。

### 2. 读日志分类

结果在 `C:\Users\Admin\Project\Other\update-app\logs\`：
- `latest.json` / `run-<时间戳>.json` —— 结构化摘要（`items[].status`）
- `latest.log` / `run-<时间戳>.log` —— 人类可读日志

逐项 status 语义：

| status | 含义 | 你的动作 |
|---|---|---|
| `ok` / `fixed` | 成功 / 规则自动修复成功 | 无需处理 |
| `skipped` | 已知问题按规则跳过 | 无需处理（可在汇总时提一句） |
| `needs_input` | 命中规则但需要用户拍板 | 提问，见第 3 步 |
| `failed` | 未命中规则，或修复后仍失败 | AI 处理，见第 4 步 |

### 3. 处理 needs_input

- 用 `ask_user_question` 一次问清（每题给选项，如「stash 后重试 / 跳过本次 / 手动处理」），
  **同时继续**处理 other failed 项和整理剩余报告——不需要干等。
- 用户答复后按答复执行，再跑 `--only <name>` 验证该项变 ok/fixed。

### 4. 处理 failed（自动处理逻辑）

对每个 failed 项读它 Output：

1. **判断根因**：网络？路径？scoop 包损坏？构建失败？git 冲突？WIP？
2. **可自动修 → 直接修**（例：网络设代理 `127.0.0.1:7897` 重试、`scoop reset <app>`、补依赖、清理锁文件），
   修完跑 `run --only <name>` 验证。验证通过后：
3. **固化规则（核心闭环）**：把解法写进 applist.toml 新增一条 `[[fixes.rules]]`：
   - `match` = 报错关键词正则（尽量精确到稳定子串）
   - `command` = 修复命令模板（可选，支持 `{name}` `{path}`；不写则只重试一次）
   - `retry = true`；需要拍板的语义用 `skip = true` 或 `ask_user = true` + `hint`
   - 再跑一次 CLI 确认该规则能把问题自动处理掉（fixed/skipped/needs_input），
     从此**这个软件的问题不再需要 AI 介入**。
4. **需要用户判断的** → 归入 needs_input 一起问。

### 5. update-app 自身出问题

- 现象：直接调 current.json 的 exe 报错/起不来；或 publish 失败。
- 处理：更新它本身 —— `git -C C:\Users\Admin\Project\Other\update-app pull`（有 remote 时），
  修代码 bug，然后 `update-app self` 重新发布（会写入新的 current.json），再重跑全流程。
- update-app 的 bug 修复记得 commit（有 remote 则 push）。

### 6. 汇总报告

按类别给出：成功/自动修复/skipped/待确认/失败 清单 + 下一步动作（哪些等用户回复、哪些建议调整配置）。

### 7. DSH 相关更新后的收尾：最后重启 PM2

本机 DSH（dsh-web / dsh-proxy / headroom 代理 / ollama 等）由 PM2 托管。凡是改了 DSH 插件、MCP 注册
（`~/.dsh/profiles/web/cordis.patch.yml`、mcp.json 等）、web profile 配置，**必须重启才生效**，
且只放在**所有更新确认 OK 之后**做：

- 执行 `pm2 restart all`（用户确认：直接全量重启，含 DSH 自身）。
- **绝不能提前重启**：dsh-web 就是 DeepSeek harness 本体，中途重启会把当前对话与剩余工作全部打断。
- 重启瞬间本对话会断线，页面随后自动恢复——此时新配置（如卸载的 MCP）才真正生效。
- 注意 `pm2 restart all` 不会拉起当前 stopped 的应用（如 headroom-kimi），需要时单独 `pm2 start <name>`。

## 本机已知问题速查

| 日志特征（match） | 处理 |
|---|---|
| `Could not resolve host` / `Failed to connect` / `unable to access` | 网络问题，规则已跳过；可设代理 `http://127.0.0.1:7897` 后重试 |
| `git push` 报 `Failed to connect to github.com:443` / `Connection was reset` | 先查代理：`Test-NetConnection 127.0.0.1 -Port 7897`；端口在听仍失败 = 代理上游问题，本地 commit 不受影响，等网络恢复后重试 push 即可 |
| `fatal: not a git repository` | 路径不是 git 仓库：确认路径 / `git init`，规则已 ask_user |
| `CONFLICT` / `Automatic merge failed` | 上游冲突：人工解决（保留双方改动），规则已 ask_user |
| `cannot pull with rebase: You have unstaged changes` | 仓库有 WIP（如 dsh-continual-evolve 常态）：
  先 `git -C <path> status` 看改动，向用户确认 stash/commit/跳过，规则已 ask_user |
| `scoop` 相关失败 | `scoop update <app>` 失败常见解法：`scoop reset <app>` 或重装；scoop 不在 PATH 先确认安装 |
| 构建报 net10 不支持 | 用了 9 的 SDK：改用 `C:\Users\Admin\scoop\apps\dotnet-sdk\current\dotnet.exe` |
| `N/A` 不是有效的版本字符串 | `version` 环境变量作祟：`Remove-Item Env:Version` 后再构建 |

## 固化原则（硬性要求）

- 每次 AI 解决一个**新的** failed 问题并验证通过后，**必须**把可复现的解法固化进
  `applist.toml [fixes.rules]`（或必要时改 update-app 代码/文档），保证下次不再需要 AI——
  这正是需求第三点的闭环。
- 修复命令严禁破坏用户的 WIP/本地改动；需要取舍时一律 ask_user。

## 交接给用户的修改点

修改过 `applist.toml`（新增/调整规则或更新项）时，在汇总里明确列出，并说明每条新规则的作用。