/**
 * dsh-task-manager — orchestration data contract (M1).
 *
 * Single source of truth for the persisted task/orchestration shapes shared by
 * the host service, the HTTP routes, the model tools (M2), and the GUI (M4).
 * Old `tasks.json` records predate the orchestration fields; loading must
 * tolerate them by filling defaults at read time (never throwing, never
 * dropping the legacy keys).
 */
import { randomUUID } from 'node:crypto'

/** Task status vocabulary (stable keys; labels live in the client dictionaries). */
export const STATUSES = ['not-started', 'in-progress', 'waiting-reply', 'problem', 'waiting-check', 'done'] as const
export type Status = (typeof STATUSES)[number]

/** Run-location modes the create dialog offers. */
export type RunMode = 'cwd' | 'new-worktree' | 'existing-worktree'

/** One captain report written back through the restricted report path. */
export interface TaskReport {
  /** Free-text report body from the captain (状态 + 进展 + 结论). */
  text: string
  /** Epoch ms when the report was recorded. */
  at: number
  /** Evidence paths/references backing the report (形式核验 input). */
  evidence?: string[]
}

/** One persisted task record (orchestration fields added in M1). */
export interface TaskRecord {
  id: string
  title: string
  content: string
  status: Status
  runMode: RunMode
  directory: string
  worktreeBranch?: string
  conversations?: ConversationSummary[]
  /** 队长类别；首次派发时写入。 */
  category?: string
  /** 派发到的队长会话 id；与 captains.json 中该类别的 sessionId 一致。 */
  captainSessionId?: string
  /** 派发轮次：0 = 从未派发；每次成功 assign +1（含同单重派）。 */
  dispatchRound: number
  /** 最近一次队长回报（覆盖式：新回报替换旧回报）。 */
  report?: TaskReport
  /** 需终审：true 时队长的 done 回报被钳制为 waiting-check，等用户终审后经 set-status 关单。 */
  needsFinalReview: boolean
  /** 最近一次催办时间（epoch ms）。 */
  lastNudgeAt?: number
  /** 用户在任务清单回复框里发出的最近一次回答（回复清单的答）。 */
  lastReply?: { text: string; at: number }
  /** 所属项目管理器会话（ADR-0014 两层管理器）。 */
  consoleSessionId?: string
  /** 项目主键：git 仓库根路径。 */
  project?: string
  /** 本单订阅的触发器键（inbox / github / ci …），配置本身挂项目。 */
  sources?: string[]
  /** 待你拍板的问题（ADR-0012/0013：非阻塞，落在卡片上）。 */
  questions?: TaskQuestion[]
  /** 项目管理器已裁决的下一步动作。 */
  nextSteps?: TaskNextStep[]
  createdAt: number
  updatedAt: number
}

/** 一条落在任务卡片上的问题；答复后 `answer` 有值。 */
export interface TaskQuestion {
  id: string
  text: string
  /** 系统推荐的答案；答复时可直接采纳。 */
  recommendation?: string
  at: number
  answer?: { text: string; at: number }
}

/** 一条已裁决的下一步动作。 */
export interface TaskNextStep {
  id: string
  text: string
  /** 谁裁决的：项目管理器自己定，还是你覆写。 */
  decidedBy: 'project-manager' | 'human'
  at: number
}

/** Compact, owned summary of one durable session that took over a task. */
export interface ConversationSummary {
  id: string
  shortId: string
  cwd?: string
  createdAt?: number
  origin?: string
}

/** One captain registry entry persisted in `captains.json`. */
export interface CaptainRecord {
  /** 类别章程全文（类别差异的唯一载体，ADR-0002）。 */
  charter: string
  /** 队长会话 id；首次 assign 建会话成功后写入，失败回滚为缺席。 */
  sessionId?: string
  /** 注册表条目创建时间（epoch ms）。 */
  createdAt: number
  /** 最近一次派发时间（epoch ms）；首次派发前缺席。 */
  lastDispatchAt?: number
}

/** captains.json on-disk shape: category → record. */
export type CaptainRegistryData = Record<string, CaptainRecord>

/** Orchestrator error carrying a stable code the routes map to HTTP statuses. */
export class OrchestratorError extends Error {
  readonly code: OrchestratorErrorCode
  constructor(code: OrchestratorErrorCode, message: string) {
    super(message)
    this.name = 'OrchestratorError'
    this.code = code
  }
}

