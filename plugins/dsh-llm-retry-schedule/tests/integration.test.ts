/**
 * Integration coverage: the plugin mounted next to the real agent loop,
 * LLM runtime, and session store, driving real request failures through a
 * scripted adapter. Waits run on vitest fake timers, so the assertions read
 * the scheduled delay out of the durable `llm/retry` record and then advance
 * exactly that many milliseconds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as shippedRetry from '@deepseek-ai/dsh-llm-retry'
import { apply, inject, type RetryInternals, type RetryScheduleConfig } from '../src/index.ts'

type ScriptEntry = Error | Iterable<StreamChunk>

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('integration script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

let context: Context | undefined

afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
})

async function harness(
  adapter: ScriptedAdapter,
  config: RetryScheduleConfig = {},
  internals: RetryInternals = {},
  shipped: boolean = false,
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (shipped) {
    await ctx.plugin(Object.assign((inner: Context) => {
      shippedRetry.apply(inner, {}, { random: () => 0.5 })
    }, { inject: shippedRetry.inject }))
  }
  await ctx.plugin(Object.assign((inner: Context) => {
    apply(inner, config, internals)
  }, { inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForRetry(
  ctx: Context,
  agent: Agent,
  retryNumber: number,
): Promise<Extract<SessionEvent, { type: 'llm/retry' }>> {
  return new Promise((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'llm/retry' && event.data.retry === retryNumber) {
        dispose()
        resolve(event)
      }
    })
  })
}

async function startTurn(ctx: Context, id: string, adapter: ScriptedAdapter): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  return agent
}

/** Drive one failure per scripted entry, advancing each recorded wait exactly. */
async function driveRetries(
  ctx: Context,
  agent: Agent,
  count: number,
): Promise<Extract<SessionEvent, { type: 'llm/retry' }>[]> {
  // Every waiter is registered before the first advance: a retry that follows
  // an elapsed wait schedules its own record inside the same timer flush.
  const waiters = Array.from({ length: count }, (_, index) => waitForRetry(ctx, agent, index + 1))
  const events: Extract<SessionEvent, { type: 'llm/retry' }>[] = []
  for (const waiter of waiters) {
    const event = await waiter
    events.push(event)
    await vi.advanceTimersByTimeAsync(event.data.delayMs)
  }
  return events
}

describe('llm-retry-schedule on the real agent loop', () => {
  it('retries a transient failure on the default schedule and finishes the turn', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
      textResponse('done'),
    ])
    context = await harness(adapter)
    const agent = await startTurn(context, 'schedule-single', adapter)

    const [scheduled] = await driveRetries(context, agent, 1)

    expect(scheduled?.data).toMatchObject({
      turn: 1,
      step: 1,
      provider: 'mock',
      mode: 'normal',
      retry: 1,
      maxRetries: 1000,
      delayMs: 5_000,
      failure: { message: 'busy', code: 'RATE_LIMIT', status: 429 },
    })

    const idle = agent.whenIdle()
    await vi.advanceTimersByTimeAsync(0)
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end'))
      .toHaveLength(1)
  })

  it('holds a long series at 5s, then 10s, then 60s inside one step', async () => {
    vi.useFakeTimers()
    const failures = Array.from({ length: 21 }, () => new LlmError('busy', 'RATE_LIMIT', { status: 429 }))
    const adapter = new ScriptedAdapter([...failures, textResponse('recovered')])
    context = await harness(adapter)
    const agent = await startTurn(context, 'schedule-tiers', adapter)

    const events = await driveRetries(context, agent, 21)
    const delays = events.map(event => event.data.delayMs)

    expect(delays.slice(0, 4)).toEqual([5_000, 5_000, 5_000, 5_000])
    expect(delays.slice(4, 19)).toEqual(new Array(15).fill(10_000))
    expect(delays.slice(19)).toEqual([60_000, 60_000])
    expect(events.map(event => event.data.retry)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1),
    )
    expect(new Set(events.map(event => event.data.retryId)).size).toBe(1)

    // The whole series stays inside one step: retries never re-enter the loop's
    // step admission.
    expect(agent.session.snapshotEvents().filter(event => event.type === 'step/start')).toHaveLength(1)

    const idle = agent.whenIdle()
    await vi.advanceTimersByTimeAsync(0)
    await idle

    expect(adapter.requests).toHaveLength(22)
  })

  it('honors a configured budget and then hands the failure to the next owner', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
      new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
      new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
    ])
    context = await harness(adapter, { maxRetries: 2 })
    const agent = await startTurn(context, 'schedule-budget', adapter)

    await driveRetries(context, agent, 2)
    const idle = agent.whenIdle().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(60_000)
    await idle

    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'llm/retry')).toHaveLength(2)
    expect(adapter.requests).toHaveLength(3)
    const end = events.find(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind).toBe('error')
  })

  it('leaves a non-transient failure terminal', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH', { status: 401 })])
    context = await harness(adapter)
    const agent = await startTurn(context, 'schedule-terminal', adapter)

    const idle = agent.whenIdle().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(60_000)
    await idle

    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'llm/retry')).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)
    const end = events.find(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind).toBe('error')
  })

  it('wins over the shipped llm-retry row that stays mounted underneath', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
      new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
      textResponse('done'),
    ])
    context = await harness(adapter, {}, {}, true)
    const agent = await startTurn(context, 'schedule-over-shipped', adapter)

    const events = await driveRetries(context, agent, 2)
    const idle = agent.whenIdle()
    await vi.advanceTimersByTimeAsync(0)
    await idle

    // The shipped policy would have waited 500 ms and capped at 5 retries;
    // both attempts carry this plugin's schedule instead, once each.
    expect(events.map(event => event.data.delayMs)).toEqual([5_000, 5_000])
    expect(events.map(event => event.data.mode === 'normal' ? event.data.maxRetries : 0)).toEqual([1000, 1000])
    expect(new Set(events.map(event => event.data.policyKey)).size).toBe(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(2)
    expect(adapter.requests).toHaveLength(3)
  })
})
