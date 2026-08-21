# DeepSeek Vision — DSH 视觉模型配置扩展

给 DSH 添加 DeepSeek 官方多模态模型 **`deepseek-v4-flash-vision-exp`**（V4-Flash-Vision-Exp）。
基于官方文档 <https://api-docs.deepseek.com/zh-cn/guides/vision/>。

## 形态

**settings.yaml 配置 + dsh-llm-pi-ai compat 配置面小扩展**（两个新字段：
`supportsDeveloperRole` / `requiresReasoningContentOnAssistantMessages`，见「配套源码改动」）。
settings 文件由 chokidar 监听、配置热生效；compat 字段改动属于官方包源码，需重建 lib 并
重启 dsh web 进程（PM2：`pm2 restart dsh-web`）。

## 配置

在 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers` 下新增：

```yaml
llm-pi-ai:
  providers:
    deepseek:
      displayName: DeepSeek Vision
      baseURL: http://127.0.0.1:8787/v1   # 可换成 https://api.deepseek.com 直连
      apiKeyEnv: DEEPSEEK_API_KEY
      compat:
        thinkingFormat: deepseek
        supportsReasoningEffort: true
        supportsDeveloperRole: false      # DeepSeek 端点不认 developer role，必须关
        requiresReasoningContentOnAssistantMessages: true   # 思考模式多轮回传 reasoning_content
      models:
        - id: deepseek-v4-flash-vision-exp
          name: DeepSeek V4 Flash Vision
          input: [ text, image ]          # 声明多模态：read_image/贴图才会放行
          reasoningEfforts:
            off: null
            max: max                      # 思考档位已开启（实测 thinking + reasoning_effort max 可用）
```

若希望新会话默认使用视觉模型：

```yaml
agent-default-model:
  provider: deepseek
  model: deepseek-v4-flash-vision-exp
```

> 注意：开启思考档位后，默认模型条目可以携带 `reasoningEffort: max`；
> 若改用 `reasoningEfforts: false`（无档位）则默认条目**不要带** `reasoningEffort`，
> 否则新建会话报 `UNSUPPORTED_REASONING_EFFORT`。

## 工作原理

- 路由走 `llm-pi-ai`（pi-ai 适配器）：手声明模型 `input: [text, image]` → `resolveModelInfo`
  返回 `inputModalities: ["text","image"]` → 宿主放行图片附件与 `read_image` 工具。
- 请求时 `llm-pi-ai` 的 context 转换把 `image` 内容块经 `attachments.readImage` 读字节 →
  base64 → OpenAI 兼容 `image_url` data URL，发往端点。
- 本机示例走 headroom 缓存代理（`http://127.0.0.1:8787/v1` → `api.deepseek.com`），
  直连官方端点同样可用（图片限 48 MiB base64 / 外部 URL 8192 字符 / 仅 user 消息可带图）。
- 思考模式：`compat.thinkingFormat: deepseek` + `reasoningEfforts` 档位 →
  请求携带 `thinking: {type: enabled}` 与 `reasoning_effort`。

## 配套源码改动（dsh-llm-pi-ai compat 配置面）

pi-ai 对思考型模型默认把系统提示写成 `developer` role，DeepSeek 端点只接受
`system/user/assistant/tool`（否则 400 `unknown variant developer`）。pi-ai 内置 deepseek
目录的模型靠 `compat.supportsDeveloperRole: false` 规避，但 DSH 的 `llm-pi-ai` 配置面原先只
暴露 `thinkingFormat` / `supportsReasoningEffort`，无法对手声明模型注入该标志。

改动（`packages/llm/llm-pi-ai`）：
- `src/catalog.ts`：`PiAiCompatProfile` 增加 `supportsDeveloperRole?` 与
  `requiresReasoningContentOnAssistantMessages?`；`resolveModelCompat` 转发两字段；
  route 级开关校验同步覆盖。
- `src/config.ts`：`compatProfile` schema 增加两字段。
- `tests/catalog.spec.ts`：覆盖新字段的 route/entry 合并、协议拒绝路径。

改后需重建：`pnpm exec tsc -b tsconfig.host.json && pnpm exec tsdown --env.DSH_BUILD_FACE host`，
再 `pm2 restart dsh-web`。

## 验证

```powershell
# 1. 提供方已注册
$body = @{ type='client-request'; rpcId=[guid]::NewGuid().ToString(); method='llm.providers'; payload=@{} } | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:3080/api/llm.providers" -Method Post -ContentType 'application/json' -Body $body

# 2. 会话模型目录含 vision 模型（groups[].id == 'deepseek'），reasoning 档位 Off/Max
# 3. 直接贴图提问即可；也可在 GUI 模型选择器切到「DeepSeek V4 Flash Vision」
```

实测（wire 捕获）：`messages[0].role: system`（非 developer）、`thinking: {type: enabled}`、
`reasoning_effort: max`、`user` 消息含 `text,image_url` 块；带「VISION 42」文字的测试图回答
准确读出 `VISION 42`。

## 已知限制

- 视觉模型不在 DSH 的 `llm-deepseek`（deepseek-official）适配器目录中；该适配器把所有模型
  硬编码为 `inputModalities: ['text']` 且序列化器拒绝图片块，故视觉模型挂在 pi-ai 路由下。
- 若 pi-ai 目录日后收录 `deepseek-v4-flash-vision-exp`（自带 compat），可改用 catalog 路由
  或直接删掉本配置的 compat 块（继承目录值）。

## 出处

- DeepSeek 视觉指南：<https://api-docs.deepseek.com/zh-cn/guides/vision/>
- DeepSeek 官方公告：<https://api-docs.deepseek.com/zh-cn/news/news260821/>
