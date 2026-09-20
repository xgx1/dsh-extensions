import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRYABLE_CODES,
  DEFAULT_SCHEDULE,
  delayForRetry,
  maxScheduledDelay,
  resolveRetrySchedule,
} from '../src/schedule.ts'

const noJitter = () => 0.5

describe('resolveRetrySchedule', () => {
  it('defaults to 1000 retries on a 5s / 10s / 60s step table', () => {
    const resolved = resolveRetrySchedule(undefined)
    expect(resolved.maxRetries).toBe(DEFAULT_MAX_RETRIES)
    expect(resolved.maxRetries).toBe(1000)
    expect(resolved.tiers).toEqual([
      { fromRetry: 1, delayMs: 5_000 },
      { fromRetry: 5, delayMs: 10_000 },
      { fromRetry: 20, delayMs: 60_000 },
    ])
    expect(resolved.jitterRatio).toBe(0)
    expect(resolved.retryableCodes).toBeUndefined()
    expect(DEFAULT_RETRYABLE_CODES).toEqual(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
  })

  it('accepts an explicit schedule and keeps it detached', () => {
    const tiers = [{ fromRetry: 1, delayMs: 1_000 }, { fromRetry: 3, delayMs: 2_000 }]
    const resolved = resolveRetrySchedule({ maxRetries: 7, schedule: tiers })
    tiers[1]!.delayMs = 9_999
    expect(resolved.maxRetries).toBe(7)
    expect(resolved.tiers[1]?.delayMs).toBe(2_000)
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.tiers[1])).toBe(true)
  })

  it.each([
    ['unknown key', { nope: 1 }],
    ['negative maxRetries', { maxRetries: -1 }],
    ['fractional maxRetries', { maxRetries: 1.5 }],
    ['empty schedule', { schedule: [] }],
    ['tier not starting at 1', { schedule: [{ fromRetry: 2, delayMs: 100 }] }],
    ['descending tiers', { schedule: [{ fromRetry: 1, delayMs: 100 }, { fromRetry: 1, delayMs: 200 }] }],
    ['zero delay', { schedule: [{ fromRetry: 1, delayMs: 0 }] }],
    ['non-finite delay', { schedule: [{ fromRetry: 1, delayMs: Number.POSITIVE_INFINITY }] }],
    ['too large delay', { schedule: [{ fromRetry: 1, delayMs: 2 ** 31 }] }],
    ['unknown tier key', { schedule: [{ fromRetry: 1, delayMs: 100, extra: true }] }],
    ['empty code list', { retryableCodes: [] }],
    ['duplicate codes', { retryableCodes: ['SERVER', 'SERVER'] }],
    ['jitter above one', { jitterRatio: 1.5 }],
  ])('rejects %s', (_label, config) => {
    expect(() => resolveRetrySchedule(config as never)).toThrow()
  })

  it('keys two different policies apart', () => {
    const a = resolveRetrySchedule(undefined)
    const b = resolveRetrySchedule({ maxRetries: 5 })
    expect(a.policyKey).not.toBe(b.policyKey)
  })
})

describe('delayForRetry', () => {
  const schedule = resolveRetrySchedule(undefined)

  it('holds 5s through retry 4, 10s from retry 5, 60s from retry 20', () => {
    expect(delayForRetry(schedule, 1, noJitter)).toBe(5_000)
    expect(delayForRetry(schedule, 4, noJitter)).toBe(5_000)
    expect(delayForRetry(schedule, 5, noJitter)).toBe(10_000)
    expect(delayForRetry(schedule, 19, noJitter)).toBe(10_000)
    expect(delayForRetry(schedule, 20, noJitter)).toBe(60_000)
    expect(delayForRetry(schedule, 1000, noJitter)).toBe(60_000)
  })

  it('applies jitter symmetrically around the tier delay', () => {
    const jittered = resolveRetrySchedule({ jitterRatio: 0.5, schedule: DEFAULT_SCHEDULE })
    expect(delayForRetry(jittered, 1, () => 0)).toBe(2_500)
    expect(delayForRetry(jittered, 1, () => 1)).toBe(7_500)
  })

  it('reports the longest scheduled wait', () => {
    expect(maxScheduledDelay(schedule)).toBe(60_000)
  })
})
