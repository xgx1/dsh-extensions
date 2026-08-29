/**
 * dsh-task-manager — browser half.
 *
 * Two contributions, both additive over the official GUI:
 *  1. A Task Commander entry in the sidebar top area (DOM-injected next to the
 *     New Session button). Clicking it switches the center conversation area to
 *     the task panel (same mechanism as the official Automations tab).
 *  2. A `conversation.view` entry ("task-manager") that renders the full task
 *     panel: a new-task dialog, the task list, and a task detail view.
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
  register(
    options: {
      readonly name: string
      readonly id: string
      readonly order?: number
      readonly label?: string | (() => string)
    },
    component: ComponentType,
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
interface Task {
  id: string
  title: string
  content: string
  status: Status
  runMode: RunMode
  directory: string
  worktreeBranch?: string
  conversations?: ConversationSummary[]
  createdAt: number
  updatedAt: number
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
    createError: 'Failed to create the task.',
    noConversations: 'No conversation has run in this task’s directory yet.',
    statusNotStarted: 'Not started',
    statusInProgress: 'In progress',
    statusWaitingReply: 'Waiting for reply',
    statusProblem: 'Problem',
    statusWaitingCheck: 'Waiting for check',
    statusDone: 'Done',
    createdAt: 'Created',
    updatedAt: 'Updated',
    noRepo: 'Current directory is not a git repository.',
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
    createError: '任务创建失败。',
    noConversations: '还没有对话在这个任务的目录里运行。',
    statusNotStarted: '未开始',
    statusInProgress: '进行中',
    statusWaitingReply: '等待回复',
    statusProblem: '发生问题',
    statusWaitingCheck: '等待检查',
    statusDone: '已完成',
    createdAt: '创建时间',
    updatedAt: '更新时间',
    noRepo: '当前目录不在 git 仓库里。',
  },
}

const STATUSES: Status[] = ['not-started', 'in-progress', 'waiting-reply', 'problem', 'waiting-check', 'done']
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
    throw new Error(message)
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

function timeText(ms: number): string {
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

.dsh-taskm-empty{padding:32px 8px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dsh-taskm-list{display:flex;flex-direction:column;gap:8px}
.dsh-taskm-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;text-align:left;font:inherit}
.dsh-taskm-row:hover{border-color:var(--dsw-alias-brand-primary)}
.dsh-taskm-row-title{flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-taskm-row-sub{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}

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
.dsh-taskm-field{display:flex;flex-direction:column;gap:6px}
.dsh-taskm-field-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsh-taskm-input{width:100%;box-sizing:border-box;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dsh-taskm-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsh-taskm-textarea{width:100%;box-sizing:border-box;min-height:120px;resize:vertical;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.dsh-taskm-textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsh-taskm-title-row{display:flex;gap:8px;align-items:center}
.dsh-taskm-title-row .dsh-taskm-input{flex:1}
.dsh-taskm-ghost{display:inline-flex;align-items:center;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font:inherit;font-size:12px;white-space:nowrap}
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
  const [content, setContent] = useState('')
  const [runMode, setRunMode] = useState<RunMode>('cwd')
  const [branch, setBranch] = useState('')
  const [worktreePath, setWorktreePath] = useState(props.context.worktrees[0]?.path ?? '')
  const [directory, setDirectory] = useState(props.context.currentDir)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const handleContent = (value: string): void => {
    setContent(value)
    setTitle((previous) => (previous.trim() === '' ? autoTitle(value) : previous))
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
              onChange={(event) => setTitle(event.target.value)}
            />
            <button type="button" className="dsh-taskm-ghost" onClick={() => setTitle(autoTitle(content))}>
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

/** Task detail: title, content, status, conversations, worktree. */
function TaskDetail(props: {
  task: Task
  onBack: () => void
  onStatusChange: (next: Task) => void
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
        <span>{translate('createdAt')}: {new Date(task.createdAt).toLocaleString()}</span>
        <span>{translate('updatedAt')}: {new Date(task.updatedAt).toLocaleString()}</span>
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

      {error !== null ? <div className="dsh-taskm-error">{error}</div> : null}
    </div>
  )
}

/** Task list: one row per task with title, status badge, and location. */
function TaskList(props: {
  tasks: Task[]
  onCreate: () => void
  onOpen: (id: string) => void
}): ReactElement {
  if (props.tasks.length === 0) {
    return <div className="dsh-taskm-empty">{translate('empty')}</div>
  }
  return (
    <div className="dsh-taskm-list">
      {props.tasks.map((task) => (
        <button
          key={task.id}
          type="button"
          className="dsh-taskm-row"
          onClick={() => props.onOpen(task.id)}
        >
          <span className="dsh-taskm-row-title">{task.title}</span>
          <span className={`dsh-taskm-badge ${STATUS_CLASS[task.status]}`}>
            {statusLabel(translate, task.status)}
          </span>
          <span className="dsh-taskm-row-sub">{timeText(task.updatedAt)}</span>
          <span className="dsh-taskm-row-sub">{shortPath(task.directory)}</span>
        </button>
      ))}
    </div>
  )
}

