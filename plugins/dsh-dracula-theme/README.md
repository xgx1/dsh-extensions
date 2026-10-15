# dsh-dracula-theme

DSH Web GUI 的 **Dracula** 主题（Atom Dracula 最全功能版）——纯 profile-bundle 覆盖层，**零官方源码修改**，纯手写 JS，无构建步骤、无依赖、离线可装。

装上后打开/刷新页面即为 Dracula：整体底色、侧边栏、卡片、边框、文字层级、按钮、链接、成功/警告/错误状态，以及**代码块语法高亮**（shiki css-variables 主题）全部换成 Dracula 配色。

## 安装

```sh
dsh plugin --profile web add link:/home/sx/projects/MyAI/dsh-extensions/plugins/dsh-dracula-theme
```

这条命令同时做两件事：加 `dependencies` 条目、往 `dsh.profile.bundles` 追加一行。运行中的 host 会热加载新行（本机实测：装完 boot 图里就有 `dsh-dracula-theme`，**不用重启** `dsh-web.service`）；若没生效再 `systemctl --user restart dsh-web`，注意重启会中断正在进行的对话。

装完在浏览器刷新一次页面即可（客户端半部随页面启动加载）。之后改 `lib/client.js` 会被客户端 HMR 直接热替换，连刷新都不用。

## 工作原理

DSH 的客户端主题服务 `ctx.theme`（`@deepseek-ai/dsh-client-ui-theme`）会把「当前激活主题」的 token 写成 **body 上的行内 CSS 变量**，行内样式优先级高于样式表，因此本插件只需注册一份 token 表：

| token 前缀 | 作用 | 例子 |
|---|---|---|
| `--dsw-alias-*` | 具名语义色：面板、边框、文字层级、品牌色、状态色、markdown | `--dsw-alias-bg-base: #282a36`、`--dsw-alias-brand-primary: #bd93f9` |
| `--dsw-static-*` | 底层色阶。官方别名大量写成 `var(--dsw-static-neutral-bluish-900)` 这类引用，换掉色阶就等于**一次改掉一整片**没单独列出的别名 | `--dsw-static-neutral-bluish-950: #282a36` |
| `--shiki-token-*` | 代码块/语法高亮（shiki `cssVariablesTheme`） | `--shiki-token-keyword: #ff79c6` |

`lib/client.js` 里的 `PALETTE` 是唯一色源，改配色只改这一处；改版本（Dracula / Dracula Pro / OneHalfDark 等）就是改这一组的十六进制值。

### 为什么每次都要重新选中，而且盯住不放

官方只持久化 `light` / `dark` / `system` 三个偏好值（`setTheme` 内部 `isThemePreference` 判定），自定义 id 不会被写进设置。安装时的实测：只在 `apply` 里 `setTheme('dracula')` 会失败——设置作用域是**异步**到达的，`ui-theme` 的 `adopt()` 随后把偏好复位成持久值 `'system'`，官方内置暗色 token 表是空表，于是 body 上一个行内变量都没有，界面回到官方配色。

所以插件把补选挂在 `theme/change` 上：只要当前偏好不是 `dracula`（刷新、`adopt()` 复位、手工切走，都算），就再选一次。`setTheme` 在偏好已相等时直接 `return`，因此最多补写一次，不会来回打架。

补选**必须推迟一个微任务**（`queueMicrotask`），不能在监听器里同步 `setTheme`：`setTheme` 内部的 `publish()` 会重入 `emit`，重入的内层先依次调用监听器——后注册的 `ui-layout` 的 `ThemePresenter` 在这一层写上 dracula token——外层继续把**旧快照**（`system`/`dark`，官方暗色 token 表是空的）派发给同一个 presenter，刚写上的 token 立刻被擦掉。症状极具迷惑性：主题服务里 `active.id === 'dracula'`、`active.tokens` 有 88 条，而 `document.body` 的行内样式里一个 token 都没有，界面停留在官方配色（2026-10-14 实况，`tests/theme.test.js` 有回归断言）。

副作用即预期行为：**插件装着时主题被钉死为 Dracula**，在「设置 → 外观」里切走会被立刻拉回。要恢复自由选择就禁用插件（见下）。

## 自检

```sh
cd /home/sx/projects/MyAI/dsh-extensions/plugins/dsh-dracula-theme
npm test    # 等价于 node --test tests/
```

- 用假的 `window.__ModuleLoader__` 与假 `ctx` 断言：注册的 id / `colorScheme` / token 表正确，会选中 `dracula`；已选中时不重复写设置；偏好被 `adopt()` 复位后 `theme/change` 会补选一次并收敛。
- **覆盖率检查**：解析官方 `packages/client/ui-theme/src/styles/design-platform.css` 的暗色别名块，断言其中每条变量要么被本插件直接覆盖、要么它引用的色阶被覆盖（`rgba()` 半透明遮罩除外，它们在任意暗底上观感一致）。官方 CSS 变了名字，这条测试会先红。

## 如何禁用

- 临时：侧边栏 **Plugins** 页把 `dsh-dracula-theme` 一行关掉（或删掉 profile 合成树里那一行）。
- 彻底：`dsh plugin --profile web remove dsh-dracula-theme`，然后重启 `dsh-web.service`。

## 已知边界

- 只覆盖暗色路径（`colorScheme: 'dark'`）。同理，如果页面处于 light 主题且本插件未激活，界面回到官方配色——这是刻意选择，不做双套。
- 少量控件把颜色**写死**在组件样式里（不读变量），这类不跟主题；要 100% 覆盖需要官方把颜色都收敛到 token。
- 官方暗色块里的半透明遮罩（`--dsw-alias-bg-mask-*`、`--dsw-alias-border-inverted*`、hover 的半透明白）沿用官方值不覆盖，见上表测试里的豁免说明。
