/**
 * `dsh-laya-router` — per-turn model routing, reasoning-effort mapping and
 * proactive compaction, decided by a local Laya System One model.
 *
 * Once per user turn (the first step of a turn) the router composes a decision
 * state out of the conversation's **human** messages, asks the local Laya
 * sidecar three `choice` questions (difficulty, time budget, task continuity),
 * and turns the answers into a route, a reasoning effort and a compaction
 * decision. It sees no assistant output and no tool results, and it never asks
 * Laya about quota or provider health — those belong to the policy table.
 *
 * Modes:
 * - `off`    — do nothing at all.
 * - `shadow` — decide, record, change nothing (the default; use it to calibrate).
 * - `live`   — apply the route and effort, record the selection durably so the
 *              UI selector shows the route that is actually in force, and
 *              compact when the rule fires.
 *
 * The mode can be changed at runtime with `/route shadow|live|off`, which
 * persists over the configured mode until `/route reset`.
 *
 * Registered at profile level; `dsh-scope` admits ancestor listeners into
 * descendant-scoped events, so `agent/pre-step` and `agent/request` arrive
 * without touching an agent preset.
 *
 * @module dsh-laya-router
 */

import { appendFile, readFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import {
  boundContextSummary,
  createUserMessage,
  type LlmCallConfig,
  type ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_POLICY,
  QUESTIONS,
  mergePolicy,
  pickEffort,
  pickRoute,
  readJudgement,
  shouldCompact,
  type ChoiceAnswer,
  type PolicyOverride,
  type Route,
} from './policy.ts'
import { formatSummary, summarize } from './stats.ts'
import { composeState, isHumanMessage, textOf, type MessageLike } from './state.ts'

export const name = 'laya-router'

/** Agent events arrive through the agent registry, so it activates first. */
export const inject = ['agents']

/** How the router behaves with what it decides. */
export type Mode = 'off' | 'shadow' | 'live'

/** Plugin configuration; every field is optional. */
export interface Config {
  /** Behaviour mode before any `/route` override; defaults to `shadow`. */
  mode?: Mode
  /** Language hint for every Laya call; defaults to `zh`. */
  lang?: string
  /** JSONL decision log; `null` disables it, omitted uses `$DSH_HOME/laya-router.jsonl`. */
  logFile?: string | null
  /** `/route` override store; `null` disables persistence, omitted uses `$DSH_HOME/laya-router-state.json`. */
  stateFile?: string | null
  /** Policy overrides merged over the shipped defaults. */
  policy?: PolicyOverride
}

/** The slice of `ctx.laya` this plugin consumes. */
interface LayaService {
  ask(body: {
    state: string
    questions: unknown
    lang?: string
    strict?: boolean
  }, options?: unknown): Promise<LayaResponse>
}

/** The sidecar's answer payload, as `ctx.laya.ask` returns it unshaped. */
interface LayaResponse {
  answers?: Record<string, ChoiceAnswer | undefined>
  model?: string
  latency_ms?: number
  warnings?: readonly string[]
}

/** The slice of `ctx.compaction` this plugin consumes. */
interface CompactionService {
  compactIfNeeded(agent: unknown, trigger: string, signal?: AbortSignal): Promise<unknown>
}

/** The slice of `ctx.tokenMeter` this plugin consumes. */
interface TokenMeterService {
  measure(session: unknown, header?: unknown): { totalTokens?: number; surfaceTokens?: number }
}

/** The slice of `ctx.llm` this plugin consumes. */
interface LlmService {
  resolveModelInfo?(provider: string, model: string): { context?: { contextWindow?: number } } | undefined
}

/** The slice of a Session this plugin reads. */
interface SessionLike {
  deriveMessages?(): MessageLike[]
  requestHeader?(): unknown
}

/** One decision, appended to the JSONL log whether or not it was applied. */
interface DecisionRecord {
  readonly time: string
  readonly mode: Mode
  readonly state: { messages: number; kept: number; elided: number; estimatedTokens: number }
  readonly judgement: Record<string, unknown>
  readonly route: { key: string; provider: string; model: string; basis: string } | null
  readonly effort?: string
  /** Written after the compaction attempt, so it is the one mutable field. */
  compaction: { decided: boolean; occupancy?: number; applied?: boolean; error?: string }
  readonly response: { model?: string; latencyMs?: number; warnings?: readonly string[] }
}

/** A decision waiting to be applied by this turn's first request. */
interface PendingRoute {
  readonly route: Route
  readonly effort?: string
}

/** The user-role notice this plugin appends when it reroutes a turn. */
type NoticeMessage = ReturnType<typeof createUserMessage>

/** Resolve the default decision log inside the active Harness home. */
function dshHome(): string {
  return process.env['DSH_HOME']?.trim() || join(homedir(), '.dsh')
}

/** Write one line to the decision log; failures never break a turn. */
async function recordDecision(file: string | null, record: DecisionRecord): Promise<void> {
  if (file === null) return
  try {
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // A decision log that cannot be written is a diagnostic loss, not a turn failure.
  }
}

/** Read the `/route` override, ignoring a missing or malformed file. */
function readModeOverride(file: string | null): Mode | undefined {
  if (file === null) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { mode?: unknown }
    return parsed.mode === 'off' || parsed.mode === 'shadow' || parsed.mode === 'live'
      ? parsed.mode
      : undefined
  } catch {
    return undefined
  }
}

