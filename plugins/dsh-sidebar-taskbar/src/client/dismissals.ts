/**
 * Acknowledgement state for the finished group of the sidebar task bar.
 *
 * A finished session stays in the bar until the user closes it. The official
 * `completionUnread` flag cannot serve as that fact on its own: the harness
 * suppresses it while the session is the visible, focused main view, so the
 * conversation the user is watching finish never raises it. A completion is
 * therefore announced on either signal — the official flag rising (a session
 * that finished away from the main view), or the session's `running` flag
 * falling after this browser saw it running (a finished main-view turn). This
 * module keeps its own "already announced" set, pruned only by an explicit
 * dismissal, a session that starts running again, or a session leaving the
 * list. The host persists that set in its Turso database (`../store.ts`), so
 * every browser and every host restart see the same finished rows.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session-status/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { isSubagentSession } from './tasks.ts'

/** Finished-group state, JSON-shaped so the host can store it. */
export interface DoneState {
  /** Sessions shown in the finished group until closed. */
  readonly shown: readonly SessionId[]
  /**
   * Sessions whose current completion this bar has already announced. Keeps a
   * closed row from announcing itself again while the session stays idle, so
   * entries live until the session runs again or leaves the list. The stored
   * name is unchanged from the earlier flag-raised meaning, which held the
   * same role for the completions that did raise the official flag.
   */
  readonly unread: readonly SessionId[]
}

/** Nothing finished and nothing observed yet. */
export const EMPTY_DONE: DoneState = { shown: [], unread: [] }

/** Same-origin route the host half serves the finished-group state on. */
const DONE_PATH = '/plugins/dsh-sidebar-taskbar/done'

/**
 * Fold one pair of live snapshots into the finished-group state.
 *
 * A session joins `shown` on either completion signal, once per idle period:
 * its official unread flag is raised (it finished while some other session
 * was the main view, or before the bar loaded), or its `running` flag falls
 * after a run this browser saw — which is the only signal left for a turn
 * finished in the visible main view, whose flag the harness suppresses. The
 * official flag falling is deliberately ignored: that is the harness
 * acknowledging the completion by opening the session, and the row must outlive
 * it. A session that runs again leaves the finished group for the running one,
 * and one that leaves the Session list leaves both groups. Subagent-origin
 * sessions are never bar rows, so an entry recorded before that rule existed
 * is dropped here rather than lingering until the user closes it.
 * @param state - state carried from the previous snapshot.
 * @param list - the sessions list snapshot.
 * @param status - the `uiSession.sessionStatus` snapshot.
 * @param seenRunning - sessions this browser has seen running; kept across
 *   calls so the falling edge stays observable, and pruned here. Not persisted:
 *   a completion missed while the page was closed still needs the official flag.
 * @returns the next state, or the same reference when nothing moved.
 */
export function reduceDone(
  state: DoneState,
  list: SessionListState,
  status: SessionStatusSnapshot,
  seenRunning: Set<SessionId> = new Set(),
): DoneState {
  // A list still arriving is empty, not truly empty: folding it would drop rows
  // the host already persisted, so a reload would wipe the finished group.
  if (list.phase !== 'ready') return state
  const shown = new Set(state.shown)
  const announced = new Set(state.unread)
  for (const id of [...seenRunning]) {
    if (list.byId[id] === undefined) seenRunning.delete(id)
  }
  for (const id of list.ids) {
    const summary = list.byId[id]
    if (summary === undefined || isSubagentSession(summary)) {
      shown.delete(id)
      announced.delete(id)
      seenRunning.delete(id)
      continue
    }
    const facts = status.get(id)
    if (facts === undefined) continue
    if (facts.running === true) {
      // Running again: the last completion is spent, a new one will be owed.
      shown.delete(id)
      announced.delete(id)
      seenRunning.add(id)
      continue
    }
    // shortcut: a turn that ends while this page is closed leaves neither signal
    // here, so only the official flag can cover it.
    if (announced.has(id)) continue
    if (seenRunning.has(id) || facts.completionUnread === true) {
      shown.add(id)
      announced.add(id)
    }
  }
  const next: DoneState = {
    shown: list.ids.filter(id => shown.has(id)),
    // An announced completion stays announced until the session runs again or
    // leaves the list, so a closed row cannot come back while it stays idle.
    unread: list.ids.filter(id => announced.has(id)),
  }
  return sameDone(state, next) ? state : next
}

/**
 * Remove one session from the finished group.
 * @param state - current state.
 * @param id - session the user closed.
 * @returns the next state, or the same reference when it was not shown.
 */
export function dismissDone(state: DoneState, id: SessionId): DoneState {
  if (!state.shown.includes(id)) return state
  return { shown: state.shown.filter(other => other !== id), unread: state.unread }
}

/**
 * Compare two states member by member.
 * @param left - one state.
 * @param right - the other.
 * @returns whether they describe the same finished group.
 */
export function sameDone(left: DoneState, right: DoneState): boolean {
  return sameIds(left.shown, right.shown) && sameIds(left.unread, right.unread)
}

function sameIds(left: readonly SessionId[], right: readonly SessionId[]): boolean {
  if (left.length !== right.length) return false
  for (const id of left) {
    if (!right.includes(id)) return false
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIdArray(value: unknown): value is SessionId[] {
  return Array.isArray(value) && value.every(id => typeof id === 'string')
}

function parseDone(value: unknown): DoneState | undefined {
  if (!isRecord(value)) return undefined
  if (!isIdArray(value.shown) || !isIdArray(value.unread)) return undefined
  return { shown: value.shown, unread: value.unread }
}

/**
 * Read the finished-group state the host stored for an earlier visit.
 * @returns the stored state, or the empty state when the host holds none.
 * @throws {Error} when the host route is unavailable or answers non-200.
 */
export async function loadDone(): Promise<DoneState> {
  const response = await fetch(DONE_PATH, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`taskbar: done state read failed (${response.status})`)
  return parseDone(await response.json() as unknown) ?? EMPTY_DONE
}

/**
 * Persist the finished-group state in the host database.
 * @param state - state to persist.
 * @throws {Error} when the host route is unavailable or answers non-200.
 */
export async function saveDone(state: DoneState): Promise<void> {
  const response = await fetch(DONE_PATH, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
  })
  if (!response.ok) throw new Error(`taskbar: done state write failed (${response.status})`)
}
