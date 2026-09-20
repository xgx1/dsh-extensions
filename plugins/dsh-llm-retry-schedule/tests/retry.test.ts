import { describe, expect, it, vi } from 'vitest'
import type { RetryScheduleConfig } from '../src/schedule.ts'
import { apply, name } from '../src/index.ts'

interface Appended {
  type: string
  data: Record<string, unknown>
}

interface HarnessOptions {
  config?: RetryScheduleConfig
  /** Overrides the injected wait; default records the delay and resolves `true`. */
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<boolean>
}

function makeHarness(options: HarnessOptions = {}) {
  const listeners = new Map<string, (...args: any[]) => unknown>()
  const listenerOptions = new Map<string, unknown>()
  const appended: Appended[] = []
  const waits: number[] = []
  const warn = vi.fn()
  const session = {
    id: 'session-1',
    append: (type: string, data: Record<string, unknown>) => {
      appended.push({ type, data })
    },
  }
  const sleep = options.sleep ?? (async (delayMs: number) => {
    waits.push(delayMs)
    return true
  })
  const ctx = {
    logger: { info: vi.fn(), warn },
    on: (eventName: string, listener: (...args: any[]) => unknown, opts?: unknown) => {
      listeners.set(eventName, listener)
      listenerOptions.set(eventName, opts)
      return () => listeners.delete(eventName)
    },
    effect: (callback: () => unknown) => {
      const disposer = callback()
      return () => disposer
    },
  }
  apply(ctx as never, (options.config ?? {}) as never, { sleep, random: () => 0.5 } as never)

  const requestError = listeners.get('agent/request-error')!
  const sessionEvent = listeners.get('session/event')!
  const next = vi.fn(async () => undefined as never)

  return {
    appended,
    waits,
    warn,
    next,
    sleep,
    listenerOptions,
    retry: (overrides: Record<string, unknown> = {}) => requestError({
      agent: { session },
      turn: 1,
      step: 1,
      provider: 'test-provider',
      failure: { message: 'boom', code: 'SERVER' },
      retryPolicy: {
        mode: 'normal',
        maxRetries: 5,
        retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
        initialDelayMs: 500,
        maxDelayMs: 10_000,
        jitterRatio: 0.1,
      },
      signal: new AbortController().signal,
      ...overrides,
    }, next),
    sessionEvent: (event: Record<string, unknown>) => sessionEvent(session, event),
  }
}