export type OrchestratorErrorCode =
  /** 任务 id 不存在。→ 404 */
  | 'TASK_NOT_FOUND'
  /** 回报身份不符：sessionId 不是该任务的 captainSessionId。→ 403 */
  | 'NOT_CAPTAIN'
  /** status 不在 6 状态词表内。→ 400 */
  | 'INVALID_STATUS'
  /** 其余输入不合法（category/charter/text 形状）。→ 400 */
  | 'INVALID_INPUT'
  /** 任务未派发（无 category/captainSessionId），不能 nudge/回报。→ 409 */
  | 'NOT_DISPATCHED'
  /** 新建队长会话需要 managerSessionId（request.parent 必需，M0 结论 1）。→ 409 */
  | 'MANAGER_AGENT_REQUIRED'
  /** 队长会话既不 live 也无法冷恢复投递（无 manager agent）。→ 409 */
  | 'DELIVERY_UNAVAILABLE'
  /** startContinuable 建会话失败（已回滚注册表 sessionId）。→ 502 */
  | 'CREATION_FAILED'

/**
 * Normalize one raw tasks.json entry into a well-typed TaskRecord.
 *
 * Migration tolerance: legacy records keep every original key (spread first);
 * missing orchestration fields get defaults (`dispatchRound` 0,
 * `needsFinalReview` false); malformed optional fields are dropped rather than
 * propagated so downstream code sees well-typed values only.
 */
export function normalizeTask(raw: unknown): TaskRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  // Destructure the orchestration fields out so malformed values are REMOVED
  // (not merely overridden) — the spread keeps every legacy/unknown key.
  const { category, captainSessionId, dispatchRound, needsFinalReview, lastNudgeAt, report, ...rest } = source
  const validCategory = asOptionalString(category)
  const validSessionId = asOptionalString(captainSessionId)
  const validNudge = asOptionalEpoch(lastNudgeAt)
  const validReport = normalizeReport(report)
  return {
    ...rest,
    dispatchRound: asSafeCount(dispatchRound) ?? 0,
    needsFinalReview: needsFinalReview === true,
    ...(validCategory === undefined ? {} : { category: validCategory }),
    ...(validSessionId === undefined ? {} : { captainSessionId: validSessionId }),
    ...(validNudge === undefined ? {} : { lastNudgeAt: validNudge }),
    ...(validReport === undefined ? {} : { report: validReport }),
  } as TaskRecord
}

/** Coerce a report value into a well-typed TaskReport, or undefined when absent/malformed. */
function normalizeReport(value: unknown): TaskReport | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (typeof source['text'] !== 'string' || source['text'] === '') return undefined
  const at = typeof source['at'] === 'number' && Number.isFinite(source['at']) ? source['at'] : undefined
  if (at === undefined) return undefined
  const evidence = normalizeEvidence(source['evidence'])
  return evidence === undefined ? { text: source['text'], at } : { text: source['text'], at, evidence }
}

/** Coerce evidence into a string array; accepts one string, arrays, else undefined. */
function normalizeEvidence(value: unknown): string[] | undefined {
  if (typeof value === 'string') return value === '' ? undefined : [value]
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item !== '')
  return items.length === 0 ? undefined : items
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asOptionalEpoch(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function asSafeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Normalize one raw captains.json entry. Unknown keys survive the spread;
 * charter defaults to '' and createdAt defaults to first-seen time.
 */
export function normalizeCaptainEntry(raw: unknown): CaptainRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const { charter, sessionId, createdAt, lastDispatchAt, ...rest } = source
  return {
    ...rest,
    charter: typeof charter === 'string' ? charter : '',
    createdAt: asOptionalEpoch(createdAt) ?? Date.now(),
    ...(asOptionalString(sessionId) === undefined ? {} : { sessionId: sessionId as string }),
    ...(asOptionalEpoch(lastDispatchAt) === undefined ? {} : { lastDispatchAt: lastDispatchAt as number }),
  } as CaptainRecord
}

/**
 * Apply one report to a task record in place (shared by the identity-checked
 * captain path and the human manual-supplement path).
 *
 * Invariant (plan M5 / ADR-0003): a `needsFinalReview` task can never be
 * closed `done` through a report — the status clamps to `waiting-check` and
 * stays there until the user's final review closes it via set-status.
 */
