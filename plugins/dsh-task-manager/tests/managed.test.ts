/**
 * 纳管视图：把 session-manager 的持久化状态映射成任务卡片，并把汇报折叠成 Markdown。
 */
import { describe, expect, it } from 'vitest'
import { buildManagedReportMarkdown, readManagedCards } from '../src/managed.ts'

/** One realistic slice of the `session_manager` global state. */
function state(): unknown {
  return {
    links: {
      'session-a': {
        workerId: 'session-a', managerId: 'session-m', workspaceId: 'ws',
        agentPreset: 'js', generation: 0, paused: false, detached: false, seenSeq: 3,
      },
      'session-b': {
        workerId: 'session-b', managerId: 'session-m', workspaceId: 'ws',
        agentPreset: 'js', generation: 0, paused: false, detached: false, seenSeq: 9,
      },
      'session-c': {
        workerId: 'session-c', managerId: 'session-m', workspaceId: 'ws',
        agentPreset: 'js', generation: 0, paused: true, detached: false, seenSeq: 1,
      },
      'session-d': {
        workerId: 'session-d', managerId: 'session-m', workspaceId: 'ws',
        agentPreset: 'js', generation: 0, paused: false, detached: true, seenSeq: 1,
      },
    },
    creations: {
      'session-a': {
        managerId: 'session-m', workerId: 'session-a', workspaceId: 'ws',
        agentPreset: 'js', digest: 'd', message: '整理任务清单\n第二行细节', ready: true,
      },
    },
    questions: {
      q1: {
        id: 'q1', workerId: 'session-b', managerId: 'session-m', generation: 0,
        callId: 'call-1', status: 'pending',
        answers: [],
        questions: [{
          id: 'choice', question: '用方案 A 还是 B？', header: '选择',
          options: [{ label: 'A' }, { label: 'B' }], multi_select: false,
        }],
      },
      q2: {
        id: 'q2', workerId: 'session-a', managerId: 'session-m', generation: 0,
        callId: 'call-2', status: 'answered', answers: [],
        questions: [{ id: 'x', question: '已经答过的问题' }],
      },
    },
    deliveries: {},
    pausedManagers: [],
  }
}

describe('readManagedCards', () => {
  it('maps links to cards and drops detached conversations', () => {
    const { cards } = readManagedCards(state())
    expect(cards.map((card) => card.workerId)).toEqual(['session-b', 'session-c', 'session-a'])
    expect(cards.every((card) => card.workerId !== 'session-d')).toBe(true)
  })

  it('derives status: pending question → waiting-reply, paused → paused, else in-progress', () => {
    const { cards } = readManagedCards(state())
    const byId = new Map(cards.map((card) => [card.workerId, card]))
    expect(byId.get('session-b')?.status).toBe('waiting-reply')
    expect(byId.get('session-c')?.status).toBe('paused')
    expect(byId.get('session-a')?.status).toBe('in-progress')
  })

  it('carries the pending question items and ignores answered ones', () => {
    const { cards } = readManagedCards(state())
    const pending = cards.find((card) => card.workerId === 'session-b')
    expect(pending?.question?.id).toBe('q1')
    expect(pending?.question?.items).toEqual([
      { id: 'choice', question: '用方案 A 还是 B？', header: '选择', options: ['A', 'B'] },
    ])
    expect(cards.find((card) => card.workerId === 'session-a')?.question).toBeUndefined()
  })

  it('titles a card from its creation message, falling back to the short id', () => {
    const { cards } = readManagedCards(state())
    const byId = new Map(cards.map((card) => [card.workerId, card]))
    expect(byId.get('session-a')?.title).toBe('整理任务清单')
    expect(byId.get('session-b')?.title).toBe('b')
  })

  it('reports unavailable instead of throwing when the domain is absent', () => {
    expect(readManagedCards(undefined)).toEqual({ cards: [], unavailable: true })
    expect(readManagedCards({ nonsense: true })).toEqual({ cards: [], unavailable: true })
  })
})

describe('buildManagedReportMarkdown', () => {
  const card = {
    workerId: 'session-b', managerId: 'session-m', workspaceId: 'ws', preset: 'js',
    title: '整理任务清单', status: 'waiting-reply' as const,
  }

  it('renders the card header and the routed reports of that worker', () => {
    const events = [
      { type: 'user/message', data: { source: { kind: 'session-manager', workerSessionId: 'session-b' }, content: [{ type: 'text', text: '{"type":"turn-ended","summary":"先写文档"}' }] } },
      { type: 'user/message', data: { source: { kind: 'session-manager', workerSessionId: 'session-other' }, content: [{ type: 'text', text: '别的工作的汇报' }] } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '不是用户消息' }] } },
      { type: 'user/message', data: { source: { kind: 'session-manager', workerSessionId: 'session-b' }, content: [{ type: 'text', text: '{"type":"report","summary":"已改完 3 个文件"}' }] } },
    ]
    const markdown = buildManagedReportMarkdown(card, events)
    expect(markdown).toContain('# 整理任务清单')
    expect(markdown).toContain('先写文档')
    expect(markdown).toContain('已改完 3 个文件')
    expect(markdown).not.toContain('别的工作的汇报')
    expect(markdown).not.toContain('不是用户消息')
    // 路由信封被拆开，人看到的是摘要而不是原始 JSON
    expect(markdown).not.toContain('"summary"')
    expect(markdown).toContain('本轮结束')
  })

  it('states the absence honestly when no report was routed yet', () => {
    const markdown = buildManagedReportMarkdown(card, [])
    expect(markdown).toContain('暂无回报')
  })
})
