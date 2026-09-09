/**
 * dsh-task-manager — shared HTTP plumbing for the host routes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Send a JSON response with `no-store` so the browser never caches task state. */
export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Read a small JSON request body, rejecting oversize or malformed payloads. */
export async function readJsonBody(req: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  await new Promise<void>((resolvePromise, reject) => {
    req.on('data', (chunk) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += part.length
      if (size > limit) {
        reject(new Error('request body is too large'))
        return
      }
      chunks.push(part)
    })
    req.on('end', () => resolvePromise())
    req.on('error', reject)
  })
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}
