# Web DSH Web Extension

DSH Web GUI 布局扩展（纯 profile-bundle 覆盖层，**零官方源码修改**）：

- **对话内容铺满**：内容列从固定 748px 撑满至 100% 可用宽度
- **输入框左对齐**：输入框卡片贴左（停靠态与空态 hero 均生效）
- **设置界面**：设置 → 常规 新增「对话布局」行（内容宽度 / 输入框位置 两个选择器），默认铺满 + 左对齐
- **持久化**：偏好存于 localStorage，重启/刷新后保持

## 安装

```sh
# 在 web profile 注册本包（本地 link）
dsh plugin --profile web add link:C:\Users\Admin\Project\Other\web-dsh-web-extension
pm2 restart dsh-web
```

或手工：`profiles/web/package.json` 的 dependencies + `dsh.profile.bundles` 加入 `web-dsh-web-extension`，`cordis.patch.yml` 提供插件行。

## 工作原理

| 部件 | 机制 |
|---|---|
| Host 半 (`src/index.ts`) | 官方 `webServer.tapIndex` seam：向每个 index 响应注入静态覆盖样式表 + 启动脚本（读 localStorage → 在 `<html>` 打 `data-wde-wide` / `data-wde-left` 标记） |
| Client 半 (`src/client/index.ts`) | 注册官方 additive seat `settings.general.item`（「对话布局」行）；偏好变更即时写 localStorage 并同步 `<html>` 标记 |
| 覆盖样式 (`src/boot.ts`) | 全部规则以 `html[data-wde-*]` 为门、以官方 DOM 的稳定 data 属性为锚（`[data-phase]`、`[data-composer-seat]`、`[data-composer-card]`），不依赖任何 hashed CSS-module 类名 |

关闭任一开关即恢复官方原始布局（标记移除 → 规则失活）。

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest（persist / boot）
pnpm build       # tsdown → lib/index.js + lib/client.js
```

## 出处

技术路线复用官方 `packages/client/ui-theme` 的 tapIndex 注入模式与 `ui-conversation` 的 `settings.general.item` 注册模式；持久化风格沿用本机已装 `dsh-aionui-panel` 的 localStorage 先例。构建产物形态（`__ModuleLoader__.load` + platform-module external）与官方 client bundle 一致。
