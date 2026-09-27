/**
 * The `auto` route: the model-selector entry that hands the choice to the
 * router.
 *
 * The browser model catalog is a projection of the LLM registry
 * (`listProviders()` → `listModels()`), so the only supported way to offer a
 * selector entry is to register a provider that advertises it. This adapter
 * exists for exactly that: it advertises one model, `auto`.
 *
 * The router normally rewrites the call config at `agent/request` before
 * dispatch, and a session that selects `auto` resolves to a real route — the
 * Laya choice in `live` mode, the configured static default otherwise. A request
 * can still arrive here when it is not an agent step the router sees (a title or
 * summary call, a caller that bypasses `agent/request`), so this adapter
 * **delegates** to the configured static default instead of failing the turn.
 * With no default configured there is nothing sensible to run, and the stream
 * fails loudly.
 *
 * @module dsh-laya-router/auto-route
 */

import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

/** Provider route the selector shows as "auto". */
export const AUTO_PROVIDER = 'auto'

/** The single model id that provider advertises. */
export const AUTO_MODEL = 'auto'

/**
 * Context capacity assumed while a session is on `auto`. Every candidate route
 * is at least this large, so occupancy measured against it never overstates
 * pressure before the router resolves the real model.
 */
const AUTO_CONTEXT_WINDOW = 1_000_000

/** Where a request that reached the placeholder route is actually dispatched. */
export interface AutoRouteFallback {
  /** Route to dispatch on behalf of `auto`. */
  readonly route: { readonly provider: string; readonly model: string }
  /** Runtime dispatch entry point, re-resolving the adapter for {@link route}. */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Adapter that advertises the `auto` selector entry and delegates dispatch. */
export class AutoRouteAdapter extends LlmAdapter {
  #noted = false

  /**
   * @param fallback - Resolves the configured static default, or `undefined` when none is set.
   * @param note - Reports the first delegation, which means something bypassed the router.
   */
  constructor(
    private readonly fallback: () => AutoRouteFallback | undefined,
    private readonly note: (message: string) => void = () => {},
  ) {
    super()
  }

  /**
   * Name the provider group in the selector.
   * @param provider - the route this registration owns.
   * @returns Display metadata whose id equals `provider`.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: '自动（判断层逐轮选择）' }
  }

  /**
   * Advertise the single `auto` entry.
   * @param provider - the route this registration owns.
   * @returns One model entry describing what selecting it means.
   */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{
      provider,
      id: AUTO_MODEL,
      name: 'auto',
      description: '由 dsh-laya-router 按轮判断：难度 / 时间预算 / 是否换任务 → 在已配置模型里选一个',
    }])
  }

  /**
   * Report the placeholder capacity a session on `auto` is measured against.
   * @param provider - the route this registration owns.
   * @param model - the requested model id.
   * @returns Provider/model identity with the assumed context window.
   */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'auto',
      context: { contextWindow: AUTO_CONTEXT_WINDOW },
    })
  }

  /**
   * Dispatch on the configured static default.
   *
   * @param options - the assembled request that reached the placeholder route.
   * @returns The fallback route's chunk stream.
   * @throws LlmError when no static default is configured.
   */
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, undefined> {
    const target = this.fallback()
    if (target === undefined) {
      throw new LlmError(
        'route "auto" has no route to run on: configure policy.unlabeledRoute (or compose dsh-laya-router) '
        + 'so a request that reaches the auto entry resolves to a real model',
        'AUTO_ROUTE_UNRESOLVED',
      )
    }
    if (!this.#noted) {
      this.#noted = true
      this.note(`a request reached the auto route unresolved; running it on ${target.route.provider}/${target.route.model}`)
    }
    yield* target.stream({ ...options, provider: target.route.provider, model: target.route.model })
  }
}

/** The chunk type this module never yields, re-exported for the adapter contract. */
export type AutoRouteChunk = StreamChunk
