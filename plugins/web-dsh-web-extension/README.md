# Web DSH Web Extension

**空插件（预留 roster 行，零行为）**：原本的「对话布局」功能（对话内容铺满 / 标准、输入框左对齐 / 居中）已内置进 DSH 本体，本包不再提供 UI、样式或设置行。

保留 profile roster 行是为了让既有安装**无需修改 profile** 即可平滑过渡。

## 为什么是空的

DSH 本体的 `ui-conversation` 已提供等价的布局偏好入口，本包的 CSS 覆盖与 `settings.general.item` 行成为重复实现，故清空。

清空后仍保留：

- `cordis.patch.yml` 的 bundle 行（roster 成员）
- `lib/index.js`（Host 加载入口，空 `apply`）
- `lib/client.js`（Client 加载入口，空 `apply`）—— `dsh.client` 声明要求存在 `./client` 导出

## 彻底移除（可选）

不再需要这个 roster 行时，从 profile 三处删除即可：

```sh
# 1. profiles/web/package.json：dependencies 与 dsh.profile.bundles 各删一行
# 2. profiles/web/cordis.patch.yml：删除 web-dsh-web-extension 的插件行
# 3. 删除插件目录并重新安装依赖
rm -rf /home/sx/projects/MyAI/dsh-extensions/plugins/web-dsh-web-extension
```

## 遗留偏好

旧的 localStorage 键 `dsh-web-extension` 与 `<html>` 上的 `data-wde-wide` / `data-wde-left` 标记现在无人读取，也无规则消费；不影响功能。需要清理由浏览器手动删除即可。

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # tsdown → lib/index.js + lib/client.js（两者均为空 apply）
```
