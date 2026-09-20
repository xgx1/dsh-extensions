/**
 * Pure task classification for the sidebar task bar. One row per Session that
 * currently signals activity, from the official unified UI status source:
 * waiting for a reply (amber) or running (red). The finished (green) group
 * comes from the caller's acknowledgement state instead, because the official
 * completion flag is cleared by the harness as soon as the session is opened.
 * Waiting outranks running — the user owes an answer and should see it first
 * in its own group.
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
  /** Finished outside the main view and not yet closed — green, newest first. */
  done: TaskRow[]
  /** Currently running — red, oldest first. */
  running: TaskRow[]
  /** Waiting for a reply (pending interaction) — amber, oldest first. */
  waiting: TaskRow[]
}

/**
 * Classify the Session list snapshot and the unified UI status snapshot into
 * the three task-bar groups.
 *
 * The finished group is not read from the status snapshot: `completionUnread`
 * is the harness's own acknowledgement, which opening a session clears. The
 * caller passes the ids its acknowledgement state still holds, so a finished
 * row survives the click that opens its conversation.
 * @param list - the sessions list snapshot (titles and update order).
 * @param status - the `uiSession.sessionStatus` snapshot: per-Session running
 *   and pending-interaction facts.
 * @param finished - ids the caller still owes a look at.
 * @returns the three groups (each empty when nothing signals).
 */
export function classifyTasks(
  list: SessionListState,
  status: SessionStatusSnapshot,
  finished: ReadonlySet<SessionId>,
): TaskGroups {
  const done: TaskRow[] = []
  const running: TaskRow[] = []
  const waiting: TaskRow[] = []
  for (const id of list.ids) {
    const summary = list.byId[id]
    if (summary === undefined) continue
    const facts = status.get(id)
    const row: TaskRow = { id, title: summary.displayTitle }
    if (facts?.pendingInteraction !== undefined) {
      waiting.push(row)
    } else if (facts?.running === true) {
      running.push(row)
    } else if (finished.has(id)) {
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
