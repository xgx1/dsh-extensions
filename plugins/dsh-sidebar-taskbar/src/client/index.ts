/**
 * dsh-sidebar-taskbar — browser half: mounts the task bar above the
 * workspace browser. Data comes entirely from the official sessions list
 * snapshot (`running` / `pendingInteraction` / `completed`), so this package
 * holds no business state of its own.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { mountTaskBar } from './mount.tsx'

/** Required services: the sessions list + navigation. */
export const inject = ['sessions']

/**
 * Mount the browser half.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => mountTaskBar({
    list: ctx.sessions.list,
    open: (id) => { ctx.sessions.open(id) },
  }), 'dsh-sidebar-taskbar: mount')
}
