/**
 * Sidebar task bar: three groups (finished green on top, running red,
 * waiting-for-reply amber) above the workspace browser. One row per session:
 * click the row to jump, click its close button to drop it from the bar. A
 * finished row survives the jump — only its close button removes it. The bar
 * auto-hides while the sidebar is collapsed to the narrow rail.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { classifyTasks, type TaskRow } from './tasks.ts'
import { dismissDone, loadDone, reduceDone, saveDone, type DoneState } from './dismissals.ts'

/** Read-only observable source of one snapshot. */
export interface SnapshotSource<Value> {
  getSnapshot(): Value
  subscribe(callback: () => void): () => void
}

/** Sessions face the bar needs (structural, duck-typed against ctx.sessions and uiSession). */
export interface TaskBarSessions {
  list: SnapshotSource<SessionListState>
  /** Unified UI status snapshot from the `uiSession` client service. */
  status: SnapshotSource<SessionStatusSnapshot>
  open(id: SessionId): void
}

/** Sidebar column width below which the rail is considered collapsed. */
const COLLAPSED_WIDTH = 100

/** Group copy (product copy is Chinese). */
const GROUP_LABELS = {
  done: '运行结束',
  running: '运行中',
  waiting: '等待回复',
} as const

/** Close-button copy for the finished rows. */
const CLOSE_LABEL = '关闭'

/** Dot colors: green done, red running, amber waiting (official signal hues). */
const DOT_COLORS = {
  done: '#22c55e',
  running: '#ef4444',
  waiting: '#f59e0b',
} as const

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '8px 12px 4px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-base)',
    minWidth: 0,
  },
  groupTitle: {
    fontSize: 11,
    lineHeight: '16px',
    color: 'var(--dsw-alias-label-tertiary)',
    paddingTop: 4,
  },
  rowWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    minWidth: 0,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
    padding: '3px 4px',
    border: 'none',
    borderRadius: 6,
    background: 'transparent',
    font: 'inherit',
    fontSize: 13,
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-primary)',
    textAlign: 'left',
    cursor: 'pointer',
  },
  close: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    width: 20,
    height: 20,
    padding: 0,
    border: 'none',
    borderRadius: 6,
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
  },
  dot: {
    flex: 'none',
    width: 8,
    height: 8,
    borderRadius: '50%',
  },
  title: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
}

/** Hover feedback for the two row controls, scoped to this bar's own subtree. */
const HOVER_CSS = [
  '[data-dsh-taskbar] [data-taskbar-row]:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '[data-dsh-taskbar] [data-taskbar-close]:hover{background:var(--dsw-alias-interactive-bg-hover);',
  'color:var(--dsw-alias-label-primary)}',
].join('')

/** One group of rows. */
function Group({
  label,
  rows,
  color,
  onJump,
  onDismiss,
}: {
  label: string
  rows: TaskRow[]
  color: string
  onJump: (id: SessionId) => void
  onDismiss?: (id: SessionId) => void
}) {
  if (rows.length === 0) return null
  return (
    <div>
      <div style={styles.groupTitle}>{label}</div>
      {rows.map((row) => (
        <div key={row.id} style={styles.rowWrap}>
          <button
            type="button"
            data-taskbar-row=""
            style={styles.row}
            onClick={() => { onJump(row.id) }}
            title={row.title}
          >
            <span style={{ ...styles.dot, background: color }} />
            <span style={styles.title}>{row.title}</span>
          </button>
          {onDismiss === undefined ? null : (
            <button
              type="button"
              data-taskbar-close=""
              style={styles.close}
              onClick={() => { onDismiss(row.id) }}
              title={CLOSE_LABEL}
              aria-label={`${CLOSE_LABEL}：${row.title}`}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable="false">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * Render the task bar from the live sessions snapshot.
 * @param props - the sessions face.
 * @returns the bar, or null when nothing signals or the sidebar is collapsed.
 */
export function TaskBar({ sessions }: { sessions: TaskBarSessions }) {
  const list = useSyncExternalStore(
    (callback) => sessions.list.subscribe(callback),
    () => sessions.list.getSnapshot(),
  )
  const status = useSyncExternalStore(
    (callback) => sessions.status.subscribe(callback),
    () => sessions.status.getSnapshot(),
  )
  const [done, setDone] = useState<DoneState>(loadDone)
  // Snapshot objects keep their identity between changes, so this folds once
  // per real change rather than once per render.
  useEffect(() => { setDone(previous => reduceDone(previous, list, status)) }, [list, status])
  useEffect(() => { saveDone(done) }, [done])
  const dismiss = useCallback((id: SessionId) => {
    setDone(previous => dismissDone(previous, id))
  }, [])
  const groups = classifyTasks(list, status, new Set(done.shown))
  const total = groups.done.length + groups.running.length + groups.waiting.length
  const container = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    const el = container.current
    const parent = el?.parentElement ?? null
    if (el === null || parent === null) return
    const update = (): void => { setCollapsed(parent.clientWidth < COLLAPSED_WIDTH) }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(parent)
    return () => { observer.disconnect() }
  }, [])

  if (total === 0 || collapsed) return null
  const jump = (id: SessionId): void => { sessions.open(id) }
  return (
    <div ref={container} style={styles.bar} data-dsh-taskbar="">
      <style dangerouslySetInnerHTML={{ __html: HOVER_CSS }} />
      <Group label={GROUP_LABELS.done} rows={groups.done} color={DOT_COLORS.done} onJump={jump} onDismiss={dismiss} />
      <Group label={GROUP_LABELS.running} rows={groups.running} color={DOT_COLORS.running} onJump={jump} />
      <Group label={GROUP_LABELS.waiting} rows={groups.waiting} color={DOT_COLORS.waiting} onJump={jump} />
    </div>
  )
}
