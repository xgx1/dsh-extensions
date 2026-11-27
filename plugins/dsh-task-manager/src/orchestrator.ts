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
import { existsSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  STATUSES,
  type CaptainRecord,
  OrchestratorError,
  type Status,
  type TaskNextStep,
  type TaskQuestion,
  type TaskRecord,
  applyAnswerToTask,
  applyReportToTask,
  applyTestDocForRound,
  buildCharterPersona,
  buildAnswerText,
  buildConsoleAssignment,
  buildDispatchBrief,
  buildExecutionBrief,
  buildProjectBrief,
  buildNudgeText,
  buildReplyText,
  buildTestBrief,
  createOutboundMessage,
  normalizeSettings,
  SITUATIONS,
  type TaskSettings,
  type TaskSituation,
} from './records.ts'
import { type ReplyRuntime } from './managed-reply.ts'
import {
  CaptainStore,
  ConsoleStore,
  SettingsStore,
  TaskStore,
  summarizeCaptains,
  type ConsoleManagerRecord,
  type ConsoleState,
} from './stores.ts'
import {
  GLOBAL_MANAGER_PRESET,
  PROJECT_MANAGER_PRESET,
  createSessionOf,
  deliverToManager,
  git,
  ensureManagerSession,
  gitRootOf,
} from './console.ts'
import { deliverHumanMessage } from './managed-reply.ts'
import { collectWorkspaceBriefs, seatSessions } from './workspaces.ts'
import { registerExecSeat } from './seats.ts'

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
    options: { source: { kind: 'task-manager' }; signal: AbortSignal },
  ): Promise<string>
}

/** Resolved runtime services; every piece is optional (headless/GUI-only profiles). */
export interface OrchestratorRuntime {
  subagents?: SubagentsLike
  agents?: AgentsRegistryLike
  /** 会话控制器：两层管理器用它建 / 唤醒没有宿主会话的会话（ADR-0014）。 */
  sessionController?: ReplyRuntime['sessionController']
  /** 工作区注册表：把任务台起的会话挂进对应工作区（2026-11-17 用户要求，别再堆在「未分组」）。 */
  workspaces?: ReplyRuntime['workspaces']
}

/** Dependencies of the taskManager service. */
export interface TaskManagerDeps {
  store: TaskStore
  captains: CaptainStore
  /** Lazy runtime resolution — re-read on every operation so late-mounting services appear. */
  resolveRuntime: () => OrchestratorRuntime
  /** 两层管理器注册表（ADR-0014）；缺失时管理器相关方法明确报错。 */
  consoleStore?: ConsoleStore
  /** 设置面板存储（`settings` 文档）；缺失时不覆盖任何会话的模型。 */
  settings?: SettingsStore
  /** 大管理器会话的工作目录（默认 stateDir 下的 console 目录）。 */
  consoleCwd?: string
  /** 执行会话的座位目录（agent-configs 登记过 core 工具）；默认 <store 目录>/exec。 */
  execCwd?: string
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
  /**
   * 队长回填测试文档（进入待测试后，执行会话测完用 task_test_doc 调用）：
   * sessionId 必须是该任务的 captainSessionId，与 report 同一条身份线。
   */
  setTestDoc(sessionId: string, taskId: string, text: string): Promise<TaskRecord>
  /** 人类 GUI 手动补录（无身份语义，ADR-0001 人类全权写）。 */
  applyReportHuman(
    taskId: string,
    report: { status: Status; text: string; evidence?: string[] },
  ): Promise<TaskRecord>
  /** 队长只读自身被派发的任务。 */
  listMine(sessionId: string): Promise<TaskRecord[]>
  /** 催办：向队长会话投递催办文本并打 lastNudgeAt。 */
  nudge(taskId: string, options?: { managerSessionId?: string }): Promise<{ taskId: string; lastNudgeAt: number }>
  /**
   * 回复清单的答：把用户在任务卡片回复框里写的内容投递给该任务的队长会话，
   * 并记 lastReply。送达语义与 nudge 相同（live → followup，冷恢复需 Manager）。
   */
  reply(
    taskId: string,
    text: string,
    options?: { managerSessionId?: string },
  ): Promise<{ taskId: string; delivery: 'live' | 'cold'; at: number }>
  /** Manager 建单（cwd 模式；worktree 流程走 HTTP /create 路由）。 */
  create(input: { title?: string; content: string; directory?: string; needsFinalReview?: boolean; situation?: TaskSituation }): Promise<TaskRecord>
  /** Manager 显式改状态（形式核验关单/打回通道；不做终审钳制——set-status 是用户的终审关单通道）。 */
  setStatus(taskId: string, status: Status): Promise<TaskRecord>
  /** 删除任务记录（不动会话/worktree/git 分支；in-progress 拒绝，先改状态再删）。 */
  deleteTask(taskId: string): Promise<{ taskId: string }>
  /** 设置面板：读当前设置（允许的模型 + 情形→模型）。 */
  getSettings(): Promise<TaskSettings>
  /** 设置面板：校验并保存设置（非法路由丢弃，情形模型必须在白名单内）。 */
  saveSettings(input: unknown): Promise<TaskSettings>
  /** 任务列表（可按类别/状态过滤，updatedAt 降序）。 */
  list(filter?: { category?: string; status?: Status }): Promise<TaskRecord[]>
  /** 注册表快照（含类别任务计数）。 */
  captains(): Promise<Array<CaptainRecord & { category: string; taskCount: number }>>
  /** 章程编辑（upsert：可先于首次派发预写章程）。 */
  setCharter(category: string, charter: string): Promise<CaptainRecord & { category: string }>

