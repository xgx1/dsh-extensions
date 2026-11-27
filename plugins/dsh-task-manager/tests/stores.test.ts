/**
 * a2 — serialized atomic writes: concurrent mutations never interleave.
 *
 * The mutation queue is the correctness mechanism: each mutate() re-reads the
 * freshest on-disk state inside the serialized section, so lost updates (the
 * symptom of interleaved read-modify-write) cannot happen.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaptainStore, SettingsStore, TaskStore } from '../src/stores.ts'

describe('TaskStore concurrent mutate() serialization', () => {
  it('survives 30 concurrent increments with all updates present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-conc-'))
    try {
      const store = new TaskStore(dir)
      await store.mutate((tasks) => {
        tasks.push({
          id: 't1',
          title: 'counter',
          content: '',
          status: 'not-started',
          runMode: 'cwd',
          directory: '/tmp',
          dispatchRound: 0,
          needsFinalReview: false,
          createdAt: 1,
          updatedAt: 1,
        })
      })

      // 30 个并发 mutate，各自 read-modify-write 同一个计数；未串行化必然丢失更新
      await Promise.all(
        Array.from({ length: 30 }, () =>
          store.mutate(async (tasks) => {
            const task = tasks.find((item) => item.id === 't1')
            if (task === undefined) throw new Error('missing')
            await new Promise((resolve) => setTimeout(resolve, 1)) // 放大交错窗口
            task.dispatchRound += 1
          }),
        ),
      )

      // 数据在 <dir>/task-manager.db：从 store 读回，别读已退役的 tasks.json。
      const stored = await store.load()
      expect(stored[0]?.dispatchRound).toBe(30)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('CaptainStore concurrent mutate() serialization', () => {
  it('keeps 20 concurrent category upserts without cross-corruption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'captain-conc-'))
    try {
      const store = new CaptainStore(dir)
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          store.mutate((registry) => {
            registry[`cat-${index}`] = {
              ...(registry[`cat-${index}`] ?? {}),
              charter: `charter-${index}`,
              createdAt: index,
              lastDispatchAt: index,
            }
          }),
        ),
      )
      // 再并发 20 次同类别章程覆盖，验证同键竞争也不丢
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          store.mutate((registry) => {
            const entry = registry['cat-0']
            if (entry !== undefined) entry.charter = `rewritten-${index}`
          }),
        ),
      )

      // 数据在 <dir>/task-manager.db：从 store 读回，别读已退役的 captains.json。
      const raw = await store.load()
      expect(Object.keys(raw)).toHaveLength(20)
      expect(raw['cat-0']?.charter).toMatch(/^rewritten-\d+$/)
      expect(raw['cat-19']?.charter).toBe('charter-19')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
describe('Turso 迁移：旧分文件 JSON 一次性导入', () => {
  it('首次打开导入 tasks.json，之后再也不覆盖库里的状态', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-mig-'))
    try {
      await writeFile(join(dir, 'tasks.json'), JSON.stringify([{ id: 'legacy', title: 'legacy', content: '', status: 'not-started', runMode: 'cwd', directory: '/tmp', dispatchRound: 0, needsFinalReview: false, createdAt: 1, updatedAt: 1 }]), 'utf8')
      const store = new TaskStore(dir)
      expect((await store.load()).map((task) => task.id)).toEqual(['legacy'])

      await store.mutate((tasks) => { tasks[0]!.title = 'renamed' })
      // 旧文件不被回写覆盖：它只是迁移证据，事实源已经是 task-manager.db
      expect(JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8'))[0].title).toBe('legacy')
      expect((await store.load())[0]?.title).toBe('renamed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('同一库两个 store 并发写', () => {
  it('tasks 与 settings 同时 mutate 不会互相打断事务', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-shared-'))
    try {
      const tasks = new TaskStore(dir)
      const settings = new SettingsStore(dir)
      const results = await Promise.allSettled([
        tasks.mutate((list) => { list.push({ id: 'x', title: 't', content: '', status: 'not-started', runMode: 'cwd', directory: '/tmp', dispatchRound: 0, needsFinalReview: false, createdAt: 1, updatedAt: 1 }) }),
        settings.mutate((state) => { state.allowedModels = ['prov/m'] }),
        tasks.mutate((list) => { const first = list.find((task) => task.id === 'x'); if (first) first.dispatchRound += 1 }),
        settings.mutate((state) => { state.situationModels = { simple: 'prov/m' } }),
      ])
      expect(results.map((item) => item.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'])
      expect((await tasks.load())[0]?.dispatchRound).toBe(1)
      expect(await settings.load()).toEqual({ allowedModels: ['prov/m'], situationModels: { simple: 'prov/m' } })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

