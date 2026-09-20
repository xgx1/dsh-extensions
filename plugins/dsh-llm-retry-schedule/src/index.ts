/**
 * `dsh-llm-retry-schedule` — a tiered, deployment-owned retry budget on the
 * agent loop's request-recovery extension point.
 *
 * The recovery point is the `agent/request-error` waterfall: a listener that
 * returns `{ kind: 'retry' }` without calling `next()` owns that failure, while
 * one that calls `next()` delegates down the chain. This plugin registers with
 * `prepend: true`, so it is the outermost listener and settles every transient
 * failure itself; the shipped `@deepseek-ai/dsh-llm-retry` stays mounted
 * underneath and keeps whatever this plugin declines (a code outside the
 * effective set, an exhausted budget, or a provider route configured with
 * `mode: 'always'`, whose own policy decides first).
 *
 * Retry waits come from `./schedule.ts` — a step table instead of the shipped
 * exponential curve. Every scheduled retry is appended durably as the
 * `llm/retry` session event before its cancellable wait, then
 * `llm/retry-started` once that wait completes. Those are the durable records
 * the shipped plugin writes, so the Web Chat retry row renders this plugin's
 * retries unchanged.
 *
 * @module dsh-llm-retry-schedule
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { RetryId } from '@deepseek-ai/dsh-llm-retry'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import {
  DEFAULT_RETRYABLE_CODES,
  delayForRetry,
  maxScheduledDelay,
  resolveRetrySchedule,
  type ResolvedRetrySchedule,
  type RetryScheduleConfig,
} from './schedule.ts'

export { DEFAULT_MAX_RETRIES, DEFAULT_SCHEDULE } from './schedule.ts'
export type { RetryScheduleConfig, ScheduleTier } from './schedule.ts'

export const name = 'llm-retry-schedule'

/** The failure arrives on an agent event, so the agent registry activates first. */
export const inject = ['agents']

/** Plugin configuration; see {@link RetryScheduleConfig}. */
export type Config = RetryScheduleConfig

/** Non-serializable hooks used to make timing deterministic in tests. */
export interface RetryInternals {
  /** Random sample in the inclusive zero-to-one range used for jitter. */
  random?: () => number
  /** Cancellable wait; resolves `false` when the signal aborted first. */
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<boolean>
}

/** The `agent/request-error` payload this plugin reads. */
interface RequestErrorPayload {
  agent: Agent
  turn: number
  step: number
  provider: string
  failure: LlmFailure
  retryPolicy: ResolvedRetryPolicy | undefined
  signal: AbortSignal
}

/** One request step's retry accounting for one provider route. */
interface RetryEntry {
  retry: number
  retryId: RetryId
}

type SessionRetryState = Record<string, RetryEntry>

/** Events whose arrival closes the retry series of the step they belong to. */
const SERIES_END_EVENTS: ReadonlySet<string> = new Set(['step/start', 'step/end', 'turn/end'])

function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

type DownstreamOutcome =
  | { readonly type: 'decision'; readonly decision: RequestErrorAction }
  | { readonly type: 'error'; readonly error: unknown }

async function settleDownstream(next: () => Promise<RequestErrorAction>): Promise<DownstreamOutcome> {
  try {
    return { type: 'decision', decision: await next() }
  } catch (error: unknown) {
    return { type: 'error', error }
  }
}

/**
 * Install the tiered retry budget.
 * @param ctx - plugin context that owns the listener, the retry counters, and the active waits.
 * @param config - the row's configuration; every field has a default, so `{}` is valid.
 * @param internals - deterministic timing hooks for tests.
 * @throws when the configuration is invalid, so a mistyped row fails at load.
 */