/** Persist or clear the `/route` override. */
function writeModeOverride(file: string | null, mode: Mode | undefined): void {
  if (file === null) return
  try {
    writeFileSync(file, `${JSON.stringify({ mode: mode ?? null }, null, 2)}\n`, 'utf8')
  } catch {
    // Losing the override only means the configured mode applies again after a restart.
  }
}

/**
 * Announce a startup fact on the service log as well as the Harness log.
 * A plugin that silently fails to mount a command or a channel is otherwise
 * indistinguishable from one that works, and the service log is where an
 * operator looks first.
 */
function announce(message: string): void {
  console.log(`[laya-router] ${message}`)
}

/** Log through the Cordis logger when present, falling back to the process log. */
function log(ctx: Context, level: 'info' | 'warn', message: string): void {
  const logger = (ctx as unknown as { logger?: Record<string, unknown> }).logger
  const sink = logger?.[level]
  if (typeof sink === 'function') {
    ;(sink as (text: string) => void).call(logger, message)
    return
  }
  if (level === 'warn') console.warn(`[laya-router] ${message}`)
  else console.log(`[laya-router] ${message}`)
}

/** Context occupancy in the zero-to-one range, when both services can supply it. */
function occupancyOf(ctx: Context, session: unknown, header: unknown): number | undefined {
  try {
    const meter = ctx.get('tokenMeter') as TokenMeterService | undefined
    const llm = ctx.get('llm') as LlmService | undefined
    if (meter === undefined || typeof llm?.resolveModelInfo !== 'function') return undefined
    const config = (header as { config?: { provider?: string; model?: string } } | undefined)?.config
    if (config?.provider === undefined || config?.model === undefined) return undefined
    const info = llm.resolveModelInfo(config.provider, config.model)
    const window = info?.context?.contextWindow
    if (typeof window !== 'number' || window <= 0) return undefined
    const measured = meter.measure(session, header)
    const used = measured?.totalTokens ?? measured?.surfaceTokens
    if (typeof used !== 'number') return undefined
    return used / window
  } catch {
    return undefined
  }
}

/** Collect the human message texts of this conversation plus this turn's claim. */
function humanMessages(session: SessionLike | undefined, claimed: unknown): string[] {
  const history: string[] = []
  try {
    if (typeof session?.deriveMessages === 'function') {
      for (const message of session.deriveMessages()) {
        if (isHumanMessage(message)) history.push(textOf(message))
      }
    }
  } catch {
    // A session that cannot be derived leaves the claim as the whole state.
  }
  const current: string[] = []
  if (Array.isArray(claimed)) {
    for (const message of claimed as MessageLike[]) {
      if (isHumanMessage(message)) current.push(textOf(message))
    }
  }
  // The claim is normally not yet committed; drop a duplicate if a caller did commit it.
  if (current.length > 0 && history.length > 0 && history[history.length - 1] === current[0]) {
    history.pop()
  }
  return [...history, ...current]
}

/** The model-change notice this plugin owes the log when it reroutes a turn. */
function routeNotice(route: Route, effort: string | undefined): NoticeMessage {
  const label = `${route.provider}/${route.model}`
  return createUserMessage({
    content: [{
      type: 'text' as const,
      text: `[model routed: this turn continues on ${label}${effort === undefined ? '' : ` (reasoning ${effort})`}]`,
    }],
    source: {
      kind: 'plugin' as const,
      plugin: 'laya-router',
      form: 'notice' as const,
      summary: boundContextSummary(label),
    },
  })
}

