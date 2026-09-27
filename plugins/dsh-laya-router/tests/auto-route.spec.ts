import { describe, expect, it } from 'vitest'
import { AUTO_MODEL, AUTO_PROVIDER, AutoRouteAdapter } from '../src/auto-route.ts'

const adapter = new AutoRouteAdapter()

describe('AutoRouteAdapter', () => {
  it('names the provider group under the route it owns', () => {
    expect(adapter.providerInfo(AUTO_PROVIDER).id).toBe(AUTO_PROVIDER)
    expect(adapter.providerInfo(AUTO_PROVIDER).name).toContain('自动')
  })

  it('advertises exactly the one selector entry the router resolves', async () => {
    const models = await adapter.listModels(AUTO_PROVIDER)
    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe(AUTO_MODEL)
    expect(models[0]?.provider).toBe(AUTO_PROVIDER)
  })

  it('reports a context window so occupancy stays comparable across routes', async () => {
    const resolved = await adapter.resolveModel(AUTO_PROVIDER, AUTO_MODEL)
    expect(resolved.context?.contextWindow).toBeGreaterThan(262_144)
  })

  it('fails loudly when a request reaches it instead of the router', async () => {
    const iterate = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({} as never)) {
        throw new Error('the adapter must not yield')
      }
    }
    await expect(iterate()).rejects.toMatchObject({ code: 'AUTO_ROUTE_UNRESOLVED' })
  })
})
