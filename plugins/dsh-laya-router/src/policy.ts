/**
 * The routing policy: what Laya is asked, and how its answers become a route,
 * an effort and a compaction decision.
 *
 * Laya answers task *properties*, never a model name: it has no view of quota,
 * provider health or cost, so those stay with the plugin. Two upstream facts
 * are encoded here: every question is a `choice` with explicit `criteria`
 * (a bare `noul` answers its first option regardless of the state — measured
 * 40/40 upstream), and an answer below the confidence floor is treated as
 * "the text did not say" rather than as a weak signal.
 *
 * @module dsh-laya-router/policy
 */

/** How hard the newest user message looks. */
export type Difficulty = 'easy' | 'medium' | 'hard'
/** How long the user can wait for it. */
export type Budget = 'immediate' | 'minutes' | 'can_wait'
/** Whether the newest message continues the task or starts another one. */
export type Continuity = 'continues' | 'new_task'

/** One provider route, as `request/header` records it. */
export interface Route {
  /** Registered provider route id (for example `deepseek-official`, `md`). */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
}

/** One ordered routing rule; the first match wins. */
export interface RouteRule {
  /** Required difficulty, or any. */
  readonly difficulty?: Difficulty
  /** Required budget, or any. */
  readonly budget?: Budget
  /** Route key in {@link PolicyConfig.routes}. */
  readonly route: string
}

/** Everything the policy needs that a profile can change. */
export interface PolicyConfig {
  /** Below this confidence an answer counts as absent. */
  readonly confidenceFloor: number
  /** Route key to provider/model. */
  readonly routes: Record<string, Route>
  /** Ordered rules; first match wins. */
  readonly table: readonly RouteRule[]
  /** Route applied when the text said nothing at all; `null` changes nothing. */
  readonly unlabeledRoute: string | null
  /** Effort mapping: only routes listed in `effortRoutes` ever receive one. */
  readonly effort: {
    readonly byDifficulty: Record<Difficulty, string>
    readonly effortRoutes: readonly string[]
  }
  /** When to compact proactively. */
  readonly compaction: {
    readonly enabled: boolean
    /** P(new_task) above this is a task switch. */
    readonly newTaskProbability: number
    /** Context occupancy above this makes compaction worth doing. */
    readonly minOccupancy: number
  }
  /** Rough token budget for the composed decision state. */
  readonly stateBudgetTokens: number
}

