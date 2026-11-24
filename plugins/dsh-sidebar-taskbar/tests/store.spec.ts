import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DoneStore } from '../src/store.ts'

const dirs: string[] = []
const stores: DoneStore[] = []

/** Open one store on a fresh database file inside a fresh temporary directory. */
async function openStore(): Promise<{ path: string; store: DoneStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'taskbar-'))
  dirs.push(dir)
  const path = join(dir, 'taskbar.db')
  const store = new DoneStore(path)
  stores.push(store)
  return { path, store }
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Row order is the database's, not the writer's; compare the sets. */
const sets = (state: { shown: readonly string[]; unread: readonly string[] }): unknown => ({
  shown: [...state.shown].sort(),
  unread: [...state.unread].sort(),
})

describe('DoneStore', () => {
  it('starts empty and round-trips both sets', async () => {
    const { store } = await openStore()
    expect(sets(await store.read())).toEqual({ shown: [], unread: [] })
    await store.write({ shown: ['a', 'b'], unread: ['a'] })
    expect(sets(await store.read())).toEqual({ shown: ['a', 'b'], unread: ['a'] })
  })

  it('replaces the stored sets on every write', async () => {
    const { store } = await openStore()
    await store.write({ shown: ['a', 'b'], unread: ['a', 'b'] })
    await store.write({ shown: ['b'], unread: ['a', 'b'] })
    expect(sets(await store.read())).toEqual({ shown: ['b'], unread: ['a', 'b'] })
  })

  it('reads back across a reopen, as after a host restart', async () => {
    const { path, store } = await openStore()
    await store.write({ shown: ['a'], unread: [] })
    await store.close()
    const reopened = new DoneStore(path)
    stores.push(reopened)
    expect(sets(await reopened.read())).toEqual({ shown: ['a'], unread: [] })
  })
})