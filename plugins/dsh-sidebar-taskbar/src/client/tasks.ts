/**
 * Pure task classification for the sidebar task bar. One row per Session that
 * currently signals activity, from the official unified UI status source:
 * waiting for a reply (amber), running (red), or stopped outside the main view
 * without acknowledgement (green). Waiting outranks the other two — the user
 * owes an answer and should see it first in its own group.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** One task-bar row. */
export interface TaskRow {
  /** The session id (jump target). */
  id: SessionId
  /** Human-facing session label. */
  title: string
}

/** The three task-bar groups, in display order. */
export interface TaskGroups {
  /** Stopped outside the main view, not yet acknowledged — green, newest first. */
  done: TaskRow[]
  /** Currently running — red, oldest first. */
  running: TaskRow[]
  /** Waiting for a reply (pending interaction) — amber, oldest first. */
  waiting: TaskRow[]
}

/**
 * Classify the Session list snapshot and the unified UI status snapshot into
 * the three task-bar groups.
 * @param list - the sessions list snapshot (titles and update order).
 * @param status - the `uiSession.sessionStatus` snapshot: per-Session running,
 *   pending-interaction, and completion-acknowledgement facts.
 * @returns the three groups (each empty when nothing signals).
 */
export function classifyTasks(
  list: SessionListState,
  status: SessionStatusSnapshot,
): TaskGroups {
  const done: TaskRow[] = []
  const running: TaskRow[] = []
  const waiting: TaskRow[] = []
  for (const id of list.ids) {
    const summary = list.byId[id]
    const facts = status.get(id)
    if (summary === undefined || facts === undefined) continue
    const row: TaskRow = { id, title: summary.displayTitle }
    if (facts.pendingInteraction !== undefined) {
      waiting.push(row)
    } else if (facts.running === true) {
      running.push(row)
    } else if (facts.completionUnread) {
      done.push(row)
    }
  }
  const byUpdatedAt = (rows: TaskRow[], newestFirst: boolean): TaskRow[] =>
    [...rows].sort((left, right) => {
      const a = list.byId[left.id]?.updatedAt ?? 0
      const b = list.byId[right.id]?.updatedAt ?? 0
      return newestFirst ? b - a : a - b
    })
  return {
    done: byUpdatedAt(done, true),
    running: byUpdatedAt(running, false),
    waiting: byUpdatedAt(waiting, false),
  }
}
