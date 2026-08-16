# dsh-extensions

DeepSeek Harness（DSH）个人扩展集合。遵循极简原则：**一个功能一个目录**。

## 结构

- `skills/<名字>/` —— DSH 技能（`~/.dsh/skills/` 的托管副本）
- `plugins/<名字>/` —— DSH 插件（预留）

## 同步方式

本仓库是托管副本；本机生效路径为 `C:\Users\Admin\.dsh\skills\<名字>\SKILL.md`。技能改动后复制回仓库并 push。

## 已有扩展

- [`skills/dsh-extension-dev`](skills/dsh-extension-dev/SKILL.md) —— DSH 扩展开发元技能：先搜索复用 → 调 `cordis-plugin-development` 技能 → 极简（一功能一插件）→ 传 GitHub。
  - 形态分类与证据优先思路参考 [w2112515/dsh-plugin-development](https://github.com/w2112515/dsh-plugin-development)
  - 基本原理参考官方 [extension-cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)
