import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { classifyTasks } from '../src/client/tasks.ts'
import { dismissDone, EMPTY_DONE, reduceDone, sameDone } from '../src/client/dismissals.ts'

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
    }), new Set([sid('done-a')]))
    expect(groups.done.map((row) => row.id)).toEqual(['done-a'])
    expect(groups.running.map((row) => row.id)).toEqual(['running-a'])
    expect(groups.waiting.map((row) => row.id)).toEqual(['wait-a'])
  })

  it('takes the waiting group from the pending-interaction fact, ranked above running', () => {
    const state = list([summary({ id: 'busy-but-asking', running: true, updatedAt: 1 })])
    const groups = classifyTasks(state, statusOf({
      'busy-but-asking': { running: true, pendingInteraction: pending('busy-but-asking') },
    }), new Set())
    expect(groups.waiting.map((row) => row.id)).toEqual(['busy-but-asking'])
    expect(groups.running).toEqual([])
  })

  it('sorts finished rows newest-first by updatedAt', () => {
    const state = list([
      summary({ id: 'old', updatedAt: 100 }),
      summary({ id: 'new', updatedAt: 300 }),
      summary({ id: 'mid', updatedAt: 200 }),
    ])
    const groups = classifyTasks(state, statusOf({}), new Set([sid('old'), sid('new'), sid('mid')]))
    expect(groups.done.map((row) => row.id)).toEqual(['new', 'mid', 'old'])
  })

  it('sorts running rows oldest-first by updatedAt', () => {
    const state = list([
      summary({ id: 'late', updatedAt: 50 }),
      summary({ id: 'early', updatedAt: 10 }),
    ])
    const groups = classifyTasks(state, statusOf({ late: { running: true }, early: { running: true } }), new Set())
    expect(groups.running.map((row) => row.id)).toEqual(['early', 'late'])
  })

  it('excludes sessions with no status entry', () => {
    const state = list([
      summary({ id: 'quiet', updatedAt: 5 }),
      summary({ id: 'blank', blank: true, updatedAt: 6 }),
    ])
    const groups = classifyTasks(state, statusOf({}), new Set())
    expect(groups.done).toEqual([])
    expect(groups.running).toEqual([])
    expect(groups.waiting).toEqual([])
  })

  it('excludes status entries absent from the Session list membership', () => {
    const state = list([summary({ id: 'in-list', updatedAt: 1 })])
    const groups = classifyTasks(state, statusOf({
      ghost: { running: true },
      'in-list': { running: true },
    }), new Set())
    expect(groups.running.map((row) => row.id)).toEqual(['in-list'])
  })

  it('keeps a finished row the caller still owes a look at, even once acknowledged', () => {
    const state = list([summary({ id: 'seen', updatedAt: 7 })])
    const groups = classifyTasks(state, statusOf({ seen: { completionUnread: false } }), new Set([sid('seen')]))
    expect(groups.done.map((row) => row.id)).toEqual(['seen'])
  })

  it('drops a finished row the caller no longer owes a look at', () => {
    const state = list([summary({ id: 'closed', updatedAt: 7 })])
    const groups = classifyTasks(state, statusOf({ closed: { completionUnread: true } }), new Set())
    expect(groups.done).toEqual([])
  })

  it('moves a finished row into the running group once it runs again', () => {
    const state = list([summary({ id: 'again', updatedAt: 7 })])
    const groups = classifyTasks(state, statusOf({ again: { running: true } }), new Set([sid('again')]))
    expect(groups.done).toEqual([])
    expect(groups.running.map((row) => row.id)).toEqual(['again'])
  })

  it('carries the display title into each row', () => {
    const state = list([summary({ id: 's1', displayTitle: '我的会话', updatedAt: 1 })])
    expect(classifyTasks(state, statusOf({ s1: { running: true } }), new Set()).running[0]?.title).toBe('我的会话')
  })
})

