/**
 * Tiered retry-delay schedule for `dsh-llm-retry-schedule`.
 *
 * The shipped `@deepseek-ai/dsh-llm-retry` derives every local delay from one
 * exponential curve (`initialDelayMs * 2 ** (retry - 1)`, capped, jittered).
 * This module resolves a step table instead, so a deployment can keep a long
 * retry budget at a few fixed wait lengths — the shape requested here is
 * "5 s for the first retries, 10 s from the 5th, 60 s from the 20th".
 *
 * @module dsh-llm-retry-schedule/schedule
 */

/** One step of the delay table: retries from `fromRetry` until the next tier start wait `delayMs`. */
export interface ScheduleTier {
  /** First retry number this tier covers (1-based, the first tier must be 1). */
  readonly fromRetry: number
  /** Wait before that retry, in milliseconds. */
  readonly delayMs: number
}

/** Plugin configuration; every field has a default, so an empty `config:` row is valid. */
export interface RetryScheduleConfig {
  /** Eligible retries per request step before this plugin delegates down the chain. Default 1000. */
  readonly maxRetries?: number
  /** Ascending delay table; see {@link DEFAULT_SCHEDULE}. */
  readonly schedule?: readonly ScheduleTier[]
  /** Failure codes this plugin owns. Omitted: the provider policy's codes, else {@link DEFAULT_RETRYABLE_CODES}. */
  readonly retryableCodes?: readonly string[]
  /** Symmetric random multiplier range around one; 0 keeps every scheduled wait exact. Default 0. */
  readonly jitterRatio?: number
}

/** Validated, detached plugin policy captured once when the plugin loads. */
export interface ResolvedRetrySchedule {
  readonly maxRetries: number
  readonly tiers: readonly ScheduleTier[]
  /** `undefined` defers the code set to the provider policy, then to the built-in default. */
  readonly retryableCodes: readonly string[] | undefined
  readonly jitterRatio: number
  /** Identifies this resolved policy in durable retry records and log lines. */
  readonly policyKey: string
}

/** Retry budget applied when the configuration omits `maxRetries`. */
export const DEFAULT_MAX_RETRIES = 1000

/**
 * Delay table applied when the configuration omits `schedule`:
 * retries 1–4 wait 5 s, retries 5–19 wait 10 s, retry 20 and later wait 60 s.
 */
export const DEFAULT_SCHEDULE: readonly ScheduleTier[] = Object.freeze([
  Object.freeze({ fromRetry: 1, delayMs: 5_000 }),
  Object.freeze({ fromRetry: 5, delayMs: 10_000 }),
  Object.freeze({ fromRetry: 20, delayMs: 60_000 }),
])

/** Jitter applied when the configuration omits `jitterRatio`. */
export const DEFAULT_JITTER_RATIO = 0

/**
 * Failure codes owned when neither the configuration nor the provider route
 * declares any. Copied from `@deepseek-ai/dsh-llm`'s default retry policy
 * (`EMPTY_RESPONSE_CODE` plus the transient adapter codes) so a provider route
 * that registers without a policy still gets the expected transient set.
 */