export function applyReportToTask(
  task: TaskRecord,
  input: { status: Status; text: string; evidence?: string[]; at: number },
): void {
  task.report = {
    text: input.text,
    at: input.at,
    ...(input.evidence !== undefined && input.evidence.length > 0 ? { evidence: input.evidence } : {}),
  }
  task.status = task.needsFinalReview && input.status === 'done' ? 'waiting-check' : input.status
  task.updatedAt = input.at
}

/**
 * 项目管理器把一条待办落到卡片上（ADR-0012/0013）：问题 + 推荐答案，或一条已裁决的下一步。
 * 追加而非覆盖：卡片是历史，重复的同一句话不重复落。
 * @param task - 目标任务卡（就地修改）。
 * @param input.question - 待用户拍板的问题。
 * @param input.recommendation - 推荐答案；有它时 GUI 能「按建议继续」。
 * @param input.nextStep - 已裁决的下一步（项目管理器自己定的）。
 * @param input.at - 当前时间（epoch ms）。
 */
export function applyNoteToTask(
  task: TaskRecord,
  input: { question?: string; recommendation?: string; nextStep?: string; at: number },
): void {
  const question = input.question?.trim() ?? ''
  if (question !== '') {
    const questions = task.questions ?? []
    const duplicate = questions.some((item) => item.answer === undefined && item.text === question)
    if (!duplicate) {
      task.questions = [...questions, {
        id: randomUUID(),
        text: question,
        at: input.at,
        ...(input.recommendation !== undefined && input.recommendation.trim() !== ''
          ? { recommendation: input.recommendation.trim() }
          : {}),
      }]
      task.status = 'waiting-reply'
    }
  }
  const nextStep = input.nextStep?.trim() ?? ''
  if (nextStep !== '') {
    task.nextSteps = [...(task.nextSteps ?? []), { id: randomUUID(), text: nextStep, decidedBy: 'project-manager', at: input.at }]
  }
  task.updatedAt = input.at
}

/** 卡片上第一条没人回答的问题（没有则 undefined）。 */
export function firstOpenQuestion(task: TaskRecord): TaskQuestion | undefined {
  return task.questions?.find((item) => item.answer === undefined)
}

/**
 * 记录用户对某个问题的答复。答完最后一条未答问题时卡片回到进行中。
 * @param task - 目标任务卡（就地修改）。
 * @param input.questionId - 指定问题；省略时取还没答的第一条。
 * @param input.text - 答复正文（「按建议继续」传推荐值）。
 * @param input.at - 当前时间（epoch ms）。
 * @returns 被回答的那条问题。
 */
export function applyAnswerToTask(
  task: TaskRecord,
  input: { questionId?: string; text: string; at: number },
): TaskQuestion {
  const text = input.text.trim()
  if (text === '') throw new OrchestratorError('INVALID_INPUT', 'an answer is required')
  const target = input.questionId === undefined
    ? firstOpenQuestion(task)
    : task.questions?.find((item) => item.id === input.questionId)
  if (target === undefined) throw new OrchestratorError('INVALID_INPUT', 'the task has no question to answer')
  if (target.answer !== undefined) throw new OrchestratorError('INVALID_INPUT', 'that question is already answered')
  target.answer = { text, at: input.at }
  task.lastReply = { text, at: input.at }
  if (firstOpenQuestion(task) === undefined && task.status === 'waiting-reply') task.status = 'in-progress'
  task.updatedAt = input.at
  return target
}

/** 用户答复投给管理器的正文：带着问题原文，管理器不需要回头翻卡片。 */
export function buildAnswerText(input: { task: Pick<TaskRecord, 'id' | 'title'>; question: TaskQuestion; answer: string }): string {
  return [
    `【任务台·答复】${input.task.title}（${input.task.id}）`,
    '',
    `- 问题: ${input.question.text}`,
    `- 用户答复: ${input.answer}`,
    '',
    '按这条答复继续推进；还有别的待办就继续落在卡片上。',
  ].join('\n')
}

/** One fresh user-role message matching the M0 conclusion 2 frame (createUserMessage({content, source}) output shape). */
export interface OutboundUserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: Array<{ type: 'text'; text: string }>
  readonly source: { kind: 'plugin'; plugin: string }
}

