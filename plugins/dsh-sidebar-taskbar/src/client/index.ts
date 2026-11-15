/**
 * dsh-sidebar-taskbar — browser half: mounts the task bar above the
 * workspace browser. Data comes from two official sources only: the Session
 * list snapshot (`ctx.sessions.list`, titles and update order) and the
 * `uiSession.sessionStatus` service's unified UI status snapshot (running,
 * pending interaction, completion acknowledgement), so this package holds no
 * business state of its own. Navigation uses the `uiWorkspace` service's
 * session-open action, which is where selection belongs after
 * `ctx.sessions.open` moved out of the Session face.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the sessions service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the unified UI status snapshot and the `uiSession.sessionStatus`
// service merge (ctx.uiSession.sessionStatus).
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session-status/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mountTaskBar } from './mount.tsx'

/**
 * Required services: the Session list, the `uiSession` status sub-service, and navigation.
 * `uiSession.sessionStatus` is a Cordis sub-service of its own (provided by
 * `@deepseek-ai/dsh-client-ui-session-status`); 0.2.2 and later reject the
 * property read unless it is declared here, so it must stay in this list.
 */
export const inject = ['sessions', 'uiSession', 'uiSession.sessionStatus', 'uiWorkspace']

/** The `uiWorkspace` service's session navigation entry. */
interface UiWorkspaceNavigation {
  openSession(sessionId: SessionId): void
}

/**
 * Mount the browser half.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // uiWorkspace has no published Context merge, so its declared injection is
  // read structurally against the service face.
  const uiWorkspace = (ctx as unknown as { uiWorkspace: UiWorkspaceNavigation }).uiWorkspace
  ctx.effect(() => mountTaskBar({
    list: ctx.sessions.list,
    status: ctx.uiSession.sessionStatus,
    open: (id) => { uiWorkspace.openSession(id) },
  }), 'dsh-sidebar-taskbar: mount')
}
