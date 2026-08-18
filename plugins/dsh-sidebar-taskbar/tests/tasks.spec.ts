import { describe, expect, it } from 'vitest'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { classifyTasks } from '../src/client/tasks.ts'

function summary(overrides: Omit<Partial<SessionSummary>, 'id'> & { id: string }): SessionSummary {
  return {
    displayTitle: overrides.id,
    running: false,
    blank: false,
    updatedAt: 0,
    ...overrides,
    id: overrides.id as SessionId,
  }
}

function list(rows: SessionSummary[]): SessionListState {
  return {
    ids: rows.map((row) => row.id),
    byId: Object.fromEntries(rows.map((row) => [row.id, row])),
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  } as SessionListState
}

describe('classifyTasks', () => {
  it('groups completed (green) on top, then running (red), then waiting (amber)', () => {
    const state = list([
      summary({ id: 'running-a', running: true, updatedAt: 3 }),
      summary({ id: 'done-a', completed: true, updatedAt: 2 }),
      summary({ id: 'wait-a', pendingInteraction: 'question', updatedAt: 1 }),
    ])
    const groups = classifyTasks(state)
    expect(groups.done.map((row) => row.id)).toEqual(['done-a'])
    expect(groups.running.map((row) => row.id)).toEqual(['running-a'])
    expect(groups.waiting.map((row) => row.id)).toEqual(['wait-a'])
  })

  it('sorts finished rows newest-first by updatedAt', () => {
    const state = list([
      summary({ id: 'old', completed: true, updatedAt: 100 }),
      summary({ id: 'new', completed: true, updatedAt: 300 }),
      summary({ id: 'mid', completed: true, updatedAt: 200 }),
    ])
    expect(classifyTasks(state).done.map((row) => row.id)).toEqual(['new', 'mid', 'old'])
  })

  it('sorts running rows oldest-first by updatedAt', () => {
    const state = list([
      summary({ id: 'late', running: true, updatedAt: 50 }),
      summary({ id: 'early', running: true, updatedAt: 10 }),
    ])
    expect(classifyTasks(state).running.map((row) => row.id)).toEqual(['early', 'late'])
  })

  it('excludes blank idle sessions with no signals', () => {
    const state = list([
      summary({ id: 'quiet', updatedAt: 5 }),
      summary({ id: 'blank', blank: true, updatedAt: 6 }),
    ])
    const groups = classifyTasks(state)
    expect(groups.done).toEqual([])
    expect(groups.running).toEqual([])
    expect(groups.waiting).toEqual([])
  })

  it('keeps a waiting session visible even when it also completed earlier', () => {
    const state = list([
      summary({ id: 'mixed', pendingInteraction: 'approval', completed: true, updatedAt: 7 }),
    ])
    const groups = classifyTasks(state)
    // Waiting outranks the green done state (the user owes an answer).
    expect(groups.waiting.map((row) => row.id)).toEqual(['mixed'])
    expect(groups.done).toEqual([])
  })

  it('carries the display title into each row', () => {
    const state = list([
      summary({ id: 's1', running: true, displayTitle: '我的会话', updatedAt: 1 }),
    ])
    expect(classifyTasks(state).running[0]?.title).toBe('我的会话')
  })
})
