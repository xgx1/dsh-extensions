/**
 * a1 — legacy record migration tolerance.
 *
 * The production `~/.dsh/task-manager/tasks.json` holds two pre-orchestration
 * records; loading must keep every legacy key and fill the new fields with
 * defaults at read time, never throwing.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeTask } from '../src/records.ts'
import { TaskStore } from '../src/stores.ts'

/** The two legacy records exactly as they sit in the production tasks.json. */
const LEGACY_TASKS = [
  {
    id: '66221e31-b493-4288-b137-e906719db7b5',
    title: 'ce shi',
    content: 'ce shi',
    status: 'not-started',
    runMode: 'cwd',
    directory: '/home/sx/projects/MyAI',
    createdAt: 1787993715031,
    updatedAt: 1787993732980,
  },
  {
    id: 'f4c0d450-5cae-4599-b50e-6bcee448940f',
    title: 'ce shi biao ti ying',
    content: 'ce shi biao ti ying',
    status: 'not-started',
    runMode: 'cwd',
    directory: '/home/sx/projects/MyAI',
    createdAt: 1787993865199,
    updatedAt: 1787993865199,
  },
]

describe('normalizeTask (读时补默认)', () => {
  it('keeps every legacy key and fills orchestration defaults', () => {
    const task = normalizeTask(LEGACY_TASKS[0])
    expect(task).not.toBeNull()
    // 旧字段一字不丢
    expect(task?.id).toBe('66221e31-b493-4288-b137-e906719db7b5')
    expect(task?.title).toBe('ce shi')
    expect(task?.content).toBe('ce shi')
    expect(task?.status).toBe('not-started')
    expect(task?.runMode).toBe('cwd')
    expect(task?.directory).toBe('/home/sx/projects/MyAI')
    expect(task?.createdAt).toBe(1787993715031)
    expect(task?.updatedAt).toBe(1787993732980)
    // 缺失的新字段补默认
    expect(task?.dispatchRound).toBe(0)
    expect(task?.needsFinalReview).toBe(false)
    expect(task?.category).toBeUndefined()
    expect(task?.captainSessionId).toBeUndefined()
    expect(task?.report).toBeUndefined()
    expect(task?.lastNudgeAt).toBeUndefined()
  })

  it('drops malformed optional fields instead of propagating them', () => {
    const task = normalizeTask({
      ...LEGACY_TASKS[0],
      dispatchRound: 'three',
      needsFinalReview: 'yes',
      category: '',
      captainSessionId: 42,
      lastNudgeAt: -5,
      report: { text: 7, at: 'now' },
    })
    expect(task?.dispatchRound).toBe(0)
    expect(task?.needsFinalReview).toBe(false)
    expect(task?.category).toBeUndefined()
    expect(task?.captainSessionId).toBeUndefined()
    expect(task?.lastNudgeAt).toBeUndefined()
    expect(task?.report).toBeUndefined()
  })

  it('accepts well-formed orchestration fields (string evidence coerced to array)', () => {
    const task = normalizeTask({
      ...LEGACY_TASKS[0],
      category: 'research',
      captainSessionId: 'session-cap',
      dispatchRound: 2,
      needsFinalReview: true,
      lastNudgeAt: 123,
      report: { text: 'done', at: 456, evidence: 'out.txt' },
    })
    expect(task?.category).toBe('research')
    expect(task?.captainSessionId).toBe('session-cap')
    expect(task?.dispatchRound).toBe(2)
    expect(task?.needsFinalReview).toBe(true)
    expect(task?.lastNudgeAt).toBe(123)
    expect(task?.report).toEqual({ text: 'done', at: 456, evidence: ['out.txt'] })
  })

  it('returns null for non-object rows', () => {
    expect(normalizeTask(null)).toBeNull()
    expect(normalizeTask('x')).toBeNull()
    expect(normalizeTask([])).toBeNull()
  })
})

describe('TaskStore migration round-trip', () => {
  it('loads legacy tasks.json, mutates, and persists legacy keys + new defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-test-'))
    try {
      const file = join(dir, 'tasks.json')
      await writeFile(file, JSON.stringify(LEGACY_TASKS, null, 2), 'utf8')
      const store = new TaskStore(dir)

      const loaded = await store.load()
      expect(loaded).toHaveLength(2)
      expect(loaded[0]?.dispatchRound).toBe(0)
      expect(loaded[0]?.needsFinalReview).toBe(false)

      await store.mutate((tasks) => {
        const first = tasks.find((task) => task.id === LEGACY_TASKS[0]?.id)
        if (first) {
          first.category = 'research'
          first.captainSessionId = 'session-cap'
          first.dispatchRound += 1
          first.status = 'in-progress'
        }
      })

      // 从磁盘读回：旧字段不丢，新字段已写
      const raw = JSON.parse(await readFile(file, 'utf8')) as Array<Record<string, unknown>>
      expect(raw).toHaveLength(2)
      expect(raw[1]?.['title']).toBe('ce shi biao ti ying') // 第二条旧记录原样
      expect(raw[1]?.['dispatchRound']).toBe(0)
      expect(raw[0]?.['directory']).toBe('/home/sx/projects/MyAI')
      expect(raw[0]?.['category']).toBe('research')
      expect(raw[0]?.['captainSessionId']).toBe('session-cap')
      expect(raw[0]?.['dispatchRound']).toBe(1)
      expect(raw[0]?.['status']).toBe('in-progress')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
