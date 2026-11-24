/**
 * Host half of the sidebar task bar: keeps the finished group's
 * acknowledgement state in a Turso database (see `store.ts`) and serves it to
 * the browser half over same-origin HTTP. Only durability lives here; the
 * grouping, announcement, and manual-close rules stay in the client.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DoneStore, type DoneState } from './store.ts'

/** Hold this plugin until the web server exists: the routes only exist there. */
export const inject = ['webServer']

/** Same-origin path both halves meet on. */
const DONE_PATH = '/plugins/dsh-sidebar-taskbar/done'

/** Most sessions one finished group can hold; a larger body is not one the bar sent. */
const MAX_IDS = 500

/** Longest accepted session id. */
const MAX_ID_LENGTH = 200

/** Largest accepted request body. */
const MAX_BODY = 512 * 1024

/** Structural slice of the host web server this plugin registers on. */
interface WebServer {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The Harness-home path resolver `app-boot` provides. */
type HomePath = (...segments: string[]) => string

/**
 * Send one JSON response, never cached.
 * @param res - the response to own.
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Read a request body as JSON, refusing oversize or malformed payloads.
 * @param req - the request to read.
 * @returns the parsed body, or `{}` for an empty one.
 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const part = chunk as Buffer
    size += part.length
    if (size > MAX_BODY) throw new Error('request body is too large')
    chunks.push(part)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text) as unknown
}

/** Whether a value is a list of plausible session ids. */
function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_IDS
    && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH)
}

/**
 * Validate one request body as the finished-group state.
 * @param value - the decoded JSON body.
 * @returns the state, or `undefined` when the body is not one the bar sent.
 */
function parseDone(value: unknown): DoneState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const shown = record['shown']
  const unread = record['unread']
  if (!isIdList(shown) || !isIdList(unread)) return undefined
  return { shown, unread }
}

/**
 * Mount the store and its two routes.
 * @param ctx - the host plugin context.
 */
export function apply(ctx: Context): void {
  const home = ctx.get('dshHomePath') as HomePath
  const webServer = ctx.get('webServer') as WebServer
  const store = new DoneStore(home('taskbar.db'))
  ctx.effect(() => () => store.close(), 'dsh-sidebar-taskbar: close the done store')
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: DONE_PATH,
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          json(res, 200, await store.read())
          return
        }
        if (req.method !== 'PUT') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        const state = parseDone(await readBody(req))
        if (state === undefined) {
          json(res, 400, { error: 'body must be { shown: string[], unread: string[] }' })
          return
        }
        await store.write(state)
        json(res, 200, { ok: true })
      } catch (error: unknown) {
        json(res, 500, { error: error instanceof Error ? error.message : 'done state failed' })
      }
    },
  }), 'dsh-sidebar-taskbar: done route')
}
