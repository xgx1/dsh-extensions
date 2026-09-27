import { describe, expect, it } from 'vitest'
import { AUTO_MODEL, AUTO_PROVIDER, AutoRouteAdapter } from '../src/auto-route.ts'

/** Collect every chunk one adapter stream yields. */
async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('AutoRouteAdapter', () => {
  it('names the provider group under the route it owns', () => {
    const adapter = new AutoRouteAdapter(() => undefined)
    expect(adapter.providerInfo(AUTO_PROVIDER).id).toBe(AUTO_PROVIDER)
    expect(adapter.providerInfo(AUTO_PROVIDER).name).toContain('自动')
  })

  it('advertises exactly the one selector entry the router resolves', async () => {
    const adapter = new AutoRouteAdapter(() => undefined)
    const models = await adapter.listModels(AUTO_PROVIDER)
    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe(AUTO_MODEL)
    expect(models[0]?.provider).toBe(AUTO_PROVIDER)
  })

  it('reports a context window so occupancy stays comparable across routes', async () => {
    const adapter = new AutoRouteAdapter(() => undefined)
    const resolved = await adapter.resolveModel(AUTO_PROVIDER, AUTO_MODEL)
    expect(resolved.context?.contextWindow).toBeGreaterThan(262_144)
  })

  it('delegates a request that bypassed the router to the static default', async () => {
    const seen: unknown[] = []
    let notes = 0
    const adapter = new AutoRouteAdapter(
      () => ({
        route: { provider: 'md', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
        stream: options => (async function* stream() {
          seen.push(options)
          yield 'chunk' as never
        })(),
      }),
      () => { notes += 1 },
    )

    const chunks = await drain(adapter.stream({ provider: AUTO_PROVIDER, model: AUTO_MODEL } as never))
    expect(chunks).toEqual(['chunk'])
    expect(seen[0]).toMatchObject({ provider: 'md', model: 'deepseek-ai/DeepSeek-V4.1-Flash' })
    expect(notes).toBe(1)

    // The note reports the first bypass only; a second one must not spam the log.
    await drain(adapter.stream({ provider: AUTO_PROVIDER, model: AUTO_MODEL } as never))
    expect(notes).toBe(1)
  })

  it('fails loudly when no static default is configured', async () => {
    const adapter = new AutoRouteAdapter(() => undefined)
    await expect(drain(adapter.stream({ provider: AUTO_PROVIDER, model: AUTO_MODEL } as never)))
      .rejects.toMatchObject({ code: 'AUTO_ROUTE_UNRESOLVED' })
  })
})