/** The shipped defaults; a profile may override any of them. */
export const DEFAULT_POLICY: PolicyConfig = {
  confidenceFloor: 0.5,
  routes: {
    official: { provider: 'deepseek-official', model: 'deepseek-flash' },
    md: { provider: 'md', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
    deepseek: { provider: 'sensenova', model: 'deepseek-v4.1-flash' },
    lite: { provider: 'sensenova', model: 'sensenova-6.8-flash-lite' },
  },
  table: [
    { difficulty: 'hard', budget: 'immediate', route: 'official' },
    { budget: 'immediate', route: 'official' },
    { difficulty: 'hard', budget: 'can_wait', route: 'md' },
    { budget: 'can_wait', route: 'lite' },
    { budget: 'minutes', route: 'deepseek' },
  ],
  unlabeledRoute: 'md',
  effort: {
    byDifficulty: { hard: 'high', medium: 'medium', easy: 'low' },
    effortRoutes: ['deepseek', 'lite'],
  },
  compaction: { enabled: true, newTaskProbability: 0.65, minOccupancy: 0.4 },
  stateBudgetTokens: 700,
}

/** One answered question, as the sidecar returns it. */
export interface ChoiceAnswer {
  /** Chosen option, when the checkpoint answered at all. */
  readonly choice?: string
  /** Distribution concentration — not accuracy. */
  readonly confidence?: number
  /** Per-option probabilities, when reported. */
  readonly probabilities?: Record<string, number>
}

/** The three judgements this plugin asks for, each absent when unsaid. */
export interface Judgement {
  readonly difficulty?: Difficulty
  readonly budget?: Budget
  readonly continuity?: Continuity
  /** P(new_task); absent when the continuity answer did not clear the floor. */
  readonly newTaskProbability?: number
  /** Confidence per answered question, for the decision record. */
  readonly confidence: Record<string, number | undefined>
}

/** The four questions, in the exact wire shape the sidecar expects. */
export const QUESTIONS = {
  difficulty: {
    type: 'choice' as const,
    instructions: '把编号最大的那条消息交给一个编码 agent 执行，难度属于哪一档？',
    criteria: {
      easy: '一句话能答完的问答，或明确的单点小改动',
      medium: '需要多步操作、要读几处代码，但不需要设计',
      hard: '需要跨文件、跨系统设计与实现，或存在多种方案要权衡',
    },
  },
  budget: {
    type: 'choice' as const,
    instructions: '编号最大的那条消息对响应速度的要求是什么？只能依据消息本身判断，消息没说就选不出。',
    criteria: {
      immediate: '用户正在等结果，必须马上出（例如说「现在」「马上」「卡住了」）',
      minutes: '几分钟内可以接受，但不打算等很久',
      can_wait: '不赶时间，可以一直等、后台慢慢跑，甚至跨天',
    },
  },
  continuity: {
    type: 'choice' as const,
    instructions: '编号最大的那条消息，是在延续编号更小的那些消息所描述的任务，还是一个与它们无关的全新任务？',
    criteria: {
      continues: '仍在同一个任务线上推进或追问',
      new_task: '与前文无关，或明显换了一件要做的事',
    },
  },
} as const

function readChoice(
  answer: ChoiceAnswer | undefined,
  floor: number,
): { value: string; confidence: number; probabilities: Record<string, number> } | undefined {
  if (answer === undefined || typeof answer.choice !== 'string') return undefined
  const confidence = typeof answer.confidence === 'number' ? answer.confidence : 0
  const probabilities = answer.probabilities ?? {}
  if (confidence < floor) return { value: answer.choice, confidence, probabilities }
  return { value: answer.choice, confidence, probabilities }
}

/**
 * Read the sidecar's answers into judgements, keeping below-floor answers as
 * "unsaid" (their confidence is still recorded so the shadow log can show it).
 *
 * @param answers - `answers` object from the sidecar response.
 * @param floor - Confidence below which an answer counts as absent.
 * @returns The judgements, with per-question confidence.
 */
export function readJudgement(
  answers: Record<string, ChoiceAnswer | undefined>,
  floor: number,
): Judgement {
  const difficulty = readChoice(answers.difficulty, floor)
  const budget = readChoice(answers.budget, floor)
  const continuity = readChoice(answers.continuity, floor)
  const accept = <T extends string>(reading: ReturnType<typeof readChoice>, allowed: readonly T[]): T | undefined => {
    if (reading === undefined || reading.confidence < floor) return undefined
    return (allowed as readonly string[]).includes(reading.value) ? (reading.value as T) : undefined
  }
  const continuityValue = accept<Continuity>(continuity, ['continues', 'new_task'])
  // P(new_task) is only trustworthy when the answer it came from cleared the
  // floor: an unsure continuity answer must not be able to trigger compaction.
  const newTaskProbability = continuityValue === undefined
    ? undefined
    : continuity?.probabilities?.new_task
  return {
    difficulty: accept<Difficulty>(difficulty, ['easy', 'medium', 'hard']),
    budget: accept<Budget>(budget, ['immediate', 'minutes', 'can_wait']),
    continuity: continuityValue,
    ...newTaskProbability === undefined ? {} : { newTaskProbability },
    confidence: {
      difficulty: difficulty?.confidence,
      budget: budget?.confidence,
      continuity: continuity?.confidence,
    },
  }
}

/** One chosen route plus why it was chosen. */
export interface RouteChoice {
  /** Route key. */
  readonly key: string
  /** Provider and model. */
  readonly route: Route
  /** `laya` when a rule matched a judgeable answer, `unlabeled` otherwise. */
  readonly basis: 'laya' | 'unlabeled'
}

/**
 * Pick a route from the ordered table, falling back to the configured
 * unlabeled route when the text said nothing the table could match.
 *
 * @param judgement - Answers that cleared the confidence floor.
 * @param policy - Effective policy.
 * @returns The chosen route, or `null` when nothing should change.
 */
export function pickRoute(judgement: Judgement, policy: PolicyConfig): RouteChoice | null {
  for (const rule of policy.table) {
    if (rule.difficulty !== undefined && rule.difficulty !== judgement.difficulty) continue
    if (rule.budget !== undefined && rule.budget !== judgement.budget) continue
    if (rule.difficulty === undefined && rule.budget === undefined) continue
    const route = policy.routes[rule.route]
    if (route === undefined) continue
    return { key: rule.route, route, basis: 'laya' }
  }
  if (policy.unlabeledRoute === null) return null
  const fallback = policy.routes[policy.unlabeledRoute]
  if (fallback === undefined) return null
  return { key: policy.unlabeledRoute, route: fallback, basis: 'unlabeled' }
}

/**
 * Map difficulty to an effort the target provider actually accepts. Routes not
 * listed in `effortRoutes` get `undefined`, which the caller turns into an
 * explicit clear — sending an unsupported level is a loud request failure.
 *
 * @param routeKey - Chosen route key.
 * @param judgement - Answers that cleared the confidence floor.
 * @param policy - Effective policy.
 * @returns The effort id, or `undefined` to clear any inherited one.
 */
export function pickEffort(
  routeKey: string,
  judgement: Judgement,
  policy: PolicyConfig,
): string | undefined {
  if (!policy.effort.effortRoutes.includes(routeKey)) return undefined
  if (judgement.difficulty === undefined) return undefined
  return policy.effort.byDifficulty[judgement.difficulty]
}

/**
 * Decide whether to compact before this turn: the newest message starts
 * another task, and the context is long enough that compacting is worth it.
 *
 * @param judgement - Answers that cleared the confidence floor.
 * @param occupancy - Context occupancy in the zero-to-one range, when known.
 * @param policy - Effective policy.
 * @returns True when the caller should compact now.
 */
export function shouldCompact(
  judgement: Judgement,
  occupancy: number | undefined,
  policy: PolicyConfig,
): boolean {
  if (!policy.compaction.enabled) return false
  if (judgement.newTaskProbability === undefined) return false
  if (judgement.newTaskProbability <= policy.compaction.newTaskProbability) return false
  if (occupancy === undefined) return false
  return occupancy > policy.compaction.minOccupancy
}

/** Deep-partial override shape a profile may supply. */
export interface PolicyOverride {
  readonly confidenceFloor?: number
  readonly routes?: Record<string, Route>
  readonly table?: readonly RouteRule[]
  readonly unlabeledRoute?: string | null
  readonly effort?: Partial<PolicyConfig['effort']>
  readonly compaction?: Partial<PolicyConfig['compaction']>
  readonly stateBudgetTokens?: number
}

/**
 * Merge a profile override over the shipped defaults, field by field.
 *
 * @param base - Shipped defaults.
 * @param override - Profile override, when present.
 * @returns The effective policy.
 */
export function mergePolicy(base: PolicyConfig, override?: PolicyOverride): PolicyConfig {
  if (override === undefined) return base
  return {
    confidenceFloor: override.confidenceFloor ?? base.confidenceFloor,
    routes: { ...base.routes, ...override.routes },
    table: override.table ?? base.table,
    unlabeledRoute: override.unlabeledRoute === undefined ? base.unlabeledRoute : override.unlabeledRoute,
    effort: {
      byDifficulty: { ...base.effort.byDifficulty, ...override.effort?.byDifficulty },
      effortRoutes: override.effort?.effortRoutes ?? base.effort.effortRoutes,
    },
    compaction: { ...base.compaction, ...override.compaction },
    stateBudgetTokens: override.stateBudgetTokens ?? base.stateBudgetTokens,
  }
}
