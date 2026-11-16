/**
 * dsh-task-manager — tools-only subpath entry (ADR-0004).
 *
 * The preset row (`dsh-task-manager/tools`) imports THIS entry, not the
 * package root: mounting the whole package from a preset collides with the
 * web profile's host-bundle instance (double `taskManager` service, double
 * routes — standingKeyFor rejects). This entry is isomorphic with tool-todo:
 *
 * - registers the twelve `task_*` tools into the CALLER-SCOPED tools registry
 *   (declared `tools` injection — session composition, not the host plane);
 * - consumes the host-plane `taskManager` service via `ctx.get` (read-only);
 * - provides NOTHING and registers NO HTTP routes.
 *
 * The host bundle (package root entry) keeps the service, routes, and stores;
 * per ADR-0004 the two sides must never both register the same tool names.
 */
import type { Context } from '@deepseek-ai/cordis'
import { registerTaskTools } from './tools.ts'
import type { TaskManagerService } from './orchestrator.ts'

export const name = 'dsh-task-manager/tools'

/**
 * Only `tools` is a declared injection. Declaring `taskManager` too would make
 * the row wait for a host-plane service inside the Session's own fiber and never
 * apply there (the tools then silently never reach the model's catalog).
 */
export const inject = ['tools']

/** Register the seven task tools into the caller's tools scope. */
export function apply(ctx: Context): void {
  // Lazy host-service handle: resolved on first call, inside whatever fiber the
  // tool executes in. `ctx.get` is the untyped read that works without inject.
  const taskManager = new Proxy({} as TaskManagerService, {
    get: (_target, property) => {
      const service = ctx.get('taskManager') as TaskManagerService | undefined
      if (service === undefined) {
        throw new Error('dsh-task-manager/tools requires the taskManager service — mount the dsh-task-manager host bundle first (ADR-0004)')
      }
      return (service as unknown as Record<string | symbol, unknown>)[property]
    },
  })
  registerTaskTools(
    ctx.tools as unknown as { register(definition: unknown): () => void },
    taskManager,
    (factory, label) => ctx.effect(factory, label),
  )
}
