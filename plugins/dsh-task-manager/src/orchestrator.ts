/**
 * dsh-task-manager — taskManager host service (M1).
 *
 * The orchestration brain: assigns tasks to category captains, receives the
 * restricted captain reports, nudges, and reads/writes the captain registry.
 *
 * Call surface follows the M0 conclusions (docs/plans/manager-task-orchestration.md
 * 「## M0 结论」) and the path-A decision (ADR-0003):
 * - Create branch: `ctx.subagents.startContinuable({ provider: 'spawn', label:
 *   `队长·<category>`, childId, request: { prompt, parent: managerAgent, signal,
 *   persona, toolFilter }, signal })` — the 类别章程+任务简报 rides the per-child
 *   persona, and the captain face drops the five management tools via a
 *   deny-list (ToolRestriction semantics verified in dsh-tools:
 *   visible = (allow missing || allow.has(name)) && (deny missing || !deny.has(name))).
 * - Reuse branch: live captain → `Agent.followup(input)` (wakeup); absent
 *   captain → `ctx.subagents.followup(managerAgent, sessionId, content,
 *   { source, signal })` cold-resume, which requires the exact live direct
 *   parent (the Manager agent) — naturally satisfied by the v1 巡检制.
 *
 * Identity enforcement (ADR-0003 mandatory line): report() rejects any
 * sessionId that is not the dispatched task's captainSessionId. The GUI's
 * human manual supplement bypasses identity on purpose (ADR-0001: the human
 * owns the list) via applyReportHuman().
 */
import { randomUUID } from 'node:crypto'
import {
  STATUSES,
  type CaptainRecord,
  OrchestratorError,
  type Status,
  type TaskRecord,
  applyReportToTask,
  buildCharterPersona,
  buildDispatchBrief,
  buildNudgeText,
  createOutboundMessage,
} from './records.ts'
import { CaptainStore, TaskStore, summarizeCaptains } from './stores.ts'

/** Service key published on the host context (consumed by M2 tools via ctx.get). */
export const TASK_MANAGER_SERVICE = 'taskManager'

/**
 * The five management tools (管理模式面, 定案补记 toolFilter 配置表). Denied on
 * the captain face so the captain keeps task_claim/task_report + work tools.
 * NOTE: these names must be registered by the M2 tool rows before real
 * captain creation — tools.restrict() validates names loudly.
 */
export const MANAGEMENT_TOOL_NAMES = ['task_assign', 'task_create', 'task_set_status', 'task_list', 'task_nudge'] as const

/** The per-child toolFilter expressing the captain face (排除全部管理工具). */
export const CAPTAIN_TOOL_FILTER = Object.freeze({
  deny: Object.freeze([...MANAGEMENT_TOOL_NAMES]),
})

/** Text content block (dsh-llm TextBlock shape). */
export interface TextBlockLike {
  type: 'text'
  text: string
}

/** Structural slice of the live Agent the delivery primitives need. */
export interface AgentLike {
  /** Wakeup delivery: queued as the next normal turn and driven (M0 结论 2). */
  followup(message: unknown): void
  /** Non-waking delivery: joins the next pre-step batch. */
  inject(message: unknown): void
}

/** Structural slice of the live-agent registry service. */
export interface AgentsRegistryLike {
  get(sessionId: string): AgentLike | undefined
}

/** Structural slice of the SubagentRuntime service (M0 结论 1/2 call surface). */
export interface SubagentsLike {
  startContinuable(spec: {
    provider: string
    label: string
    childId: string
    request: {
      prompt: TextBlockLike[]
      parent: AgentLike
      signal: AbortSignal
      persona?: string
      toolFilter?: { deny?: readonly string[]; allow?: readonly string[] }
    }
    signal: AbortSignal
  }): Promise<{ childId: string; messageId: string }>
  followup(
    parent: AgentLike,
    childId: string,
    content: TextBlockLike[],
    options: { source: { kind: 'plugin'; plugin: string }; signal: AbortSignal },
  ): Promise<string>
}

/** Resolved runtime services; every piece is optional (headless/GUI-only profiles). */
export interface OrchestratorRuntime {
  subagents?: SubagentsLike
  agents?: AgentsRegistryLike
}

