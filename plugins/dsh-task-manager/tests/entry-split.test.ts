/**
 * ADR-0004 — the entry split, from the host bundle's side.
 *
 * The bundle provides the `taskManager` service, the HTTP routes, and the
 * stores; it must NOT register the model tools. Session visibility of the
 * seven `task_*` names belongs to the preset row (`dsh-task-manager/tools`),
 * which registers them into that session's own tools scope. A bundle-side
 * registration would land in the tools registry's GLOBAL layer, where every
 * session inherits it whatever its preset — the exact double registration the
 * ADR forbids.
 *
 * Measured in the live process before this guard existed (2026-09-10): a
 * scope key no preset owns answered `true` for all seven `task_*` names, i.e.
 * they resolved from the global layer, and a plain `omni` session saw the
 * management tools in its model catalog.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

/** Record every tool registration the bundle entry attempts, plus its lookups. */
function recordingCtx() {
  const registered: string[] = []
  const asked: string[] = []
  const effects: string[] = []
  const provided: string[] = []
  const listeners: string[] = []
  const tools = {
    register(definition: unknown) {
      registered.push((definition as { name: string }).name)
      return () => undefined
    },
  }
  const webServer = { register: () => () => undefined }
  const ctx = {
    get(serviceName: string) {
      asked.push(serviceName)
      if (serviceName === 'tools') return tools
      if (serviceName === 'webServer' || serviceName === 'httpServer') return webServer
      return undefined
    },
    effect(factory: () => () => void, label?: string) {
      effects.push(label ?? '')
      factory()
    },
    provide(serviceName: string) {
      provided.push(serviceName)
    },
    on(eventName: string) {
      listeners.push(eventName)
      return () => undefined
    },
  } as unknown as Context
  return { ctx, registered, asked, effects, provided, listeners, tools }
}

describe('host bundle 入口（ADR-0004：服务/路由/存储，不产生会话工具）', () => {
  it('a1 模块名保持 dsh-task-manager', () => {
    expect(name).toBe('dsh-task-manager')
  })

  it('a2 apply 后零工具注册：bundle 侧不产生任何会话工具', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-entry-split-'))
    try {
      const { ctx, registered } = recordingCtx()
      apply(ctx, { stateDir: dir })
      expect(registered).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a2 bundle 侧根本不消费 tools 注册表（连解析都不发起）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-entry-split-'))
    try {
      const { ctx, asked } = recordingCtx()
      apply(ctx, { stateDir: dir })
      expect(asked).not.toContain('tools')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a3 服务与路由仍在：provide taskManager，且监听 internal/service 以便迟到挂载', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-entry-split-'))
    try {
      const { ctx, provided, listeners } = recordingCtx()
      apply(ctx, { stateDir: dir })
      expect(provided).toEqual(['taskManager'])
      expect(listeners).toContain('internal/service')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
