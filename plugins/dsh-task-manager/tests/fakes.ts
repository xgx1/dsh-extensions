/**
 * Shared test fakes for dsh-task-manager unit tests.
 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentLike, AgentsRegistryLike, SubagentsLike } from '../src/orchestrator.ts'

/** Fake ServerResponse capturing status, headers, and body. */
export class FakeResponse {
  status = 0
  headers: Record<string, unknown> = {}
  body = ''

  writeHead(status: number, headers?: Record<string, unknown>): void {
    this.status = status
    this.headers = headers ?? {}
  }

  end(body?: string): void {
    if (body !== undefined) this.body += body
  }
}

/** Fake IncomingMessage: a URL + method + pushable body over the event emitter. */
export class FakeRequest extends EventEmitter {
  constructor(readonly url: string, readonly method: string = 'GET', private body = '') {
    super()
  }

  /** Simulate request-body arrival (call before the handler awaits `end`). */
  feed(): void {
    queueMicrotask(() => {
      if (this.body !== '') this.emit('data', Buffer.from(this.body, 'utf8'))
      this.emit('end')
    })
  }
}

/** Cast fakes to the node http types the route handlers accept. */
export function asReq(request: FakeRequest): IncomingMessage {
  return request as unknown as IncomingMessage
}
export function asRes(response: FakeResponse): ServerResponse {
  return response as unknown as ServerResponse
}

export interface StartContinuableCall {
  spec: Parameters<SubagentsLike['startContinuable']>[0]
}

/** Recording fake for the subagent runtime (M0 结论 1/2 call surface). */
export class FakeSubagents implements SubagentsLike {
  readonly continuableCalls: StartContinuableCall[] = []
  readonly coldFollowups: Array<{ childId: string; text: string }> = []
  /** Next startContinuable call rejects with this error when set. */
  failNext: Error | undefined

  async startContinuable(spec: Parameters<SubagentsLike['startContinuable']>[0]): Promise<{ childId: string; messageId: string }> {
    this.continuableCalls.push({ spec })
    if (this.failNext !== undefined) throw this.failNext
    return { childId: spec.childId, messageId: 'msg-' + String(this.continuableCalls.length) }
  }

  async followup(
    _parent: AgentLike,
    childId: string,
    content: Array<{ type: 'text'; text: string }>,
    _options: { source: { kind: 'plugin'; plugin: string }; signal: AbortSignal },
  ): Promise<string> {
    this.coldFollowups.push({ childId, text: content.map((block) => block.text).join('\n') })
    return 'cold-msg-' + String(this.coldFollowups.length)
  }
}

/** Recording fake for one live agent (hot delivery path). */
export class FakeAgent implements AgentLike {
  readonly followups: unknown[] = []
  readonly injects: unknown[] = []

  followup(message: unknown): void {
    this.followups.push(message)
  }

  inject(message: unknown): void {
    this.injects.push(message)
  }

  lastFollowupText(): string {
    const last = this.followups[this.followups.length - 1] as { content?: Array<{ text?: string }> } | undefined
    return last?.content?.map((block) => block.text ?? '').join('\n') ?? ''
  }
}

/** Fake agents registry: map of sessionId → live agent. */
export class FakeAgents implements AgentsRegistryLike {
  constructor(readonly map: Map<string, FakeAgent> = new Map()) {}

  get(sessionId: string): FakeAgent | undefined {
    return this.map.get(sessionId)
  }

  add(sessionId: string): FakeAgent {
    const agent = new FakeAgent()
    this.map.set(sessionId, agent)
    return agent
  }
}
