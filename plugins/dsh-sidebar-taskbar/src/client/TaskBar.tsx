/**
 * Sidebar task bar: three groups (finished-running green on top, running
 * red, waiting-for-reply amber) above the workspace browser. One row per
 * session, click to jump. Auto-hides while the sidebar is collapsed to the
 * narrow rail.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { classifyTasks, type TaskRow } from './tasks.ts'

/** Sessions face the bar needs (structural, duck-typed against ctx.sessions). */
export interface TaskBarSessions {
  list: {
    getSnapshot(): SessionListState
    subscribe(callback: () => void): () => void
  }
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
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
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
  rowHover: {
    background: 'var(--dsw-alias-interactive-bg-hover)',
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

/** One group of rows. */
function Group({
  label,
  rows,
  color,
  onJump,
}: {
  label: string
  rows: TaskRow[]
  color: string
  onJump: (id: SessionId) => void
}) {
  if (rows.length === 0) return null
  return (
    <div>
      <div style={styles.groupTitle}>{label}</div>
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          style={styles.row}
          onClick={() => { onJump(row.id) }}
          title={row.title}
        >
          <span style={{ ...styles.dot, background: color }} />
          <span style={styles.title}>{row.title}</span>
        </button>
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
  const groups = classifyTasks(list)
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
      <Group label={GROUP_LABELS.done} rows={groups.done} color={DOT_COLORS.done} onJump={jump} />
      <Group label={GROUP_LABELS.running} rows={groups.running} color={DOT_COLORS.running} onJump={jump} />
      <Group label={GROUP_LABELS.waiting} rows={groups.waiting} color={DOT_COLORS.waiting} onJump={jump} />
    </div>
  )
}