describe('reduceDone', () => {
  it('adds a session whose unread flag rises', () => {
    const state = list([summary({ id: 'a', updatedAt: 1 })])
    const next = reduceDone(EMPTY_DONE, state, statusOf({ a: { completionUnread: true } }))
    expect(next.shown).toEqual([sid('a')])
    expect(next.unread).toEqual([sid('a')])
  })

  it('keeps a finished row once the harness acknowledges it by opening the session', () => {
    const state = list([summary({ id: 'a', updatedAt: 1 })])
    const first = reduceDone(EMPTY_DONE, state, statusOf({ a: { completionUnread: true } }))
    const second = reduceDone(first, state, statusOf({ a: { completionUnread: false } }))
    expect(second.shown).toEqual([sid('a')])
    expect(second.unread).toEqual([])
  })

  it('does not re-add a row the user closed while the flag stays raised', () => {
    const state = list([summary({ id: 'a', updatedAt: 1 })])
    const raised = statusOf({ a: { completionUnread: true } })
    const first = reduceDone(EMPTY_DONE, state, raised)
    const closed = dismissDone(first, sid('a'))
    expect(reduceDone(closed, state, raised).shown).toEqual([])
  })

  it('re-announces a session that finishes again after being closed', () => {
    const state = list([summary({ id: 'a', updatedAt: 1 })])
    const first = reduceDone(EMPTY_DONE, state, statusOf({ a: { completionUnread: true } }))
    const closed = dismissDone(first, sid('a'))
    const idle = reduceDone(closed, state, statusOf({ a: { completionUnread: false } }))
    const running = reduceDone(idle, state, statusOf({ a: { running: true } }))
    expect(running.shown).toEqual([])
    const again = reduceDone(running, state, statusOf({ a: { completionUnread: true } }))
    expect(again.shown).toEqual([sid('a')])
  })

  it('moves a finished row out once the session runs again', () => {
    const state = list([summary({ id: 'a', updatedAt: 1 })])
    const first = reduceDone(EMPTY_DONE, state, statusOf({ a: { completionUnread: true } }))
    expect(reduceDone(first, state, statusOf({ a: { running: true } })).shown).toEqual([])
  })

  it('forgets a session that leaves the list', () => {
    const state = list([summary({ id: 'a', updatedAt: 1 })])
    const first = reduceDone(EMPTY_DONE, state, statusOf({ a: { completionUnread: true } }))
    const emptied = reduceDone(first, list([]), statusOf({}))
    expect(emptied.shown).toEqual([])
    expect(emptied.unread).toEqual([])
  })

  it('returns the same reference when nothing moved', () => {
    const state = list([summary({ id: 'a', updatedAt: 1 })])
    const first = reduceDone(EMPTY_DONE, state, statusOf({ a: { running: true } }))
    expect(reduceDone(first, state, statusOf({ a: { running: true } }))).toBe(first)
  })

  it('reports equality across shown and unread', () => {
    const state = list([summary({ id: 'a', updatedAt: 1 })])
    const first = reduceDone(EMPTY_DONE, state, statusOf({ a: { completionUnread: true } }))
    expect(sameDone(first, { shown: [sid('a')], unread: [sid('a')] })).toBe(true)
    expect(sameDone(first, { shown: [sid('a')], unread: [] })).toBe(false)
    expect(sameDone(first, { shown: [], unread: [sid('a')] })).toBe(false)
  })

  it('keeps a closed row hidden across a reload while the flag stays raised', () => {
    const state = list([summary({ id: 'a', updatedAt: 1 })])
    const raised = statusOf({ a: { completionUnread: true } })
    const closed = dismissDone(reduceDone(EMPTY_DONE, state, raised), sid('a'))
    // A reload round-trips the state through its persisted JSON shape.
    const restored = JSON.parse(JSON.stringify(closed)) as typeof closed
    expect(reduceDone(restored, state, raised).shown).toEqual([])
  })

  it('announces a completion that happened while the bar was not loaded', () => {
    const state = list([summary({ id: 'a', updatedAt: 1 })])
    const raised = statusOf({ a: { completionUnread: true } })
    expect(reduceDone(EMPTY_DONE, state, raised).shown).toEqual([sid('a')])
  })
})

describe('dismissDone', () => {
  it('removes only the named session', () => {
    const state = { shown: [sid('a'), sid('b')] as SessionId[], unread: [sid('a'), sid('b')] as SessionId[] }
    expect(dismissDone(state, sid('a')).shown).toEqual([sid('b')])
  })

  it('returns the same reference for a session that is not shown', () => {
    const state = { shown: [sid('a')] as SessionId[], unread: [sid('a')] as SessionId[] }
    expect(dismissDone(state, sid('z'))).toBe(state)
  })
})