  // ── 两层管理器（ADR-0014）────────────────────────────────────────────────
  /**
   * 管理器注册表快照（大管理器 + 每项目一个项目管理器）。
   */
  consoleState(): Promise<ConsoleState>
  /**
   * 用户「指派任务」：把文本投给大管理器，由它判断项目归属。
   * @param text - 用户粘贴的任务正文。
   * @param options.cwd - 判断项目归属时的提示目录（通常是当前工作区）。
   * @returns 大管理器会话 id 与投递方式。
   */
  assignToConsole(text: string, options?: { cwd?: string; sources?: string[] }): Promise<{ managerSessionId: string; delivered: 'live' | 'resumed' }>
  /**
   * 大管理器派单：确保该项目的项目管理器存在，建一张任务卡并把简报投给它。
   * @param input.project - 项目主键（git 根）；省略时从 `input.cwd` 探测。
   * @param input.text - 任务正文。
   * @param input.title - 短标题；省略时取正文首行。
   * @param input.sources - 本单订阅的触发器键。
   * @returns 项目键、项目管理器会话 id、新建的任务 id。
   */
  dispatchToProject(input: {
    project?: string
    cwd?: string
    text: string
    title?: string
    sources?: string[]
  }): Promise<{ project: string; managerSessionId: string; taskId: string; delivered: 'live' | 'resumed' }>
  /**
   * 项目管理器把一条待拍板的问题挂到任务卡上（ADR-0012：不阻塞继续）。
   * @param recommendation - 系统推荐的答案，人类可直接采纳。
   */
  addQuestion(taskId: string, text: string, recommendation?: string): Promise<TaskRecord>
  /**
   * 项目管理器把一条已裁决的下一步挂到任务卡上。
   * @param decidedBy - 谁裁决的：项目管理器自己，还是人类覆写。
   */
  addNextStep(taskId: string, text: string, decidedBy?: 'project-manager' | 'human'): Promise<TaskRecord>
  /**
   * 回答任务卡上的一条问题，并把答复转发给该任务的项目管理器。
   * @returns 更新后的任务卡与投递方式（无项目管理器时为 none）。
   */
  answerQuestion(taskId: string, questionId: string, answer: string): Promise<{ task: TaskRecord; delivered: 'live' | 'resumed' | 'none' }>
  /**
   * 起执行会话：在项目目录里开一个普通会话（默认预设 standard），投开工简报并转 in-progress。
   */
  startExecution(taskId: string, options?: { agentPreset?: string }): Promise<{ taskId: string; sessionId: string; status: Status }>
  /** 对账：纠正"卡片在进行中、实际没人干活"的状态。 */
  reconcile(options?: { idleMs?: number; limit?: number }): Promise<{
    examined: number
    toWaitingCheck: number
    retried: number
    blocked: number
    left: number
  }>
  /**
   * 配置项目的触发器订阅（inbox / github / ci）：配置挂项目，任务只引用。
   * @param sources - 订阅的触发器键；空数组表示不订阅。
   */
  setProjectSources(project: string, sources: string[]): Promise<ConsoleManagerRecord>
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
        source: { kind: 'task-manager' },
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

  /**
   * 会话最后活动时间（epoch ms）：在 `<DSH_HOME>/sessions` 下找该会话的目录，取 mtime。
   * 找不到（会话早就没了）返回 undefined —— 调用方按"没人干活"处理。
   */
  const sessionActivity = async (dshHome: string, sessionId: string | undefined): Promise<number | undefined> => {
    if (sessionId === undefined || sessionId === '') return undefined
    const root = join(dshHome, 'sessions')
    const buckets = await readdir(root).catch(() => [] as string[])
    let newest: number | undefined
    for (const bucket of buckets) {
      const dir = join(root, bucket, `session-${sessionId.replace(/^session-/, '')}`)
      const stats = await stat(dir).catch(() => undefined)
      if (stats === undefined) continue
      if (newest === undefined || stats.mtimeMs > newest) newest = stats.mtimeMs
    }
    return newest
  }

  /** 情形→模型路由（设置面板）：白名单内的路由才生效，否则 undefined（用宿主默认）。 */
  const situationModelRoute = async (situation: TaskSituation | undefined): Promise<string | undefined> => {
    if (situation === undefined) return undefined
    const settings = await deps.settings?.load()
    const route = settings?.situationModels[situation]
    return route !== undefined && settings?.allowedModels.includes(route) === true ? route : undefined
  }