/** Dependencies of the taskManager service. */
export interface TaskManagerDeps {
  store: TaskStore
  captains: CaptainStore
  /** Lazy runtime resolution — re-read on every operation so late-mounting services appear. */
  resolveRuntime: () => OrchestratorRuntime
  /** Testable clock. */
  now?: () => number
}

/** The taskManager service surface (consumed by M2 tools, HTTP routes, tests). */
export interface TaskManagerService {
  /**
   * 派发：把任务交给某类别的队长。
   * - 新类别/无会话：经 startContinuable 创建队长子会话（persona=章程+简报，
   *   toolFilter=排除管理工具），需要 options.managerSessionId。
   * - 已有会话：复用同一 sessionId 投递任务简报（dispatchRound+1）。
   * charter 仅在创建分支生效（persona 建会话时定型，ADR-0003）。
   */
  assign(
    taskId: string,
    category: string,
    options?: { charter?: string; managerSessionId?: string },
  ): Promise<{
    taskId: string
    category: string
    captainSessionId: string
    dispatchRound: number
    created: boolean
    charter: string
  }>
  /**
   * 队长受限回报（身份校验线，ADR-0003）：sessionId 必须等于该任务的
   * captainSessionId；needsFinalReview 单的 done 回报钳制为 waiting-check。
   */
  report(
    sessionId: string,
    taskId: string,
    status: Status,
    text: string,
    evidence?: string[],
  ): Promise<TaskRecord>
  /** 人类 GUI 手动补录（无身份语义，ADR-0001 人类全权写）。 */
  applyReportHuman(
    taskId: string,
    report: { status: Status; text: string; evidence?: string[] },
  ): Promise<TaskRecord>
  /** 队长只读自身被派发的任务。 */
  listMine(sessionId: string): Promise<TaskRecord[]>
  /** 催办：向队长会话投递催办文本并打 lastNudgeAt。 */
  nudge(taskId: string, options?: { managerSessionId?: string }): Promise<{ taskId: string; lastNudgeAt: number }>
  /** 注册表快照（含类别任务计数）。 */
  captains(): Promise<Array<CaptainRecord & { category: string; taskCount: number }>>
  /** 章程编辑（upsert：可先于首次派发预写章程）。 */
  setCharter(category: string, charter: string): Promise<CaptainRecord & { category: string }>
}