/** Task panel view: the center conversation area when the task view is active. */
function TaskView(props: { sessionId?: string }): ReactElement {
  const [view, setView] = useState<'list' | 'detail'>('list')
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [context, setContext] = useState<ContextInfo | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const sessionIdRef = useRef(props.sessionId)
  sessionIdRef.current = props.sessionId

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setError(null)
      const [state, ctx] = await Promise.all([
        getJSON<{ tasks: Task[] }>('/plugins/dsh-task-manager/state'),
        getJSON<ContextInfo>(
          `/plugins/dsh-task-manager/context?sessionId=${encodeURIComponent(sessionIdRef.current ?? '')}`,
        ),
      ])
      setTasks(state.tasks)
      setContext(ctx)
      setSelectedTask((previous) => {
        if (previous === null) return null
        return state.tasks.find((task) => task.id === previous.id) ?? null
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('loadError'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
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
        <button type="button" className="dsh-taskm-main-create" onClick={() => setDialogOpen(true)}>
          {translate('newTask')}
        </button>
      </div>

      <div className="dsh-taskm-main-body">
        {error !== null && view === 'list' ? (
          <div className="dsh-taskm-error">{error}</div>
        ) : null}

        {view === 'list' ? (
          <TaskList
            tasks={tasks}
            onCreate={() => setDialogOpen(true)}
            onOpen={(id) => {
              const task = tasks.find((item) => item.id === id) ?? null
              setSelectedTask(task)
              setView('detail')
            }}
          />
        ) : (
          selectedTask !== null ? (
            <TaskDetail
              task={selectedTask}
              onBack={() => setView('list')}
              onStatusChange={onStatusChange}
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
  ctx.effect(() => ctx.locale.subscribe(() => { syncLocale(); renderLabel() }), 'dsh-task-manager: locale subscription')

  // ── Sidebar entry (low-overhead DOM injection) ────────────────────────────
  let entry: HTMLButtonElement | undefined
  let rootEl: HTMLElement | undefined
  let placed = false

  const renderLabel = (): void => {
    if (entry === undefined) return
    const labelNode = entry.querySelector('.dsh-taskm-side-label')
    if (labelNode !== null) labelNode.textContent = pick('sideLabel')
    entry.setAttribute('aria-label', pick('sideLabel'))
    entry.setAttribute('title', pick('sideLabel'))
  }

  const placeEntry = (): void => {
    if (placed || entry === undefined || rootEl === undefined) return
    if (entry.parentElement === rootEl) {
      placed = true
      rootObserver.observe(rootEl, { childList: true, subtree: true })
      return
    }
    const newSession = rootEl.querySelector<HTMLButtonElement>('button[class*="newSession"]')
    if (newSession === null) return
    rootEl.insertBefore(entry, newSession.nextElementSibling)
    if (entry.parentElement === rootEl) {
      placed = true
      rootObserver.observe(rootEl, { childList: true, subtree: true })
    }
  }

  const findRoot = (): HTMLElement | undefined => {
    const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
    if (column === null) return undefined
    return column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
      ?? (column.firstElementChild as HTMLElement | null) ?? undefined
  }

  // Global observer: only active until the entry is placed, then disconnected
  // so streaming conversation output cannot trigger any plugin work.
  const waitObserver = new MutationObserver(() => {
    if (placed) { waitObserver.disconnect(); return }
    if (rootEl !== undefined && !rootEl.isConnected) rootEl = undefined
    if (rootEl === undefined) rootEl = findRoot()
    if (rootEl === undefined) return
    placeEntry()
  })

  // Narrow observer: after placement, self-heal the entry if a sidebar
  // re-render displaces it. Scoped to the sidebar root only.
  const rootObserver = new MutationObserver(() => {
    if (rootEl === undefined || !rootEl.isConnected) {
      rootObserver.disconnect()
      placed = false
      rootEl = undefined
      waitObserver.observe(document.body, { childList: true, subtree: true })
      return
    }
    if (entry === undefined || !rootEl.contains(entry)) {
      const newSession = rootEl.querySelector<HTMLButtonElement>('button[class*="newSession"]')
      if (newSession !== null && entry !== undefined) rootEl.insertBefore(entry, newSession.nextElementSibling)
    }
  })

  ctx.effect(() => {
    entry = document.createElement('button')
    entry.type = 'button'
    entry.className = 'dsh-taskm-side'
    entry.innerHTML = `<span class="dsh-taskm-side-icon">${ICON}</span><span class="dsh-taskm-side-label"></span>`
    entry.addEventListener('click', () => { activateTaskView(pick) })
    renderLabel()
    rootEl = findRoot()
    if (rootEl !== undefined) placeEntry()
    else waitObserver.observe(document.body, { childList: true, subtree: true })
    return () => {
      waitObserver.disconnect()
      rootObserver.disconnect()
      if (entry !== undefined && entry.parentElement !== null) entry.remove()
    }
  }, 'dsh-task-manager: sidebar entry')

  // ── Task view in the official conversation view ring ──────────────────────
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'task-manager',
    order: 30,
    label: () => pick('tabLabel'),
  }, (props: { sessionId?: string }) => <TaskView sessionId={props.sessionId} />))
}