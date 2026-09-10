/**
 * a1/a4 — the tools-only subpath entry (ADR-0004): applying it in a caller
 * scope registers exactly the seven task_* tools into the CALLER's tools
 * registry, provides no service, and mounts no HTTP routes.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../src/tools-entry.ts'
import { CAPTAIN_TOOL_FILTER, MANAGEMENT_TOOL_NAMES, createTaskManager } from '../src/orchestrator.ts'
import { CaptainStore, TaskStore } from '../src/stores.ts'
import { FakeAgents, FakeSubagents } from './fakes.ts'
import type { Context } from '@deepseek-ai/cordis'

interface RegisteredDefinition {
  name: string
}

/** Caller-scope fake: declared `tools` property, recording get/provide, effect runs inline. */
function callerScope(options?: { taskManager?: unknown }) {
  const defs = new Map<string, RegisteredDefinition>()
  const provided: string[] = []
  const asked: string[] = []
  const effectLabels: string[] = []
  const tools = {
    register: (definition: unknown) => {
      const def = definition as RegisteredDefinition
      defs.set(def.name, def)
      return () => undefined
    },
  }
  const ctx = {
    tools,
    effect(factory: () => () => void, label?: string) {
      if (label !== undefined) effectLabels.push(label)
      factory()
    },
    get(serviceName: string) {
      asked.push(serviceName)
      if (serviceName === 'taskManager') return options?.taskManager
      return undefined
    },
    provide(serviceName: string) {
      provided.push(serviceName)
    },
  } as unknown as Context & { tools: typeof tools }
  return { ctx, defs, provided, asked, effectLabels, tools }
}

async function realService() {
  const dir = await mkdtemp(join(tmpdir(), 'task-manager-entry-'))
  const service = createTaskManager({
    store: new TaskStore(dir),
    captains: new CaptainStore(dir),
    resolveRuntime: () => ({ subagents: new FakeSubagents(), agents: new FakeAgents() }),
    now: () => 1_000,
  })
  return { dir, service }
}

describe('tools-only 入口（dsh-task-manager/tools，ADR-0004）', () => {
  it('模块元数据：name 与 inject 与 tool-todo 同构', () => {
    expect(name).toBe('dsh-task-manager/tools')
    expect(inject).toEqual(['tools'])
  })

  it('a1 apply 后恰好 7 个 task_* 工具，名字与 MANAGEMENT_TOOL_NAMES 5+2 逐字一致', async () => {
    const { dir, service } = await realService()
    try {
      const { ctx, defs, provided } = callerScope({ taskManager: service })
      apply(ctx)
      const names = [...defs.keys()].sort()
      expect(names).toEqual([...MANAGEMENT_TOOL_NAMES, 'task_claim', 'task_report'].sort())
      expect(names).toHaveLength(7)
      // 无服务泄漏：入口绝不 provide（服务只属于 host bundle 主入口）
      expect(provided).toEqual([])
      // deny 的 5 个管理工具名字都真实存在（队长面 toolFilter 依赖）
      for (const denied of CAPTAIN_TOOL_FILTER.deny) expect(defs.has(denied)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a1 入口不挂任何 HTTP 路由：从不向 webServer/httpServer 发起解析', async () => {
    const { dir, service } = await realService()
    try {
      const { ctx, asked } = callerScope({ taskManager: service })
      apply(ctx)
      expect(asked).toEqual(['taskManager']) // 唯一的跨面消费；绝不碰 web 服务
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a4 taskManager 缺席时加载期响亮失败（错误点名 ADR-0004）', () => {
    const { ctx } = callerScope({ taskManager: undefined })
    expect(() => apply(ctx)).toThrow(/taskManager service.*ADR-0004/)
  })

  it('a4 注册经 ctx.effect（disposer 语义由 cordis 接管，标签可诊断）', async () => {
    const { dir, service } = await realService()
    try {
      const { ctx, effectLabels } = callerScope({ taskManager: service })
      apply(ctx)
      expect(effectLabels).toHaveLength(7)
      expect(effectLabels.every((label) => label.startsWith('task-manager: task_'))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
