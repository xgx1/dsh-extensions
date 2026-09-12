/**
 * Pure task classification for the sidebar task bar. One row per session
 * that currently signals activity: finished-running (green), running (red),
 * or waiting for a reply (amber). Waiting outranks the green done state —
 * the user owes an answer and should see it first in its own group.
 */
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'

/** One task-bar row. */
export interface TaskRow {
  /** The session id (jump target). */
  id: SessionId
  /** Human-facing session label. */
  title: string
}

/** The three task-bar groups, in display order. */
export interface TaskGroups {
  /** Finished running while not yet opened — green, newest first. */
  done: TaskRow[]
  /** Currently running — red, oldest first. */
  running: TaskRow[]
  /** Waiting for a reply (pending interaction) — amber, oldest first. */
  waiting: TaskRow[]
}

/** True when the summary carries any signal the task bar should show. */
function isActive(summary: SessionSummary): boolean {
  return summary.running || summary.pendingInteraction !== undefined || summary.completed === true
}

/** Sort one group: finished newest-first, live/waiting oldest-first. */
function byUpdatedAt(rows: TaskRow[], summaries: Map<string, SessionSummary>, newestFirst: boolean): TaskRow[] {
  return [...rows].sort((left, right) => {
    const a = summaries.get(left.id)?.updatedAt ?? 0
    const b = summaries.get(right.id)?.updatedAt ?? 0
    return newestFirst ? b - a : a - b
  })
}

/**
 * Classify one session list snapshot into the three task-bar groups.
 * @param state - the sessions list snapshot.
 * @returns the three groups (each empty when nothing signals).
 */
export function classifyTasks(state: SessionListState): TaskGroups {
  const done: TaskRow[] = []
  const running: TaskRow[] = []
  const waiting: TaskRow[] = []
  const summaries = new Map<string, SessionSummary>()
  for (const id of state.ids) {
    const summary = state.byId[id]
    if (summary === undefined || !isActive(summary)) continue
    summaries.set(id, summary)
    const row: TaskRow = { id, title: summary.displayTitle }
    if (summary.pendingInteraction !== undefined) waiting.push(row)
    else if (summary.running) running.push(row)
    else done.push(row)
  }
  return {
    done: byUpdatedAt(done, summaries, true),
    running: byUpdatedAt(running, summaries, false),
    waiting: byUpdatedAt(waiting, summaries, false),
  }
}
