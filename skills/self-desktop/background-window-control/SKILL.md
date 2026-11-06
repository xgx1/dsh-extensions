---
name: background-window-control
description: 在不打断人的前提下操作另一批 GUI 应用：把别人的原窗口显示出来、把键鼠定向投进指定窗口、对指定窗口截图。当用户要求"后台/不抢焦点地"驱动 Unity、Unreal、浏览器、.NET 等应用，或要验证/改动这套 scoped 输入能力时使用。
---

# 后台窗口控制（显示原窗口 / 定向键鼠 / 单窗口截图）

## 这套东西到底是什么

- **niri fork**（`/home/sx/projects/niri`，分支 `scoped-input-poc`）在 26.04 上加了：
  - 额外的 `agent-0` 席位（虚拟键盘/指针，投递到被 pin 的一个窗口）；
  - IPC `ScopedTarget{window}`（`none` 清除）和 `ScopedScreenshot{window,path}`；
  - 被 pin 的窗口豁免 focus-follows-mouse（`b55b7334`），未知 target 失败关闭（`0647becb`）。
- 小工具在 `/home/sx/projects/agent-seat-probe`（私有仓 `xgx1/agent-seat-probe`，
  `Cargo.toml` 的 `niri-ipc` 走 `../niri` 相对路径，clone 时与 niri 检出放同级）：
  `agent-seat-probe`（席位输入）、`scoped-target`、`scoped-shot`、`sink`（按座位归属验证投递）。
- **能力只在 fork 二进制起的实例里成立**：嵌套环境用 `target/debug/niri`；生产桌面自 2026-11-05
  起跑 `target/release/niri`，且**上游 `niri` 包已卸载**（`/usr/bin/niri` 已不存在）：
  - 单元 `~/.config/systemd/user/niri.service`（整份本地 unit，不再有 drop-in）；
  - 入口链 greetd → `/usr/local/bin/start-desktop` → `/usr/local/bin/niri-session` → `systemctl --user start niri.service`；
  - `niri` 命令是 `/usr/local/bin/niri` 包装脚本，指向 fork release（`niri msg` / `validate` 都走它）。
  **重启它 = 重启整个桌面会话**（窗口全关），动手前先问用户。`/usr/local/bin/start-desktop` 带 30s 看门狗：
  会话起不来会自动 `pacman -U` 缓存包并起 `niri-fallback.service`；手工等价步骤就是这三条命令。
- 落点：**每个工作区一个 agent 桌面**（见第 0 节）；要干净可复位的回归环境时，用同一套机制的
  私有实例：嵌套 niri 挂生产合成器（窗口停 `ue`）→ 它自己的 xwayland-satellite（第 1 节）。
  **没有 Xvfb**（2026-11-06 已把 `xorg-server-xvfb` 卸载、两套回归夹具全部改掉）。
  生产桌面也是 fork（`scoped-target` 失败关闭在真会话上验过），但注入类实测仍只在嵌套环境做。

## 0. 先选路线

| 用户要的效果 | 用什么 | 不要用什么 |
| --- | --- | --- |
| 人想"看一眼"后台应用 | niri 浮窗搬运 + `scoped-shot` 截图 | 不要注入键鼠 |
| 应用必须真的收到输入（canvas/游戏） | `scoped-target` + 席位（原生 Wayland）、`xi2-inject`（satellite 的 X11） | 不要用 `xdotool type --window`（XSendEvent） |
| 读内容（浏览器/有 a11y 的应用） | 优先 a11y/CDP/应用自带 API | 不要靠模拟点击抓数据 |
| 运行 UE/Unity 全屏游戏 | 先在嵌套环境里跑，X11 走 satellite + MPX | 不要在人正在用的会话里全屏接管 |
| Unity/UE 桌面包的端到端点击测试（要固定分辨率、模拟键鼠） | 直接在自己的 agent 桌面里跑：`DISPLAY=:10`（satellite 的 X11）或原生 Wayland，桌面本身就是合成器/窗口管理者 | **不要 `xvfb-run` / 自起 `Xvfb`**：软渲染（llvmpipe）、面板上还得额外扫、焦点只能靠指针 |

## 0. 落点：GUI 默认在自己的 agent 桌面（2026-11-06 起）

`dsh-web` 的 bash 工具命令启动时会 source `~/.dsh/bin/agent-shell-env.sh`（systemd drop-in 里的
`BASH_ENV`），按工作区 key 找/拉起一个嵌套 niri 桌面，并把 `WAYLAND_DISPLAY` / `DISPLAY` / `NIRI_SOCKET`
指过去。所以：

