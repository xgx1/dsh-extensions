import { describe, expect, it } from 'vitest'
import { pickAppliedRoute, type PendingRoute } from '../src/apply.ts'

const md: PendingRoute = { route: { provider: 'md', model: 'deepseek-ai/DeepSeek-V4.1-Flash' } }
const lite: PendingRoute = { route: { provider: 'sensenova', model: 'sensenova-6.8-flash-lite' }, effort: 'low' }

describe('pickAppliedRoute', () => {
  it('uses the fresh decision on the first step of a turn', () => {
    expect(pickAppliedRoute({ step: 1, pending: lite, applied: md, fallback: md })).toBe(lite)
  })

  it('keeps a later step on the route the turn already runs on', () => {
    expect(pickAppliedRoute({ step: 2, pending: undefined, applied: lite, fallback: md })).toBe(lite)
  })

  it('never switches models mid-turn, even when a new decision is somehow present', () => {
    expect(pickAppliedRoute({ step: 2, pending: md, applied: lite, fallback: md })).toBe(lite)
  })

  it('falls back to the static default when the turn recorded nothing', () => {
    expect(pickAppliedRoute({ step: 2, pending: undefined, applied: undefined, fallback: md })).toBe(md)
    expect(pickAppliedRoute({ step: 1, pending: undefined, applied: undefined, fallback: md })).toBe(md)
  })

  it('reports nothing to apply when every candidate is absent', () => {
    expect(pickAppliedRoute({ step: 1, pending: undefined, applied: undefined, fallback: undefined }))
      .toBeUndefined()
  })
})
