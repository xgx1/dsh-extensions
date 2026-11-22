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
import {
  type TaskRecord,
  TEST_SKILLS,
  applyTestDocForRound,
  buildConsoleAssignment,
  buildTestDocMarkdown,
  normalizeTask,
} from '../src/records.ts'
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

describe('待测试：测试文档（2026-11-19）', () => {
  const makeTask = (overrides: Record<string, unknown> = {}): TaskRecord => ({
    id: 'task-1',
    title: '把面板做完',
    content: '点一下测试文档要能看到要测什么',
    status: 'waiting-check',
    runMode: 'cwd',
    directory: '/repo',
    dispatchRound: 1,
    needsFinalReview: false,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as TaskRecord)

  it('生成的文档带齐强制技能、这一单要测什么与证据', () => {
    const doc = buildTestDocMarkdown(makeTask({
      report: { text: '改了卡片', at: 5, evidence: ['/repo/out.md'] },
    }))
    for (const skill of TEST_SKILLS) expect(doc).toContain(skill)
    expect(doc).toContain('点一下测试文档要能看到要测什么') // 一、要测什么
    expect(doc).toContain('/repo/out.md')                      // 证据
    expect(doc).toContain('task_test_doc')                     // 交回通道
    expect(doc).toContain('模拟点击桌面窗口')
  })

  it('已有比汇报更新的文档就不覆盖；汇报更新后重新生成', () => {
    const fed = makeTask({
      report: { text: '第一轮', at: 5 },
      testDoc: { text: '## 正式测试文档', at: 9, origin: 'session' },
    })
    applyTestDocForRound(fed, 10)
    expect(fed.testDoc).toEqual({ text: '## 正式测试文档', at: 9, origin: 'session' })

    applyTestDocForRound(fed, 11) // 汇报没变 → 仍保留
    expect(fed.testDoc?.text).toBe('## 正式测试文档')

    fed.report = { text: '第二轮返工', at: 12 } // 重做后再报：旧文档过期
    applyTestDocForRound(fed, 13)
    expect(fed.testDoc?.origin).toBe('generated')
    expect(fed.testDoc?.at).toBe(13)
  })

  it('normalizeTask 保留合法测试文档，丢掉畸形值', () => {
    const kept = normalizeTask({
      id: 'a', title: 't', content: 'c', status: 'waiting-check', runMode: 'cwd', directory: '/x',
      dispatchRound: 0, needsFinalReview: false, createdAt: 1, updatedAt: 1,
      testDoc: { text: '正式版', at: 7, origin: 'session' },
      testStartedAt: 6,
    })
    expect(kept?.testDoc).toEqual({ text: '正式版', at: 7, origin: 'session' })
    expect(kept?.testStartedAt).toBe(6)

    const dropped = normalizeTask({
      id: 'b', title: 't', content: 'c', status: 'waiting-check', runMode: 'cwd', directory: '/x',
      dispatchRound: 0, needsFinalReview: false, createdAt: 1, updatedAt: 1,
      testDoc: { text: '  ', at: 7 },
      testStartedAt: -1 as unknown as number,
    })
    expect(dropped?.testDoc).toBeUndefined()
    expect(dropped?.testStartedAt).toBeUndefined()
  })
})


describe('buildConsoleAssignment — 工作区清单', () => {
  it('有工作区时渲染路径与用途，并指示按用途匹配选 cwd', () => {
    const text = buildConsoleAssignment('做个价格对比', undefined, [], [{ path: '/home/sx/projects/demo', purpose: '演示、demo' }])
    expect(text).toContain('## 可用工作区（路径 — 用途关键词）')
    expect(text).toContain('- /home/sx/projects/demo — 演示、demo')
    expect(text).toContain('按正文与各工作区用途关键词的匹配度选 cwd')
  })
  it('没有工作区时不渲染空清单', () => {
    expect(buildConsoleAssignment('做个对比')).not.toContain('## 可用工作区')
  })
})