export function apply(ctx: Context, config: Config = {}, internals: RetryInternals = {}): void {
  const schedule: ResolvedRetrySchedule = resolveRetrySchedule(config)
  ctx.logger.info(
    `llm-retry-schedule: active — maxRetries=${schedule.maxRetries}, `
    + `waits=${schedule.tiers.map(tier => `retry>=${tier.fromRetry}:${tier.delayMs}ms`).join(' ')}, `
    + `jitter=${schedule.jitterRatio}`,
  )
  const random = internals.random ?? Math.random
  const sleep = internals.sleep ?? cancellableDelay
  const lifetime = new AbortController()
  const active = new Set<Promise<RequestErrorAction>>()
  // One counter set per Session: the loop retries a request inside the same
  // step, and only a step or turn boundary closes that retry series.
  const states = new Map<string, SessionRetryState>()

  function track(operation: Promise<RequestErrorAction>): Promise<RequestErrorAction> {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  function effectiveCodes(policy: ResolvedRetryPolicy | undefined): readonly string[] {
    if (schedule.retryableCodes !== undefined) return schedule.retryableCodes
    if (policy !== undefined && policy.mode === 'normal') return policy.retryableCodes
    return DEFAULT_RETRYABLE_CODES
  }

  function retriesSoFar(sessionId: string, provider: string): number {
    return states.get(sessionId)?.[provider]?.retry ?? 0
  }

  async function scheduleRetry(
    agent: Agent,
    turn: number,
    step: number,
    provider: string,
    failure: LlmFailure,
    signal: AbortSignal,
  ): Promise<RequestErrorAction> {
    const fusedSignal = AbortSignal.any([signal, lifetime.signal])
    if (fusedSignal.aborted) return

    const sessionId = agent.session.id
    const state = states.get(sessionId) ?? {}
    const previous = state[provider]
    const retry = (previous?.retry ?? 0) + 1
    const retryId = previous?.retryId ?? randomUUID() as RetryId
    state[provider] = { retry, retryId }
    states.set(sessionId, state)

    // A provider-issued Retry-After wins only when it fits inside this
    // deployment's own longest scheduled wait.
    const providerDelay = failure.providerRetryAfterMs
    const delayMs = providerDelay !== undefined
      && Number.isFinite(providerDelay)
      && providerDelay > 0
      && providerDelay <= maxScheduledDelay(schedule)
      ? providerDelay
      : delayForRetry(schedule, retry, random)

    agent.session.append('llm/retry', {
      retryId,
      turn,
      step,
      provider,
      mode: 'normal',
      policyKey: schedule.policyKey,
      retry,
      maxRetries: schedule.maxRetries,
      delayMs,
      failure,
    })
    if (!await sleep(delayMs, fusedSignal)) return
    agent.session.append('llm/retry-started', { retryId, turn, step, retry })
    return { kind: 'retry' }
  }

  async function recover(
    { agent, turn, step, provider, failure, retryPolicy, signal }: RequestErrorPayload,
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    if (signal.aborted || lifetime.signal.aborted) return

    if (retryPolicy?.mode === 'always') {
      // An unbounded route's own policy decides first, so context-overflow and
      // image-offload recovery keep owning their codes; this plugin serves only
      // a failure nothing else claimed.
      const downstream = await settleDownstream(next)
      if (signal.aborted || lifetime.signal.aborted) return
      if (downstream.type === 'error') {
        ctx.logger.warn(
          `llm-retry-schedule: provider "${provider}" downstream recovery failed: ${String(downstream.error)}`,
        )
      }
      if (downstream.type === 'decision' && downstream.decision?.kind === 'retry') return downstream.decision
    } else {
      if (!effectiveCodes(retryPolicy).includes(failure.code)) return next()
      if (retriesSoFar(agent.session.id, provider) >= schedule.maxRetries) {
        ctx.logger.warn(
          `llm-retry-schedule: provider "${provider}" used all ${schedule.maxRetries} `
          + `scheduled retries on ${failure.code}; delegating to the next recovery owner`,
        )
        return next()
      }
    }

    return scheduleRetry(agent, turn, step, provider, failure, signal)
  }

  const disposeListener = ctx.on('agent/request-error', (
    payload: RequestErrorPayload,
    next: () => Promise<RequestErrorAction>,
  ) => {
    // A waterfall may hold this callback past disposal; the abort then wins
    // before a stale callback can schedule another wait.
    if (lifetime.signal.aborted) return Promise.resolve<RequestErrorAction>(undefined)
    return track(recover(payload, next))
  }, { prepend: true })

  const disposeSessionEvents = ctx.on('session/event', (session, event) => {
    if (SERIES_END_EVENTS.has(event.type)) states.delete(session.id)
  })

  ctx.effect(() => async () => {
    disposeSessionEvents()
    disposeListener()
    states.clear()
    lifetime.abort(new Error('llm-retry-schedule plugin disposed'))
    await Promise.allSettled([...active])
  }, 'llm-retry-schedule: abort and drain active waits')
}
