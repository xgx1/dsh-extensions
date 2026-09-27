/**
 * The `auto` route: the model-selector entry that hands the choice to the
 * router.
 *
 * The browser model catalog is a projection of the LLM registry
 * (`listProviders()` → `listModels()`), so the only supported way to offer a
 * selector entry is to register a provider that advertises it. This adapter
 * exists for exactly that: it advertises one model, `auto`.
 *
 * No request should ever reach `stream()`. The router rewrites the call config
 * at `agent/request` before dispatch, and a session that selects `auto` always
 * resolves to a real route — the Laya choice in `live` mode, the configured
 * static default otherwise. Reaching this adapter therefore means the router is
 * not composed at all (or its `unlabeledRoute` is `null`), which is a
 * misconfiguration worth failing loudly for.
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

/** Adapter that advertises the `auto` selector entry and refuses to be called. */
export class AutoRouteAdapter extends LlmAdapter {
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
   * Refuse dispatch: `auto` must be replaced by the router before a call.
   * @param _options - the assembled request this adapter must never receive.
   * @returns Never; the stream throws on first iteration.
   */
  override async *stream(_options: GenerateOptions): AsyncGenerator<never, void, undefined> {
    throw new LlmError(
      'route "auto" is resolved per turn by dsh-laya-router, and no request should reach it; '
      + 'either the router is not composed for this profile, or its policy.unlabeledRoute is null',
      'AUTO_ROUTE_UNRESOLVED',
    )
  }
}

/** The chunk type this module never yields, re-exported for the adapter contract. */
export type AutoRouteChunk = StreamChunk
