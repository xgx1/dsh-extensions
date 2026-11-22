/**
 * Super Agent 进程内派单（2026-11-22 融合修复）：服务缺席/熔断/模拟 Worker 都退回
 * undefined（调用方自建执行会话），成功才返回 worker 信息。
 */
import { describe, expect, it } from 'vitest'
import { dispatchToSuperAgent, type SuperAgentService } from '../src/superagent.ts'

const service = (over?: Partial<SuperAgentService>): SuperAgentService => ({
  dispatch: async () => ({ workerId: 'w-1', threadId: 'th-1' }),
  snapshot: () => ({ workers: [{ id: 'w-1', simulated: false }] }),
  ...over,
})
const request = { title: 't', brief: 'b', cwd: '/x' }

describe('dispatchToSuperAgent', () => {
  it('服务缺席 → undefined', async () => {
    expect(await dispatchToSuperAgent(undefined, request)).toBeUndefined()
  })
  it('成功 → workerId/threadId；model 原样传给服务', async () => {
    let seen: { model?: string } | undefined
    const svc = service({ dispatch: async (args) => { seen = args; return { workerId: 'w-9', threadId: 'th-9' } } })
    expect(await dispatchToSuperAgent(svc, { ...request, model: 'prov/m' })).toEqual({ workerId: 'w-9', threadId: 'th-9' })
    expect(seen?.model).toBe('prov/m')
  })
  it('预算熔断 blocked → undefined', async () => {
    expect(await dispatchToSuperAgent(service({ dispatch: async () => ({ blocked: true }) }), request)).toBeUndefined()
  })
  it('simulated Worker → undefined（秒回假完成不算融合）', async () => {
    const svc = service({ snapshot: () => ({ workers: [{ id: 'w-1', simulated: true }] }) })
    expect(await dispatchToSuperAgent(svc, request)).toBeUndefined()
  })
  it('dispatch 抛错 → undefined', async () => {
    const svc = service({ dispatch: async () => { throw new Error('boom') } })
    expect(await dispatchToSuperAgent(svc, request)).toBeUndefined()
  })
})