- 直接跑任何 GUI（Unity、Unreal、Electron、GTK）**默认落在自己的 agent 桌面**，不是人的桌面；
  `niri msg ...` 也操作自己的桌面（`agent-niri` 等价）。
- 人的桌面：`prod-niri msg ...`、`prod-xdo ...`、`prod-grim ...`，或直接用 `PROD_NIRI_SOCKET` /
  `PROD_DISPLAY` / `PROD_WAYLAND_DISPLAY`。`PROD_NIRI_SOCKET` 指向**当前活着的**生产 socket，
  不要用从 dsh-web 进程继承下来的旧值（可能停在已结束的会话上）。
- 单条命令要留在人的桌面：`AGENT_DESKTOP=0 <命令>`。
- 桌面管理：`~/.dsh/bin/agent-desktop.py list | up | down --all | env | run -- CMD`；30 分钟没命令没窗口自动收。
  key 是工作区根目录（向上找 `.git`/`AGENTS.md`/`.dsh`）md5 前 8 位，形如 `ws-6f1aa0a4`。
- 看/接手别人的桌面：http://127.0.0.1:8793/ 的「其他桌面」区，或
  `dsh-desktops.py action <桌面> type --text ... | key --combo ... | click --x X --y Y | focus-window --window N`。
- **真 GPU（2026-11-06 起）**：agent 桌面是生产合成器的 **Wayland 客户端**（父表面 = 生产 niri 的 Wayland，
  不再套 Xvfb），所以嵌套 niri 和里面的客户端直接拿到 `/dev/dri/renderD128`，UE/Unity 的 GPU 部分能跑。
  以前套 Xvfb 时是 llvmpipe 软渲染（X 虚拟帧缓冲没有 DRI3），那条路的限制只对**回归环境**（第 1 节）成立。
  agent 桌面在 `ue` 工作区是一个普通窗口（规则 app-id `^niri$` → `ue` + `open-focused false`），要看按 `Mod+U`。
- **不要为了"要 GPU"把 GUI 塞进生产桌面**：agent 桌面已经是真 GPU，照常启动即可。
  `NIRI_SOCKET=$PROD_NIRI_SOCKET niri msg action spawn -- ...` 这种写法会把窗口开到人的合成器上
  （2026-11-06 12:12 就是这样把 UnrealEditor 开到 `ue` 的）。只有 VR/OpenXR 预览、独占全屏、GPU 基准
  这类必须碰物理 GPU 会话的，才用 `AGENT_DESKTOP=0` 回生产桌面。
- 打字/点击只走 agent 座位：`scoped-target <嵌套窗口 id>` 钉住，然后
  `agent-seat-probe agent-0 text '...'` / `keys 'ctrl+v'` / `click <x> <y>`（坐标是千分数）。
  中文等非 ASCII 由 `dsh-desktops.py` 自动走 `wl-copy`（写进这个桌面自己的剪贴板）+ `keys 'ctrl+v'`。
  **别用 `wtype` 往生产合成器打字**——它绑注册表里最后一个 seat，绑到 seat0 就会打进人的窗口。
- 下面几节的嵌套测试环境流程（`cycle.py`）依然适用于**需要干净可复位环境**的回归；
  日常干活用 agent 桌面即可。本机没有 Xvfb 了，也别再 `xvfb-run`。

## 1. 起环境（默认方式）

```bash
cd /home/sx/projects/MyAI/.scratch/background-window-control/regression-visibility
python3 cycle.py 1 smoke.py
```

一条命令完成：起嵌套 niri（生产合成器的 Wayland 客户端，窗口自动停 `ue`）+ 它自带的
satellite → 起 4 个真实 GTK fixture（`regression-human` 原生、`regression-agent-x11`、
`regression-agent-native`、`regression-human-x11`）→ 跑 `smoke.py`（6 步，验证本文件里的命令）
→ 收尾清理。**每轮都是全新环境**：同一环境连跑第三次起 X11 注入会整体失效，这是实测事实，
不要试图复用。人看到的永远是 `ue` 里那个嵌套窗口，不会糊到面前来。

手动长会话：

```bash
python3 environment.py &      # 等出现 run/environment.json
python3 apps.py &             # 等出现 run/apps.json
# 交互……结束收尾（必须）：
touch run/STOP-APPS run/STOP  # 两个脚本回收自己的子进程；XDG_RUNTIME_DIR 与生产共用，不再有私有目录
```