  /**
   * 卡片自带的 worktree（new/existing-worktree 建单时已建好）：确认目录还在、分支还对
   * 就直接用；被别的任务切走了就切回来，切不动（脏树）落回 prepareWorktree。
   */
  const cardWorktree = async (target: TaskRecord): Promise<{ dir: string; branch: string } | undefined> => {
    const branch = target.worktreeBranch
    if (branch === undefined || branch === '' || !existsSync(target.directory)) return undefined
    try {
      const current = (await git(target.directory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      if (current !== branch) await git(target.directory, ['checkout', branch])
      return { dir: target.directory, branch }
    } catch {
      return undefined
    }
  }

  /**
   * 为一张任务卡准备 worktree（分支 `task/<前 8 位>`）。不是 git 仓库、或分支/目录已存在时
   * 返回 undefined，执行会话就落在项目目录里 —— 失败不阻断开工。
   */
  const prepareWorktree = async (
    project: string,
    taskId: string,
  ): Promise<{ dir: string; branch: string } | undefined> => {
    const root = await gitRootOf(project)
    if (root === undefined) return undefined
    const branch = `task/${taskId.slice(0, 8)}`
    // 先复用本项目已完成任务的 worktree（2026-11-22 用户要求）：保留编译产物，切新分支继续干，
    // 不再每单新建目录与工作区。
    const reused = await reuseDoneWorktree(root, branch)
    if (reused !== undefined) return reused
    const dir = join(dirname(root), `${basename(root)}-${taskId.slice(0, 8)}`)
    try {
      await git(root, ['worktree', 'add', dir, '-b', branch])
      return { dir, branch }
    } catch {
      // 分支或目录已存在（重跑同一张卡）：直接复用那个 worktree。
      try {
        const listed = await git(root, ['worktree', 'list', '--porcelain'])
        return listed.includes(`worktree ${dir}`) ? { dir, branch } : undefined
      } catch {
        return undefined
      }
    }
  }

  /**
   * 复用已完成任务的 worktree：同根、目录仍在 worktree 列表、树干净（脏树跳过，绝不动
   * 未提交的工作），按 updatedAt 取最新。新分支基线是项目根 HEAD，不是旧 task 分支头。
   */
  const reuseDoneWorktree = async (root: string, branch: string): Promise<{ dir: string; branch: string } | undefined> => {
    const cards = await deps.store.load()
    const candidates = cards
      .filter((card) => card.status === 'done' && card.worktreeBranch !== undefined && card.worktreeBranch !== '' && card.directory !== root)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    if (candidates.length === 0) return undefined
    let listed: string
    let base: string
    try {
      listed = await git(root, ['worktree', 'list', '--porcelain'])
      base = (await git(root, ['rev-parse', 'HEAD'])).trim()
    } catch {
      return undefined
    }
    for (const card of candidates) {
      if (!listed.includes(`worktree ${card.directory}`)) continue
      const dirty = await git(card.directory, ['status', '--porcelain']).catch(() => undefined)
      if (dirty === undefined || dirty.trim() !== '') continue
      try {
        await git(card.directory, ['checkout', '-b', branch, base])
        return { dir: card.directory, branch }
      } catch {
        // 分支重名等：试下一个候选。
      }
    }
    return undefined
  }

  /**
   * 确保项目目录存在且是 git 仓库：执行会话要在 `task/<前 8 位>` 分支的 worktree 里开工，
   * 而派单的调用方（大管理器）常常拿到的是一个还不存在的路径。
   */
  const ensureProjectRepo = async (dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true })
    // 只看目录自己有没有 .git：项目常常落在另一个仓库的子目录里（.scratch/…），
    // 那种情况要建自己的仓库，否则 gitRootOf 会一路走到外层仓库根。
    if (existsSync(join(dir, '.git'))) return
    await git(dir, ['init', '-q'])
    await git(dir, ['-c', 'user.email=task-console@local', '-c', 'user.name=task-console', 'commit', '-q', '--allow-empty', '-m', 'init: project skeleton'])
  }

  /**
   * 把任务分支合回项目当前分支（`git merge --no-ff`）。没分支、没仓库、已合过都算无事发生。
   * @returns 合并提交 id；失败时返回原因（卡片照旧置 done，合并失败要能看见）。
   */
  const mergeTaskBranch = async (
    task: Pick<TaskRecord, 'id' | 'project' | 'worktreeBranch' | 'directory'>,
  ): Promise<{ commit?: string; error?: string } | undefined> => {
    const branch = task.worktreeBranch
    const project = task.project ?? (task.directory === undefined ? undefined : await gitRootOf(task.directory))
    if (branch === undefined || branch === '' || project === undefined) return undefined
    try {
      const merged = await git(project, ['branch', '--list', '--merged', 'HEAD', branch])
      if (merged.includes(branch)) return undefined // 已经合过
      await git(project, ['-c', 'user.email=task-console@local', '-c', 'user.name=task-console',
        'merge', '--no-ff', '-m', `merge: 完成任务 ${task.id.slice(0, 8)}（${branch}）`, branch])
      return { commit: await git(project, ['rev-parse', '--short', 'HEAD']) }
    } catch (reason) {
      // 冲突会让项目工作区停在 UU/AA（用户下一条命令全撞上），合不了就先撤掉这次合并。
      await git(project, ['merge', '--abort']).catch(() => '')
      return { error: reason instanceof Error ? reason.message.slice(0, 300) : 'merge failed' }
    }
  }

  /** 读最新落盘状态、改一张任务卡、写回（并发安全，走 store 的写队列）。 */
  const mutateTask = (taskId: string, fn: (task: TaskRecord) => void): Promise<TaskRecord> => {
    return deps.store.mutate((tasks) => {
      const target = tasks.find((item) => item.id === taskId)
      if (target === undefined) throw new OrchestratorError('TASK_NOT_FOUND', `task ${taskId} does not exist`)
      fn(target)
      target.updatedAt = now()
      return target
    })
  }

