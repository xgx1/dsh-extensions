import { describe, expect, it } from 'vitest'
import {
  composeState,
  estimateTokens,
  isHumanMessage,
  textOf,
  type MessageLike,
} from '../src/state.ts'

const human = (text: string): MessageLike => ({
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
})

describe('isHumanMessage', () => {
  it('accepts a typed user message', () => {
    expect(isHumanMessage(human('hi'))).toBe(true)
  })

  it('rejects a tool result, which is also role user', () => {
    expect(isHumanMessage({ role: 'user', source: { kind: 'tool' }, content: [] })).toBe(false)
  })

  it('rejects injected runtime context, which is role user with plugin provenance', () => {
    expect(isHumanMessage({ role: 'user', source: { kind: 'plugin' }, content: [] })).toBe(false)
  })

  it('rejects assistant messages and messages without provenance', () => {
    expect(isHumanMessage({ role: 'assistant', source: { kind: 'model' } })).toBe(false)
    expect(isHumanMessage({ role: 'user' })).toBe(false)
  })
})

describe('textOf', () => {
  it('joins text parts in order', () => {
    expect(textOf({
      content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
    })).toBe('first\nsecond')
  })

  it('names non-text parts instead of inlining them', () => {
    expect(textOf({ content: [{ type: 'image', url: 'x' }, { type: 'text', text: 'hi' }] }))
      .toBe('[image]\nhi')
  })

  it('passes a plain string through and ignores unusable content', () => {
    expect(textOf({ content: 'plain' })).toBe('plain')
    expect(textOf({ content: 42 })).toBe('')
    expect(textOf({})).toBe('')
  })
})

describe('estimateTokens', () => {
  it('counts CJK characters one token each', () => {
    expect(estimateTokens('你好世界')).toBe(4)
  })

  it('counts other scripts four characters per token', () => {
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('is zero for empty text', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('composeState', () => {
  it('returns an empty state for no messages', () => {
    expect(composeState([], 100)).toEqual({ state: '', kept: 0, elided: 0, estimatedTokens: 0 })
  })

  it('keeps a single message whole', () => {
    const composed = composeState(['只有一个任务'], 100)
    expect(composed.state).toBe('【消息1】只有一个任务')
    expect(composed.elided).toBe(0)
  })

  it('keeps the origin and the newest, and marks what it dropped', () => {
    const messages = ['起点任务', ...Array.from({ length: 6 }, (_, i) => `中间任务${i}`), '最新任务']
    const composed = composeState(messages, 30)
    expect(composed.state).toContain('【消息1】起点任务')
    expect(composed.state).toContain('最新任务')
    expect(composed.state).toMatch(/中间省略了 \d+ 条消息/)
    expect(composed.elided).toBeGreaterThan(0)
    expect(composed.kept + composed.elided).toBe(messages.length)
  })

  it('never drops the newest message, even when it alone exceeds the budget', () => {
    const composed = composeState(['起点', '这是一个非常长'.repeat(50)], 10)
    expect(composed.state).toContain('这是一个非常长')
  })

  it('numbers messages by their original position so "the largest number is newest" holds', () => {
    const composed = composeState(['a', 'b', 'c', 'd'], 20)
    const numbers = [...composed.state.matchAll(/【消息(\d+)】/g)].map(match => Number(match[1]))
    expect(numbers[0]).toBe(1)
    expect(Math.max(...numbers)).toBe(4)
  })
})
