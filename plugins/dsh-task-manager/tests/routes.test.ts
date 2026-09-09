/**
 * a5 groundwork — the three orchestration routes respond correctly at the
 * handler level (a real curl pass runs against the built bundle separately).
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerOrchestrationRoutes, type RouteRegistrar } from '../src/orchestration-routes.ts'
import { createTaskManager } from '../src/orchestrator.ts'
import { CaptainStore, TaskStore } from '../src/stores.ts'
import { FakeAgents, FakeRequest, FakeResponse, FakeSubagents, asReq, asRes } from './fakes.ts'

interface RegisteredRoute {
  path: string
  handler: (req: FakeRequest, res: FakeResponse) => Promise<void>
}

/** Collect registered routes instead of mounting a server. */
function collect(): {
  routes: Map<string, RegisteredRoute['handler']>
  registrar: RouteRegistrar
  effect: (factory: () => () => void) => void
} {
  const routes = new Map<string, RegisteredRoute['handler']>()
  const registrar: RouteRegistrar = {
    register: (route) => {
      routes.set(route.path, route.handler as unknown as RegisteredRoute['handler'])
      return () => undefined
    },
  }
  return { routes, registrar, effect: (factory) => void factory() }
}

async function rig() {
  const dir = await mkdtemp(join(tmpdir(), 'task-manager-routes-'))
  const store = new TaskStore(dir)
  const captains = new CaptainStore(dir)
  const subagents = new FakeSubagents()
  const agents = new FakeAgents()
  agents.add('session-manager')
  const service = createTaskManager({
    store,
    captains,
    resolveRuntime: () => ({ subagents, agents }),
    now: () => 1_000,
  })
  const { routes, registrar, effect } = collect()
  registerOrchestrationRoutes(registrar, service, effect)
  await store.mutate((tasks) => {
    tasks.push({
      id: 'task-1',
      title: '示例任务',
      content: '内容',
      status: 'not-started',
      runMode: 'cwd',
      directory: '/tmp',
      dispatchRound: 0,
      needsFinalReview: true,
      createdAt: 1,
      updatedAt: 1,
    })
  })
  return {
    dir,
    routes,
    service,
    async call(path: string, request: FakeRequest): Promise<FakeResponse> {
      const handler = routes.get(path)
      if (handler === undefined) throw new Error(`route not registered: ${path}`)
      const response = new FakeResponse()
      request.feed()
      await handler(request, response)
      return response
    },
  }
}

const jsonBody = (value: unknown): string => JSON.stringify(value)

describe('GET /plugins/dsh-task-manager/captains', () => {
  it('lists the registry with task counts', async () => {
    const t = await rig()
    try {
      await t.service.setCharter('research', '章程')
      const response = await t.call('/plugins/dsh-task-manager/captains', new FakeRequest('/plugins/dsh-task-manager/captains', 'GET'))
      expect(response.status).toBe(200)
      const body = JSON.parse(response.body) as { captains: Array<{ category: string; charter: string; taskCount: number; sessionId?: string }> }
      expect(body.captains).toHaveLength(1)
      expect(body.captains[0]).toMatchObject({ category: 'research', charter: '章程', taskCount: 0 })
      expect(body.captains[0]?.sessionId).toBeUndefined()
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
})

describe('PUT /plugins/dsh-task-manager/captains', () => {
  it('edits the charter (upsert)', async () => {
    const t = await rig()
    try {
      const response = await t.call(
        '/plugins/dsh-task-manager/captains',
        new FakeRequest('/plugins/dsh-task-manager/captains', 'PUT', jsonBody({ category: 'writing', charter: '写作章程' })),
      )
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toMatchObject({ category: 'writing', charter: '写作章程' })
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('rejects a missing category with 400', async () => {
    const t = await rig()
    try {
      const response = await t.call(
        '/plugins/dsh-task-manager/captains',
        new FakeRequest('/plugins/dsh-task-manager/captains', 'PUT', jsonBody({ charter: 'x' })),
      )
      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toMatchObject({ code: 'INVALID_INPUT' })
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
})

describe('POST /plugins/dsh-task-manager/assign', () => {
  it('assigns and returns the dispatch result', async () => {
    const t = await rig()
    try {
      const response = await t.call(
        '/plugins/dsh-task-manager/assign',
        new FakeRequest('/plugins/dsh-task-manager/assign', 'POST', jsonBody({
          taskId: 'task-1',
          category: 'research',
          charter: '章程',
          managerSessionId: 'session-manager',
        })),
      )
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toMatchObject({
        taskId: 'task-1',
        category: 'research',
        dispatchRound: 1,
        created: true,
      })
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('maps TASK_NOT_FOUND to 404 and bad input to 400', async () => {
    const t = await rig()
    try {
      const missing = await t.call(
        '/plugins/dsh-task-manager/assign',
        new FakeRequest('/plugins/dsh-task-manager/assign', 'POST', jsonBody({
          taskId: 'nope',
          category: 'research',
          managerSessionId: 'session-manager',
        })),
      )
      expect(missing.status).toBe(404)
      expect(JSON.parse(missing.body)).toMatchObject({ code: 'TASK_NOT_FOUND' })

      const bad = await t.call(
        '/plugins/dsh-task-manager/assign',
        new FakeRequest('/plugins/dsh-task-manager/assign', 'POST', jsonBody({ category: 'research' })),
      )
      expect(bad.status).toBe(400)
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
})

describe('POST /plugins/dsh-task-manager/report (human manual supplement)', () => {
  it('records a report without identity semantics', async () => {
    const t = await rig()
    try {
      const response = await t.call(
        '/plugins/dsh-task-manager/report',
        new FakeRequest('/plugins/dsh-task-manager/report', 'POST', jsonBody({
          taskId: 'task-1',
          status: 'waiting-check',
          text: 'GUI 手动补录的回报',
          evidence: ['/tmp/evidence.md'],
        })),
      )
      expect(response.status).toBe(200)
      const task = JSON.parse(response.body) as { status: string; report?: { text: string; evidence?: string[] } }
      expect(task.status).toBe('waiting-check')
      expect(task.report?.text).toBe('GUI 手动补录的回报')
      expect(task.report?.evidence).toEqual(['/tmp/evidence.md'])
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('clamps done on a needsFinalReview task and maps unknown tasks to 404', async () => {
    const t = await rig()
    try {
      const clamped = await t.call(
        '/plugins/dsh-task-manager/report',
        new FakeRequest('/plugins/dsh-task-manager/report', 'POST', jsonBody({
          taskId: 'task-1', status: 'done', text: '直接关单尝试',
        })),
      )
      expect(clamped.status).toBe(200)
      expect((JSON.parse(clamped.body) as { status: string }).status).toBe('waiting-check')

      const missing = await t.call(
        '/plugins/dsh-task-manager/report',
        new FakeRequest('/plugins/dsh-task-manager/report', 'POST', jsonBody({
          taskId: 'nope', status: 'done', text: 'x',
        })),
      )
      expect(missing.status).toBe(404)
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
})
