/**
 * dsh-sidebar-taskbar — browser half: mounts the task bar above the
 * workspace browser. Data comes from two official sources only: the sessions
 * list snapshot (`running` / `completed`) and the `uiSession` service's
 * pending-interaction source (`pendingInteractions`), so this package holds no
 * business state of its own.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the sessions service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { mountTaskBar, type PendingSource } from './mount.tsx'

/** Required services: the sessions list + navigation, and pending-interaction state. */
export const inject = ['sessions', 'uiSession']

/**
 * Mount the browser half.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // `uiSession` is a harness client service with no published type merge, so the
  // pending-interaction source is read structurally (same shape as sessions.list).
  const uiSession = (ctx as unknown as { uiSession: { pendingInteractions: PendingSource } }).uiSession
  ctx.effect(() => mountTaskBar({
    list: ctx.sessions.list,
    open: (id) => { ctx.sessions.open(id) },
    pending: uiSession.pendingInteractions,
  }), 'dsh-sidebar-taskbar: mount')
}