/**
 * Build the outbound user message the way M0 conclusion 2 specifies
 * (`createUserMessage({ content, source })` from @deepseek-ai/dsh-llm produces
 * exactly `{ id, role: 'user', content, source }`). Constructed structurally
 * because the plugin declares no runtime dependency on dsh-llm; the value
 * shape is the contract Agent.followup/inject and subagents.followup consume.
 */
export function createOutboundMessage(content: string): OutboundUserMessage {
  return Object.freeze({
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text: content }],
    source: { kind: 'plugin' as const, plugin: 'dsh-task-manager' },
  })
}

/** The per-child persona text: 类别章程 + 任务简报 (定案补记/ADR-0003: charter rides persona). */
export function buildCharterPersona(input: {
  category: string
  charter: string
  task: Pick<TaskRecord, 'id' | 'title' | 'content' | 'directory' | 'needsFinalReview'>
}): string {
  return [
    `你是「队长·${input.category}」会话，负责类别 ${input.category} 的任务执行。`,
    '',
    '## 类别章程',
    input.charter.trim() === '' ? '（该类别暂无章程，按任务简报执行。）' : input.charter.trim(),
    '',
    '## 任务简报',
    `- taskId: ${input.task.id}`,
    `- 标题: ${input.task.title}`,
    `- 需求:`,
    input.task.content.trim(),
    `- 任务目录（你的工作目录；cwd 继承 Manager，务必在此目录内工作）: ${input.task.directory}`,
    `- 需终审: ${input.task.needsFinalReview ? '是（完成后回报，等待用户终审，勿自行关单）' : '否'}`,
    '',
    '## 纪律',
    '- 开工前用 task_claim 领取派发给你的任务。',
    '- 完成、受阻或需要澄清时，必须用 task_report 回报：状态 + 报告正文 + 证据路径（文件/命令输出等）。',
    '- 无证据的完成回报会被 Manager 打回。',
  ].join('\n')
}

/** The reuse-delivery brief: same task brief without repeating the charter (已在会话 persona 里). */
export function buildDispatchBrief(input: {
  category: string
  task: Pick<TaskRecord, 'id' | 'title' | 'content' | 'directory' | 'needsFinalReview'>
}): string {
  return [
    `【任务派发】类别 ${input.category}`,
    '',
    `- taskId: ${input.task.id}`,
    `- 标题: ${input.task.title}`,
    `- 需求:`,
    input.task.content.trim(),
    `- 任务目录（你的工作目录）: ${input.task.directory}`,
    `- 需终审: ${input.task.needsFinalReview ? '是（完成后回报，等待用户终审，勿自行关单）' : '否'}`,
    '',
    '开工前 task_claim 领取；完成或受阻时 task_report 回报（状态 + 报告 + 证据路径）。',
  ].join('\n')
}

/**
 * 「指派任务」投给大管理器的正文（ADR-0014）：大管理器只做路由，不动手。
 * @param text - 用户粘贴的任务正文。
 * @param cwdHint - 当前工作区目录，作为判断项目归属的提示。
 */
export function buildConsoleAssignment(text: string, cwdHint?: string, sources?: string[]): string {
  return [
    '【任务台·指派】用户把这件事交给你：',
    '',
    text.trim(),
    ...(cwdHint === undefined ? [] : ['', `- 指派时的工作目录提示: ${cwdHint}`]),
    ...(sources === undefined || sources.length === 0 ? [] : [`- 本单订阅的触发器: ${sources.join(' / ')}（派单时原样传给 task_dispatch_project 的 sources）`]),
    '',
    '你只做一件事：调用 task_dispatch_project 派给该项目的项目管理器。',
    '- project 填 git 仓库根路径；不确定就先调 task_console_state 看已有哪些项目。',
    '- 也不需要先跑 git 核对：传 cwd=上面的工作目录提示，host 会自己解析出仓库根。',
    '- 你没有 shell、没有文件读写，只能用 task_* 工具；不要输出工具格式的文本，直接发起工具调用。',
  ].join('\n')
}

/**
 * 项目管理器收到的任务简报（ADR-0014）。
 * @param input.task - 刚建好的任务卡。
 * @param input.project - 项目主键（git 根路径）。
 */
