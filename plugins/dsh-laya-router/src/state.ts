/**
 * Deterministic composition of the decision state handed to Laya.
 *
 * Laya reads one `state` per call and every question about it is answered from
 * that single reading, so the state is the whole input surface. Two measured
 * facts shape this module:
 *
 * - The state budget is small (english 320 tokens, multilingual 768) and Laya
 *   truncates an oversized state by keeping its FRONT and discarding its tail —
 *   the opposite of what per-turn routing needs. So the plugin composes the
 *   state itself instead of handing over a transcript and hoping.
 * - Only messages a human typed belong in it. A tool result is also
 *   `role: 'user'`, and the prompt assembler injects runtime context the same
 *   way, so provenance (`source.kind === 'user'`) is the only reliable test.
 *
 * @module dsh-laya-router/state
 */

/** The part of a message this module reads. */
export interface MessageLike {
  /** Message role; tool results also use `user`. */
  readonly role?: string
  /** Provenance; only `kind === 'user'` is a human message. */
  readonly source?: { readonly kind?: string } | null
  /** Content parts, or a plain string for synthetic messages. */
  readonly content?: unknown
}

/** True only for a message a human typed. */
export function isHumanMessage(message: MessageLike): boolean {
  return message.role === 'user' && message.source?.kind === 'user'
}

/** Join the text parts of one message; non-text parts are named, never inlined. */
export function textOf(message: MessageLike): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    else if (typeof record.type === 'string') parts.push(`[${record.type}]`)
  }
  return parts.join('\n')
}

/**
 * Rough token estimate: one token per CJK character, one per four others.
 * The sidecar reports an exact count when it answers; this is only used to
 * decide what fits before paying for a call.
 */
export function estimateTokens(text: string): number {
  let wide = 0
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) > 0x2e80) wide += 1
  }
  return Math.ceil(wide + (text.length - wide) / 4)
}

/** What {@link composeState} produced, including what it had to drop. */
export interface ComposedState {
  /** The state text handed to Laya. */
  readonly state: string
  /** Messages that survived, counting the preserved first one. */
  readonly kept: number
  /** Messages elided from the middle. */
  readonly elided: number
  /** Estimated tokens of {@link state}. */
  readonly estimatedTokens: number
}

/**
 * Compose the decision state: the first message (the task's origin) plus as
 * many of the newest messages as the budget allows, with one marker naming how
 * many were elided between them. Every message keeps its original `【消息N】`
 * number, so "the highest number is the newest" stays true after elision.
 *
 * The newest message is always kept, even when it alone exceeds the budget:
 * routing without it would answer a question nobody asked.
 *
 * @param messages - Human message texts in conversation order.
 * @param budgetTokens - Rough token budget for the composed state.
 * @returns The composed state and its elision facts.
 */
export function composeState(messages: readonly string[], budgetTokens: number): ComposedState {
  const rendered = messages
    .map((text, index) => ({ index, text: `【消息${index + 1}】${text.trim()}` }))
    .filter(entry => entry.text.length > 0)
  if (rendered.length === 0) return { state: '', kept: 0, elided: 0, estimatedTokens: 0 }

  const first = rendered[0]!
  if (rendered.length === 1) {
    return { state: first.text, kept: 1, elided: 0, estimatedTokens: estimateTokens(first.text) }
  }

  const tail: string[] = []
  let used = estimateTokens(first.text)
  for (let cursor = rendered.length - 1; cursor >= 1; cursor -= 1) {
    const candidate = rendered[cursor]!
    const cost = estimateTokens(candidate.text)
    if (tail.length > 0 && used + cost > budgetTokens) break
    tail.unshift(candidate.text)
    used += cost
  }

  const elided = rendered.length - 1 - tail.length
  const marker = elided > 0 ? `【…中间省略了 ${elided} 条消息…】` : ''
  const parts = [first.text, marker, ...tail].filter(part => part.length > 0)
  const state = parts.join('\n')
  return { state, kept: 1 + tail.length, elided, estimatedTokens: estimateTokens(state) }
}
