/**
 * dsh-task-manager — browser half.
 *
 * Two contributions, both additive over the official GUI:
 *  1. A Task Commander entry in the sidebar top area (DOM-injected next to the
 *     New Session button; the sidebar shell exposes no additive slot there).
 *     Clicking it switches the center conversation area to the task panel by
 *     activating the task view (same mechanism the official Automations panel
 *     uses: find the `[role="tab"]` whose label matches and click it).
 *  2. A `conversation.view` entry ("task-manager") that renders the task panel
 *     in place of the chat view — the official view ring replaces the whole
 *     conversation area, so this is a full-area switch, not a side float.
 *
 * The view ring mounts/renders through the slot lifecycle, and the sidebar
 * entry only narrow-observes the sidebar root after placement, so streaming
 * conversation output causes no plugin DOM work (no global mutation storm).
 */
import { createElement, useState } from 'react'
import type { ComponentType, ReactElement } from 'react'

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

/** Locale dictionaries; fallback is English. */
const dicts: Record<string, Record<string, string>> = {
  en: {
    sideLabel: 'Task Commander',
    tabLabel: 'Task Commander',
    panelTitle: 'Task Manager',
    createTask: 'Create New Task',
    placeholder: 'Task creation coming soon. Click again to dismiss.',
  },
  zh: {
    sideLabel: '任务管理',
    tabLabel: '任务管理',
    panelTitle: '任务管理',
    createTask: '创建新的任务',
    placeholder: '任务创建功能开发中，再点一次收起提示。',
  },
}

const CSS = `
.dsh-taskm-side{display:flex;align-items:center;gap:8px;width:100%;height:34px;padding:0 12px;box-sizing:border-box;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);cursor:pointer;text-align:left;white-space:nowrap;font:inherit;font-size:13px;line-height:20px;flex:none}
.dsh-taskm-side:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsh-taskm-side .dsh-taskm-side-icon{display:inline-flex;flex:none;width:18px;height:18px;align-items:center;justify-content:center}
.dsh-taskm-side .dsh-taskm-side-label{overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.dsh-taskm-main{display:flex;min-height:100%;flex-direction:column;box-sizing:border-box;padding:20px 24px;color:var(--dsw-alias-label-primary,#0f1115)}
.dsh-taskm-main-head{display:flex;align-items:center;gap:12px;padding-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));flex:none}
.dsh-taskm-main-create{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 14px;box-sizing:border-box;border:none;border-radius:8px;background:var(--dsw-alias-brand-primary,#3964fe);color:#fff;cursor:pointer;font:inherit;font-size:13px;font-weight:600;line-height:20px;white-space:nowrap;flex:none}
.dsh-taskm-main-create:hover{filter:brightness(1.08)}
.dsh-taskm-main-create:active{filter:brightness(.95)}
.dsh-taskm-main-title{font-size:16px;font-weight:650;line-height:22px;color:var(--dsw-alias-label-primary,#0f1115);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.dsh-taskm-main-body{flex:1;padding-top:14px;color:var(--dsw-alias-label-secondary,#61666b);font-size:13px;line-height:20px}
`

/** Inline icon normalized to the shell's 18px navigation glyph size. */
const ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M6.5 6.5v7"/></svg>'

/** Translator bound once by apply; read by the stateless TaskView component. */
let translate: Translate = (key) => key

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

/**
 * Task panel view: the center conversation area when the task view is active.
 * @returns the panel element.
 */
export function TaskView(): ReactElement {
  const [notice, setNotice] = useState(false)
  return createElement('div', { className: 'dsh-taskm-main', 'data-dsh-taskm-main': true },
    createElement('div', { className: 'dsh-taskm-main-head' },
      createElement('button', {
        type: 'button',
        className: 'dsh-taskm-main-create',
        onClick: () => setNotice((value) => !value),
      }, translate('createTask')),
      createElement('span', { className: 'dsh-taskm-main-title' }, translate('panelTitle')),
    ),
    createElement('div', { className: 'dsh-taskm-main-body' },
      notice
        ? createElement('div', null, translate('placeholder'))
        : null,
    ),
  )
}

/** Required services. */
export const inject = ['slots', 'locale']

/**
 * Mount the browser half: styles, the sidebar Task Commander entry, and the
 * task-manager view in the official conversation view ring.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => installStyles(), 'dsh-task-manager: styles')

  ctx.effect(() => ctx.locale.register(NS, { zh: dicts.zh, en: dicts.en }), 'dsh-task-manager: locale')

  // One observable translator for the plugin fiber lifetime; TaskView reads it.
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
  }, TaskView), )
}