/**
 * dsh-task-manager — orchestration HTTP routes (M1).
 *
 * GUI-facing routes on the same-origin channel `/plugins/dsh-task-manager/*`,
 * registered next to the existing state/context/create/set-status routes.
 * Per the architecture note: HTTP carries NO session identity (the human owns
 * the list, ADR-0001) — identity enforcement lives in the taskManager service
 * for the model-tool path.
 *
 * - `GET  /captains` — registry snapshot (category → charter/session/count).
 * - `PUT  /captains` — charter edit (upsert; may pre-write before first assign).
 * - `POST /assign`   — dispatch a task to a category captain.
 * - `POST /report`   — human manual report supplement (no identity semantics).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { OrchestratorError, type OrchestratorErrorCode, type Status } from './records.ts'
import type { TaskManagerService } from './orchestrator.ts'
import { readJsonBody } from './http.ts'

/** Structural slice of the host web server route registration. */
export interface RouteRegistrar {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Map an orchestrator error code to its HTTP status. */
export function statusForError(error: unknown): number {
  if (!(error instanceof OrchestratorError)) return 500
  const table: Record<OrchestratorErrorCode, number> = {
    TASK_NOT_FOUND: 404,
    NOT_CAPTAIN: 403,
    INVALID_STATUS: 400,
    INVALID_INPUT: 400,
    NOT_DISPATCHED: 409,
    MANAGER_AGENT_REQUIRED: 409,
    DELIVERY_UNAVAILABLE: 409,
    CREATION_FAILED: 502,
  }
  return table[error.code] ?? 500
}

/** Shared handler wrapper: JSON errors with code-mapped statuses. */
async function handle(res: ServerResponse, fn: () => Promise<unknown>): Promise<void> {
  try {
    const body = await fn()
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = error instanceof OrchestratorError ? error.code : 'INTERNAL'
    res.writeHead(statusForError(error), {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify({ error: message, code }))
  }
}

/** Register the three orchestration routes on the host web server. */
export function registerOrchestrationRoutes(
  registrar: RouteRegistrar,
  taskManager: TaskManagerService,
  effect: (factory: () => () => void, label?: string) => void,
): void {
  effect(() => registrar.register({
    kind: 'exact',
    path: '/plugins/dsh-task-manager/captains',
    handler: async (req, res) => {
      if (req.method === 'PUT') {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'invalid JSON body', code: 'INVALID_INPUT' }))
          return
        }
        const category = typeof body['category'] === 'string' ? body['category'].trim() : ''
        const charter = typeof body['charter'] === 'string' ? body['charter'] : ''
        if (category === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'category is required', code: 'INVALID_INPUT' }))
          return
        }
        await handle(res, () => taskManager.setCharter(category, charter))
        return
      }
      await handle(res, () => taskManager.captains().then((captains) => ({ captains })))
    },
  }), 'task-manager: captains route')

  effect(() => registrar.register({
    kind: 'exact',
    path: '/plugins/dsh-task-manager/assign',
    handler: async (req, res) => {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'invalid JSON body', code: 'INVALID_INPUT' }))
        return
      }
      const taskId = typeof body['taskId'] === 'string' ? body['taskId'].trim() : ''
      const category = typeof body['category'] === 'string' ? body['category'].trim() : ''
      const charter = typeof body['charter'] === 'string' ? body['charter'] : undefined
      const managerSessionId = typeof body['managerSessionId'] === 'string' && body['managerSessionId'] !== ''
        ? body['managerSessionId']
        : undefined
      if (taskId === '' || category === '') {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'taskId and category are required', code: 'INVALID_INPUT' }))
        return
      }
      await handle(res, () => taskManager.assign(taskId, category, { charter, managerSessionId }))
    },
  }), 'task-manager: assign route')

  effect(() => registrar.register({
    kind: 'exact',
    path: '/plugins/dsh-task-manager/report',
    handler: async (req, res) => {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'invalid JSON body', code: 'INVALID_INPUT' }))
        return
      }
      const taskId = typeof body['taskId'] === 'string' ? body['taskId'].trim() : ''
      const status = typeof body['status'] === 'string' ? body['status'] : ''
      const text = typeof body['text'] === 'string' ? body['text'] : ''
      const evidence = Array.isArray(body['evidence'])
        ? body['evidence'].filter((item): item is string => typeof item === 'string' && item !== '')
        : undefined
      if (taskId === '' || status === '') {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'taskId and status are required', code: 'INVALID_INPUT' }))
        return
      }
      // Human manual supplement: no identity semantics (ADR-0001 human full write).
      await handle(res, () => taskManager.applyReportHuman(taskId, { status: status as Status, text, evidence }))
    },
  }), 'task-manager: report route')
}
