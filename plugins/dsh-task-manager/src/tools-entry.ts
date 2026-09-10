/**
 * dsh-task-manager — tools-only subpath entry (ADR-0004).
 *
 * The preset row (`dsh-task-manager/tools`) imports THIS entry, not the
 * package root: mounting the whole package from a preset collides with the
 * web profile's host-bundle instance (double `taskManager` service, double
 * routes — standingKeyFor rejects). This entry is isomorphic with tool-todo:
 *
 * - registers the seven `task_*` tools into the CALLER-SCOPED tools registry
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

/** The caller-scoped tools registry is a declared injection (tool-todo shape). */
export const inject = ['tools']

/** Register the seven task tools into the caller's tools scope. */
export function apply(ctx: Context): void {
  const taskManager = ctx.get('taskManager') as TaskManagerService | undefined
  if (taskManager === undefined) {
    // The tools delegate every operation to the host-plane service; without it
    // the row is misconfigured — fail loud at load instead of at first call.
    throw new Error('dsh-task-manager/tools requires the taskManager service — mount the dsh-task-manager host bundle first (ADR-0004)')
  }
  registerTaskTools(ctx.tools as unknown as { register(definition: unknown): () => void }, taskManager, (factory, label) => ctx.effect(factory, label))
}