/**
 * Apply the router to one profile context.
 *
 * @param ctx - Profile-level context; agent-scoped events reach it as an ancestor listener.
 * @param config - Optional configuration from the profile patch.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const lang = config.lang ?? 'zh'
  const logFile = config.logFile === null ? null : (config.logFile ?? join(dshHome(), 'laya-router.jsonl'))
  const stateFile = config.stateFile === null ? null : (config.stateFile ?? join(dshHome(), 'laya-router-state.json'))
  const policy = mergePolicy(DEFAULT_POLICY, config.policy)
  const configuredMode: Mode = config.mode ?? 'shadow'
  let mode: Mode = readModeOverride(stateFile) ?? configuredMode

  /** This turn's decision, handed from pre-step to the first request. */
  const pending = new WeakMap<object, PendingRoute>()

  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (mode === 'off' || decision.kind !== 'enter') return decision
    if (payload.step !== 1) return decision

    let notice: NoticeMessage | undefined
    try {
      notice = await decide(ctx, {
        agent: payload.agent,
        messages: payload.messages,
        signal: payload.signal,
        policy,
        mode,
        lang,
        logFile,
        pending,
      })
    } catch (error) {
      log(ctx, 'warn', `decision failed: ${String(error)}`)
    }
    if (notice === undefined) return decision
    return { ...decision, messages: [...decision.messages, notice] }
  })

  ctx.on(
    'agent/request',
    async (payload, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      if (mode !== 'live' || payload.step !== 1) return resolved
      const chosen = pending.get(payload.agent)
      if (chosen === undefined) return resolved
      pending.delete(payload.agent)
      // An explicit effort persists into later steps through the request header,
      // so an unset effort is cleared rather than merely omitted.
      const { reasoningEffort: _inherited, ...rest } = resolved
      return {
        ...rest,
        provider: chosen.route.provider,
        model: chosen.route.model,
        ...chosen.effort === undefined
          ? {}
          : { reasoningEffort: chosen.effort as ReasoningEffortId },
      }
    },
    { prepend: true },
  )

  /** Register `/route` when this profile composes the commands registry. */
  ctx.inject(['commands'], scope => {
    scope.effect(() => scope.commands.register({
      definitionId: CommandDefinitionId('dsh-laya-router/route'),
      name: 'route',
      description: 'Show or change the Laya model-router mode: status | shadow | live | off | stats | reset',
      handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
        const argument = invocation.rawInput.trim().toLowerCase()
        if (argument === '' || argument === 'status') {
          const last = await lastDecision(logFile)
          return {
            kind: 'success',
            text: [
              `laya-router mode=${mode}（配置默认 ${configuredMode}${stateFile === null ? '，覆盖不持久化' : ''}）`,
              `决策日志 ${logFile ?? '（已关闭）'}`,
              last === undefined ? '还没有任何决策记录。' : `最近一次：${last}`,
            ].join('\n'),
          }
        }
        if (argument === 'off' || argument === 'shadow' || argument === 'live') {
          mode = argument
          writeModeOverride(stateFile, argument)
          return { kind: 'success', text: `laya-router 已切到 ${argument}（重启后仍生效；/route reset 恢复配置默认）` }
        }
        if (argument === 'reset') {
          mode = configuredMode
          writeModeOverride(stateFile, undefined)
          return { kind: 'success', text: `laya-router 已恢复配置默认：${configuredMode}` }
        }
        if (argument === 'stats' || argument.startsWith('stats ')) {
          const requested = Number.parseInt(argument.slice('stats'.length).trim(), 10)
          const limit = Number.isFinite(requested) && requested > 0 ? requested : 50
          const lines = await readLog(logFile)
          if (lines === undefined) return { kind: 'success', text: '还没有决策日志可统计。' }
          return { kind: 'success', text: formatSummary(summarize(lines, limit), mode) }
        }
        return { kind: 'error', text: '用法：/route [status | shadow | live | off | stats [n] | reset]' }
      },
    }), 'laya-router /route command')
    announce('/route registered (status | shadow | live | off | stats | reset)')
  })

  announce(`ready (mode=${mode}, lang=${lang}, routes=${Object.keys(policy.routes).join('/')})`)
}