Python 里直接用 `testlib.py`：`windows() focus() workspaces() action() act() by_title() state()
agent() human() human_motion() xdo() shot() run()`；`ENV` 已带 `XDG_RUNTIME_DIR/WAYLAND_DISPLAY/
NIRI_SOCKET` 并从环境里删掉 `DISPLAY`（X11 fixture 要自己塞 `INFO['display']`，跑 `xdotool` 用 `xdo()`）。
`environment.json` 字段：`display`（satellite 的 X11）、`wayland`/`ipc`（嵌套 niri）、`runtime`
（`/run/user/1000`，与生产共用）、`parent_wayland`、`parent_window`（人在生产合成器上看到的那个窗口）、
`park_workspace`（默认 `ue`，可用 `BWC_PARK_WORKSPACE` 改）、`pids`。没有 `parent_display`：
人的那一面是 Wayland，模拟"人把鼠标移过去"用 `human_motion(x千分比, y千分比)`（探针的 `motion` 模式）。

## 2. 显示原窗口但不夺焦

```bash
niri msg action move-window-to-floating --id <WIN>
niri msg action move-window-to-workspace --window-id <WIN> --focus false <WORKSPACE>
niri msg action set-window-width  --id <WIN> 400
niri msg action set-window-height --id <WIN> 320
niri msg action move-floating-window --id <WIN> -x 800 -y 80
```

- `--focus false` 是关键：窗口搬过去、亮起来，焦点留在原窗口（回归 03 有逐事件证据）。
- `-x/-y` 裸数字 = **绝对**位置，`+N`/`-N` = 相对，`N%` = 占工作区比例
  （`PositionChange` 的 FromStr 语义，别再照抄"相对位移"的说法）。
- 等价 JSON：CLI 参数拿不准时直接往 niri socket 写一行
  `{"Action":{"MoveWindowToWorkspace":{"window_id":3,"reference":{"Name":"human"},"focus":false}}}`，
  `testlib.action()` 就是这么发的（`niri msg` 只用来发 CLI 形式）。
- 浮窗只压在平铺窗口之上；fullscreen/其他浮窗不保证。
- `<WORKSPACE>` 是索引或名字（`human`/`agent`），不是内部 id。

## 3. 把键鼠定向送进一个窗口

### 3.1 原生 Wayland 或 satellite 的 X11 窗口 → agent-0 席位

```bash
scoped-target <WIN>            # 选窗口；scoped-target none 解除
agent-seat-probe agent-0 key 30          # evdev 30 = a（48=b，35=h）
agent-seat-probe agent-0 click 500 500   # 坐标是千分比：0..1000 相对被 pin 的窗口
agent-seat-probe agent-0 wheel 500 500 2 # 位置 + 滚轮格数
agent-seat-probe agent-0 drag 100 100 900 900 12
PROBE_SKIP_MOTION=1 agent-seat-probe agent-0 key 30   # 只测键盘路径
```

- **先 `scoped-target` 再发键**：席位键盘焦点只在 pin 建立后设置。
- 席位名写错时报错会列出所有 seat（`seat "x" not found; seats = [...]`），拿它当发现手段。
- `scoped-target` 对未知 id 非 0 退出且**不动**原目标（fail closed）；脚本里必须检查退出码。
- 投递到 X11 窗口时，前提是 satellite 持有 Wayland 键盘焦点（见坑 2）。

### 3.2 satellite 的 X11 窗口，要在同一个 X server 里做多设备隔离 → MPX

```bash
cd .scratch/background-window-control/regression-visibility
gcc -O1 -Wall -Wextra -o xi2-inject xi2-inject.c -lX11 -lXi -lXtst   # 首次或改源码后
./xi2-inject --display :2 state                     # 看 core/master 焦点与两个指针
./xi2-inject --display :2 type  <XID> "hello"       # 用 agent master 打字
./xi2-inject --display :2 key   <XID> Return
./xi2-inject --display :2 click <XID> 300 80        # 窗口内像素坐标
./xi2-inject --display :2 move  <XID> 10 10
./xi2-inject --display :2 remove                    # 收掉 master
```

- `--display` 必须显式给且非 `:0`（工具自己拒绝 `:0`）。
- **测量 core 状态必须开新进程**：自己设过 `XISetClientPointer` 的连接看到的是自己的视角，
  会得出"core 被改动了"的假结论（踩过）。
- 这里是 X core 焦点 + `mpx-agent` master 焦点两套并行，不是 MPX 关闭 X11。

### 3.3 截图（不碰剪贴板）

