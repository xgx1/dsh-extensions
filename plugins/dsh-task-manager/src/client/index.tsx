/**
 * dsh-task-manager — browser half.
 *
 * Two contributions, both additive over the official GUI:
 *  1. A sidebar panel entry ("task-manager"), seated in the sidebar icon row at
 *     the same level as the other plugin pages.
 *  2. A `main` panel behind that entry, rendering the full task console: a
 *     new-task dialog, the task list, and a task detail view.
 *
 * The panel talks to the host half over same-origin HTTP routes on
 * `/plugins/dsh-task-manager/*`. Nothing in this half touches the filesystem;
 * task state and worktree operations live entirely on the host.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentType, ReactElement } from 'react'


/** Required services: the slot registry and the locale dictionaries. */
export const inject = ['slots', 'locale'] as const

/** Namespace for the locale dictionaries registered into the official locale service. */
const NS = 'dshTaskManager'

interface LocaleSnapshot {
  readonly id: string
}
interface Translate {
  (key: string): string
}
interface Slots {
  inject(name: string, register: () => void | (() => void)): void
  /** Seat options: `id` for list slots, `key` for the keyed `main` slot. */
  register(
    options: {
      readonly name: string
      readonly id?: string
      readonly key?: string
      readonly order?: number
      readonly label?: string | (() => string)
      /** Locale namespace the seat re-renders on. */
      readonly locale?: string
    },
    component: ComponentType<any>,
  ): () => void
}
interface Locale {
  register(
    namespace: string,
    dictionaries: { readonly zh: Record<string, string>; readonly en: Record<string, string> },
  ): () => void
  bind(namespace: string): Translate
  getLocale(): LocaleSnapshot
  subscribe(callback: () => void): () => void
}
interface ClientContext {
  effect(factory: () => void | (() => void), label?: string): void
  slots: Slots
  locale: Locale
}

/** Task status vocabulary, aligned with the host half. */
type Status = 'not-started' | 'in-progress' | 'waiting-reply' | 'problem' | 'waiting-check' | 'done'
type RunMode = 'cwd' | 'new-worktree' | 'existing-worktree'

interface ConversationSummary {
  id: string
  shortId: string
  cwd?: string
  createdAt?: number
  origin?: string
}
/** Latest captain report (覆盖式：a new report replaces the previous one). */
interface TaskReport {
  text: string
  at: number
  evidence?: string[]
}
interface Task {
  id: string
  title: string
  content: string
  status: Status
  runMode: RunMode
  directory: string
  worktreeBranch?: string
  conversations?: ConversationSummary[]
  /** 队长类别；首次派发时写入（t8 契约）。 */
  category?: string
  /** 派发到的队长会话 id；与 captains.json 中该类别的 sessionId 一致（t8 契约）。 */
  captainSessionId?: string
  /** 派发轮次：0 = 从未派发；每次成功 assign +1（含同单重派）。 */
  dispatchRound: number
  /** 最近一次队长回报（覆盖式）。 */
  report?: TaskReport
  /** 需终审：队长的 done 回报被钳制为 waiting-check，等用户终审后经 set-status 关单。 */
  needsFinalReview: boolean
  /** 最近一次催办时间（epoch ms）。 */
  lastNudgeAt?: number
  /** 用户在任务卡片回复框里发出的最近一次回答。 */
  lastReply?: { text: string; at: number }
  /** 所属项目管理器会话（ADR-0014 两层管理器）。 */
  consoleSessionId?: string
  /** 项目主键：git 仓库根路径。 */
  project?: string
  /** 本单订阅的触发器键（配置挂项目，任务只引用）。 */
  sources?: string[]
  /** 任务分支合回项目分支后的提交 id（`setStatus(done)` 副作用）。 */
  mergeCommit?: string
  /** 待你拍板的问题（ADR-0012：非阻塞，落在卡片上）。 */
  questions?: TaskQuestion[]
  /** 项目管理器已裁决的下一步。 */
  nextSteps?: TaskNextStep[]
  createdAt: number
  updatedAt: number
}
interface TaskQuestion {
  id: string
  text: string
  /** 推荐答案；「按建议继续」就是把这段原样答复回去。 */
  recommendation?: string
  at: number
  answer?: { text: string; at: number }
}
interface TaskNextStep {
  id: string
  text: string
  decidedBy: 'project-manager' | 'human'
  at: number
}

/** 纳管对话的卡片（来自 session-manager 的状态派生，不是本插件自己存的任务）。 */
type ManagedStatus = 'in-progress' | 'done' | 'problem' | 'paused'
interface ManagedQuestionItem {
  id: string
  question: string
  header?: string
  options?: string[]
}
interface ManagedCard {
  workerId: string
  managerId: string
  workspaceId: string
  preset: string
  title: string
  status: ManagedStatus
  question?: { id: string; items: ManagedQuestionItem[] }
  /** 最近一轮的结束原因；仅作提示，一轮结束不代表任务完成。 */
  lastTurnOutcome?: string
  /** 待你答复的问题条数；提问不阻塞工作，所以它只是个提示。 */
  pendingQuestions?: number
}
interface ManagedView {
  cards: ManagedCard[]
  unavailable?: true
}

interface WorktreeRow {
  path: string
  branch?: string
  head?: string
  isCurrent: boolean
}
interface ContextInfo {
  currentDir: string
  repoRoot: string | null
  workspaces: Array<{ title: string; path: string }>
  worktrees: WorktreeRow[]
}

