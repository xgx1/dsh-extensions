import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { classifyTasks } from '../src/client/tasks.ts'

/** Brand a spec-local string literal as a Session identity. */
const sid = (value: string): SessionId => value as SessionId

function summary(overrides: Omit<Partial<SessionSummary>, 'id'> & { id: string }): SessionSummary {
  return {
    displayTitle: overrides.id,
    running: false,
    blank: false,
    updatedAt: 0,
    retainedBy: {},
    ...overrides,
    id: sid(overrides.id),
  }
}

function list(rows: SessionSummary[]): SessionListState {
  return {
    ids: rows.map((row) => row.id),
    byId: Object.fromEntries(rows.map((row) => [row.id, row])),
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
  }
}

function statusOf(entries: Record<string, Partial<SessionStatus>>): SessionStatusSnapshot {
  const snapshot = new Map<SessionId, SessionStatus>()
  for (const [id, facts] of Object.entries(entries)) {
    snapshot.set(sid(id), {
      running: undefined,
      pendingInteraction: undefined,
      completionUnread: false,
      ...facts,
    })
  }
  return snapshot
}

function pending(sessionId: string): NonNullable<SessionStatus['pendingInteraction']> {
  return { key: 'k', kind: 'question', sessionId: sid(sessionId) }
}

describe('classifyTasks', () => {
  it('groups done (green) on top, then running (red), then waiting (amber)', () => {
    const state = list([
      summary({ id: 'running-a', updatedAt: 3 }),
      summary({ id: 'done-a', updatedAt: 2 }),
      summary({ id: 'wait-a', updatedAt: 1 }),
    ])
    const groups = classifyTasks(state, statusOf({
      'running-a': { running: true },
      'done-a': { completionUnread: true },
      'wait-a': { pendingInteraction: pending('wait-a') },
    }))
    expect(groups.done.map((row) => row.id)).toEqual(['done-a'])
    expect(groups.running.map((row) => row.id)).toEqual(['running-a'])
    expect(groups.waiting.map((row) => row.id)).toEqual(['wait-a'])
  })

  it('takes the waiting group from the pending-interaction fact, ranked above running', () => {
    const state = list([summary({ id: 'busy-but-asking', running: true, updatedAt: 1 })])
    const groups = classifyTasks(state, statusOf({
      'busy-but-asking': { running: true, pendingInteraction: pending('busy-but-asking') },
    }))
    expect(groups.waiting.map((row) => row.id)).toEqual(['busy-but-asking'])
    expect(groups.running).toEqual([])
  })

  it('sorts finished rows newest-first by updatedAt', () => {
    const state = list([
      summary({ id: 'old', updatedAt: 100 }),
      summary({ id: 'new', updatedAt: 300 }),
      summary({ id: 'mid', updatedAt: 200 }),
    ])
    const groups = classifyTasks(state, statusOf({
      old: { completionUnread: true },
      new: { completionUnread: true },
      mid: { completionUnread: true },
    }))
    expect(groups.done.map((row) => row.id)).toEqual(['new', 'mid', 'old'])
  })

  it('sorts running rows oldest-first by updatedAt', () => {
    const state = list([
      summary({ id: 'late', updatedAt: 50 }),
      summary({ id: 'early', updatedAt: 10 }),
    ])
    const groups = classifyTasks(state, statusOf({ late: { running: true }, early: { running: true } }))
    expect(groups.running.map((row) => row.id)).toEqual(['early', 'late'])
  })

  it('excludes sessions with no status entry', () => {
    const state = list([
      summary({ id: 'quiet', updatedAt: 5 }),
      summary({ id: 'blank', blank: true, updatedAt: 6 }),
    ])
    const groups = classifyTasks(state, statusOf({}))
    expect(groups.done).toEqual([])
    expect(groups.running).toEqual([])
    expect(groups.waiting).toEqual([])
  })

  it('excludes status entries absent from the Session list membership', () => {
    const state = list([summary({ id: 'in-list', updatedAt: 1 })])
    const groups = classifyTasks(state, statusOf({
      ghost: { running: true },
      'in-list': { running: true },
    }))
    expect(groups.running.map((row) => row.id)).toEqual(['in-list'])
  })

  it('keeps an acknowledged finished session out of the green group', () => {
    const state = list([summary({ id: 'seen', updatedAt: 7 })])
    const groups = classifyTasks(state, statusOf({ seen: { completionUnread: false } }))
    expect(groups.done).toEqual([])
  })

  it('carries the display title into each row', () => {
    const state = list([summary({ id: 's1', displayTitle: '我的会话', updatedAt: 1 })])
    expect(classifyTasks(state, statusOf({ s1: { running: true } })).running[0]?.title).toBe('我的会话')
  })
})