```bash
scoped-shot <WIN> /tmp/look.png          # 单次请求，回复到达时 PNG 已落盘
scoped-shot <WIN> /tmp/look.png legacy   # 老动作，会占用剪贴板（对照组）
```

- 文件名必须新：`testlib.shot()` 直接拒绝已存在路径，避免把上一轮旧文件当成新截图。
- 失败/未知窗口：非 0 退出 + stderr，从"打印了错误但 exit 0"改过来的。

### 3.4 人在嵌套环境里的输入

`human('click',100,100)` / `testlib.human('key',35)` 走 `agent-seat-probe winit ...`
（嵌套 niri 里人的座位叫 `winit`），不是 XTest，所以和席位的 scoped 输入是两条真路径。

## 4. 实测踩过的坑

1. **XSendEvent 不是投递路径**：`xdotool type --window` 对 GTK3 文本零变化。后台打字只能走
   席位或 MPX。旧文档"Unity 截图不变即证明全拒"就是误用了这条。
2. **satellite 只有一个 Wayland 客户端 → 只有一个键盘焦点**：人的焦点在原生 Wayland 窗口时，
   注入其 X server 的按键（core 和 MPX 都一样）全被丢。测 X11 隔离前先把人切进一个 X11
   窗口：`niri msg action focus-window --id <HX>`。跨「X11 agent ↔ Wayland 人」的键盘隔离
   在这条路上做不到，那种场景用 agent-0 席位。
3. **同一环境第三次起注入失效** → 每轮重建（`cycle.py`）。
4. **focus-follows-mouse**：本机开着；fork 只豁免**当前 pin 的窗口**，未 pin 的窗口仍会夺焦。
5. **GTK 同名 helper 窗口**：同一 title 会多出一个 10×10 窗口。按 XID 选框要取面积最大的
   （`xdotool search` + `getwindowgeometry --shell` 算 WIDTH×HEIGHT），否则 `windowfocus`
   会 `BadMatch`。
6. **`xdotool getwindowfocus` 不可靠**（`xdo_get_focused_window_sane failed`）：用
   `xi2-inject ... state` 或 niri `FocusedWindow`。
7. `set-window-width/height` 是绝对值；`move-floating-window` 的 `-x/-y` 用裸数字才是绝对值。

## 5. 安全红线

- 不碰：生产会话进程（`systemctl --user show niri.service -p MainPID --value` 取）、生产
  `xwayland-satellite`（`:0`）、日常 Helium 及其 profile、用户的 UnrealEditor、生产 DSH(`:3080`)。
  本目录的生产会话一律只读。
- 只清理**自己起的** PID；禁止 `pkill -f`；不要动别的会话的 X/Wayland socket。
- 不要用 `~/.local/bin/pin`（会读剪贴板）；不要在没起嵌套环境时把未定向键鼠发进当前会话。
- 收尾用 `run/STOP-APPS` + `run/STOP`，结束后确认 `/run/user/1000` 下没有 `bwc-reg-*` 残留、
  `ps` 里没有自己起的 niri/satellite/fixture。

## 6. 怎么验证

```bash
python3 cycle.py 1 smoke.py      # 6 步全 PASS = 本文件里的命令都还能用
python3 cycle.py 2 suite.py      # 期望 13 PASS / 0 FAIL / 1 LIMITATION（XSendEvent）
python3 cycle.py 2 suite2.py     # 期望  7 PASS / 0 FAIL / 1 LIMITATION（XSendEvent）
```

证据与背景（都在 `/home/sx/projects/MyAI/.scratch/background-window-control/`，注意该目录目前
不进 MyAI 仓库）：`regression-evidence.md`（逐项实测）、`xwayland-visibility-research.md`、
`xwayland-isolation-research.md`、`xwayland-local-source-verification.md`、`spec.md`。

## 7. 改代码时

- niri fork：`/home/sx/projects/niri`，分支 `scoped-input-poc`；提交前
  `cargo build --bin niri` + `cargo test --lib`（期望 `204 passed`）；席位状态机在
  `src/agent_seat.rs`，IPC 在 `src/ipc/server.rs`，FFM 豁免在 `src/niri.rs`。
- 探针仓：`/home/sx/projects/agent-seat-probe`（私有 `xgx1/agent-seat-probe`，`main`）——
  改完 `cargo build --bins` 验证再提交推送。退出码是契约：非 0 = 没做成（未知窗口 / IPC 错 /
  意外响应），且失败时**不动**原 pin，脚本里必须检查。
- 已知未做：视频录制、相对鼠标/pointer-lock；agent-desktop 的端到端验收要等生产 `dsh-web` 重启（钩子才生效）。