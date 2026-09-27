/**
 * Which route one request runs on.
 *
 * The harness re-applies a Session's `auto` selection on **every** step of a
 * turn: its pending pick is retired only when a written `request/header` matches
 * it exactly, and a rerouted header never does. So `auto` is resolved per step
 * rather than once per turn, and every step of one turn keeps the same route —
 * switching models mid-turn would split the KV-cache epoch for no reason.
 *
 * @module dsh-laya-router/apply
 */

/** A route this turn may run on. */
export interface PendingRoute {
  /** Provider and model to dispatch. */
  readonly route: { readonly provider: string; readonly model: string }
  /** Reasoning effort to send, when the route accepts one. */
  readonly effort?: string
}

/**
 * Choose the route for this request.
 *
 * The first step of a turn uses the decision taken at `agent/pre-step`; a later
 * step reuses whatever that turn already ran on. A step with no decision of its
 * own (a resumed turn, a decision that failed, a freshly mounted router) falls
 * back to the configured static default rather than leaving the placeholder
 * route in place.
 *
 * @param options - step number plus the three candidate routes, any of which may be absent.
 * @returns The route to apply, or `undefined` to leave the request untouched.
 */
export function pickAppliedRoute(options: {
  readonly step: number
  readonly pending: PendingRoute | undefined
  readonly applied: PendingRoute | undefined
  readonly fallback: PendingRoute | undefined
}): PendingRoute | undefined {
  if (options.step === 1 && options.pending !== undefined) return options.pending
  return options.applied ?? options.fallback
}