/** Locale dictionaries; fallback is English. */
const dicts: Record<string, Record<string, string>> = {
  en: {
    sideLabel: 'Task Commander',
    tabLabel: 'Task Commander',
    panelTitle: 'Tasks',
    newTask: 'New task',
    close: 'Close',
    create: 'Create',
    back: 'Back',
    title: 'Title',
    content: 'Content',
    autoTitle: 'Generate title',
    runLocation: 'Run in',
    runCwd: 'Current directory',
    runNewWorktree: 'Create a worktree',
    runExistingWorktree: 'Use an existing worktree',
    branch: 'Branch name',
    worktree: 'Worktree',
    directory: 'Directory',
    status: 'Status',
    conversations: 'Conversations that took over this task',
    empty: 'No tasks yet. Click “New task” to create one.',
    loading: 'Loading…',
    loadError: 'Failed to load tasks.',
    authExpired: 'Session expired: reopen DSH Web with the current token link.',
    createError: 'Failed to create the task.',
    noConversations: 'No conversation has run in this task’s directory yet.',
    statusNotStarted: 'Not started',
    statusInProgress: 'In progress',
    statusWaitingReply: 'Waiting for reply',
    statusProblem: 'Problem',
    statusWaitingCheck: 'Ready to test',
    statusDone: 'Done',
    createdAt: 'Created',
    updatedAt: 'Updated',
    noRepo: 'Current directory is not a git repository.',
    category: 'Category',
    allCategories: 'All categories',
    uncategorized: 'Uncategorized',
    emptyFiltered: 'No tasks in this category.',
    orchestration: 'Orchestration',
    captainSession: 'Captain session',
    dispatchRound: 'Dispatch round',
    notDispatched: 'Not dispatched',
    latestReport: 'Latest report',
    noReport: 'No captain report yet.',
    evidence: 'Evidence',
    needsFinalReview: 'Final review required',
    needsFinalReviewHint: 'When enabled, a captain’s done report is clamped to “Waiting for check” until you close the task after your final review.',
    openConversation: 'Open conversation',
    statusPaused: 'Paused',
    managedTurnEnded: 'Turn ended',
    managedSection: 'Managed conversations',
    managedUnavailable: 'This instance has no session_manager domain, so the managed-session view is off. The task list below still works.',
    managedQuestion: 'Waiting for your answer',
    managedReplyHint: 'Your answer goes to the manager conversation, not to this panel.',
    managedNoQuestions: 'No pending question.',
    executionReport: 'Execution report',
    reportSectionContent: 'Task',
    reportSectionReport: 'Execution report',
    reportSectionReply: 'My reply',
    reportEmpty: '(no report yet)',
    reportClose: 'Close',
    reportCopy: 'Copy Markdown',
    reportOpenTab: 'Open in tab',
    reportCopied: 'Copied',
    reportFailed: 'Could not load report: ',
    pendingQuestion: 'Waiting for your reply',
    replyPlaceholder: 'Type your answer here…',
    sendReply: 'Send reply',
    assignTitle: 'Hand a task to the managers',
    assignPlaceholder: 'Paste the job here. The global manager picks the project and hands it to that project’s manager.',
    assignButton: 'Assign',
    assignSent: 'Sent to the global manager.',
    assignError: 'Failed to hand the task over.',
    todoOnly: 'Needs me',
    allTasks: 'All',
    filterAll: 'All',
    filterAssigned: 'Assigned',
    filterQuestions: 'Questions',
    filterNext: 'Next steps',
    filterRunning: 'Running',
    mergedCommit: 'Merged as',
    byProject: 'By project',
    superAgentLabel: 'Super Agent',
    superAgentMissing: 'Super Agent: not mounted in this instance',
    superAgentPaused: 'paused',
    superAgentDecisions: 'router decisions',
    projectTasks: 'tasks',
    noProjects: 'No project has a task yet.',
    questionsSection: 'Questions',
    nextStepsSection: 'Next steps',
    projectLabel: 'Project',
    managerSession: 'Project manager',
    startExecution: 'Start execution',
    resumeExecution: 'Resume execution',
    executionStarted: 'Execution session ready.',
    questions: 'Waiting for you',
    recommendation: 'Suggested',
    adoptRecommendation: 'Go with the suggestion',
    answerPlaceholder: 'Or answer it yourself…',
    answerButton: 'Answer',
    nextSteps: 'Decided next steps',
    project: 'Project',
    replyError: 'Failed to send the reply.',
    lastReply: 'Your last reply',
  },
  zh: {
    sideLabel: '任务管理',
    tabLabel: '任务管理',
    panelTitle: '任务列表',
    newTask: '新建任务',
    close: '关闭',
    create: '创建',
    back: '返回',
    title: '标题',
    content: '任务内容',
    autoTitle: '生成标题',
    runLocation: '运行位置',
    runCwd: '当前目录运行',
    runNewWorktree: '创建 worktree 运行',
    runExistingWorktree: '选择已创建的 worktree 运行',
    branch: '分支名',
    worktree: 'Worktree',
    directory: '目录',
    status: '任务状态',
    conversations: '接手过此任务的对话',
    empty: '还没有任务，点击「新建任务」创建一个。',
    loading: '加载中…',
    loadError: '任务加载失败。',
    authExpired: '登录已失效：这个标签页用的是旧 token。请用 dev 实例当前 token 的链接重新打开。',
    createError: '任务创建失败。',
    noConversations: '还没有对话在这个任务的目录里运行。',
    statusNotStarted: '未开始',
    statusInProgress: '进行中',
    statusWaitingReply: '等待回复',
    statusProblem: '发生问题',
    statusWaitingCheck: '待测试',
    statusDone: '已完成',
    createdAt: '创建时间',
    updatedAt: '更新时间',
    noRepo: '当前目录不在 git 仓库里。',
    category: '类别',
    allCategories: '全部类别',
    uncategorized: '未分类',
    emptyFiltered: '该类别下暂无任务。',
    orchestration: '编排信息',
    captainSession: '队长会话',
    dispatchRound: '派发轮次',
    notDispatched: '未派发',
    latestReport: '最近回报',
    noReport: '尚无队长回报。',
    evidence: '证据路径',
    needsFinalReview: '需终审',
    needsFinalReviewHint: '勾选后，完成回报会停在「待测试」，要你验收（关单时会自动把任务分支合回项目）。',
    openConversation: '打开对话',
    statusPaused: '已暂停',
    managedTurnEnded: '本轮已结束',
    managedSection: '纳管对话',
    managedUnavailable: '本实例没启用 session_manager（dev 组成里已移除），管理会话视图不可用；下面的任务列表照常工作。',
    managedQuestion: '等待你的答复',
    managedReplyHint: '答复会送进管理对话，不留在本面板。',
    managedNoQuestions: '当前没有待答问题。',
    executionReport: '执行汇报',
    reportSectionContent: '任务内容',
    reportSectionReport: '执行汇报',
    reportSectionReply: '我的回复',
    reportEmpty: '（暂无汇报）',
    reportClose: '关闭',
    reportCopy: '复制 Markdown',
    reportOpenTab: '新标签打开',
    reportCopied: '已复制',
    reportFailed: '读取汇报失败：',
    pendingQuestion: '等待你的回复',
    replyPlaceholder: '在这里回复…',
    sendReply: '发送回复',
    assignTitle: '把任务交给管理器',
    assignPlaceholder: '把要做的事贴在这里。大管理器判断属于哪个项目，再交给该项目的项目管理器。',
    projectPath: '项目路径',
    projectPathPlaceholder: '项目路径（绝对路径，留空则从任务正文里找）',
    assignButton: '派下去',
    assignSent: '已交给大管理器。',
    assignError: '派发失败。',
    todoOnly: '待我处理',
    allTasks: '全部',
    filterAll: '全部',
    filterAssigned: '已指派',
    filterQuestions: '问题',
    filterNext: '下一步',
    filterRunning: '运行中',
    mergedCommit: '已合入提交',
    byProject: '按项目',
    superAgentLabel: 'Super Agent',
    superAgentMissing: 'Super Agent：本实例没挂',
    superAgentPaused: '已暂停',
    superAgentDecisions: '次路由决策',
    projectTasks: '任务',
    noProjects: '还没有任何项目有任务。',
    questionsSection: '问题',
    nextStepsSection: '下一步',
    projectLabel: '项目',
    managerSession: '项目管理器',
    startExecution: '起执行会话',
    resumeExecution: '继续执行会话',
    executionStarted: '执行会话已就绪。',
    questions: '等你拍板',
    recommendation: '建议',
    adoptRecommendation: '按建议继续',
    answerPlaceholder: '或者自己答一句…',
    answerButton: '答复',
    nextSteps: '已定的下一步',
    project: '项目',
    replyError: '回复发送失败。',
    lastReply: '你上次的回复',
  },
}

const STATUSES: Status[] = ['not-started', 'in-progress', 'waiting-reply', 'problem', 'waiting-check', 'done']

/** Category-filter sentinel for tasks without a category (「未分类」). */
const UNCATEGORIZED = '__uncategorized__'

const STATUS_CLASS: Record<Status, string> = {
  'not-started': 'dsh-taskm-badge-muted',
  'in-progress': 'dsh-taskm-badge-active',
  'waiting-reply': 'dsh-taskm-badge-wait',
  'problem': 'dsh-taskm-badge-danger',
  'waiting-check': 'dsh-taskm-badge-check',
  'done': 'dsh-taskm-badge-ok',
}

/** Translator bound once by apply; read by the stateless TaskView component. */
let translate: Translate = (key) => key

/** Shared fetch helpers against the host half's same-origin routes. */
async function getJSON<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin' })
  const body: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = (body as { error?: string }).error ?? `HTTP ${response.status}`
    // 带上状态码：401 要单独说明"登录已失效"，不能笼统报成插件不可用。
    throw Object.assign(new Error(message), { status: response.status })
  }
  return body as T
}

async function postJSON<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = (body as { error?: string }).error ?? `HTTP ${response.status}`
    throw new Error(message)
  }
  return body as T
}

