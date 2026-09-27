import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POLICY,
  mergePolicy,
  pickEffort,
  pickRoute,
  readJudgement,
  shouldCompact,
  type ChoiceAnswer,
} from '../src/policy.ts'

const choice = (value: string, confidence: number, probabilities?: Record<string, number>): ChoiceAnswer => ({
  choice: value,
  confidence,
  ...probabilities === undefined ? {} : { probabilities },
})

describe('readJudgement', () => {
  it('reads answers that clear the floor', () => {
    const judgement = readJudgement({
      difficulty: choice('hard', 0.9),
      budget: choice('immediate', 0.8),
      continuity: choice('new_task', 0.7, { continues: 0.3, new_task: 0.7 }),
    }, 0.5)
    expect(judgement.difficulty).toBe('hard')
    expect(judgement.budget).toBe('immediate')
    expect(judgement.continuity).toBe('new_task')
    expect(judgement.newTaskProbability).toBeCloseTo(0.7)
  })

  it('treats a below-floor answer as unsaid while keeping its confidence on record', () => {
    const judgement = readJudgement({
      budget: choice('can_wait', 0.49),
    }, 0.5)
    expect(judgement.budget).toBeUndefined()
    expect(judgement.confidence.budget).toBeCloseTo(0.49)
    // The routing table must not be able to see the value it refused.
    expect(JSON.stringify(judgement)).not.toContain('can_wait')
  })

  it('withholds P(new_task) when continuity itself did not clear the floor', () => {
    const judgement = readJudgement({
      continuity: choice('new_task', 0.2, { continues: 0.2, new_task: 0.8 }),
    }, 0.5)
    expect(judgement.continuity).toBeUndefined()
    expect(judgement.newTaskProbability).toBeUndefined()
  })

  it('rejects a value outside the declared options', () => {
    expect(readJudgement({ difficulty: choice('impossible', 0.9) }, 0.5).difficulty).toBeUndefined()
  })

  it('survives an empty answer set', () => {
    const judgement = readJudgement({}, 0.5)
    expect(judgement.difficulty).toBeUndefined()
    expect(judgement.budget).toBeUndefined()
    expect(judgement.continuity).toBeUndefined()
    expect(judgement.newTaskProbability).toBeUndefined()
  })
})

describe('pickRoute', () => {
  it('takes the first matching rule', () => {
    const chosen = pickRoute({ confidence: {}, difficulty: 'hard', budget: 'immediate' }, DEFAULT_POLICY)
    expect(chosen?.key).toBe('official')
    expect(chosen?.basis).toBe('laya')
  })

  it('routes hard work that can wait to the daily-refreshed quota', () => {
    expect(pickRoute({ confidence: {}, difficulty: 'hard', budget: 'can_wait' }, DEFAULT_POLICY)?.key).toBe('md')
  })

  it('routes easy waiting work to the cheapest model', () => {
    expect(pickRoute({ confidence: {}, difficulty: 'easy', budget: 'can_wait' }, DEFAULT_POLICY)?.key).toBe('lite')
  })

  it('falls back to the unlabeled route when the text said nothing', () => {
    const chosen = pickRoute({ confidence: {},}, DEFAULT_POLICY)
    expect(chosen?.key).toBe('md')
    expect(chosen?.basis).toBe('unlabeled')
  })

  it('changes nothing when no unlabeled route is configured', () => {
    const policy = mergePolicy(DEFAULT_POLICY, { unlabeledRoute: null })
    expect(pickRoute({ confidence: {},}, policy)).toBeNull()
  })

  it('skips a rule naming an unknown route instead of throwing', () => {
    const policy = mergePolicy(DEFAULT_POLICY, { table: [{ budget: 'can_wait', route: 'ghost' }] })
    expect(pickRoute({ confidence: {}, budget: 'can_wait' }, policy)?.key).toBe('md')
  })
})

describe('pickEffort', () => {
  it('maps difficulty for a route that accepts an effort', () => {
    expect(pickEffort('lite', { difficulty: 'hard', confidence: {} }, DEFAULT_POLICY)).toBe('high')
  })

  it('returns undefined for a route that declares none, so the caller clears it', () => {
    expect(pickEffort('official', { difficulty: 'hard', confidence: {} }, DEFAULT_POLICY)).toBeUndefined()
  })

  it('returns undefined when difficulty was never established', () => {
    expect(pickEffort('lite', { confidence: {} }, DEFAULT_POLICY)).toBeUndefined()
  })
})

describe('shouldCompact', () => {
  const judgement = { newTaskProbability: 0.8, confidence: {} }

  it('compacts when the task switched and the context is long enough', () => {
    expect(shouldCompact(judgement, 0.5, DEFAULT_POLICY)).toBe(true)
  })

  it('does not compact inside the same task', () => {
    expect(shouldCompact({ newTaskProbability: 0.2, confidence: {} }, 0.9, DEFAULT_POLICY)).toBe(false)
  })

  it('does not compact a short context', () => {
    expect(shouldCompact(judgement, 0.39, DEFAULT_POLICY)).toBe(false)
  })

  it('does not compact when occupancy is unknown', () => {
    expect(shouldCompact(judgement, undefined, DEFAULT_POLICY)).toBe(false)
  })

  it('respects the disabled switch', () => {
    const policy = mergePolicy(DEFAULT_POLICY, { compaction: { enabled: false } })
    expect(shouldCompact(judgement, 0.9, policy)).toBe(false)
  })
})

describe('mergePolicy', () => {
  it('returns the base policy untouched without an override', () => {
    expect(mergePolicy(DEFAULT_POLICY)).toBe(DEFAULT_POLICY)
  })

  it('replaces the table wholesale when one is supplied', () => {
    const policy = mergePolicy(DEFAULT_POLICY, { table: [{ budget: 'minutes', route: 'lite' }] })
    expect(policy.table).toHaveLength(1)
    expect(pickRoute({ confidence: {}, budget: 'minutes' }, policy)?.key).toBe('lite')
  })

  it('merges routes and keeps the rest', () => {
    const policy = mergePolicy(DEFAULT_POLICY, {
      routes: { ghost: { provider: 'x', model: 'y' } },
      confidenceFloor: 0.7,
    })
    expect(policy.routes.ghost).toEqual({ provider: 'x', model: 'y' })
    expect(policy.routes.official).toEqual(DEFAULT_POLICY.routes.official)
    expect(policy.confidenceFloor).toBe(0.7)
  })
})
