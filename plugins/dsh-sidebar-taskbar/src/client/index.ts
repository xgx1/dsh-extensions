/**
 * dsh-sidebar-taskbar — browser half: mounts the task bar above the
 * workspace browser. Data comes from two official sources only: the sessions
 * list snapshot (`running` / `completed`) and the `uiSession` service's
 * pending-interaction source (`pendingInteractions`), so this package holds no
 * business state of its own.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { mountTaskBar, type PendingSource } from './mount.tsx'

/** Required services: the sessions list + navigation, and pending-interaction state. */
export const inject = ['sessions', 'uiSession']

/**
 * Mount the browser half.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // `uiSession` is a current-harness client service; the pinned runtime types predate it,
  // so the pending-interaction source is read structurally (same shape as sessions.list).
  const uiSession = (ctx as unknown as { uiSession: { pendingInteractions: PendingSource } }).uiSession
  ctx.effect(() => mountTaskBar({
    list: ctx.sessions.list,
    open: (id) => { ctx.sessions.open(id) },
    pending: uiSession.pendingInteractions,
  }), 'dsh-sidebar-taskbar: mount')
}