/** Read the decision log as text, or `undefined` when there is none. */
async function readLog(file: string | null): Promise<string | undefined> {
  if (file === null) return undefined
  try {
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Render the newest decision as one line for `/route status`. */
async function lastDecision(file: string | null): Promise<string | undefined> {
  const text = await readLog(file)
  if (text === undefined) return undefined
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  const newest = lines[lines.length - 1]
  if (newest === undefined) return undefined
  try {
    const record = JSON.parse(newest) as DecisionRecord
    const route = record.route === null
      ? '不改动'
      : `${record.route.key}（${record.route.provider}/${record.route.model}，${record.route.basis}）`
    const effort = record.effort === undefined ? '' : ` effort=${record.effort}`
    const latency = record.response.latencyMs === undefined ? '' : ` ${record.response.latencyMs.toFixed(0)}ms`
    const compaction = record.compaction.decided
      ? ` 压缩=${record.compaction.applied === true ? '已执行' : '未执行'}`
      : ''
    return `${record.time} mode=${record.mode} → ${route}${effort}${latency}${compaction}`
  } catch {
    return newest.slice(0, 200)
  }
}

/** Options carried from the pre-step listener into {@link decide}. */
interface DecideOptions {
  readonly agent: { session?: SessionLike }
  readonly messages: unknown
  readonly signal?: AbortSignal
  readonly policy: ReturnType<typeof mergePolicy>
  readonly mode: Mode
  readonly lang: string
  readonly logFile: string | null
  readonly pending: WeakMap<object, PendingRoute>
}

/**
 * Ask Laya, record the decision, and — in live mode — compact, publish the
 * selection and remember the route for this turn's first request.
 *
 * @returns The model-visible notice to append, or `undefined` when none is owed.
 */
async function decide(ctx: Context, options: DecideOptions): Promise<NoticeMessage | undefined> {
  const { agent, messages, signal, policy, mode, lang, logFile, pending } = options
  const session = agent.session
  const composed = composeState(humanMessages(session, messages), policy.stateBudgetTokens)
  const header = session?.requestHeader?.()
  const occupancy = occupancyOf(ctx, session, header)

  const laya = ctx.get('laya') as LayaService | undefined
  const base = {
    time: new Date().toISOString(),
    mode,
    state: {
      messages: composed.kept + composed.elided,
      kept: composed.kept,
      elided: composed.elided,
      estimatedTokens: composed.estimatedTokens,
    },
  }

  if (composed.state.length === 0) {
    await recordDecision(logFile, {
      ...base,
      judgement: {},
      route: null,
      compaction: { decided: false, ...occupancy === undefined ? {} : { occupancy } },
      response: {},
    })
    return undefined
  }
  if (laya === undefined) {
    await recordDecision(logFile, {
      ...base,
      judgement: {},
      route: null,
      compaction: { decided: false, ...occupancy === undefined ? {} : { occupancy } },
      response: { warnings: ['ctx.laya is not registered (dsh-laya missing or not active)'] },
    })
    log(ctx, 'warn', 'no ctx.laya service; this turn is not routed')
    return undefined
  }

  const response = await laya.ask({ state: composed.state, questions: QUESTIONS, lang, strict: false })
  const judgement = readJudgement(response.answers ?? {}, policy.confidenceFloor)
  const choice = pickRoute(judgement, policy)
  const effort = choice === null ? undefined : pickEffort(choice.key, judgement, policy)
  const compact = shouldCompact(judgement, occupancy, policy)

  const record: DecisionRecord = {
    ...base,
    judgement: {
      difficulty: judgement.difficulty,
      budget: judgement.budget,
      continuity: judgement.continuity,
      newTaskProbability: judgement.newTaskProbability,
      confidence: judgement.confidence,
    },
    route: choice === null
      ? null
      : { key: choice.key, provider: choice.route.provider, model: choice.route.model, basis: choice.basis },
    ...effort === undefined ? {} : { effort },
    compaction: { decided: compact, ...occupancy === undefined ? {} : { occupancy } },
    response: {
      ...response.model === undefined ? {} : { model: response.model },
      ...response.latency_ms === undefined ? {} : { latencyMs: response.latency_ms },
      ...response.warnings === undefined ? {} : { warnings: response.warnings },
    },
  }

  if (mode !== 'live') {
    await recordDecision(logFile, record)
    return undefined
  }

  if (compact) {
    const compaction = ctx.get('compaction') as CompactionService | undefined
    if (compaction === undefined) {
      record.compaction = { ...record.compaction, applied: false, error: 'ctx.compaction unavailable' }
    } else {
      try {
        await compaction.compactIfNeeded(agent, 'context-overflow', signal)
        record.compaction = { ...record.compaction, applied: true }
      } catch (error) {
        record.compaction = { ...record.compaction, applied: false, error: String(error) }
      }
    }
  }

  await recordDecision(logFile, record)

  if (choice === null) return undefined
  const previous = (header as { config?: { provider?: string; model?: string } } | undefined)?.config
  const unchanged = previous?.provider === choice.route.provider && previous?.model === choice.route.model
  // Publish the selection so the UI's model selector names the route in force;
  // `model/selection` is a built-in event every build already knows.
  try {
    const append = (session as { append?: (type: string, data: unknown) => unknown } | undefined)?.append
    append?.call(session, 'model/selection', {
      provider: choice.route.provider,
      model: choice.route.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    })
  } catch (error) {
    log(ctx, 'warn', `model/selection was not recorded: ${String(error)}`)
  }
  if (unchanged) return undefined
  pending.set(agent, { route: choice.route, ...effort === undefined ? {} : { effort } })
  return routeNotice(choice.route, effort)
}
