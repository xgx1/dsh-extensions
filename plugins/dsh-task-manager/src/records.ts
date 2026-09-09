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
  createdAt: number
  updatedAt: number
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