  /**
   * 进入待测试（2026-11-19 用户要求）：先把「这一单要测什么」落到卡片的测试文档上，
   * 再向执行会话投一次测试简报（强制测试技能 → 写用例真跑 → 模拟点桌面窗口 → 交回正式文档）。
   * 简报只按「最近一次汇报之后是否投过」去重：重做后再报 waiting-check 会重新发起一轮。
   */
  const openTestRound = async (taskId: string): Promise<void> => {
    const task = await mutateTask(taskId, (record) => { applyTestDocForRound(record, now()) })
    const briefed = task.testStartedAt !== undefined && task.testStartedAt >= (task.report?.at ?? 0)
    const sessionId = task.captainSessionId ?? ''
    if (briefed || sessionId === '') return
    try {
      await deliverHumanMessage(deps.resolveRuntime(), sessionId, buildTestBrief(task))
    } catch {
      // 执行会话已经不在：文档仍在卡片上，等人接手或重起执行会话。
      return
    }
    await mutateTask(taskId, (record) => { record.testStartedAt = now() })
  }

  const requireConsoleStore = (): ConsoleStore => {
    if (deps.consoleStore === undefined) {
      throw new OrchestratorError('DELIVERY_UNAVAILABLE', 'the two-layer console needs a console store (deps.consoleStore)')
    }
    return deps.consoleStore
  }