/** Derive a short title from task content: first meaningful line, prefixes stripped. */
function autoTitle(content: string): string {
  const first = content.split(/\n+/).map((line) => line.trim()).find((line) => line !== '')
  if (first === undefined) return ''
  const cleaned = first.replace(/^[#>*\-\d.\s]+/, '').trim()
  const text = cleaned === '' ? first : cleaned
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/** Collapse the home directory to `~` for compact display. */
function shortPath(path: string): string {
  if (path.startsWith('/home/')) {
    const parts = path.split('/')
    return `~/${parts.slice(3).join('/')}`
  }
  return path
}

/** Short display code for a captain session id (same derivation as the host half). */
function shortSessionId(id: string): string {
  return id.replace(/^session-/, '').slice(0, 8) || id.slice(0, 8)
}

function timeText(value: number): string {
  // 调用方给的可能是秒（会话元数据）也可能是毫秒（任务卡），统一按毫秒算。
  const ms = value > 0 && value < 1e12 ? value * 1000 : value
  const delta = Date.now() - ms
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return `${Math.floor(delta / 86_400_000)} 天前`
}

function statusLabel(t: Translate, status: Status): string {
  const key = `status${status.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')}`
  return t(key)
}

function runModeLabel(t: Translate, mode: RunMode): string {
  if (mode === 'cwd') return t('runCwd')
  if (mode === 'new-worktree') return t('runNewWorktree')
  return t('runExistingWorktree')
}

/** Inline icon normalized to the shell's 18px navigation glyph size. */
const ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M6.5 6.5v7"/></svg>'
/** Sidebar panel icon for the task console (same glyph the old row entry used). */
function SidebarIcon(props: { size?: number }): ReactElement {
  const size = props.size ?? 18
  return (
    <svg
      viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M6.5 6.5v7" />
    </svg>
  )
}

const BACK_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg>'

/*
 * Component CSS. Colors come exclusively from the `--dsw-alias-*` semantic
 * tokens (all of which flip with the light/dark theme); this file writes no
 * theme-selector overrides. The one component-local custom property
 * (`--dsh-taskm-check-accent`) is a presentation-only derivation of theme
 * tokens for the "等待检查" badge, allowed to live on the component root.
 */
const CSS = `
.dsh-taskm-side{display:flex;align-items:center;gap:8px;width:100%;height:34px;padding:0 12px;box-sizing:border-box;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;white-space:nowrap;font:inherit;font-size:13px;line-height:20px;flex:none}
.dsh-taskm-side:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-taskm-side .dsh-taskm-side-icon{display:inline-flex;flex:none;width:18px;height:18px;align-items:center;justify-content:center}
.dsh-taskm-side .dsh-taskm-side-label{overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.dsh-taskm-main{--dsh-taskm-check-accent:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-state-error-primary));display:flex;min-height:100%;flex-direction:column;box-sizing:border-box;padding:20px 24px;color:var(--dsw-alias-label-primary)}
.dsh-taskm-main-head{display:flex;align-items:center;gap:12px;padding-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dsh-taskm-main-create{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 14px;box-sizing:border-box;border:none;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);cursor:pointer;font:inherit;font-size:13px;font-weight:600;line-height:20px;white-space:nowrap;flex:none}
.dsh-taskm-main-create:hover{background:var(--dsw-alias-button-primary-hover)}
.dsh-taskm-main-create:active{filter:brightness(.95)}
.dsh-taskm-main-title{font-size:16px;font-weight:650;line-height:22px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.dsh-taskm-main-body{flex:1;padding-top:14px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow:auto}

.dsh-taskm-empty{display:flex;flex-direction:column;align-items:center;gap:12px;padding:72px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.dsh-taskm-empty-mark{display:grid;place-items:center;width:44px;height:44px;border:1px dashed var(--dsw-alias-border-l2);border-radius:14px;color:var(--dsw-alias-label-secondary)}
.dsh-taskm-list{display:flex;flex-direction:column;gap:10px;width:100%}
.dsh-taskm-item{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;transition:border-color .16s ease}
.dsh-taskm-item:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 38%,var(--dsw-alias-border-l1))}
.dsh-taskm-row{display:flex;flex-direction:column;gap:6px;width:100%;padding:14px 16px 12px;box-sizing:border-box;border:none;border-radius:0;background:transparent;color:inherit;cursor:pointer;text-align:left;font:inherit}
.dsh-taskm-row:hover{background:transparent}
.dsh-taskm-row-head{display:flex;align-items:center;gap:10px;width:100%;min-width:0}
.dsh-taskm-row-title{flex:1;min-width:0;font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-taskm-row-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.dsh-taskm-row-question{font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dsh-taskm-item-foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 16px;padding:10px 0 12px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-taskm-chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;letter-spacing:.02em;flex:none}
.dsh-taskm-pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap;flex:none}
.dsh-taskm-pill::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.dsh-taskm-link{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;text-decoration:none;transition:background-color .14s ease,color .14s ease}
.dsh-taskm-link:hover{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary)}
.dsh-taskm-reply{display:flex;flex-direction:column;gap:10px;margin:0 16px 14px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dsh-taskm-reply-question{display:flex;flex-direction:column;gap:4px}
.dsh-taskm-textarea-sm{min-height:76px}

.dsh-taskm-badge{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:11px;font-size:12px;line-height:1;white-space:nowrap;flex:none}
.dsh-taskm-badge-muted{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 16%,transparent);color:var(--dsw-alias-label-secondary)}
.dsh-taskm-badge-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent);color:var(--dsw-alias-brand-primary)}
.dsh-taskm-badge-wait{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary)}
.dsh-taskm-badge-danger{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 15%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsh-taskm-badge-check{background:color-mix(in srgb,var(--dsh-taskm-check-accent) 15%,transparent);color:var(--dsh-taskm-check-accent)}
.dsh-taskm-badge-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 15%,transparent);color:var(--dsw-alias-state-success-primary)}

.dsh-taskm-detail{display:flex;flex-direction:column;gap:14px}
.dsh-taskm-back{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px}
.dsh-taskm-back:hover{background:var(--dsw-alias-button-ghost-active-fill)}
.dsh-taskm-detail-title{font-size:18px;font-weight:700;line-height:24px;color:var(--dsw-alias-label-primary)}
.dsh-taskm-detail-meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-taskm-detail-content{white-space:pre-wrap;word-break:break-word;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:21px}
.dsh-taskm-detail-section{display:flex;flex-direction:column;gap:6px}
.dsh-taskm-detail-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsh-taskm-status-select{height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dsh-taskm-conversation{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);font-size:12px}
.dsh-taskm-conv-id{padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,monospace}
.dsh-taskm-conv-meta{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.dsh-taskm-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,black 45%,transparent)}
.dsh-taskm-dialog{width:min(560px,calc(100vw - 48px));max-height:calc(100vh - 64px);overflow:auto;display:flex;flex-direction:column;gap:14px;padding:18px;border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 16px 48px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary)}
.dsh-taskm-dialog-title{font-size:16px;font-weight:700;margin:0;color:var(--dsw-alias-label-primary)}
.dsh-taskm-report-dialog{width:min(860px,calc(100vw - 64px));max-height:calc(100vh - 80px);overflow:hidden}
.dsh-taskm-report-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-taskm-report-head .dsh-taskm-dialog-title{flex:1 1 240px;min-width:0}
.dsh-taskm-report-actions{display:flex;align-items:center;gap:10px}
.dsh-taskm-report-body{overflow:auto;min-height:0;padding-right:4px;font-size:13px;line-height:1.6}
.dsh-taskm-report-meta{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0 0 14px;font-size:12px}
.dsh-taskm-report-meta dt{color:var(--dsw-alias-label-secondary)}
.dsh-taskm-report-meta dd{margin:0;min-width:0;overflow-wrap:anywhere}
.dsh-taskm-report-section{margin:16px 0 6px;font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary)}
.dsh-taskm-report-time{margin:0 0 6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-taskm-report-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-taskm-report-evidence-list{margin:8px 0 0;padding-left:18px}
.dsh-taskm-report-evidence-list code{font-size:12px;overflow-wrap:anywhere}
.dsh-taskm-field{display:flex;flex-direction:column;gap:6px}
.dsh-taskm-field-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsh-taskm-input{width:100%;box-sizing:border-box;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dsh-taskm-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsh-taskm-textarea{width:100%;box-sizing:border-box;min-height:120px;resize:vertical;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.dsh-taskm-textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsh-taskm-title-row{display:flex;gap:8px;align-items:center}
.dsh-taskm-title-row .dsh-taskm-input{flex:1}
.dsh-taskm-ghost{display:inline-flex;align-items:center;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);color:var(--dsw-alias-brand-primary);cursor:pointer;font:inherit;font-size:12px;white-space:nowrap}
.dsh-taskm-ghost:hover{background:var(--dsw-alias-button-ghost-active-fill)}
.dsh-taskm-radio{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;cursor:pointer}
.dsh-taskm-radio:hover{border-color:var(--dsw-alias-brand-primary)}
.dsh-taskm-radio input{margin:0;accent-color:var(--dsw-alias-brand-primary)}
.dsh-taskm-radios{display:flex;flex-direction:column;gap:6px}
.dsh-taskm-error{padding:10px 12px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);font-size:13px}
.dsh-taskm-footer{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}
.dsh-taskm-primary{display:inline-flex;align-items:center;height:34px;padding:0 16px;border:none;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);cursor:pointer;font:inherit;font-size:13px;font-weight:600}
.dsh-taskm-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsh-taskm-primary:disabled{opacity:.55;cursor:not-allowed}
.dsh-taskm-secondary{display:inline-flex;align-items:center;height:34px;padding:0 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px}
.dsh-taskm-secondary:hover{background:var(--dsw-alias-button-ghost-active-fill)}
.dsh-taskm-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-taskm-filter{height:30px;padding:0 8px;box-sizing:border-box;max-width:200px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;flex:none}
.dsh-taskm-kv{display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:20px}
.dsh-taskm-kv-row{display:flex;gap:10px;align-items:baseline}
.dsh-taskm-kv-key{flex:none;min-width:72px;color:var(--dsw-alias-label-secondary)}
.dsh-taskm-kv-value{color:var(--dsw-alias-label-primary);word-break:break-all}
.dsh-taskm-report{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dsh-taskm-report-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-taskm-report-text{white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dsh-taskm-evidence{display:flex;flex-direction:column;gap:2px}
.dsh-taskm-evidence-item{font-family:ui-monospace,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dsh-taskm-checkbox{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary)}
.dsh-taskm-checkbox:hover{border-color:var(--dsw-alias-brand-primary)}
.dsh-taskm-checkbox input{margin:0;accent-color:var(--dsw-alias-brand-primary)}
`

/**
 * Install plugin-owned styles and remove them when the plugin unloads.
 * @returns a disposer removing the injected stylesheet.
 */
export function installStyles(): () => void {
  const existing = document.getElementById('dsh-task-manager-styles')
  if (existing !== null) return () => undefined
  const style = document.createElement('style')
  style.id = 'dsh-task-manager-styles'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}

/**
 * Activate the task view: find the conversation header view tab whose label
 * matches and click it (same mechanism as the official Automations tab).
 * @param t - locale translator for the view tab label.
 * @returns whether a matching tab was found and clicked.
 */
export function activateTaskView(t: Translate): boolean {
  const expected = t('tabLabel').trim().replace(/\s+/g, ' ')
  const tabs = document.querySelectorAll<HTMLElement>('[role="tab"]')
  for (const tab of tabs) {
    const label = (tab.textContent ?? '').trim().replace(/\s+/g, ' ')
    if (label === expected) {
      tab.click()
      return true
    }
  }
  return false
}

/** New-task dialog. Local state only; creates through the host on submit. */
function NewTaskDialog(props: {
  sessionId?: string
  context: ContextInfo
  onClose: () => void
  onCreated: (task: Task) => void
}): ReactElement {
  const [title, setTitle] = useState('')
  const [titleEdited, setTitleEdited] = useState(false)
  const [content, setContent] = useState('')
  const [runMode, setRunMode] = useState<RunMode>('cwd')
  const [branch, setBranch] = useState('')
  const [worktreePath, setWorktreePath] = useState(props.context.worktrees[0]?.path ?? '')
  const [directory, setDirectory] = useState(props.context.currentDir)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [needsFinalReview, setNeedsFinalReview] = useState(false)

  const handleContent = (value: string): void => {
    setContent(value)
    // Auto-generate the title from the content and keep it in sync while the
    // user has not hand-edited it (or has cleared it back to empty).
    if (!titleEdited) setTitle(autoTitle(value))
  }

  const handleTitle = (value: string): void => {
    setTitleEdited(value.trim() !== '')
    setTitle(value)
  }

  const handleAutoTitle = (): void => {
    setTitle(autoTitle(content))
    setTitleEdited(false)
  }

  const submit = async (): Promise<void> => {
    if (content.trim() === '') {
      setError(translate('createError'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload: Record<string, unknown> = {
        title,
        content,
        runMode,
        sessionId: props.sessionId,
        directory,
        worktreeBranch: branch,
        worktreePath,
        needsFinalReview,
      }
      const created = await postJSON<Task>('/plugins/dsh-task-manager/create', payload)
      props.onCreated(created)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('createError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dsh-taskm-overlay" role="dialog" aria-modal="true">
      <div className="dsh-taskm-dialog">
        <h2 className="dsh-taskm-dialog-title">{translate('newTask')}</h2>

        <div className="dsh-taskm-field">
          <span className="dsh-taskm-field-label">{translate('title')}</span>
          <div className="dsh-taskm-title-row">
            <input
              className="dsh-taskm-input"
              value={title}
              placeholder={translate('title')}
              onChange={(event) => handleTitle(event.target.value)}
            />
            <button type="button" className="dsh-taskm-ghost" onClick={handleAutoTitle}>
              {translate('autoTitle')}
            </button>
          </div>
        </div>

        <div className="dsh-taskm-field">
          <span className="dsh-taskm-field-label">{translate('content')}</span>
          <textarea
            className="dsh-taskm-textarea"
            value={content}
            placeholder={translate('content')}
            onChange={(event) => handleContent(event.target.value)}
          />
        </div>

        <div className="dsh-taskm-field">
          <span className="dsh-taskm-field-label">{translate('runLocation')}</span>
          <div className="dsh-taskm-radios">
            <label className="dsh-taskm-radio">
              <input
                type="radio"
                name="dsh-taskm-runmode"
                checked={runMode === 'cwd'}
                onChange={() => setRunMode('cwd')}
              />
              {translate('runCwd')}
            </label>
            <label className="dsh-taskm-radio">
              <input
                type="radio"
                name="dsh-taskm-runmode"
                checked={runMode === 'new-worktree'}
                disabled={props.context.repoRoot === null}
                onChange={() => setRunMode('new-worktree')}
              />
              {translate('runNewWorktree')}
            </label>
            <label className="dsh-taskm-radio">
              <input
                type="radio"
                name="dsh-taskm-runmode"
                checked={runMode === 'existing-worktree'}
                disabled={props.context.worktrees.length === 0}
                onChange={() => setRunMode('existing-worktree')}
              />
              {translate('runExistingWorktree')}
            </label>
          </div>
          {props.context.repoRoot === null ? (
            <span className="dsh-taskm-hint">{translate('noRepo')}</span>
          ) : null}
        </div>

        {runMode === 'cwd' ? (
          <div className="dsh-taskm-field">
            <span className="dsh-taskm-field-label">{translate('directory')}</span>
            <input
              className="dsh-taskm-input"
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
            />
          </div>
        ) : null}

        {runMode === 'new-worktree' ? (
          <div className="dsh-taskm-field">
            <span className="dsh-taskm-field-label">{translate('branch')}</span>
            <input
              className="dsh-taskm-input"
              value={branch}
              placeholder="feature/xxx"
              onChange={(event) => setBranch(event.target.value)}
            />
          </div>
        ) : null}

        {runMode === 'existing-worktree' ? (
          <div className="dsh-taskm-field">
            <span className="dsh-taskm-field-label">{translate('worktree')}</span>
            <select
              className="dsh-taskm-input"
              value={worktreePath}
              onChange={(event) => setWorktreePath(event.target.value)}
            >
              {props.context.worktrees.map((row) => (
                <option key={row.path} value={row.path}>
                  {row.branch !== undefined ? `${row.branch} — ` : ''}{shortPath(row.path)}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="dsh-taskm-field">
          <label className="dsh-taskm-checkbox">
            <input
              type="checkbox"
              checked={needsFinalReview}
              onChange={(event) => setNeedsFinalReview(event.target.checked)}
            />
            <span>{translate('needsFinalReview')}</span>
          </label>
          <span className="dsh-taskm-hint">{translate('needsFinalReviewHint')}</span>
        </div>

        {error !== null ? <div className="dsh-taskm-error">{error}</div> : null}

        <div className="dsh-taskm-footer">
          <button type="button" className="dsh-taskm-secondary" onClick={props.onClose}>
            {translate('close')}
          </button>
          <button type="button" className="dsh-taskm-primary" disabled={saving} onClick={() => { void submit() }}>
            {translate('create')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Client root context, captured by apply(). Stateless views reach the shell's
 * workspace navigation through it (same cast ui-sidebar uses).
 */
let clientCtx: unknown

/** Jump to a conversation: switch the shell to it (no full page reload). */
function openConversation(sessionId: string): void {
  try {
    const get = (clientCtx as { get?: (name: string) => unknown } | undefined)?.get
    if (typeof get !== 'function') return
    const nav = get.call(clientCtx, 'uiWorkspace') as { openSession?: (id: string) => void } | undefined
    nav?.openSession?.(sessionId)
  } catch {
    // The shell owns navigation; a missing service must never break the panel.
  }
}

/**
 * Inline reply box under a waiting task card. The answer is delivered by the
 * host to the conversation that asked; it is not a chat message here.
 */
function ReplyBox(props: { task: Task; managerSessionId?: string; onSent: () => void }): ReactElement {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async (): Promise<void> => {
    if (text.trim() === '') return
    setSending(true)
    setError(null)
    try {
      await postJSON<{ taskId: string }>('/plugins/dsh-task-manager/reply', {
        taskId: props.task.id,
        text,
        managerSessionId: props.managerSessionId,
      })
      setText('')
      props.onSent()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('replyError'))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="dsh-taskm-reply">
      {props.task.report !== undefined ? (
        <div className="dsh-taskm-reply-question">
          <span className="dsh-taskm-detail-label">{translate('pendingQuestion')}</span>
          <div className="dsh-taskm-report-text">{props.task.report.text}</div>
        </div>
      ) : null}
      {props.task.lastReply !== undefined ? (
        <div className="dsh-taskm-hint">
          {translate('lastReply')} · {timeText(props.task.lastReply.at)} · {props.task.lastReply.text}
        </div>
      ) : null}
      <textarea
        className="dsh-taskm-textarea dsh-taskm-textarea-sm"
        value={text}
        placeholder={translate('replyPlaceholder')}
        onChange={(event) => setText(event.target.value)}
      />
      {error !== null ? <div className="dsh-taskm-error">{error}</div> : null}
      <div className="dsh-taskm-footer">
        <button
          type="button"
          className="dsh-taskm-primary"
          disabled={sending || text.trim() === ''}
          onClick={() => { void send() }}
        >
          {translate('sendReply')}
        </button>
      </div>
    </div>
  )
}

/** Per-card footer links: jump to the working conversation, open the .md report. */
/** 卡片上的问题清单：推荐答案一键采纳，或自己答一句。答完投给该项目的项目管理器。 */
function AnswerBox(props: { task: Task; onAnswered: () => void }): ReactElement | null {
  const questions = (props.task.questions ?? []).filter((item) => item.answer === undefined)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (questions.length === 0) return null

  const answer = async (question: TaskQuestion, value: string): Promise<void> => {
    if (value.trim() === '') return
    setSending(true)
    setError(null)
    try {
      await postJSON<Task>('/plugins/dsh-task-manager/answer', {
        taskId: props.task.id,
        questionId: question.id,
        text: value,
      })
      setText('')
      props.onAnswered()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('replyError'))
    } finally {
      setSending(false)
    }
  }

  const first = questions[0] as TaskQuestion
  return (
    <div className="dsh-taskm-reply">
      <span className="dsh-taskm-detail-label">{translate('questions')}</span>
      {questions.map((question) => (
        <div key={question.id} className="dsh-taskm-conversation">
          <div className="dsh-taskm-report-text">{question.text}</div>
          {question.recommendation !== undefined ? (
            <div className="dsh-taskm-hint">{translate('recommendation')} · {question.recommendation}</div>
          ) : null}
          {question.recommendation !== undefined ? (
            <div className="dsh-taskm-footer">
              <button
                type="button"
                className="dsh-taskm-primary"
                disabled={sending}
                onClick={() => { void answer(question, question.recommendation ?? '') }}
              >
                {translate('adoptRecommendation')}
              </button>
            </div>
          ) : null}
        </div>
      ))}
      {error !== null ? <div className="dsh-taskm-error">{error}</div> : null}
      <textarea
        className="dsh-taskm-textarea dsh-taskm-textarea-sm"
        value={text}
        placeholder={translate('answerPlaceholder')}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="dsh-taskm-footer">
        <button
          type="button"
          className="dsh-taskm-primary"
          disabled={sending || text.trim() === ''}
          onClick={() => { void answer(first, text) }}
        >
          {translate('answerButton')}
        </button>
      </div>
    </div>
  )
}

function TaskLinks(props: { task: Task }): ReactElement {
  const conversationId = props.task.captainSessionId ?? props.task.conversations?.[0]?.id
  const [reportOpen, setReportOpen] = useState(false)
  return (
    <div className="dsh-taskm-item-foot">
      <span className={`dsh-taskm-pill ${STATUS_CLASS[props.task.status]}`}>
        {statusLabel(translate, props.task.status)}
      </span>
      {conversationId !== undefined && conversationId !== '' ? (
        <button type="button" className="dsh-taskm-link" onClick={() => openConversation(conversationId)}>
          {translate('openConversation')} · {shortSessionId(conversationId)}
        </button>
      ) : null}
      <button type="button" className="dsh-taskm-link" onClick={() => setReportOpen(true)}>
        {translate('executionReport')}
      </button>
      {reportOpen ? <ReportDialog task={props.task} onClose={() => setReportOpen(false)} /> : null}
    </div>
  )
}

/** 执行汇报弹窗：按 Markdown 渲染（与会话里看 Markdown 文件一致），不再把源文件直接甩出来。 */
function ReportDialog(props: { task: Task; onClose: () => void }): ReactElement {
  const [copied, setCopied] = useState(false)
  const rawUrl = `/plugins/dsh-task-manager/report?taskId=${encodeURIComponent(props.task.id)}`
  const [copyError, setCopyError] = useState(false)

  // 直接从卡片数据渲染，不再抓 Markdown 源文：内容是我们自己生成的，结构化渲染更省事也更好读。
  const copy = (): void => {
    void (async () => {
      try {
        const response = await fetch(rawUrl, { headers: { accept: 'text/markdown' } })
        await navigator.clipboard?.writeText(await response.text())
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } catch {
        setCopyError(true)
      }
    })()
  }

  return (
    <div className="dsh-taskm-overlay" role="dialog" aria-modal="true" onClick={props.onClose}>
      <div className="dsh-taskm-dialog dsh-taskm-report-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dsh-taskm-report-head">
          <h2 className="dsh-taskm-dialog-title">{props.task.title}</h2>
          <div className="dsh-taskm-report-actions">
            <button type="button" className="dsh-taskm-link" onClick={copy}>
              {translate(copied ? 'reportCopied' : 'reportCopy')}
            </button>
            <a className="dsh-taskm-link" href={rawUrl} target="_blank" rel="noreferrer">
              {translate('reportOpenTab')}
            </a>
            <button type="button" className="dsh-taskm-link" onClick={props.onClose}>
              {translate('reportClose')}
            </button>
          </div>
        </div>
        <div className="dsh-taskm-report-body">
          {copyError ? <p className="dsh-taskm-error">{translate('reportFailed')}</p> : null}
          <dl className="dsh-taskm-report-meta">
            <dt>id</dt><dd><code>{props.task.id}</code></dd>
            <dt>状态</dt><dd>{statusLabel(translate, props.task.status)}</dd>
            <dt>目录</dt><dd><code>{props.task.directory}</code></dd>
            {props.task.worktreeBranch === undefined ? null : (<><dt>分支</dt><dd><code>{props.task.worktreeBranch}</code></dd></>)}
          </dl>
          <h3 className="dsh-taskm-report-section">{translate('reportSectionContent')}</h3>
          <p className="dsh-taskm-report-text">{props.task.content}</p>
          <h3 className="dsh-taskm-report-section">{translate('reportSectionReport')}</h3>
          {props.task.report === undefined ? (
            <p className="dsh-taskm-hint">{translate('reportEmpty')}</p>
          ) : (
            <>
              <p className="dsh-taskm-report-time">{new Date(props.task.report.at).toLocaleString()}</p>
              <p className="dsh-taskm-report-text">{props.task.report.text}</p>
              {props.task.report.evidence !== undefined && props.task.report.evidence.length > 0 ? (
                <ul className="dsh-taskm-report-evidence-list">
                  {props.task.report.evidence.map((item) => (<li key={item}><code>{item}</code></li>))}
                </ul>
              ) : null}
            </>
          )}
          {props.task.lastReply === undefined ? null : (
            <>
              <h3 className="dsh-taskm-report-section">{translate('reportSectionReply')}</h3>
              <p className="dsh-taskm-report-time">{new Date(props.task.lastReply.at).toLocaleString()}</p>
              <p className="dsh-taskm-report-text">{props.task.lastReply.text}</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** 纳管卡片的答复框：答复以人类消息身份送进管理会话，不在这里开一段对话。 */
function ManagedReplyBox(props: { card: ManagedCard; onSent: () => void }): ReactElement {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async (): Promise<void> => {
    if (text.trim() === '') return
    setSending(true)
    setError(null)
    try {
      await postJSON<{ managerSessionId: string }>('/plugins/dsh-task-manager/managed-reply', {
        managerSessionId: props.card.managerId,
        text,
      })
      setText('')
      props.onSent()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('replyError'))
    } finally {
      setSending(false)
    }
  }

  const question = props.card.question
  return (
    <div className="dsh-taskm-reply">
      <span className="dsh-taskm-detail-label">{translate('managedQuestion')}</span>
      {question === undefined ? (
        <span className="dsh-taskm-hint">{translate('managedNoQuestions')}</span>
      ) : (
        question.items.map((item) => (
          <div key={item.id} className="dsh-taskm-reply-question">
            {item.header !== undefined ? <span className="dsh-taskm-hint">{item.header}</span> : null}
            <div className="dsh-taskm-report-text">{item.question}</div>
            {item.options !== undefined && item.options.length > 0 ? (
              <div className="dsh-taskm-hint">{item.options.join(' / ')}</div>
            ) : null}
          </div>
        ))
      )}
      <textarea
        className="dsh-taskm-textarea dsh-taskm-textarea-sm"
        value={text}
        placeholder={translate('replyPlaceholder')}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="dsh-taskm-hint">{translate('managedReplyHint')}</div>
      {error !== null ? <div className="dsh-taskm-error">{error}</div> : null}
      <div className="dsh-taskm-footer">
        <button
          type="button"
          className="dsh-taskm-primary"
          disabled={sending || text.trim() === ''}
          onClick={() => { void send() }}
        >
          {translate('sendReply')}
        </button>
      </div>
    </div>
  )
}

/** 纳管对话列表：每张卡片一个真实的工作对话。 */
function ManagedList(props: { cards: ManagedCard[]; onReplied: () => void }): ReactElement {
  const statusLabelOf = (status: ManagedStatus): string => {
    if (status === 'paused') return translate('statusPaused')
    if (status === 'done') return translate('statusDone')
    if (status === 'problem') return translate('statusProblem')
    return translate('statusInProgress')
  }
  const statusClassOf = (status: ManagedStatus): string => {
    if (status === 'paused') return 'dsh-taskm-badge-muted'
    if (status === 'done') return 'dsh-taskm-badge-ok'
    if (status === 'problem') return 'dsh-taskm-badge-danger'
    return 'dsh-taskm-badge-active'
  }
  return (
    <div className="dsh-taskm-list">
      {props.cards.map((card) => (
        <article key={card.workerId} className="dsh-taskm-item">
          <div className="dsh-taskm-row">
            <div className="dsh-taskm-row-head">
              <span className="dsh-taskm-row-title" title={card.title}>{card.title}</span>
              {card.pendingQuestions !== undefined && card.pendingQuestions > 0 ? (
                <span className="dsh-taskm-pill dsh-taskm-badge-wait">
                  {translate('managedQuestion')} · {card.pendingQuestions}
                </span>
              ) : null}
              <span className={`dsh-taskm-pill ${statusClassOf(card.status)}`}>{statusLabelOf(card.status)}</span>
            </div>
            {card.question !== undefined && card.question.items[0] !== undefined ? (
              <div className="dsh-taskm-row-question">{card.question.items[0].question}</div>
            ) : null}
            {card.lastTurnOutcome !== undefined && card.status === 'in-progress' ? (
              <div className="dsh-taskm-hint">
                {translate('managedTurnEnded')} · {card.lastTurnOutcome}
              </div>
            ) : null}
          </div>
          <div className="dsh-taskm-item-foot">
            {card.preset !== '' ? <span className="dsh-taskm-chip">{card.preset}</span> : null}
            <button type="button" className="dsh-taskm-link" onClick={() => openConversation(card.workerId)}>
              {translate('openConversation')} · {shortSessionId(card.workerId)}
            </button>
            <a
              className="dsh-taskm-link"
              href={`/plugins/dsh-task-manager/managed-report?workerSessionId=${encodeURIComponent(card.workerId)}&managerSessionId=${encodeURIComponent(card.managerId)}`}
              target="_blank"
              rel="noreferrer"
            >
              {translate('executionReport')}
            </a>
          </div>
          {card.pendingQuestions !== undefined && card.pendingQuestions > 0
            ? <ManagedReplyBox card={card} onSent={props.onReplied} />
            : null}
        </article>
      ))}
    </div>
  )
}

/** Task detail: title, content, status, conversations, worktree. */
function TaskDetail(props: {
  task: Task
  onBack: () => void
  onStatusChange: (next: Task) => void
  onReplied: () => void
  /** Session viewing the panel: the live manager parent for cold-resume delivery. */
  sessionId?: string
}): ReactElement {
  const { task } = props
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const changeStatus = async (status: Status): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const updated = await postJSON<Task>('/plugins/dsh-task-manager/set-status', { id: task.id, status })
      props.onStatusChange(updated)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('createError'))
    } finally {
      setSaving(false)
    }
  }

  const [notice, setNotice] = useState<string | null>(null)
  /** 从面板起执行会话（与 task_start_execution 同一条路）。 */
  const startExecution = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const started = await postJSON<{ sessionId?: string }>('/plugins/dsh-task-manager/start-execution', { taskId: task.id })
      const short = typeof started.sessionId === 'string' ? started.sessionId.replace(/^session-/, '').slice(0, 8) : ''
      setNotice(short === '' ? translate('executionStarted') : `${translate('executionStarted')}（${short}）`)
      props.onReplied()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('createError'))
    } finally {
      setSaving(false)
    }
  }

  const questions = task.questions ?? []
  const conversations = task.conversations ?? []

  return (
    <div className="dsh-taskm-detail">
      <div>
        <button type="button" className="dsh-taskm-back" onClick={props.onBack}>
          <span dangerouslySetInnerHTML={{ __html: BACK_ICON }} />
          {translate('back')}
        </button>
      </div>
      <div className="dsh-taskm-detail-title">{task.title}</div>
      <div className="dsh-taskm-detail-meta">
        <span>{translate('status')}:</span>
        <select
          className="dsh-taskm-status-select"
          value={task.status}
          disabled={saving}
          onChange={(event) => { void changeStatus(event.target.value as Status) }}
        >
          {STATUSES.map((status) => (
            <option key={status} value={status}>{statusLabel(translate, status)}</option>
          ))}
        </select>
        {task.category !== undefined && task.category !== '' ? (
          <span className="dsh-taskm-badge dsh-taskm-badge-muted">{task.category}</span>
        ) : null}
        {task.needsFinalReview === true ? (
          <span className="dsh-taskm-badge dsh-taskm-badge-check">{translate('needsFinalReview')}</span>
        ) : null}
        <span>{translate('createdAt')}: {new Date(task.createdAt).toLocaleString()}</span>
        <span>{translate('updatedAt')}: {new Date(task.updatedAt).toLocaleString()}</span>
      </div>

      <div className="dsh-taskm-detail-section">
        <span className="dsh-taskm-detail-label">{translate('projectLabel')} · {translate('managerSession')}</span>
        <div className="dsh-taskm-kv">
          <div className="dsh-taskm-kv-row">
            <span className="dsh-taskm-kv-key">{translate('projectLabel')}</span>
            <span className="dsh-taskm-kv-value">{task.project !== undefined && task.project !== '' ? shortPath(task.project) : translate('notDispatched')}</span>
          </div>
          <div className="dsh-taskm-kv-row">
            <span className="dsh-taskm-kv-key">{translate('filterAssigned')}</span>
            <span className="dsh-taskm-kv-value">
              {(task.sources ?? []).length === 0 ? '—' : (task.sources ?? []).join(' / ')}
            </span>
          </div>
          {task.mergeCommit === undefined ? null : (
            <div className="dsh-taskm-kv-row">
              <span className="dsh-taskm-kv-key">{translate('mergedCommit')}</span>
              <span className="dsh-taskm-kv-value">{task.mergeCommit}</span>
            </div>
          )}
          <div className="dsh-taskm-kv-row">
            <span className="dsh-taskm-kv-key">{translate('managerSession')}</span>
            <span className="dsh-taskm-kv-value">
              {task.consoleSessionId !== undefined && task.consoleSessionId !== ''
                ? <span className="dsh-taskm-conv-id">{shortSessionId(task.consoleSessionId)}</span>
                : translate('notDispatched')}
            </span>
          </div>
        </div>
        <div className="dsh-taskm-footer">
          <button type="button" className="dsh-taskm-primary" disabled={saving} onClick={() => { void startExecution() }}>
            {task.captainSessionId !== undefined && task.captainSessionId !== ''
              ? translate('resumeExecution')
              : translate('startExecution')}
          </button>
          {notice !== null ? <span className="dsh-taskm-hint">{notice}</span> : null}
        </div>
      </div>

      {questions.length > 0 ? (
        <div className="dsh-taskm-detail-section">
          <span className="dsh-taskm-detail-label">{translate('questionsSection')}</span>
          {questions.map((question) => (
            <div key={question.id} className="dsh-taskm-kv-row">
              <span className="dsh-taskm-kv-key">{question.answer === undefined ? '·' : '✓'}</span>
              <span className="dsh-taskm-kv-value">
                {question.text}
                {question.answer === undefined
                  ? (question.recommendation === undefined ? '' : ` （${question.recommendation}）`)
                  : ` → ${question.answer.text}`}
              </span>
            </div>
          ))}
          <AnswerBox task={task} onAnswered={props.onReplied} />
        </div>
      ) : null}


      <div className="dsh-taskm-detail-section">
        <span className="dsh-taskm-detail-label">{translate('orchestration')}</span>
        <div className="dsh-taskm-kv">
          <div className="dsh-taskm-kv-row">
            <span className="dsh-taskm-kv-key">{translate('category')}</span>
            <span className="dsh-taskm-kv-value">{task.category ?? translate('notDispatched')}</span>
          </div>
          <div className="dsh-taskm-kv-row">
            <span className="dsh-taskm-kv-key">{translate('captainSession')}</span>
            <span className="dsh-taskm-kv-value">
              {task.captainSessionId !== undefined && task.captainSessionId !== '' ? (
                <span className="dsh-taskm-conv-id">{shortSessionId(task.captainSessionId)}</span>
              ) : (
                translate('notDispatched')
              )}
            </span>
          </div>
          <div className="dsh-taskm-kv-row">
            <span className="dsh-taskm-kv-key">{translate('dispatchRound')}</span>
            <span className="dsh-taskm-kv-value">{(task.dispatchRound ?? 0) > 0 ? task.dispatchRound : translate('notDispatched')}</span>
          </div>
        </div>
      </div>

      <div className="dsh-taskm-detail-section">
        <span className="dsh-taskm-detail-label">{translate('runLocation')}</span>
        <span>{runModeLabel(translate, task.runMode)}</span>
        <span>{shortPath(task.directory)}</span>
        {task.worktreeBranch !== undefined && task.worktreeBranch !== '' ? (
          <span>{translate('branch')}: {task.worktreeBranch}</span>
        ) : null}
      </div>

      <div className="dsh-taskm-detail-section">
        <span className="dsh-taskm-detail-label">{translate('content')}</span>
        <div className="dsh-taskm-detail-content">{task.content}</div>
      </div>

      <div className="dsh-taskm-detail-section">
        <span className="dsh-taskm-detail-label">{translate('conversations')}</span>
        {conversations.length === 0 ? (
          <span className="dsh-taskm-hint">{translate('noConversations')}</span>
        ) : (
          conversations.map((conversation) => (
            <div key={conversation.id} className="dsh-taskm-conversation">
              <span className="dsh-taskm-conv-id">{conversation.shortId}</span>
              <span className="dsh-taskm-conv-meta">
                {timeText(conversation.createdAt ?? 0)}
                {conversation.origin === 'subagent' ? ' · subagent' : ''}
                {conversation.cwd !== undefined ? ` · ${shortPath(conversation.cwd)}` : ''}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="dsh-taskm-detail-section">
        <span className="dsh-taskm-detail-label">{translate('latestReport')}</span>
        {task.report === undefined ? (
          <span className="dsh-taskm-hint">{translate('noReport')}</span>
        ) : (
          <div className="dsh-taskm-report">
            <div className="dsh-taskm-report-head">
              <span className={`dsh-taskm-badge ${STATUS_CLASS[task.status]}`}>
                {statusLabel(translate, task.status)}
              </span>
              <span>{new Date(task.report.at).toLocaleString()}</span>
            </div>
            <div className="dsh-taskm-report-text">{task.report.text}</div>
            {task.report.evidence !== undefined && task.report.evidence.length > 0 ? (
              <div className="dsh-taskm-evidence">
                <span className="dsh-taskm-detail-label">{translate('evidence')}</span>
                {task.report.evidence.map((item) => (
                  <span key={item} className="dsh-taskm-evidence-item">{shortPath(item)}</span>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {task.nextSteps !== undefined && task.nextSteps.length > 0 ? (
        <div className="dsh-taskm-detail-section">
          <span className="dsh-taskm-detail-label">{translate('nextSteps')}</span>
          {task.nextSteps.map((step) => (
            <div key={step.id} className="dsh-taskm-conversation">
              <span className="dsh-taskm-report-text">{step.text}</span>
              <span className="dsh-taskm-conv-meta">
                {step.decidedBy === 'human' ? 'human' : 'project manager'} · {timeText(step.at)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <TaskLinks task={task} />
      <AnswerBox task={task} onAnswered={props.onReplied} />
      {task.status === 'waiting-reply'
        ? <ReplyBox task={task} managerSessionId={props.sessionId} onSent={props.onReplied} />
        : null}

      {error !== null ? <div className="dsh-taskm-error">{error}</div> : null}
    </div>
  )
}

/** Task list: one row per task with title, status badge, category chip, and location. */
function TaskList(props: {
  tasks: Task[]
  /** Locale key for the zero-tasks message; defaults to the global empty state. */
  emptyKey?: string
  onCreate: () => void
  onOpen: (id: string) => void
  /** Called after a reply was delivered, so the panel reloads the card state. */
  onReplied: () => void
  /** Session viewing the panel: the live manager parent for cold-resume delivery. */
  sessionId?: string
}): ReactElement {
  if (props.tasks.length === 0) {
    return (
      <div className="dsh-taskm-empty">
        <span className="dsh-taskm-empty-mark" dangerouslySetInnerHTML={{ __html: ICON }} />
        {translate(props.emptyKey ?? 'empty')}
      </div>
    )
  }
  return (
    <div className="dsh-taskm-list">
      {props.tasks.map((task) => (
        <article key={task.id} className="dsh-taskm-item">
          <button
            type="button"
            className="dsh-taskm-row"
            onClick={() => props.onOpen(task.id)}
          >
            <div className="dsh-taskm-row-head">
              <span className="dsh-taskm-row-title" title={task.title}>{task.title}</span>
              {task.category !== undefined && task.category !== '' ? (
                <span className="dsh-taskm-chip">{task.category}</span>
              ) : null}
            </div>
            <span className="dsh-taskm-row-question">
              {shortPath(task.project ?? task.directory)} · {timeText(task.updatedAt)}
            </span>
          </button>
          <TaskLinks task={task} />
          <AnswerBox task={task} onAnswered={props.onReplied} />
          {task.status === 'waiting-reply'
            ? <ReplyBox task={task} managerSessionId={props.sessionId} onSent={props.onReplied} />
            : null}
        </article>
      ))}
    </div>
  )
}

/**
 * 「按项目」总览：每个任务台一行 —— 项目路径、各状态计数、最近更新、最近一张卡的标题。
 * 点一行回到任务列表，只看这个项目。
 */
function ProjectList(props: { tasks: Task[]; onPick: (project: string) => void }): ReactElement {
  const groups = new Map<string, Task[]>()
  for (const task of props.tasks) {
    const key = task.project ?? ''
    if (key === '') continue
    groups.set(key, [...(groups.get(key) ?? []), task])
  }
  if (groups.size === 0) {
    return <div className="dsh-taskm-empty">{translate('noProjects')}</div>
  }
  const rows = [...groups.entries()].sort((a, b) => {
    const latest = (list: Task[]): number => Math.max(...list.map((task) => task.updatedAt))
    return latest(b[1]) - latest(a[1])
  })
  return (
    <div className="dsh-taskm-list">
      {rows.map(([project, list]) => {
        const count = (status: Status): number => list.filter((task) => task.status === status).length
        const newest = [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0]
        return (
          <button key={project} type="button" className="dsh-taskm-card" onClick={() => props.onPick(project)}>
            <div className="dsh-taskm-card-title">{project.split('/').filter(Boolean).pop() ?? project}</div>
            <div className="dsh-taskm-card-sub">{shortPath(project)}</div>
            <div className="dsh-taskm-card-sub">
              {translate('projectTasks')} {list.length}
              {count('waiting-check') > 0 ? ` · ${translate('statusWaitingCheck')} ${count('waiting-check')}` : ''}
              {count('in-progress') > 0 ? ` · ${translate('statusInProgress')} ${count('in-progress')}` : ''}
              {count('problem') > 0 ? ` · ${translate('statusProblem')} ${count('problem')}` : ''}
              {count('done') > 0 ? ` · ${translate('statusDone')} ${count('done')}` : ''}
            </div>
            {newest === undefined ? null : (
              <div className="dsh-taskm-card-sub">
                {newest.title.slice(0, 40)} · {timeText(newest.updatedAt)}
              </div>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** Super Agent 控制面里任务台看的那一小块（`GET /api/super-agent/state`）。 */
interface SuperAgentState {
  mode?: { accept?: string; paused?: boolean }
  health?: { state?: string; note?: string }
  workers?: { running?: number; total?: number }
  router?: { decisions?: number }
}

/** 一行状态：有 Super Agent 就报它，没有就说明没装。 */
function SuperAgentChip(props: { state: SuperAgentState | null }): ReactElement {
  const state = props.state
  if (state === null) return <span className="dsh-taskm-hint">{translate('superAgentMissing')}</span>
  const health = state.health?.state ?? 'unknown'
  const accept = state.mode?.accept ?? '?'
  const paused = state.mode?.paused === true
  return (
    <span className="dsh-taskm-hint">
      {translate('superAgentLabel')} · {health}
      {paused ? ` · ${translate('superAgentPaused')}` : ` · ${accept}`}
      {typeof state.router?.decisions === 'number' ? ` · ${state.router.decisions} ${translate('superAgentDecisions')}` : ''}
    </span>
  )
}

/** Task panel view: the center conversation area when the task view is active. */
function TaskView(props: { sessionId?: string }): ReactElement {
  const [view, setView] = useState<'list' | 'detail'>('list')
  const [tasks, setTasks] = useState<Task[]>([])
  const [managed, setManaged] = useState<ManagedCard[]>([])
  const [managedUnavailable, setManagedUnavailable] = useState(false)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [context, setContext] = useState<ContextInfo | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState('')
  const [filter, setFilter] = useState<'all' | 'assigned' | 'questions' | 'next' | 'running'>('all')
  /** 「按项目」总览：每个任务台一行（项目路径 + 会话 + 各状态计数），点一行只看该项目。 */
  const [byProject, setByProject] = useState(false)
  const [projectFilter, setProjectFilter] = useState('')
  const [assignText, setAssignText] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [assignNotice, setAssignNotice] = useState<string | null>(null)
  const [assigning, setAssigning] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Super Agent 控制面（另一套组件）：只读状态，用来判断"执行侧在不在"。 */
  const [superAgent, setSuperAgent] = useState<SuperAgentState | null>(null)
  const sessionIdRef = useRef(props.sessionId)
  sessionIdRef.current = props.sessionId

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setError(null)
      const superState = getJSON<SuperAgentState>('/api/super-agent/state').catch(() => undefined)
      void superState.then((value) => setSuperAgent(value ?? null))
      const [state, ctx, view] = await Promise.all([
        getJSON<{ tasks: Task[] }>('/plugins/dsh-task-manager/state'),
        getJSON<ContextInfo>(
          `/plugins/dsh-task-manager/context?sessionId=${encodeURIComponent(sessionIdRef.current ?? '')}`,
        ),
        getJSON<ManagedView>('/plugins/dsh-task-manager/managed').catch(() => ({ cards: [], unavailable: true as const })),
      ])
      setTasks(state.tasks)
      setContext(ctx)
      setManaged(view.cards)
      setManagedUnavailable(view.unavailable === true)
      setSelectedTask((previous) => {
        if (previous === null) return null
        return state.tasks.find((task) => task.id === previous.id) ?? null
      })
    } catch (reason) {
      const status = (reason as { status?: number }).status
      setError(
        status === 401
          ? translate('authExpired')
          : reason instanceof Error ? reason.message : translate('loadError'),
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // 别人（管理器/执行会话）在后台改卡，面板得自己跟上，否则只能手动刷新页面。
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [refresh])

  const onCreated = (): void => {
    setDialogOpen(false)
    setView('list')
    void refresh()
  }

  const onStatusChange = (next: Task): void => {
    setSelectedTask(next)
    setTasks((previous) => previous.map((task) => (task.id === next.id ? next : task)))
  }

  // Category facets derive from the loaded tasks (「未分类」 covers absent/empty).
  const categories = Array.from(
    new Set(
      tasks
        .map((task) => task.category)
        .filter((value): value is string => typeof value === 'string' && value !== ''),
    ),
  ).sort((a, b) => a.localeCompare(b))
  const pendingTodo = (task: Task): boolean =>
    (task.questions ?? []).some((item) => item.answer === undefined) || task.status === 'waiting-reply'
  const byCategory = categoryFilter === ''
    ? tasks
    : categoryFilter === UNCATEGORIZED
      ? tasks.filter((task) => task.category === undefined || task.category === '')
      : tasks.filter((task) => task.category === categoryFilter)
  const hasQuestions = (task: Task): boolean => (task.questions ?? []).some((item) => item.answer === undefined)
  const hasNextSteps = (task: Task): boolean => (task.nextSteps ?? []).length > 0
  const isRunning = (task: Task): boolean => task.status === 'in-progress'
  const matchesFilter = (task: Task): boolean => {
    if (filter === 'assigned') return task.project !== undefined && task.project !== ''
    if (filter === 'questions') return hasQuestions(task)
    if (filter === 'next') return hasNextSteps(task)
    if (filter === 'running') return isRunning(task)
    return true
  }
  const filteredTasks = byCategory
    .filter((task) => projectFilter === '' || task.project === projectFilter)
    .filter(matchesFilter)
  const todoCount = tasks.filter(pendingTodo).length
  const counts = {
    all: tasks.length,
    assigned: tasks.filter((task) => task.project !== undefined && task.project !== '').length,
    questions: tasks.filter(hasQuestions).length,
    next: tasks.filter(hasNextSteps).length,
    running: tasks.filter(isRunning).length,
  }

  /** 派给大管理器：由它建卡并交给该项目的项目管理器。 */
  const assign = async (): Promise<void> => {
    if (assignText.trim() === '') return
    setAssigning(true)
    setAssignNotice(null)
    try {
      // 项目路径只认用户填的：早先拿当前会话目录当 hint，会把任务派到错的仓库。
      const hint = projectPath.trim()
      await postJSON<{ managerSessionId: string }>('/plugins/dsh-task-manager/dispatch', {
        text: assignText,
        ...(hint === '' ? {} : { cwd: hint }),
      })
      setAssignText('')
      setAssignNotice(translate('assignSent'))
    } catch (reason) {
      setAssignNotice(reason instanceof Error ? reason.message : translate('assignError'))
    } finally {
      setAssigning(false)
    }
  }

  if (loading) {
    return <div className="dsh-taskm-main"><div className="dsh-taskm-main-body">{translate('loading')}</div></div>
  }

  return (
    <div className="dsh-taskm-main" data-dsh-taskm-main="true">
      <div className="dsh-taskm-main-head">
        {view === 'detail' ? (
          <span className="dsh-taskm-main-title">{selectedTask?.title ?? ''}</span>
        ) : (
          <span className="dsh-taskm-main-title">{translate('panelTitle')}</span>
        )}
        {view === 'list' ? (
          <select
            className="dsh-taskm-filter"
            value={categoryFilter}
            aria-label={translate('category')}
            onChange={(event) => setCategoryFilter(event.target.value)}
          >
            <option value="">{translate('allCategories')}</option>
            <option value={UNCATEGORIZED}>{translate('uncategorized')}</option>
            {categories.map((category) => (
              <option key={category} value={category}>{category}</option>
            ))}
          </select>
        ) : null}
        <button type="button" className="dsh-taskm-main-create" onClick={() => setDialogOpen(true)}>
          {translate('newTask')}
        </button>
      </div>

      <div className="dsh-taskm-main-body">
        {view === 'list' ? (
          <div className="dsh-taskm-reply">
            <span className="dsh-taskm-detail-label">{translate('assignTitle')}</span>
            <input
              className="dsh-taskm-input"
              value={projectPath}
              aria-label={translate('projectPath')}
              placeholder={translate('projectPathPlaceholder')}
              onChange={(event) => setProjectPath(event.target.value)}
            />
            <textarea
              className="dsh-taskm-textarea dsh-taskm-textarea-sm"
              value={assignText}
              placeholder={translate('assignPlaceholder')}
              onChange={(event) => setAssignText(event.target.value)}
            />
            <div className="dsh-taskm-footer">
              <button
                type="button"
                className="dsh-taskm-primary"
                disabled={assigning || assignText.trim() === ''}
                onClick={() => { void assign() }}
              >
                {translate('assignButton')}
              </button>
              {assignNotice !== null ? <span className="dsh-taskm-hint">{assignNotice}</span> : null}
            </div>
          </div>
        ) : null}

        {view === 'list' ? (
          <div className="dsh-taskm-footer" style={{ marginBottom: '10px' }}>
            {([['all', 'filterAll'], ['assigned', 'filterAssigned'], ['questions', 'filterQuestions'], ['next', 'filterNext'], ['running', 'filterRunning']] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={filter === key ? 'dsh-taskm-primary' : 'dsh-taskm-main-create'}
                onClick={() => setFilter(key)}
              >
                {translate(label)}{counts[key] > 0 ? ` · ${counts[key]}` : ''}
              </button>
            ))}
            <button
              type="button"
              className={byProject ? 'dsh-taskm-primary' : 'dsh-taskm-main-create'}
              onClick={() => {
                setByProject(!byProject)
                if (byProject) setProjectFilter('')
              }}
            >
              {translate('byProject')}
            </button>
            <SuperAgentChip state={superAgent} />
            {todoCount > 0 ? <span className="dsh-taskm-hint">{translate('todoOnly')} · {todoCount}</span> : null}
          </div>
        ) : null}

        {error !== null && view === 'list' ? (
          <div className="dsh-taskm-error">{error}</div>
        ) : null}
        {managedUnavailable && view === 'list' ? (
          <div className="dsh-taskm-hint">{translate('managedUnavailable')}</div>
        ) : null}

        {view === 'list' && managed.length > 0 ? (
          <div className="dsh-taskm-hint">{translate('managedSection')} · {managed.length}</div>
        ) : null}
        {view === 'list' && byProject ? (
          <ProjectList
            tasks={tasks}
            onPick={(project) => {
              setProjectFilter(project)
              setByProject(false)
            }}
          />
        ) : view === 'list' ? (managed.length > 0 ? (
          <ManagedList cards={managed} onReplied={() => { void refresh() }} />
        ) : (
          <TaskList
            tasks={filteredTasks}
            emptyKey={categoryFilter === '' ? undefined : 'emptyFiltered'}
            onCreate={() => setDialogOpen(true)}
            onReplied={() => { void refresh() }}
            sessionId={props.sessionId}
            onOpen={(id) => {
              const task = tasks.find((item) => item.id === id) ?? null
              setSelectedTask(task)
              setView('detail')
            }}
          />
        )) : (
          selectedTask !== null ? (
            <TaskDetail
              task={selectedTask}
              onBack={() => setView('list')}
              onStatusChange={onStatusChange}
              onReplied={() => { void refresh() }}
              sessionId={props.sessionId}
            />
          ) : null
        )}
      </div>

      {dialogOpen && context !== null ? (
        <NewTaskDialog
          sessionId={props.sessionId}
          context={context}
          onClose={() => setDialogOpen(false)}
          onCreated={onCreated}
        />
      ) : null}
    </div>
  )
}

/**
 * Mount the browser half: styles, the sidebar Task Commander entry, and the
 * task-manager view in the official conversation view ring.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  clientCtx = ctx
  ctx.effect(() => installStyles(), 'dsh-task-manager: styles')

  ctx.effect(() => ctx.locale.register(NS, { zh: dicts.zh, en: dicts.en }), 'dsh-task-manager: locale')

  // One observable translator for the plugin fiber lifetime; read by components.
  let currentLocaleId = 'zh'
  const pick = (key: string): string => {
    const current = dicts[currentLocaleId]
    if (current !== undefined && current[key] !== undefined) return current[key]
    return dicts.en[key] ?? key
  }
  translate = pick

  const syncLocale = (): void => {
    let snapshot: LocaleSnapshot | undefined
    try { snapshot = ctx.locale.getLocale() } catch { snapshot = undefined }
    currentLocaleId = (snapshot !== undefined && typeof snapshot.id === 'string') ? snapshot.id : 'zh'
  }
  syncLocale()
  ctx.effect(() => ctx.locale.subscribe(() => { syncLocale() }), 'dsh-task-manager: locale subscription')

  // ── Sidebar icon entry + main panel (the seats the Super Agent console uses) ──
  // The entry used to be DOM-injected under the sidebar title and to borrow the
  // conversation view ring. It is now a real sidebar panel that owns its own main
  // panel, so it sits at the same level as the other plugin pages.
  const PANEL_ID = 'task-manager'
  const PANEL_ORDER = 12

  /** Fail-open seat probe: an absent ledger reads as "not seated" and mounts. */
  const seated = (slot: string, field: string, value: string): boolean => {
    try {
      const lines = (ctx.slots as unknown as {
        entries?: (s: string) => Array<{ options?: Record<string, unknown> }>
      }).entries?.(slot)
      return Array.isArray(lines)
        && lines.some(line => line?.options !== undefined && line.options[field] === value)
    } catch { return false }
  }

  if (!seated('main', 'key', PANEL_ID)) {
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
    }, () => <TaskView />))
  }

  if (!seated('sidebar.panellist', 'id', PANEL_ID)) {
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: PANEL_ORDER,
      label: () => pick('sideLabel'),
      locale: NS,
    }, (props: { size?: number }) => <SidebarIcon size={props.size} />))
  }
}