export const DEFAULT_RETRYABLE_CODES: readonly string[] = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/** Largest delay `setTimeout` accepts (2^31 - 1 ms), matching the harness timer bound. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'maxRetries', 'schedule', 'retryableCodes', 'jitterRatio',
])
const TIER_KEYS: ReadonlySet<string> = new Set(['fromRetry', 'delayMs'])

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknownKeys(value: object, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}: unknown key "${key}"`)
  }
}

function positiveFinite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive finite number`)
  }
  if (value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path} must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return value
}

function resolveTiers(input: readonly ScheduleTier[] | undefined, path: string): readonly ScheduleTier[] {
  if (input === undefined) return DEFAULT_SCHEDULE
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`${path} must be a non-empty list of { fromRetry, delayMs } entries`)
  }
  const tiers: ScheduleTier[] = []
  let previous = 0
  for (const [index, tier] of input.entries()) {
    const tierPath = `${path}[${index}]`
    if (!isPlainObject(tier)) throw new Error(`${tierPath} must be an object`)
    rejectUnknownKeys(tier, TIER_KEYS, tierPath)
    const { fromRetry, delayMs } = tier as { fromRetry?: unknown; delayMs?: unknown }
    if (!Number.isSafeInteger(fromRetry) || (fromRetry as number) < 1) {
      throw new Error(`${tierPath}.fromRetry must be an integer of at least 1`)
    }
    if (index === 0 && fromRetry !== 1) {
      throw new Error(`${path}[0].fromRetry must be 1 so the first retry has a wait`)
    }
    if ((fromRetry as number) <= previous) {
      throw new Error(`${tierPath}.fromRetry must be greater than the previous tier's fromRetry`)
    }
    previous = fromRetry as number
    tiers.push(Object.freeze({ fromRetry: fromRetry as number, delayMs: positiveFinite(delayMs, `${tierPath}.delayMs`) }))
  }
  return Object.freeze(tiers)
}

function resolveCodes(input: readonly string[] | undefined, path: string): readonly string[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`${path} must be a non-empty list of failure codes`)
  }
  for (const code of input) {
    if (typeof code !== 'string' || code.length === 0) {
      throw new Error(`${path} must contain only non-empty strings`)
    }
  }
  if (new Set(input).size !== input.length) {
    throw new Error(`${path} must not contain duplicates`)
  }
  return Object.freeze([...input])
}

/**
 * Validate and default one plugin configuration.
 * @param config - the row's `config` value; `undefined` selects every default.
 * @param path - diagnostic prefix naming the configuration that owns the value.
 * @returns an immutable policy safe to capture for the plugin's lifetime.
 * @throws when a field is unknown, mistyped, or out of range — misconfiguration fails at load.
 */
export function resolveRetrySchedule(
  config: RetryScheduleConfig | undefined,
  path = 'llm-retry-schedule config',
): ResolvedRetrySchedule {
  if (config !== undefined && !isPlainObject(config)) throw new Error(`${path} must be an object`)
  if (config !== undefined) rejectUnknownKeys(config as object, CONFIG_KEYS, path)

  const maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error(`${path}.maxRetries must be a non-negative integer`)
  }
  const tiers = resolveTiers(config?.schedule, `${path}.schedule`)
  const retryableCodes = resolveCodes(config?.retryableCodes, `${path}.retryableCodes`)
  const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO
  if (typeof jitterRatio !== 'number' || !Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error(`${path}.jitterRatio must be a number between 0 and 1`)
  }

  return Object.freeze({
    maxRetries,
    tiers,
    retryableCodes,
    jitterRatio,
    policyKey: JSON.stringify([maxRetries, tiers.map(tier => [tier.fromRetry, tier.delayMs]), jitterRatio]),
  })
}

/**
 * Resolve the wait before one retry from the delay table.
 * @param schedule - the resolved plugin policy.
 * @param retry - the 1-based retry number being scheduled.
 * @param random - random sample in the inclusive zero-to-one range used for jitter.
 * @returns the wait in milliseconds, never above the timer bound.
 */
export function delayForRetry(
  schedule: ResolvedRetrySchedule,
  retry: number,
  random: () => number,
): number {
  let tier = schedule.tiers[0]!
  for (const candidate of schedule.tiers) {
    if (retry < candidate.fromRetry) break
    tier = candidate
  }
  const jitter = 1 - schedule.jitterRatio + 2 * schedule.jitterRatio * random()
  return Math.min(tier.delayMs * jitter, MAX_TIMER_DELAY_MS)
}

/**
 * Largest wait the delay table can schedule; a provider-requested delay is
 * honored only up to this bound so one `Retry-After` cannot stall a turn
 * longer than the deployment's own schedule.
 * @param schedule - the resolved plugin policy.
 * @returns the largest tier `delayMs`.
 */
export function maxScheduledDelay(schedule: ResolvedRetrySchedule): number {
  return schedule.tiers.reduce((max, tier) => Math.max(max, tier.delayMs), 0)
}
