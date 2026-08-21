# DeepSeek Vision — DSH 视觉模型配置扩展

给 DSH 添加 DeepSeek 官方多模态模型 **`deepseek-v4-flash-vision-exp`**（V4-Flash-Vision-Exp）。
基于官方文档 <https://api-docs.deepseek.com/zh-cn/guides/vision/>。

## 形态

**纯 `settings.yaml` 配置扩展，零代码、无需重启**。DSH 的 settings 文件由 chokidar 监听，
`llm-pi-ai` 插件在配置变化后按请求热重解析并就地重注册路由。

## 配置

在 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers` 下新增：

```yaml
llm-pi-ai:
  providers:
    deepseek:
      displayName: DeepSeek Vision
      baseURL: http://127.0.0.1:8787/v1   # 可换成 https://api.deepseek.com 直连
      apiKeyEnv: DEEPSEEK_API_KEY
      models:
        - id: deepseek-v4-flash-vision-exp
          name: DeepSeek V4 Flash Vision
          input: [ text, image ]          # 声明多模态：read_image/贴图才会放行
          reasoningEfforts: false          # 见「已知限制」
```

若希望新会话默认使用视觉模型：

```yaml
agent-default-model:
  provider: deepseek
  model: deepseek-v4-flash-vision-exp
```

> 注意：`reasoningEfforts: false` 的模型不提供任何思考档位，默认模型条目**不要携带
> `reasoningEffort`**，否则新建会话会报 `UNSUPPORTED_REASONING_EFFORT`。

## 工作原理

- 路由走 `llm-pi-ai`（pi-ai 适配器）：手声明模型 `input: [text, image]` → `resolveModelInfo`
  返回 `inputModalities: ["text","image"]` → 宿主放行图片附件与 `read_image` 工具。
- 请求时 `llm-pi-ai` 的 context 转换把 `image` 内容块经 `attachments.readImage` 读字节 →
  base64 → OpenAI 兼容 `image_url` data URL，发往端点。
- 本机示例走 headroom 缓存代理（`http://127.0.0.1:8787/v1` → `api.deepseek.com`），
  直连官方端点同样可用（图片限 48 MiB base64 / 外部 URL 8192 字符 / 仅 user 消息可带图）。

## 验证

```powershell
# 1. 提供方已注册
$body = @{ type='client-request'; rpcId=[guid]::NewGuid().ToString(); method='llm.providers'; payload=@{} } | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:3080/api/llm.providers" -Method Post -ContentType 'application/json' -Body $body

# 2. 会话模型目录含 vision 模型（groups[].id == 'deepseek'）
# 3. 直接贴图提问即可；也可在 GUI 模型选择器切到「DeepSeek V4 Flash Vision」
```

实测：向视觉模型发送带「VISION 42」文字的测试图，回答准确读出 `VISION 42`。

## 已知限制

- **`reasoningEfforts: false`（关闭显式思考档位）**：pi-ai 内置 deepseek 目录的模型都携带
  `compat: { supportsDeveloperRole: false, ... }`，但 DSH 的 `llm-pi-ai` compat 配置面
  （`PiAiCompatProfile`）只暴露 `thinkingFormat` / `supportsReasoningEffort`，无法对手声明模型
  注入 `supportsDeveloperRole`。开启思考时 pi-ai 会把系统提示写成 `developer` role，
  DeepSeek 端点返回 400（`unknown variant developer`）。关闭思考后走 `system` role 正常。
  模型本身仍会做内部推理（usage 含 reasoning_tokens）。
- 后续若 pi-ai 目录收录 `deepseek-v4-flash-vision-exp`（自带 compat），或
  `dsh-llm-pi-ai` 扩展 compat 面，可改回 `reasoningEfforts: { off: null, max: max }` 启用思考档位。
- 视觉模型不在 DSH 的 `llm-deepseek`（deepseek-official）适配器目录中；该适配器把所有模型
  硬编码为 `inputModalities: ['text']` 且序列化器拒绝图片块，故视觉模型挂在 pi-ai 路由下。

## 出处

- DeepSeek 视觉指南：<https://api-docs.deepseek.com/zh-cn/guides/vision/>
- DeepSeek 官方公告：<https://api-docs.deepseek.com/zh-cn/news/news260821/>