  const service: TaskManagerService = {
    async consoleState() {
      return requireConsoleStore().load()
    },

    async assignToConsole(text, options = {}) {
      const body = typeof text === 'string' ? text.trim() : ''
      if (body === '') throw new OrchestratorError('INVALID_INPUT', 'a task description is required')
      const store = requireConsoleStore()
      const runtime = deps.resolveRuntime()
      const manager = await ensureManagerSession(runtime, store, undefined, {
        cwd: deps.consoleCwd ?? join(dirname(deps.store.path), 'console'),
        preset: GLOBAL_MANAGER_PRESET,
      })
      const hint = options.cwd !== undefined && options.cwd !== '' ? options.cwd : undefined
      const sources = Array.isArray(options.sources)
        ? options.sources.filter((item): item is string => typeof item === 'string' && item !== '')
        : []
      const workspaces = await collectWorkspaceBriefs(runtime.workspaces, dirname(deps.store.path))
      const delivered = await deliverToManager(runtime, manager.sessionId, buildConsoleAssignment(body, hint, sources, workspaces))
      return { managerSessionId: manager.sessionId, delivered }
    },

    async dispatchToProject(input) {
      const body = typeof input.text === 'string' ? input.text.trim() : ''
      if (body === '') throw new OrchestratorError('INVALID_INPUT', 'a task description is required')
      const hinted = input.project !== undefined && input.project !== ''
        ? input.project
        : input.cwd
      // 面板只有文本框：调用方常把目标目录写在正文里，缺 project/cwd 时从正文里捞绝对路径。
      const fromText = hinted === undefined || hinted === ''
        ? /\/[\w./-]+/.exec(body)?.[0]
        : undefined
      const picked = hinted ?? fromText
      if (picked === undefined || picked === '') {
        throw new OrchestratorError('INVALID_INPUT', 'a project (git root or working directory) is required')
      }
      let absolute = resolve(picked)
      // 正文里写的项目目录比推断出来的仓库根更具体（用户在面板里指的就是它）：
      // 大管理器常把 `.scratch/x/y` 剪成外层仓库根，这里按正文纠回来。
      const mentioned = /\/[\w./-]+/.exec(body)?.[0]
      if (mentioned !== undefined && mentioned !== absolute) {
        const candidate = resolve(mentioned)
        if (candidate.startsWith(`${absolute}/`)) absolute = candidate
      }
      await ensureProjectRepo(absolute)
      const project = (await gitRootOf(absolute)) ?? absolute
      const store = requireConsoleStore()
      const runtime = deps.resolveRuntime()
      // 同一项目里正文一模一样的未关闭卡：复用，别再造一张（子弹旅实测重复点两次就两张卡）。
      const existingTask = (await deps.store.load()).find(
        (item) => item.project === project && item.status !== 'done' && item.content.trim() === body,
      )
      if (existingTask !== undefined) {
        const reuseManager = await ensureManagerSession(runtime, store, project, {
          cwd: deps.consoleCwd ?? join(dirname(deps.store.path), 'console'),
          preset: PROJECT_MANAGER_PRESET,
        })
        await deliverToManager(runtime, reuseManager.sessionId, buildProjectBrief({ task: existingTask, project }))
        return { project, managerSessionId: reuseManager.sessionId, taskId: existingTask.id, delivered: 'live' as const }
      }
      // 管理器会话统一住在控制台目录：agent-configs 按 cwd 发放工具，项目根目录的
      // 配置表里没有 task_* 白名单。项目路径由任务卡携带，执行会话才落在项目里。
      const manager = await ensureManagerSession(runtime, store, project, {
        cwd: deps.consoleCwd ?? join(dirname(deps.store.path), 'console'),
        preset: PROJECT_MANAGER_PRESET,
      })
      const stamp = now()
      const rawTitle = input.title !== undefined && input.title.trim() !== '' ? input.title.trim() : ''
      const title = rawTitle === '' ? (body.split('\n')[0] ?? '').slice(0, 60) : rawTitle
      const sources = Array.isArray(input.sources)
        ? input.sources.filter((item): item is string => typeof item === 'string' && item !== '')
        : []
      const task = await deps.store.mutate((tasks) => {
        const record: TaskRecord = {
          id: randomUUID(),
          title,
          content: body,
          status: 'not-started',
          runMode: 'cwd',
          directory: project,
          consoleSessionId: manager.sessionId,
          project,
          sources,
          dispatchRound: 0,
          needsFinalReview: false,
          createdAt: stamp,
          updatedAt: stamp,
        }
        tasks.push(record)
        return record
      })
      const delivered = await deliverToManager(runtime, manager.sessionId, buildProjectBrief({ task, project }))
      return { project, managerSessionId: manager.sessionId, taskId: task.id, delivered }
    },

    async addQuestion(taskId, text, recommendation) {
      const body = typeof text === 'string' ? text.trim() : ''
      if (body === '') throw new OrchestratorError('INVALID_INPUT', 'question text is required')
      const stamp = now()
      const question: TaskQuestion = {
        id: randomUUID(),
        text: body,
        at: stamp,
        ...(recommendation !== undefined && recommendation.trim() !== '' ? { recommendation: recommendation.trim() } : {}),
      }
      return mutateTask(taskId, (task) => {
        task.questions = [...(task.questions ?? []), question]
      })
    },

    async addNextStep(taskId, text, decidedBy) {
      const body = typeof text === 'string' ? text.trim() : ''
      if (body === '') throw new OrchestratorError('INVALID_INPUT', 'next step text is required')
      const step: TaskNextStep = {
        id: randomUUID(),
        text: body,
        decidedBy: decidedBy === 'human' ? 'human' : 'project-manager',
        at: now(),
      }
      return mutateTask(taskId, (task) => {
        task.nextSteps = [...(task.nextSteps ?? []), step]
      })
    },

    async answerQuestion(taskId, questionId, answer) {
      const body = typeof answer === 'string' ? answer.trim() : ''
      if (body === '') throw new OrchestratorError('INVALID_INPUT', 'an answer is required')
      let answered: TaskQuestion | undefined
      const task = await mutateTask(taskId, (target) => {
        answered = applyAnswerToTask(target, { questionId, text: body, at: now() })
      })
      const question = answered as TaskQuestion
      const adopted = question.recommendation !== undefined && body === question.recommendation.trim()
      const text = buildAnswerText({ task, question, answer: body, adopted })
      const managerSessionId = task.consoleSessionId
      let managerDelivered: 'live' | 'resumed' | 'none' = 'none'
      // 先唤醒管理器：执行会话冷恢复需要活的管理器父会话；副本注明无需转发。
      if (managerSessionId !== undefined) {
        try {
          managerDelivered = await deliverToManager(
            deps.resolveRuntime(),
            managerSessionId,
            `${text}\n\n答复将直接送达执行会话；你无需转发，跟进卡片进度即可。`,
          )
        } catch {
          // 管理器会话丢了不该吞掉答复：卡片上的 answer 已写入，下面仍直送执行会话。
        }
      }
      if (task.captainSessionId === undefined || task.captainSessionId === '') return { task, delivered: managerDelivered }
      // 确定性重新派发：答复直送执行会话，不依赖管理器 LLM 自觉转发（2026-11-22 用户报答复后不续跑）。
      try {
        const delivery = await deliverToCaptain(task.captainSessionId, text, managerSessionId)
        return { task, delivered: delivery === 'live' ? 'live' as const : 'resumed' as const }
      } catch {
        return { task, delivered: 'none' as const }
      }
    },

    async setProjectSources(project, sources) {
      const key = typeof project === 'string' ? project.trim() : ''
      if (key === '') throw new OrchestratorError('INVALID_INPUT', 'a project is required')
      const store = requireConsoleStore()
      const wanted = Array.isArray(sources)
        ? [...new Set(sources.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()))]
        : []
      return store.mutate((state) => {
        const record = state.projects?.[key]
        if (record === undefined) throw new OrchestratorError('TASK_NOT_FOUND', `project ${key} has no project manager yet`)
        record.sources = wanted
        record.updatedAt = now()
        return record
      })
    },

