/**
 * 回复框的投递：把用户在卡片里写的答复送进管理会话（人类消息，不是插件伪造的指令）。
 */
import { describe, expect, it } from 'vitest'
import { deliverHumanMessage } from '../src/managed-reply.ts'

function recorder(): { followups: unknown[]; followup(message: unknown): void } {
  const followups: unknown[] = []
  return { followups, followup: (message: unknown) => { followups.push(message) } }
}

const bodyOf = (message: unknown): { left: string; source: unknown } => {
  const typed = message as { content?: Array<{ type?: string; text?: string }>; source?: unknown }
  return { left: typed.content?.map((block) => block.text ?? '').join('') ?? '', source: typed.source }
}

describe('deliverHumanMessage', () => {
  it('follows up on a live manager conversation', async () => {
    const agent = recorder()
    const transport = await deliverHumanMessage({ agents: { get: () => agent } }, 'session-m', '用方案 B')
    expect(transport).toBe('live')
    expect(agent.followups).toHaveLength(1)
    const body = bodyOf(agent.followups[0])
    expect(body.left).toBe('用方案 B')
    expect(body.source).toEqual({ kind: 'user' })
  })

  it('resumes an idle manager conversation through the session controller', async () => {
    const agent = recorder()
    const transport = await deliverHumanMessage({
      agents: { get: () => undefined },
      sessionController: { resolveAgent: async () => ({ agent }) },
    }, 'session-m', '用方案 A')
    expect(transport).toBe('resumed')
    expect(agent.followups).toHaveLength(1)
    expect(bodyOf(agent.followups[0]).left).toBe('用方案 A')
  })

  it('refuses to pretend delivery when the manager cannot be resolved', async () => {
    await expect(deliverHumanMessage({
      agents: { get: () => undefined },
      sessionController: { resolveAgent: async () => ({ error: { code: 'not-found' } }) },
    }, 'session-m', '答案')).rejects.toMatchObject({ code: 'DELIVERY_UNAVAILABLE' })

    await expect(deliverHumanMessage({}, 'session-m', '答案')).rejects.toMatchObject({ code: 'DELIVERY_UNAVAILABLE' })
  })
})