describe('llm-retry-schedule plugin', () => {
  it('identifies itself and prepends on the recovery waterfall', () => {
    const h = makeHarness()
    expect(name).toBe('llm-retry-schedule')
    expect(h.listenerOptions.get('agent/request-error')).toEqual({ prepend: true })
  })

  it('schedules the first retry with the default 5s wait and durable records', async () => {
    const h = makeHarness()
    await expect(h.retry()).resolves.toEqual({ kind: 'retry' })

    expect(h.waits).toEqual([5_000])
    expect(h.next).not.toHaveBeenCalled()
    const [scheduled, started] = h.appended
    expect(scheduled?.type).toBe('llm/retry')
    expect(scheduled?.data).toMatchObject({
      turn: 1,
      step: 1,
      provider: 'test-provider',
      mode: 'normal',
      retry: 1,
      maxRetries: 1000,
      delayMs: 5_000,
      failure: { code: 'SERVER' },
    })
    expect(typeof scheduled?.data.policyKey).toBe('string')
    expect(started?.type).toBe('llm/retry-started')
    expect(started?.data).toEqual({ retryId: scheduled?.data.retryId, turn: 1, step: 1, retry: 1 })
  })

  it('steps 5s → 10s → 60s across a long retry series in one step', async () => {
    const h = makeHarness()
    for (let attempt = 0; attempt < 21; attempt++) await h.retry()

    expect(h.waits.slice(0, 4)).toEqual([5_000, 5_000, 5_000, 5_000])
    expect(h.waits.slice(4, 19)).toEqual(new Array(15).fill(10_000))
    expect(h.waits.slice(19)).toEqual([60_000, 60_000])

    const scheduled = h.appended.filter(entry => entry.type === 'llm/retry')
    expect(scheduled.map(entry => entry.data.retry)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1),
    )
    expect(new Set(scheduled.map(entry => entry.data.retryId)).size).toBe(1)
  })

  it('restarts the series on the next step and keeps counters per Session', async () => {
    const h = makeHarness()
    for (let attempt = 0; attempt < 3; attempt++) await h.retry()
    h.sessionEvent({ type: 'step/start' })
    await h.retry()

    const scheduled = h.appended.filter(entry => entry.type === 'llm/retry')
    expect(scheduled.map(entry => entry.data.retry)).toEqual([1, 2, 3, 1])
    expect(h.waits).toEqual([5_000, 5_000, 5_000, 5_000])
    expect(scheduled[3]?.data.retryId).not.toBe(scheduled[0]?.data.retryId)
  })

  it('restarts the series on turn/end', async () => {
    const h = makeHarness()
    await h.retry()
    h.sessionEvent({ type: 'turn/end' })
    await h.retry()
    const scheduled = h.appended.filter(entry => entry.type === 'llm/retry')
    expect(scheduled.map(entry => entry.data.retry)).toEqual([1, 1])
  })

  it('delegates once the configured budget is spent', async () => {
    const h = makeHarness({ config: { maxRetries: 2 } })
    await h.retry()
    await h.retry()
    await expect(h.retry()).resolves.toBeUndefined()

    expect(h.next).toHaveBeenCalledTimes(1)
    expect(h.appended.filter(entry => entry.type === 'llm/retry')).toHaveLength(2)
    expect(h.warn).toHaveBeenCalledTimes(1)
  })

  it('delegates a failure code outside the provider policy', async () => {
    const h = makeHarness()
    await expect(h.retry({ failure: { message: 'bad key', code: 'AUTH' } })).resolves.toBeUndefined()

    expect(h.next).toHaveBeenCalledTimes(1)
    expect(h.appended).toHaveLength(0)
    expect(h.waits).toHaveLength(0)
  })

  it('lets an explicit code list in the row override the provider policy', async () => {
    const h = makeHarness({ config: { retryableCodes: ['AUTH'] } })
    await expect(h.retry({ failure: { message: 'bad key', code: 'AUTH' } })).resolves.toEqual({ kind: 'retry' })
    expect(h.next).not.toHaveBeenCalled()

    const h2 = makeHarness({ config: { retryableCodes: ['AUTH'] } })
    await expect(h2.retry()).resolves.toBeUndefined()
    expect(h2.next).toHaveBeenCalledTimes(1)
  })

  it('accepts a provider Retry-After inside the schedule, ignores one above it', async () => {
    const short = makeHarness()
    await short.retry({ failure: { message: 'slow down', code: 'RATE_LIMIT', providerRetryAfterMs: 12_000 } })
    expect(short.waits).toEqual([12_000])

    const long = makeHarness()
    await long.retry({ failure: { message: 'slow down', code: 'RATE_LIMIT', providerRetryAfterMs: 90_000 } })
    expect(long.waits).toEqual([5_000])
  })

  it('abandons the retry when the turn aborts during the wait', async () => {
    const h = makeHarness({ sleep: async (_delayMs, signal) => signal.aborted || await new Promise<boolean>((resolve) => {
      signal.addEventListener('abort', () => resolve(false), { once: true })
    }) })
    const controller = new AbortController()
    const pending = h.retry({ signal: controller.signal })
    await Promise.resolve()
    controller.abort()

    await expect(pending).resolves.toBeUndefined()
    expect(h.appended.map(entry => entry.type)).toEqual(['llm/retry'])
  })

  it('offers an always-mode route to the chain first', async () => {
    const h = makeHarness()
    h.next.mockResolvedValueOnce({ kind: 'retry' } as never)
    await expect(h.retry({
      retryPolicy: { mode: 'always', initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
    })).resolves.toEqual({ kind: 'retry' })

    expect(h.next).toHaveBeenCalledTimes(1)
    expect(h.appended).toHaveLength(0)
  })

  it('serves an always-mode route when nothing else claims the failure', async () => {
    const h = makeHarness()
    await expect(h.retry({
      retryPolicy: { mode: 'always', initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
    })).resolves.toEqual({ kind: 'retry' })

    expect(h.waits).toEqual([5_000])
    expect(h.appended.map(entry => entry.type)).toEqual(['llm/retry', 'llm/retry-started'])
  })

  it('returns without acting when the turn is already aborted', async () => {
    const h = makeHarness()
    const controller = new AbortController()
    controller.abort()
    await expect(h.retry({ signal: controller.signal })).resolves.toBeUndefined()
    expect(h.appended).toHaveLength(0)
    expect(h.next).not.toHaveBeenCalled()
  })
})