/** Create the taskManager service. Pure dependency injection, no cordis types. */
export function createTaskManager(deps: TaskManagerDeps): TaskManagerService {
  const now = deps.now ?? Date.now
  // One exclusive chain per category: concurrent assigns to the same new
  // category must not double-create the captain session.
  const chains = new Map<string, Promise<unknown>>()

  const runExclusive = <R>(key: string, fn: () => Promise<R>): Promise<R> => {
    const prev = chains.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    chains.set(key, run.catch(() => undefined))
    return run
  }

  const assertStatus = (status: string): Status => {
    if (!(STATUSES as readonly string[]).includes(status)) {
      throw new OrchestratorError('INVALID_STATUS', `status must be one of ${STATUSES.join(', ')}`)
    }
    return status as Status
  }

  /**
   * Deliver text to a captain session: live → Agent.followup (wakeup);
   * absent → subagents.followup cold-resume (needs the live manager parent).
   */
  const deliverToCaptain = async (
    sessionId: string,
    text: string,
    managerSessionId: string | undefined,
  ): Promise<'live' | 'cold'> => {
    const { agents, subagents } = deps.resolveRuntime()
    const agent = agents?.get(sessionId)
    if (agent !== undefined) {
      // Hot path (M0 结论 2): wakeup delivery, no parent requirement.
      agent.followup(createOutboundMessage(text))
      return 'live'
    }
    // Cold path: subagents.followup needs the exact live direct parent (Manager).
    if (subagents !== undefined && managerSessionId !== undefined) {
      const managerAgent = resolveManagerAgent(managerSessionId)
      await subagents.followup(managerAgent, sessionId, [{ type: 'text', text }], {
        source: { kind: 'plugin', plugin: 'dsh-task-manager' },
        signal: new AbortController().signal,
      })
      return 'cold'
    }
    throw new OrchestratorError(
      'DELIVERY_UNAVAILABLE',
      `captain session ${sessionId} is not live and no manager session is available for cold-resume delivery`,
    )
  }

  const resolveManagerAgent = (managerSessionId: string | undefined): AgentLike => {
    const { agents } = deps.resolveRuntime()
    const agent = managerSessionId === undefined ? undefined : agents?.get(managerSessionId)
    if (agent === undefined) {
      throw new OrchestratorError(
        'MANAGER_AGENT_REQUIRED',
        'creating a captain session requires a live manager session (options.managerSessionId) as the continuable parent',
      )
    }
    return agent
  }

  const service: TaskManagerService = {
    async assign(taskId, category, options = {}) {
      if (typeof category !== 'string' || category.trim() === '') {
        throw new OrchestratorError('INVALID_INPUT', 'category must be a non-empty string')
      }
      const key = category.trim()
      return runExclusive(key, () =>
        runExclusiveAssign(key, taskId, options),
      )
    },

    async report(sessionId, taskId, status, text, evidence) {
      const validStatus = assertStatus(status)
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new OrchestratorError('NOT_CAPTAIN', 'report requires a sessionId')
      }
      if (typeof text !== 'string' || text.trim() === '') {
        throw new OrchestratorError('INVALID_INPUT', 'report text is required')
      }
      return deps.store.mutate((tasks) => {
        const task = tasks.find((item) => item.id === taskId)
        if (task === undefined) throw new OrchestratorError('TASK_NOT_FOUND', `task ${taskId} not found`)
        // Mandatory identity line (ADR-0003): only the dispatched captain reports.
        if (task.captainSessionId === undefined || task.captainSessionId !== sessionId) {
          throw new OrchestratorError(
            'NOT_CAPTAIN',
            `session ${sessionId} is not the captain of task ${taskId} (dispatched to ${task.captainSessionId ?? 'nobody'})`,
          )
        }
        applyReportToTask(task, { status: validStatus, text, evidence, at: now() })
        return task
      })
    },

    async applyReportHuman(taskId, report) {
      const validStatus = assertStatus(report.status)
      if (typeof report.text !== 'string' || report.text.trim() === '') {
        throw new OrchestratorError('INVALID_INPUT', 'report text is required')
      }
      return deps.store.mutate((tasks) => {
        const task = tasks.find((item) => item.id === taskId)
        if (task === undefined) throw new OrchestratorError('TASK_NOT_FOUND', `task ${taskId} not found`)
        applyReportToTask(task, { status: validStatus, text: report.text, evidence: report.evidence, at: now() })
        return task
      })
    },

    async listMine(sessionId) {
      const tasks = await deps.store.load()
      return tasks
        .filter((task) => task.captainSessionId === sessionId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async nudge(taskId, options = {}) {
      const tasks = await deps.store.load()
      const task = tasks.find((item) => item.id === taskId)
      if (task === undefined) throw new OrchestratorError('TASK_NOT_FOUND', `task ${taskId} not found`)
      if (task.category === undefined || task.captainSessionId === undefined) {
        throw new OrchestratorError('NOT_DISPATCHED', `task ${taskId} has not been dispatched to a captain`)
      }
      await deliverToCaptain(task.captainSessionId, buildNudgeText({ task }), options.managerSessionId)
      const lastNudgeAt = now()
      await deps.store.mutate((all) => {
        const target = all.find((item) => item.id === taskId)
        if (target !== undefined) {
          target.lastNudgeAt = lastNudgeAt
          target.updatedAt = lastNudgeAt
        }
      })
      return { taskId, lastNudgeAt }
    },

    async captains() {
      const [registry, tasks] = await Promise.all([deps.captains.load(), deps.store.load()])
      return summarizeCaptains(registry, tasks)
    },

    async setCharter(category, charter) {
      if (typeof category !== 'string' || category.trim() === '') {
        throw new OrchestratorError('INVALID_INPUT', 'category must be a non-empty string')
      }
      if (typeof charter !== 'string') {
        throw new OrchestratorError('INVALID_INPUT', 'charter must be a string')
      }
      return deps.captains.mutate((registry) => {
        const key = category.trim()
        const existing = registry[key]
        const record: CaptainRecord = existing !== undefined
          ? { ...existing, charter }
          : { charter, createdAt: now() }
        registry[key] = record
        return { ...record, category: key }
      })
    },
  }

  /** Serialized per-category assign body (create-or-reuse). */
  async function runExclusiveAssign(
    category: string,
    taskId: string,
    options: { charter?: string; managerSessionId?: string },
  ): Promise<{
    taskId: string
    category: string
    captainSessionId: string
    dispatchRound: number
    created: boolean
    charter: string
  }> {
    const tasks = await deps.store.load()
    const task = tasks.find((item) => item.id === taskId)
    if (task === undefined) throw new OrchestratorError('TASK_NOT_FOUND', `task ${taskId} not found`)

    const registry = await deps.captains.load()
    const entry = registry[category]
    const stamp = now()

    // Reuse branch: same sessionId, brief delivery, dispatchRound+1.
    if (entry?.sessionId !== undefined && entry.sessionId !== '') {
      await deliverToCaptain(entry.sessionId, buildDispatchBrief({ category, task }), options.managerSessionId)
      await deps.captains.mutate((all) => {
        const target = all[category]
        if (target !== undefined) target.lastDispatchAt = stamp
      })
      const updated = await deps.store.mutate((all) => {
        const target = all.find((item) => item.id === taskId)
        if (target === undefined) throw new OrchestratorError('TASK_NOT_FOUND', `task ${taskId} not found`)
        target.category = category
        target.captainSessionId = entry.sessionId
        target.dispatchRound = (target.dispatchRound ?? 0) + 1
        target.status = 'in-progress'
        target.updatedAt = stamp
        return target
      })
      return {
        taskId,
        category,
        captainSessionId: entry.sessionId,
        dispatchRound: updated.dispatchRound,
        created: false,
        charter: entry.charter,
      }
    }

    // Create branch (ADR-0003): persona = charter + brief, toolFilter = deny management tools.
    const managerAgent = resolveManagerAgent(options.managerSessionId)
    const charter = options.charter ?? entry?.charter ?? ''
    const childId = randomUUID()
    // Reserve the child id in the registry first (M0: 先落注册表再建会话); roll back on failure.
    await deps.captains.mutate((all) => {
      all[category] = {
        ...(all[category] ?? {}),
        charter,
        sessionId: childId,
        createdAt: all[category]?.createdAt ?? stamp,
        lastDispatchAt: stamp,
      }
    })
    const { subagents } = deps.resolveRuntime()
    if (subagents === undefined) {
      await rollbackSessionId(category, childId)
      throw new OrchestratorError('DELIVERY_UNAVAILABLE', 'subagents service is unavailable; cannot create a captain session')
    }
    try {
      await subagents.startContinuable({
        provider: 'spawn',
        label: `队长·${category}`,
        childId,
        request: {
          prompt: [{ type: 'text', text: buildCharterPersona({ category, charter, task }) }],
          parent: managerAgent,
          signal: new AbortController().signal,
          persona: buildCharterPersona({ category, charter, task }),
          toolFilter: CAPTAIN_TOOL_FILTER,
        },
        signal: new AbortController().signal,
      })
    } catch (error) {
      await rollbackSessionId(category, childId)
      const message = error instanceof Error ? error.message : String(error)
      throw new OrchestratorError('CREATION_FAILED', `creating captain session for ${category} failed: ${message}`)
    }
    const updated = await deps.store.mutate((all) => {
      const target = all.find((item) => item.id === taskId)
      if (target === undefined) throw new OrchestratorError('TASK_NOT_FOUND', `task ${taskId} not found`)
      target.category = category
      target.captainSessionId = childId
      target.dispatchRound = (target.dispatchRound ?? 0) + 1
      target.status = 'in-progress'
      target.updatedAt = stamp
      return target
    })
    return {
      taskId,
      category,
      captainSessionId: childId,
      dispatchRound: updated.dispatchRound,
      created: true,
      charter,
    }
  }

  /** Clear a reserved sessionId that never materialized (keeps charter + createdAt). */
  async function rollbackSessionId(category: string, childId: string): Promise<void> {
    await deps.captains.mutate((all) => {
      const entry = all[category]
      if (entry?.sessionId === childId) entry.sessionId = undefined
    })
  }

  return service
}
