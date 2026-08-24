# dsh-web-lan-access

让局域网内的手机 / 其他设备直接访问 DeepSeek Harness 的 Web GUI。

**形态**：纯 profile-bundle 覆盖层（`dsh.bundle.patch`），**零官方源码修改**。
安装方式与 [`web-dsh-web-extension`](../web-dsh-web-extension/) 相同：通过 `dsh plugin` 装入 web profile，
其 `cordis.patch.yml` 把官方 `webserver` 行的默认绑定 host 覆盖为 `0.0.0.0`（所有接口）。

## 原理

- 官方 `dsh-web-app` bundle 提供 `webStartup` 服务，`webserver` 行的默认 host 本应是 `127.0.0.1`，
  且 `--host 0.0.0.0` 在 CLI 层被安全闸拒绝（文档写明「直到有认证层前不支持」）。
- 本插件的 patch 只是在**组合层面**把默认 host 改为 `0.0.0.0`，绕开 CLI 闸、不动任何官方代码。
- 配套机制是官方自带的：绑到所有接口后，`web-runtime` 行会采样本机各 LAN IPv4 字面量，
  自动加入 `/api` 浏览器信任围栏的 `trustedHosts`，因此从手机浏览器发起的同源请求能通过。
- 敏感配置平面（settings / credentials / preset 管理 / 打开本机文件等）按官方设计仍**只允许本机**
  （这些 RPC 方法被钉在 loopback），手机端无法触碰。

## 安装

```bash
dsh plugin --profile web add link:/home/sx/MyAI/dsh-extensions/plugins/dsh-web-lan-access
systemctl --user restart dsh-web
```

安装后手机在同 LAN 下访问：

```
http://<本机局域网IP>:3080
```

本机 IP 查询：`hostname -I` 或 `ip -4 addr`。服务日志会打印
`dsh web: http://127.0.0.1:3080 (LAN: http://<ip>:3080)`。

## 卸载 / 关闭

```bash
dsh plugin --profile web rm dsh-web-lan-access
systemctl --user restart dsh-web
```

恢复仅本机可访问。也可以临时在 profiles/web/cordis.patch.yml 加：
`- id: webserver` + `config: {host: '127.0.0.1', port: 3080}` 覆盖回来。

## 安全提醒

- 绑到 `0.0.0.0` 后，**局域网内任何设备都能驱动这个 AI**（含运行命令 / 读写文件的完整工具集），
  没有认证层。仅适合可信的家庭 / 办公局域网。
- 官方 `/api` 信任围栏与「配置平面仅回环」的钉住仍然生效（见上）。
- 如需真正**外网**（跨网络）访问，需要额外的隧道方案（如 Cloudflare Tunnel），本插件不提供。

## 出处

本插件复用官方内置的局域网信任机制（`dsh-web-app` 的 `resolveLanTrust`、
`dsh-client-connection` 的 `/api` 信任围栏），只以覆盖层形式启用；模板参照
`web-dsh-web-extension` 的纯 profile-bundle 覆盖层形态。仓库：`xgx1/dsh-extensions`。