/**
 * dsh-sidebar-taskbar — browser half: mounts the task bar above the
 * workspace browser. Data comes from two official sources only: the Session
 * list snapshot (`ctx.sessions.list`, titles and update order) and the
 * `uiSession` service's unified UI status snapshot (running, pending
 * interaction, completion acknowledgement), so this package holds no business
 * state of its own. Navigation uses the `uiWorkspace` service's session-open
 * action, which is where selection belongs after `ctx.sessions.open` moved
 * out of the Session face.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the sessions service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the unified UI status snapshot.
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mountTaskBar } from './mount.tsx'

/** Required services: the Session list, unified UI status, and navigation. */
export const inject = ['sessions', 'uiSession', 'uiWorkspace']

/** The `uiSession` service's unified status source. */
interface UiSessionStatus {
  readonly sessionStatus: {
    getSnapshot(): SessionStatusSnapshot
    subscribe(callback: () => void): () => void
  }
}

/** The `uiWorkspace` service's session navigation entry. */
interface UiWorkspaceNavigation {
  openSession(sessionId: SessionId): void
}

/**
 * Mount the browser half.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // Both are harness client services with no published Context merge, so the
  // declared injections are read structurally against their faces.
  const uiSession = (ctx as unknown as { uiSession: UiSessionStatus }).uiSession
  const uiWorkspace = (ctx as unknown as { uiWorkspace: UiWorkspaceNavigation }).uiWorkspace
  ctx.effect(() => mountTaskBar({
    list: ctx.sessions.list,
    status: uiSession.sessionStatus,
    open: (id) => { uiWorkspace.openSession(id) },
  }), 'dsh-sidebar-taskbar: mount')
}