export function buildProjectBrief(input: {
  task: Pick<TaskRecord, 'id' | 'title' | 'content' | 'project' | 'sources'>
  project: string
}): string {
  const sources = input.task.sources !== undefined && input.task.sources.length > 0
    ? input.task.sources.join(' / ')
    : '无（只按本单内容执行）'
  return [
    `【新任务】${input.task.title}`,
    '',
    `- taskId: ${input.task.id}`,
    `- 项目: ${input.project}`,
    `- 订阅触发器: ${sources}`,
    `- 需求:`,
    input.task.content.trim(),
    '',
    '执行约束（ADR-0014 v0.1 允许清单，硬性）：只产 patch；不 push、不开 PR、不碰受保护分支、不跨仓库。',
    '需要动手时用 superagent 工具的 dispatch 动作派给执行会话（repo 填上面的项目路径），不要自己写代码。',
    '执行会话回报的「问题」和「下一步」要落回这张任务卡；你能按推荐且保险的方式决定的就直接决定并写清理由，定不了的才留给用户。',
  ].join('\n')
}

/**
 * 执行会话的开工简报（ADR-0014）。执行会话是普通 `standard` 会话，不是队长子会话。
 * @param input.task - 任务卡。
 * @param input.project - 项目主键（git 根）。
 */
export function buildExecutionBrief(input: {
  task: Pick<TaskRecord, 'id' | 'title' | 'content'>
  project: string
}): string {
  return [
    `【执行任务】${input.task.title}`,
    '',
    `- taskId: ${input.task.id}`,
    `- 项目: ${input.project}`,
    `- 需求:`,
    input.task.content.trim(),
    '',
    '允许清单（v0.1 硬性）：只产 patch；不 push、不开 PR、不碰受保护分支、不跨仓库。',
    '遇到必须由人拍板的选择，把问题写成一行「问题：…（建议：…）」，不要自行猜测继续。',
    '做完把结论与证据路径写清。',
  ].join('\n')
}

/** The user's reply from the task card, delivered to the conversation that asked. */
export function buildReplyText(input: {
  task: Pick<TaskRecord, 'id' | 'title'>
  text: string
}): string {
  return [
    '【用户回复】',
    `- taskId: ${input.task.id}`,
    `- 标题: ${input.task.title}`,
    '',
    input.text,
    '',
    '请据此继续推进；完成、受阻或还需澄清时用 task_report 回报（状态 + 报告 + 证据路径）。',
  ].join('\n')
}

/**
 * The task's execution report as a standalone Markdown document. Served by
 * GET /plugins/dsh-task-manager/report so the user can open it in a tab
 * instead of scraping the card.
 */
export function buildReportMarkdown(task: TaskRecord): string {
  const lines: string[] = [
    `# ${task.title}`,
    '',
    `- 任务 id: \`${task.id}\``,
    `- 状态: \`${task.status}\``,
    `- 目录: \`${task.directory}\``,
    `- 创建: ${new Date(task.createdAt).toISOString()}`,
    `- 更新: ${new Date(task.updatedAt).toISOString()}`,
  ]
  if (task.category !== undefined && task.category !== '') lines.push(`- 类别: ${task.category}`)
  if (task.captainSessionId !== undefined && task.captainSessionId !== '') {
    lines.push(`- 执行对话: \`${task.captainSessionId}\``)
    lines.push(`- 派发轮次: ${task.dispatchRound}`)
  }
  lines.push('', '## 任务内容', '', task.content.trim(), '', '## 执行汇报', '')
  if (task.report === undefined) {
    lines.push('（暂无汇报）')
  } else {
    lines.push(`_${new Date(task.report.at).toISOString()}_`, '', task.report.text.trim())
    if (task.report.evidence !== undefined && task.report.evidence.length > 0) {
      lines.push('', '### 证据', '')
      for (const item of task.report.evidence) lines.push(`- \`${item}\``)
    }
  }
  if (task.lastReply !== undefined) {
    lines.push('', '## 用户回复', '', `_${new Date(task.lastReply.at).toISOString()}_`, '', task.lastReply.text)
  }
  lines.push('')
  return lines.join('\n')
}

/** The nudge text delivered to the captain on nudge(taskId). */
export function buildNudgeText(input: {
  task: Pick<TaskRecord, 'id' | 'title' | 'status'>
}): string {
  return [
    '【催办】',
    `- taskId: ${input.task.id}`,
    `- 标题: ${input.task.title}`,
    `- 当前状态: ${input.task.status}`,
    '',
    '请立即回报进展或完成情况：task_report（状态 + 报告 + 证据路径）。无法推进也请回报受阻原因。',
  ].join('\n')
}