    async startExecution(taskId, options = {}) {
      const runtime = deps.resolveRuntime()
      const existing = await deps.store.load()
      const target = existing.find((item) => item.id === taskId)
      if (target === undefined) throw new OrchestratorError('TASK_NOT_FOUND', `task ${taskId} does not exist`)
      const project = target.project ?? target.directory
      // 卡片已带 worktree（new/existing-worktree 建单时就建好了）：直接用它执行，不再套一层
      // 新 worktree（2026-11-22 用户报：已有工作区却被新建，工作区越做越多）。
      // cwd 卡仍走 prepareWorktree：只产 patch，执行会话跑在独立 task 分支上，宿主侧从不 push。
      const worktree = await cardWorktree(target) ?? await prepareWorktree(project, taskId)
      const workdir = worktree?.dir ?? project
      // 会话目录就是它在任务工作区里的那个目录：工作区成员校验要求 cwd 等于工作区 path，
      // 这样执行会话才进得了自己的工作区而不是「未分组」。工具白名单由 agent-configs
      // 的生成器按 tasks.json 给这些目录发放（core + task-exec）。
      const seat = workdir
      // 新 worktree 不在 agent-configs 白名单里 → 先登记再建会话，否则执行会话零工具。
      await registerExecSeat(dirname(deps.store.path), seat)
      // 抢在会话创建前建工作区：否则宿主按 cwd 自动建的那个会拿走标题（目录名带 -<任务id>）。
      await seatSessions(runtime.workspaces, seat,
        `${(project ?? seat).split('/').filter(Boolean).pop() ?? seat} · ${target.title.slice(0, 24)}`, [])
      await mkdir(seat, { recursive: true })
      // 卡片记着哪个执行会话，就还是那个会话（2026-11-18 用户要求）：接着它跑，不新开。
      // 会话被归档/删除、宿主拒绝恢复时，才落到下面的新建分支。
      const recorded = target.captainSessionId ?? ''
      if (recorded !== '') {
        try {
          await deliverHumanMessage(runtime, recorded, buildExecutionBrief({ task: target, project, workdir }))
          const resumed = await mutateTask(taskId, (record) => {
            record.status = 'in-progress'
            record.directory = workdir
            if (worktree !== undefined) record.worktreeBranch = worktree.branch
          })
          return { taskId, sessionId: recorded, status: resumed.status }
        } catch {
          // 会话没了 → 新建。
        }
      }
      const create = createSessionOf(runtime)
      if (create === undefined) {
        throw new OrchestratorError('DELIVERY_UNAVAILABLE', 'sessionController cannot create sessions')
      }
      // 设置面板的情形→模型（2026-11-22 用户要求）：建执行会话时按它覆盖。
      const modelRoute = await situationModelRoute(target.situation)
      // 执行会话要能把结果写回卡片：优先用 task-exec 预设（组成里挂了 dsh-task-manager/tools）。
      // 该预设只在开发组成里声明过；生产组成还没加时退回 all —— 退回后任务照做，
      // 只是 `task_report` 不在工具面里，卡片得人工关单。
      const preset = options.agentPreset ?? 'task-exec'
      const created = preset === 'all'
        ? await create({ cwd: seat, agentPreset: 'all' })
        : await create({ cwd: seat, agentPreset: preset }).catch(async (reason: unknown) => {
            const message = reason instanceof Error ? reason.message : ''
            if (!/preset/i.test(message)) throw reason
            return create({ cwd: seat, agentPreset: 'all' })
          })
      const sessionId = created.sessionId
      if (sessionId === undefined) {
        throw new OrchestratorError('DELIVERY_UNAVAILABLE', 'the execution session was created without a session id')
      }
      // 情形→模型覆盖：失败不阻断开工，会话用宿主默认模型继续。
      if (modelRoute !== undefined) {
        const [provider, ...rest] = modelRoute.split('/')
        try {
          await runtime.sessionController?.selectModel?.({ sessionId, provider, model: rest.join('/') })
        } catch {
          // 模型覆盖失败不阻断开工。
        }
      }
      // 分组：执行会话进它自己的任务工作区（path = worktree），标题「项目 · 任务」。
      const seatTitle = `${project.split('/').filter(Boolean).pop() ?? project} · ${target.title.slice(0, 24)}`
      await seatSessions(deps.resolveRuntime().workspaces, workdir, seatTitle, [sessionId])
      const task = await mutateTask(taskId, (record) => {
        record.status = 'in-progress'
        // 身份线：执行会话就是这张卡的"队长"，干完用它自己的会话 id 调 task_report 关单。
        record.captainSessionId = sessionId
        record.directory = workdir
        if (worktree !== undefined) record.worktreeBranch = worktree.branch
        record.conversations = [
          ...(record.conversations ?? []),
          { id: sessionId, shortId: sessionId.replace(/^session-/, '').slice(0, 8), cwd: workdir },
        ]
      })
      await deliverHumanMessage(deps.resolveRuntime(), sessionId, buildExecutionBrief({ task, project, workdir }))
      return { taskId, sessionId, status: task.status }
    },

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
      let prior: Status | undefined
      const task = await deps.store.mutate((tasks) => {
        const target = tasks.find((item) => item.id === taskId)
        if (target === undefined) throw new OrchestratorError('TASK_NOT_FOUND', `task ${taskId} not found`)
        // Mandatory identity line (ADR-0003): only the dispatched captain reports.
        if (target.captainSessionId === undefined || target.captainSessionId !== sessionId) {
          throw new OrchestratorError(
            'NOT_CAPTAIN',
            `session ${sessionId} is not the captain of task ${taskId} (dispatched to ${target.captainSessionId ?? 'nobody'})`,
          )
        }
        prior = target.status
        applyReportToTask(target, { status: validStatus, text, evidence, at: now() })
        return target
      })
      // 只在「转入」待测试时发起测试轮：停在待测试的会话再报一次 waiting-check 不算新一轮。
      if (task.status === 'waiting-check' && prior !== 'waiting-check') await openTestRound(task.id)
      return task
    },

    async setTestDoc(sessionId, taskId, text) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new OrchestratorError('NOT_CAPTAIN', 'test doc requires a sessionId')
      }
      if (typeof text !== 'string' || text.trim() === '') {
        throw new OrchestratorError('INVALID_INPUT', 'test doc text is required')
      }
      const found = (await deps.store.load()).find((item) => item.id === taskId)
      if (found === undefined) throw new OrchestratorError('TASK_NOT_FOUND', `task ${taskId} not found`)
      if (found.captainSessionId === undefined || found.captainSessionId !== sessionId) {
        throw new OrchestratorError('NOT_CAPTAIN', `session ${sessionId} is not the captain of task ${taskId}`)
      }
      return mutateTask(taskId, (record) => {
        record.testDoc = { text, at: now(), origin: 'session' }
      })
    },

    async applyReportHuman(taskId, report) {
      const validStatus = assertStatus(report.status)
      if (typeof report.text !== 'string' || report.text.trim() === '') {
        throw new OrchestratorError('INVALID_INPUT', 'report text is required')
      }
      let prior: Status | undefined
      const task = await deps.store.mutate((tasks) => {
        const target = tasks.find((item) => item.id === taskId)
        if (target === undefined) throw new OrchestratorError('TASK_NOT_FOUND', `task ${taskId} not found`)
        prior = target.status
        applyReportToTask(target, { status: validStatus, text: report.text, evidence: report.evidence, at: now() })
        return target
      })
      if (task.status === 'waiting-check' && prior !== 'waiting-check') await openTestRound(task.id)
      return task
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

    async reply(taskId, text, options = {}) {
      if (typeof text !== 'string' || text.trim() === '') {
        throw new OrchestratorError('INVALID_INPUT', 'reply text is required')
      }
      const tasks = await deps.store.load()
      const task = tasks.find((item) => item.id === taskId)
      if (task === undefined) throw new OrchestratorError('TASK_NOT_FOUND', `task ${taskId} not found`)
      if (task.captainSessionId === undefined || task.captainSessionId === '') {
        throw new OrchestratorError('NOT_DISPATCHED', `task ${taskId} has not been dispatched to a captain`)
      }
      const body = text.trim()
      const delivery = await deliverToCaptain(task.captainSessionId, buildReplyText({ task, text: body }), options.managerSessionId)
      const at = now()
      await deps.store.mutate((all) => {
        const target = all.find((item) => item.id === taskId)
        if (target !== undefined) {
          target.lastReply = { text: body, at }
          target.updatedAt = at
        }
      })
      return { taskId, delivery, at }
    },

    async getSettings() {
      return deps.settings?.load() ?? { allowedModels: [], situationModels: {} }
    },

    async saveSettings(input) {
      const settings = normalizeSettings(input)
      if (deps.settings === undefined) return settings
      return deps.settings.mutate((state) => {
        state.allowedModels = settings.allowedModels
        state.situationModels = settings.situationModels
        return state
      })
    },

    async create(input) {
      if (typeof input.content !== 'string' || input.content.trim() === '') {
        throw new OrchestratorError('INVALID_INPUT', 'task content is required')
      }
      if (input.needsFinalReview !== undefined && typeof input.needsFinalReview !== 'boolean') {
        throw new OrchestratorError('INVALID_INPUT', 'needsFinalReview must be a boolean')
      }
      if (input.situation !== undefined && !SITUATIONS.includes(input.situation)) {
        throw new OrchestratorError('INVALID_INPUT', 'situation must be simple, complex, or long-running')
      }
      const stamp = now()
      const directory = input.directory !== undefined && input.directory.trim() !== ''
        ? resolve(input.directory)
        : process.cwd()
      return deps.store.mutate((tasks) => {
        const task: TaskRecord = {
          id: randomUUID(),
          title: input.title !== undefined && input.title.trim() !== ''
            ? input.title.trim()
            : input.content.split('\n')[0]?.slice(0, 60) ?? 'Untitled',
          content: input.content,
          status: 'not-started',
          runMode: 'cwd',
          directory,
          dispatchRound: 0,
          needsFinalReview: input.needsFinalReview === true,
          ...(input.situation === undefined ? {} : { situation: input.situation }),
          createdAt: stamp,
          updatedAt: stamp,
        }
        tasks.push(task)
        return task
      })
    },

    async setStatus(taskId, status) {
      const validStatus = assertStatus(status)
      const before = (await deps.store.load()).find((item) => item.id === taskId)
      // 用户验收通过（done）即落地：把 `task/<id>` 分支合回项目默认分支。
      // 交付物只活在 worktree 里的话，"项目做出来了"对人不可见。
      const merge = validStatus === 'done' && before !== undefined ? await mergeTaskBranch(before) : undefined
      const task = await deps.store.mutate((tasks) => {
        const target = tasks.find((item) => item.id === taskId)
        if (target === undefined) throw new OrchestratorError('TASK_NOT_FOUND', `task ${taskId} not found`)
        target.status = validStatus
        target.updatedAt = now()
        if (merge?.commit !== undefined) target.mergeCommit = merge.commit
        // 合并失败要留在卡上：只在响应里返回，面板刷新后就看不见了（实测踩过）。
        if (merge !== undefined) {
          if (merge.error === undefined) delete target.mergeError
          else target.mergeError = merge.error
        }
        return target
      })
      if (task.status === 'waiting-check' && before?.status !== 'waiting-check') await openTestRound(task.id)
      return { ...task, ...(merge?.error === undefined ? {} : { mergeError: merge.error }) }
    },

    async deleteTask(taskId) {
      await deps.store.mutate((tasks) => {
        const target = tasks.find((item) => item.id === taskId)
        if (target === undefined) throw new OrchestratorError('TASK_NOT_FOUND', `task ${taskId} not found`)
        // 进行中的卡背后可能还有执行会话在干活，删卡会丢下它：先改状态再删。
        if (target.status === 'in-progress') {
          throw new OrchestratorError('TASK_IN_PROGRESS', `task ${taskId} is in progress; change its status before deleting`)
        }
        tasks.splice(tasks.indexOf(target), 1)
      })
      return { taskId }
    },

    /**
     * 对账：把"卡片说在进行中、实际没有会话在干活"的卡纠正过来。
     *
     * 用户报过一个直接后果（2026-11-17）：一堆 in-progress 的卡，背后根本没有会话在跑 ——
     * 执行会话结束了却没回报，卡片就永远停在"进行中"。这里按证据分流：
     * - 工作区里已经有提交 → 视为干完了，转「待测试」并把分支/提交写进回报；
     * - 什么都没有且还没重试过 → 重起一次执行会话；
     * - 重试过还是空的 → 转 problem，别再装成在跑。
     */
    async reconcile(options?: { idleMs?: number; limit?: number }) {
      const idleMs = options?.idleMs ?? 10 * 60_000
      const limit = options?.limit ?? 20
      const dshHome = dirname(dirname(deps.store.path))
      const agents = deps.resolveRuntime().agents
      const tasks = await deps.store.load()
      const stale = tasks
        .filter((task) => task.status === 'in-progress')
        .slice(0, limit)
      const summary = { examined: stale.length, toWaitingCheck: 0, retried: 0, blocked: 0, left: 0 }
      for (const task of stale) {
        if (task.report !== undefined) {
          await mutateTask(task.id, (record) => { record.status = 'waiting-check' })
          await openTestRound(task.id)
          summary.toWaitingCheck += 1
          continue
        }
        const activity = await sessionActivity(dshHome, task.captainSessionId)
        // 卡片记着的执行会话不在内存（宿主重启）= 没人接着干：别等 10 分钟空闲，立刻按证据处理，
        // 由下面的自动重试把同一个会话唤醒。没有执行会话的卡仍按旧行为等待。
        const recorded = task.captainSessionId ?? ''
        const live = recorded === '' ? undefined : agents?.get(recorded)
        const orphaned = recorded !== '' && agents !== undefined && live === undefined
        if (!orphaned && activity !== undefined && now() - activity < idleMs) {
          summary.left += 1
          continue
        }
        const project = task.project ?? task.directory
        const branch = task.worktreeBranch
        const commits = project === undefined || branch === undefined
          ? ''
          : await git(project, ['rev-list', '--count', `HEAD..${branch}`]).catch(() => '')
        // 没提交但工作区里躺着改动的文件，同样算"干出来了"（Worker 常常只写文件不提交）。
        const dirty = task.directory === undefined
          ? ''
          : await git(task.directory, ['status', '--porcelain']).catch(() => '')
        if (commits === '0' && dirty !== '' && project !== undefined && branch !== undefined) {
          await mutateTask(task.id, (record) => {
            record.status = 'waiting-check'
            record.report = {
              text: '自动对账：执行会话已结束，工作区里有未提交的改动，按已完成待验收。',
              at: now(),
              evidence: [`分支 ${branch}`, `改动 ${dirty.split('\n').length} 个文件`, `目录 ${task.directory ?? ''}`],
            }
          })
          await openTestRound(task.id)
          summary.toWaitingCheck += 1
          continue
        }
        if (commits !== '' && commits !== '0' && project !== undefined && branch !== undefined) {
          const head = await git(project, ['rev-parse', '--short', branch]).catch(() => '')
          await mutateTask(task.id, (record) => {
            record.status = 'waiting-check'
            record.report = {
              text: '自动对账：执行会话已结束，工作区里有提交，按已完成待验收。',
              at: now(),
              evidence: [`分支 ${branch}（${commits} 个提交）`, `提交 ${head}`],
            }
          })
          await openTestRound(task.id)
          summary.toWaitingCheck += 1
          continue
        }
        if ((task.autoRetries ?? 0) < 1 && project !== undefined) {
          await mutateTask(task.id, (record) => { record.autoRetries = (record.autoRetries ?? 0) + 1 })
          try {
            await this.startExecution(task.id)
            summary.retried += 1
            continue
          } catch {
            // 起不来就按受阻处理
          }
        }
        await mutateTask(task.id, (record) => {
          record.status = 'problem'
          record.report = {
            text: '自动对账：执行会话已结束且工作区没有产出，自动重试也没能起新会话。',
            at: now(),
            evidence: [],
          }
        })
        summary.blocked += 1
      }
      return summary
    },

    async list(filter) {
      const tasks = await deps.store.load()
      const filtered = tasks
        .filter((task) => (filter?.category === undefined || task.category === filter.category)
          && (filter?.status === undefined || task.status === filter.status))
      return filtered.sort((a, b) => b.updatedAt - a.updatedAt)
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
    // 宿主不一定给 startContinuable（dev 实况：对象在、方法没有）——报清楚，别让上层吃 TypeError。
    if (subagents === undefined || typeof subagents.startContinuable !== 'function') {
      await rollbackSessionId(category, childId)
      throw new OrchestratorError(
        'DELIVERY_UNAVAILABLE',
        'captain sessions need subagents.startContinuable, which this host does not provide; use task_dispatch_project instead',
      )
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
