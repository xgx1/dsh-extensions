/**
 * dsh-task-manager — 纳管对话视图（ADR-0011）。
 *
 * 任务卡片不是第二份任务事实：它是 `session_manager` 持久化状态的一次派生渲染。
 * 那个域属于另一个插件、跨进程边界传来的是 `unknown`，所以这里做一次窄化解析，
 * 解析不出来就退化成「不可用」，绝不让面板崩掉（旧任务列表此时照常显示）。
 */

/**
 * 卡片状态。关系本身能给出「等待回复 / 已暂停」；「已完成 / 发生问题」来自
 * 工作对话自己发的 `manager_report`——一轮自动结束**不算**完成。
 */
export type ManagedStatus = 'in-progress' | 'done' | 'problem' | 'paused'

/** 待答问题的一项（来自工作对话原生提问的原始条目）。 */
export interface ManagedQuestionItem {
  id: string
  question: string
  header?: string
  /** 可选项标签；有选项时答复应当是其中之一。 */
  options?: string[]
}

/** 一张任务卡片。 */
export interface ManagedCard {
  workerId: string
  managerId: string
  workspaceId: string
  preset: string
  title: string
  status: ManagedStatus
  /** 待你答复的问题（最近一条 pending）；它不改变状态，只提示有几条在等你。 */
  question?: { id: string; items: ManagedQuestionItem[] }
  /** 待答问题条数，卡片上的「待你答复 · N」。 */
  pendingQuestions?: number
  /** 最近一轮的结束原因；仅作提示——一轮结束不代表任务完成。 */
  lastTurnOutcome?: string
}

/** 视图结果：域缺失时 `unavailable` 为 true，客户端据此回落到旧任务列表。 */
export interface ManagedView {
  cards: ManagedCard[]
  unavailable?: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const SHORT_ID_LENGTH = 8

/** 会话短码：与客户端 `shortSessionId` 同一套派生规则。 */
function shortId(sessionId: string): string {
  return sessionId.replace(/^session-/, '').slice(0, SHORT_ID_LENGTH) || sessionId.slice(0, SHORT_ID_LENGTH)
}

/** 卡片标题取建单消息的首个非空行；没有建单记录时回落短码。 */
function titleFor(workerId: string, creations: Record<string, unknown>): string {
  for (const value of Object.values(creations)) {
    if (!isRecord(value) || value['workerId'] !== workerId) continue
    const message = text(value['message'])
    if (message === undefined) continue
    const first = message.split('\n').map((line) => line.trim()).find((line) => line !== '')
    if (first === undefined) continue
    return first.length > 60 ? `${first.slice(0, 60)}…` : first
  }
  return shortId(workerId)
}

/** 解析一条 pending 问题；选项只保留标签。 */
function questionFor(
  workerId: string,
  questions: Record<string, unknown>,
): { id: string; items: ManagedQuestionItem[] } | undefined {
  for (const value of Object.values(questions)) {
    if (!isRecord(value) || value['workerId'] !== workerId) continue
    if (value['status'] !== 'pending') continue
    const raw = value['questions']
    const items: ManagedQuestionItem[] = []
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!isRecord(item)) continue
        const id = text(item['id'])
        const question = text(item['question'])
        if (id === undefined || question === undefined) continue
        const header = text(item['header'])
        const options = Array.isArray(item['options'])
          ? item['options']
            .map((option) => (isRecord(option) ? text(option['label']) : undefined))
            .filter((label): label is string => label !== undefined)
          : undefined
        items.push({
          id,
          question,
          ...(header === undefined ? {} : { header }),
          ...(options === undefined || options.length === 0 ? {} : { options }),
        })
      }
    }
    if (items.length === 0) continue
    const id = text(value['id']) ?? workerId
    return { id, items }
  }
  return undefined
}

const STATUS_ORDER: Record<ManagedStatus, number> = { paused: 0, problem: 1, 'in-progress': 2, done: 3 }

/**
 * 把 `session_manager` 的 global 状态映射成卡片。
 * @param state - `storageDomain.get('session_manager')?.global.get()` 的原始值。
 * @returns 卡片列表；状态缺失或形状不认识时返回 `unavailable`。
 */
export function readManagedCards(state: unknown): ManagedView {
  if (!isRecord(state)) return { cards: [], unavailable: true }
  const links = state['links']
  if (!isRecord(links)) return { cards: [], unavailable: true }
  const creations = isRecord(state['creations']) ? state['creations'] : {}
  const questions = isRecord(state['questions']) ? state['questions'] : {}

  const cards: ManagedCard[] = []
  for (const value of Object.values(links)) {
    if (!isRecord(value)) continue
    const workerId = text(value['workerId'])
    const managerId = text(value['managerId'])
    if (workerId === undefined || managerId === undefined) continue
    if (value['detached'] === true) continue
    const question = questionFor(workerId, questions)
    // 提问不再阻塞任何东西（ADR-0012）：它只是待办提示，不是任务状态。
    const status: ManagedStatus = value['paused'] === true ? 'paused' : 'in-progress'
    cards.push({
      workerId,
      managerId,
      workspaceId: text(value['workspaceId']) ?? '',
      preset: text(value['agentPreset']) ?? '',
      title: titleFor(workerId, creations),
      status,
      ...(question === undefined ? {} : { question, pendingQuestions: question.items.length }),
    })
  }
  cards.sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
    || left.title.localeCompare(right.title))
  return { cards }
}

