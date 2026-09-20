/**
 * Acknowledgement state for the finished group of the sidebar task bar.
 *
 * A finished session stays in the bar until the user closes it. The official
 * `completionUnread` flag cannot serve as that fact on its own: the harness
 * clears it the moment the session becomes the main view, so the row the user
 * clicks to open a conversation would vanish on that same click. This module
 * therefore keeps its own "still owed a look" set, seeded from the official
 * flag when a completion is first observed and pruned only by an explicit
 * dismissal, a session that starts running again, or a session leaving the
 * list.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Finished-group state, JSON-shaped so it survives a reload. */
export interface DoneState {
  /** Sessions shown in the finished group until closed. */
  readonly shown: readonly SessionId[]
  /**
   * Sessions whose official unread flag this bar last observed raised. Only
   * raised flags are recorded: a flag last seen down reads the same as one
   * never seen, so the down entries carry no fact worth persisting.
   */
  readonly unread: readonly SessionId[]
}

/** Nothing finished and nothing observed yet. */
export const EMPTY_DONE: DoneState = { shown: [], unread: [] }

/** Storage key for the finished-group state. */
const STORAGE_KEY = 'dsh-sidebar-taskbar/done-v1'

/**
 * Fold one pair of live snapshots into the finished-group state.
 *
 * A session joins `shown` when its official unread flag rises, which covers
 * both a completion observed live and one already pending on first paint. The
 * flag falling is deliberately ignored: that is the harness acknowledging the
 * completion by opening the session, and the row must outlive it. A session
 * that runs again leaves the finished group for the running one, and one that
 * leaves the Session list leaves both groups.
 * @param state - state carried from the previous snapshot.
 * @param list - the sessions list snapshot.
 * @param status - the `uiSession.sessionStatus` snapshot.
 * @returns the next state, or the same reference when nothing moved.
 */
export function reduceDone(
  state: DoneState,
  list: SessionListState,
  status: SessionStatusSnapshot,
): DoneState {
  const shown = new Set(state.shown)
  const unread = new Set<SessionId>()
  for (const id of list.ids) {
    const facts = status.get(id)
    const flag = facts?.completionUnread === true
    if (flag) {
      // A flag this bar has not seen raised yet is a completion to announce,
      // whether it just happened or was already pending when the bar loaded.
      if (!state.unread.includes(id)) shown.add(id)
      unread.add(id)
    }
    if (facts?.running === true) shown.delete(id)
  }
  const next: DoneState = {
    shown: list.ids.filter(id => shown.has(id)),
    unread: list.ids.filter(id => unread.has(id)),
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
 * Read the finished-group state written by an earlier visit.
 * @returns the stored state, or the empty state when absent, unreadable, or malformed.
 */
export function loadDone(): DoneState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return EMPTY_DONE
    return parseDone(JSON.parse(raw) as unknown) ?? EMPTY_DONE
  } catch {
    // Storage disabled or holding foreign content: the bar still works, it
    // just forgets which finished rows the user already closed.
    return EMPTY_DONE
  }
}

/**
 * Write the finished-group state for the next visit.
 * @param state - state to persist.
 */
export function saveDone(state: DoneState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // A full or disabled store must not break the bar.
  }
}
