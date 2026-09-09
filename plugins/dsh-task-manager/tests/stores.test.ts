/**
 * a2 — serialized atomic writes: concurrent mutations never interleave.
 *
 * The mutation queue is the correctness mechanism: each mutate() re-reads the
 * freshest on-disk state inside the serialized section, so lost updates (the
 * symptom of interleaved read-modify-write) cannot happen.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaptainStore, TaskStore } from '../src/stores.ts'

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

      const raw = JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8')) as Array<{ dispatchRound: number }>
      expect(raw[0]?.dispatchRound).toBe(30)
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

      const raw = JSON.parse(await readFile(join(dir, 'captains.json'), 'utf8')) as Record<string, { charter: string }>
      expect(Object.keys(raw)).toHaveLength(20)
      expect(raw['cat-0']?.charter).toMatch(/^rewritten-\d+$/)
      expect(raw['cat-19']?.charter).toBe('charter-19')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
