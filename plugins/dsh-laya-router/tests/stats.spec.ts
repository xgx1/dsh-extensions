import { describe, expect, it } from 'vitest'
import { formatSummary, summarize } from '../src/stats.ts'

const line = (value: Record<string, unknown>): string => JSON.stringify(value)

const LOG = [
  line({ time: 't1', mode: 'shadow', route: { key: 'lite', basis: 'laya' }, response: { latencyMs: 20 } }),
  line({ time: 't2', mode: 'live', route: { key: 'md', basis: 'unlabeled' }, response: { latencyMs: 40 },
    compaction: { decided: true, applied: true }, state: { elided: 3 } }),
  line({ time: 't3', mode: 'live', route: null, compaction: { decided: false } }),
].join('\n')

describe('summarize', () => {
  it('counts routes, bases and modes', () => {
    const summary = summarize(LOG)
    expect(summary.total).toBe(3)
    expect(summary.live).toBe(2)
    expect(summary.byRoute).toEqual({ lite: 1, md: 1, '(none)': 1 })
    expect(summary.byBasis).toEqual({ laya: 1, unlabeled: 1, '(none)': 1 })
  })

  it('reports compaction decisions separately from executions', () => {
    expect(summarize(LOG).compacted).toEqual({ decided: 1, applied: 1 })
  })

  it('averages the latency it actually saw', () => {
    expect(summarize(LOG).meanLatencyMs).toBeCloseTo(30)
  })

  it('counts turns whose decision state had to be trimmed', () => {
    expect(summarize(LOG).elided).toBe(1)
  })

  it('skips a truncated final line instead of failing', () => {
    const summary = summarize(`${LOG}\n{"time":"t4","mode":"li`)
    expect(summary.total).toBe(3)
  })

  it('keeps only the newest decisions when a limit is given', () => {
    const summary = summarize(LOG, 2)
    expect(summary.total).toBe(2)
    expect(summary.byRoute.lite).toBeUndefined()
  })

  it('reports an empty summary for an empty log', () => {
    const summary = summarize('')
    expect(summary.total).toBe(0)
    expect(summary.meanLatencyMs).toBeUndefined()
    expect(summary.lastAt).toBeUndefined()
  })
})

describe('formatSummary', () => {
  it('names the mode and the route counts', () => {
    const text = formatSummary(summarize(LOG), 'live')
    expect(text).toContain('mode=live')
    expect(text).toContain('lite×1')
    expect(text).toContain('平均判定耗时 30.0 ms')
  })
})
