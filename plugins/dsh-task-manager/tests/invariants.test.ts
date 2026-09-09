/**
 * Final-review invariant — full wiring test through apply() (real route
 * registration, real stores in a temp stateDir):
 *
 * - 队长回报 done（identity 路径）→ 钳制为 waiting-check（计划 M5）
 * - 人类 /report 手动补录 done → 同样钳制（数据层不变量）
 * - 人类经 /set-status 显式关单 done → **不受钳制**（用户终审的唯一关单通道）
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { FakeAgents, FakeRequest, FakeResponse, FakeSubagents, asReq, asRes } from './fakes.ts'

/** Mount the real plugin apply() on collected routes with fake runtime services. */
function rig(stateDir: string) {
  const routes = new Map<string, (req: FakeRequest, res: FakeResponse) => Promise<void>>()
  const liveAgents = new Map<string, { followups: unknown[]; followup(m: unknown): void; inject(m: unknown): void }>()
  liveAgents.set('session-manager', { followups: [], followup(m) { this.followups.push(m) }, inject() {} })
  const continuable: Array<{ childId: string; persona?: string; toolFilter?: unknown }> = []
  const webServer = {
    register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }) {
      routes.set(route.path, route.handler as (req: FakeRequest, res: FakeResponse) => Promise<void>)
      return () => undefined
    },
  }
  const ctx = {
    get(name: string) {
      if (name === 'webServer' || name === 'httpServer') return webServer
      if (name === 'agents') return { get: (id: string) => liveAgents.get(id) }
      if (name === 'subagents') {
        return {
          async startContinuable(spec: { childId: string; request: { persona?: string; toolFilter?: unknown } }) {
            continuable.push({ childId: spec.childId, persona: spec.request.persona, toolFilter: spec.request.toolFilter })
            liveAgents.set(spec.childId, { followups: [], followup() {}, inject() {} })
            return { childId: spec.childId, messageId: 'm1' }
          },
          async followup() { return 'cold' },
        }
      }
      return undefined
    },
    effect(factory: () => () => void) { factory() },
    on() {},
    provide() {},
  }
  apply(ctx as never, { stateDir })
  const call = async (path: string, request: FakeRequest): Promise<FakeResponse> => {
    const handler = routes.get(path)
    if (handler === undefined) throw new Error(`route not registered: ${path}`)
    const response = new FakeResponse()
    request.feed()
    await handler(request, response)
    return response
  }
  return { call, continuable }
}

const post = (path: string, body: unknown): FakeRequest =>
  new FakeRequest(path, 'POST', JSON.stringify(body))

describe('需终审不变量（真实挂线）', () => {
  it('队长与人类补录的 done 被钳制；set-status 显式关单不受钳制', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-invariant-'))
    try {
      const t = rig(dir)
      const B = '/plugins/dsh-task-manager'

      // 建需终审单并派发
      const created = await t.call(`${B}/create`, post(`${B}/create`, {
        title: '需终审单', content: '终审钳制对照', runMode: 'cwd', needsFinalReview: true,
      }))
      expect(created.status).toBe(200)
      const taskId = (JSON.parse(created.body) as { id: string }).id
      const assigned = await t.call(`${B}/assign`, post(`${B}/assign`, {
        taskId, category: 'review', managerSessionId: 'session-manager',
      }))
      expect(assigned.status).toBe(200)
      expect(t.continuable).toHaveLength(1)

      // 队长回报 done → 钳制 waiting-check
      const captainReport = await t.call(`${B}/report`, post(`${B}/report`, {
        taskId, status: 'done', text: '队长要求直接关单',
      }))
      expect(captainReport.status).toBe(200)
      expect((JSON.parse(captainReport.body) as { status: string }).status).toBe('waiting-check')

      // 人类 /report 手动补录 done → 同样钳制（数据层不变量，与身份无关）
      const humanReport = await t.call(`${B}/report`, post(`${B}/report`, {
        taskId, status: 'done', text: 'GUI 手动补录关单尝试',
      }))
      expect(humanReport.status).toBe(200)
      expect((JSON.parse(humanReport.body) as { status: string }).status).toBe('waiting-check')

      // 人类经 /set-status 显式关单 → 不受钳制（用户终审的唯一关单通道）
      const setStatus = await t.call(`${B}/set-status`, post(`${B}/set-status`, {
        id: taskId, status: 'done',
      }))
      expect(setStatus.status).toBe(200)
      const closed = JSON.parse(setStatus.body) as { status: string; needsFinalReview: boolean }
      expect(closed.status).toBe('done')
      expect(closed.needsFinalReview).toBe(true)

      // 落盘终态：done + 需终审旗标保留 + 回报记录在案
      const state = await t.call(`${B}/state`, new FakeRequest(`${B}/state`, 'GET'))
      const task = (JSON.parse(state.body) as { tasks: Array<{ id: string; status: string; report?: { text: string } }> })
        .tasks.find((item) => item.id === taskId)
      expect(task?.status).toBe('done')
      expect(task?.report?.text).toBe('GUI 手动补录关单尝试')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