/**
 * 路由过来的正文是 session-manager 的 JSON 信封（`{type, outcome, summary}`）。
 * 文档是给人看的，能拆就拆成「本轮结束（completed）」+ 摘要；拆不动就原样引用。
 * @param body - 一条路由消息的正文。
 * @returns 适合放进 Markdown 的正文。
 */
function formatReportBody(body: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (!isRecord(parsed)) return body
  const summary = text(parsed['summary'])
  if (summary === undefined) return body
  const kind = text(parsed['type'])
  const outcome = text(parsed['outcome'])
  const headline = kind === 'turn-ended'
    ? `本轮结束${outcome === undefined ? '' : `（${outcome}）`}`
    : kind === undefined ? '' : kind
  return headline === '' ? summary : `**${headline}**

${summary}`
}

/** 一条已投递给管理端的消息（只取需要的字段）。 */
interface RoutedEventLike {
  type?: unknown
  data?: {
    source?: { kind?: unknown; workerSessionId?: unknown }
    content?: unknown
  }
}

/** 取出一条路由消息的正文。 */
function bodyOf(event: RoutedEventLike): string | undefined {
  const content = event.data?.content
  if (!Array.isArray(content)) return undefined
  const joined = content
    .map((block) => (isRecord(block) ? text(block['text']) : undefined))
    .filter((part): part is string => part !== undefined)
    .join('\n')
    .trim()
  return joined === '' ? undefined : joined
}

/**
 * 用工作对话自己的显式回报覆盖卡片状态。
 * 只看 `explicit-report`：`turn-ended` 是「这一轮结束」，不是完成（设计红线）。
 * @param cards - 从纳管关系派生出来的卡片。
 * @param events - 管理会话日志里的完整事件（可来自多个管理对话）。
 * @returns 新数组；等待回复与已暂停的卡片不受影响。
 */
export function applyLatestReports(cards: readonly ManagedCard[], events: readonly unknown[]): ManagedCard[] {
  const latest = new Map<string, 'progress' | 'completed' | 'blocked'>()
  const lastTurn = new Map<string, string>()
  for (const event of events as readonly RoutedEventLike[]) {
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== 'session-manager') continue
    const workerId = text(source.workerSessionId)
    if (workerId === undefined) continue
    const body = bodyOf(event)
    if (body === undefined) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    if (parsed['type'] === 'turn-ended') {
      const outcome = text(parsed['outcome'])
      if (outcome !== undefined) lastTurn.set(workerId, outcome)
      continue
    }
    if (parsed['type'] !== 'explicit-report') continue
    const status = parsed['status']
    if (status === 'progress' || status === 'completed' || status === 'blocked') latest.set(workerId, status)
  }
  if (latest.size === 0 && lastTurn.size === 0) return [...cards]
  return cards.map((card) => {
    const outcome = lastTurn.get(card.workerId)
    const next: ManagedCard = outcome === undefined ? card : { ...card, lastTurnOutcome: outcome }
    if (card.status === 'paused') return next
    const reported = latest.get(card.workerId)
    if (reported === undefined) return next
    const status: ManagedStatus = reported === 'completed' ? 'done' : reported === 'blocked' ? 'problem' : 'in-progress'
    return { ...next, status }
  })
}

/** 管理会话日志里一条已投递给管理端的消息（只取报告需要的字段）。 */
interface ReportEventLike {
  type?: unknown
  data?: {
    source?: { kind?: unknown; workerSessionId?: unknown }
    content?: unknown
  }
}

const REPORT_LIMIT = 5

/**
 * 把该工作对话被路由给管理端的最近几条消息折成 Markdown 汇报。
 * @param card - 目标卡片。
 * @param events - `sessionQuery.listEvents(managerId)` 的返回值（原始事件）。
 * @returns 一份可直接下发的 Markdown 文档；没有回报时如实写明。
 */
export function buildManagedReportMarkdown(card: ManagedCard, events: readonly unknown[]): string {
  const reports: string[] = []
  const typed = events as readonly ReportEventLike[]
  for (const event of typed) {
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== 'session-manager' || source.workerSessionId !== card.workerId) continue
    const content = event.data?.content
    if (!Array.isArray(content)) continue
    const body = content
      .map((block) => (isRecord(block) ? text(block['text']) : undefined))
      .filter((part): part is string => part !== undefined)
      .join('\n')
      .trim()
    if (body !== '') reports.push(body)
  }
  const tail = reports.slice(-REPORT_LIMIT).map(formatReportBody)
  const lines: string[] = [
    `# ${card.title}`,
    '',
    `- 执行对话: \`${card.workerId}\``,
    `- 管理对话: \`${card.managerId}\``,
    `- 状态: \`${card.status}\``,
    `- 预设: ${card.preset === '' ? '（未知）' : card.preset}`,
    '',
    '## 执行汇报',
    '',
  ]
  if (tail.length === 0) lines.push('暂无回报。')
  else for (const report of tail) lines.push(report, '')
  lines.push('')
  return lines.join('\n')
}
