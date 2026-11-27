import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActiveStore } from '../src/store.ts'
import { interruptedByShutdown, resolveConfig, selectResumes } from '../src/index.ts'

const dirs: string[] = []
const stores: ActiveStore[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function openStore(): Promise<ActiveStore> {
  const dir = await mkdtemp(join(tmpdir(), 'resume-sessions-'))
  dirs.push(dir)
  const store = new ActiveStore(join(dir, 'resume.db'))
  stores.push(store)
  return store
}

describe('interruptedByShutdown', () => {
  it('keeps only the host stop', () => {
    expect(interruptedByShutdown({ kind: 'aborted', reason: { kind: 'disposed' } })).toBe(true)
    expect(interruptedByShutdown({ kind: 'aborted', reason: { kind: 'user' } })).toBe(false)
    expect(interruptedByShutdown({ kind: 'completed' })).toBe(false)
    expect(interruptedByShutdown({ kind: 'interrupted' })).toBe(false)
  })
})

describe('selectResumes', () => {
  it('drops vanished, subagent, and archived sessions', () => {
    const headers = new Map([
      ['live', {}],
      ["child", { origin: 'subagent' as const }],
      ['kept', {}],
    ])
    const selected = selectResumes(['live', 'child', 'kept', 'gone'], headers, new Set(['kept']))
    expect(selected.resume).toEqual(['live'])
    expect(selected.drop).toEqual(['child', 'kept', 'gone'])
  })
})

describe('resolveConfig', () => {
  it('defaults on and rejects a spacing it cannot honor', () => {
    expect(resolveConfig({})).toEqual({ enabled: true, delayMs: 2000 })
    expect(resolveConfig({ enabled: false, delayMs: 0 })).toEqual({ enabled: false, delayMs: 0 })
    expect(() => resolveConfig({ delayMs: -1 })).toThrow('delayMs')
    expect(() => resolveConfig({ delayMs: 60_001 })).toThrow('delayMs')
  })
})

describe('ActiveStore', () => {
  it('tracks rows individually and survives a reopen, as after a restart', async () => {
    const store = await openStore()
    expect(await store.list()).toEqual([])
    await store.keep('a')
    await store.keep('a')
    await store.keep('b')
    expect((await store.list()).sort()).toEqual(['a', 'b'])
    await store.drop('a')
    expect(await store.list()).toEqual(['b'])
    await store.dropAll(['b', 'c'])
    expect(await store.list()).toEqual([])
    await store.keep('d')
    await store.close()
    const reopened = new ActiveStore(join(dirs.at(-1)!, 'resume.db'))
    stores.push(reopened)
    expect(await reopened.list()).toEqual(['d'])
  })
})
