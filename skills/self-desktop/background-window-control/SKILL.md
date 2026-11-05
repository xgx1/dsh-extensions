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
- 小工具在 `/home/sx/projects/agent-seat-probe`（**不是 git 仓库**，换机器会丢）：
  `agent-seat-probe`（席位输入）、`scoped-target`、`scoped-shot`。
- **能力只在 fork 二进制起的实例里成立**：`/home/sx/projects/niri/target/debug/niri`。
  生产会话 `niri --session`(PID 2585) / `xwayland-satellite :0`(PID 3087) 跑的是上游 niri，
  没有这些 IPC —— 别对着它调，也别重启它。
- 目前所有实测都在**嵌套环境**里：Xvfb（`:1` 父显示）→ niri(`poc.kdl`，`:2`) → xwayland-satellite。
  真桌面还没接过开关。

## 0. 先选路线

| 用户要的效果 | 用什么 | 不要用什么 |
| --- | --- | --- |
| 人想"看一眼"后台应用 | niri 浮窗搬运 + `scoped-shot` 截图 | 不要注入键鼠 |
| 应用必须真的收到输入（canvas/游戏） | `scoped-target` + 席位（原生 Wayland）、`xi2-inject`（satellite 的 X11） | 不要用 `xdotool type --window`（XSendEvent） |
| 读内容（浏览器/有 a11y 的应用） | 优先 a11y/CDP/应用自带 API | 不要靠模拟点击抓数据 |
| 运行 UE/Unity 全屏游戏 | 先在嵌套环境里跑，X11 走 satellite + MPX | 不要在人正在用的会话里全屏接管 |

## 1. 起环境（默认方式）

```bash
cd /home/sx/projects/MyAI/.scratch/background-window-control/regression-visibility
python3 cycle.py 1 smoke.py
```

一条命令完成：起 Xvfb+niri+satellite → 起 4 个真实 GTK fixture（`regression-human` 原生、
`regression-agent-x11`、`regression-agent-native`、`regression-human-x11`）→ 跑
`smoke.py`（6 步，验证本文件里的命令）→ 收尾清理。**每轮都是全新环境**：同一环境连跑
第三次起 X11 注入会整体失效，这是实测事实，不要试图复用。

手动长会话：

```bash
python3 environment.py &      # 等出现 run/environment.json（含 display/wayland/ipc/runtime/pids）
python3 apps.py &             # 等出现 run/apps.json
# 交互……结束收尾（必须）：
touch run/STOP-APPS run/STOP  # 两个脚本会回收自己的子进程并删掉自己的 runtime 目录
```

Python 里直接用 `testlib.py`：`windows() focus() workspaces() action() act() by_title() state()
agent() human() xdo() shot() run()`；`ENV` 已带 `XDG_RUNTIME_DIR/WAYLAND_DISPLAY/NIRI_SOCKET`
并从环境里删掉 `DISPLAY`（X11 fixture 要自己塞 `INFO['display']`，跑 `xdotool` 用 `xdo()`）。

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
- 等价 JSON（CLI 参数拿不准时更省事）：
  `niri msg --json ...` 不行时直接连 socket 发 `{"Action":{"MoveWindowToWorkspace":{"window_id":3,"reference":{"Name":"human"},"focus":false}}}`。
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

- 不碰：生产 `niri --session`(2585)、`xwayland-satellite :0`(3087)、日常 Helium(30692) 及其
  profile、用户的 UnrealEditor、生产 DSH(`:3080`)。本目录的生产会话一律只读。
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

证据与背景：`../regression-evidence.md`（逐项实测）、`../xwayland-visibility-research.md`、
`../xwayland-isolation-research.md`、`../xwayland-local-source-verification.md`、`../spec.md`。

## 7. 改代码时

- niri fork：`/home/sx/projects/niri`，分支 `scoped-input-poc`；提交前
  `cargo build --bin niri` + `cargo test --lib`（期望 `204 passed`）；席位状态机在
  `src/agent_seat.rs`，IPC 在 `src/ipc/server.rs`，FFM 豁免在 `src/niri.rs`。
- 已知未做：真桌面接入（生产会话用 fork 重启）、视频录制、相对鼠标/pointer-lock、
  agent-desktop 的 DSH 落地。
