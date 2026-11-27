/**
 * a3/a4 — taskManager service behavior.
 *
 * a3: assign creates a captain session for a new category (startContinuable
 * with persona=章程+简报, toolFilter=deny management tools, parent=manager) and
 * reuses the same sessionId for the existing category (dispatchRound+1).
 * a4: report from a non-captain sessionId is explicitly rejected.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Status, OrchestratorError } from '../src/records.ts'
import { CAPTAIN_TOOL_FILTER, MANAGEMENT_TOOL_NAMES, createTaskManager } from '../src/orchestrator.ts'
import { CaptainStore, TaskStore } from '../src/stores.ts'
import { FakeAgents, FakeSubagents } from './fakes.ts'
import type { TaskManagerDeps } from '../src/orchestrator.ts'

/** Spin up a service against a temp stateDir with fake runtime services. */
async function makeService(options?: { failCreation?: Error }) {
  const dir = await mkdtemp(join(tmpdir(), 'task-manager-orch-'))
  const store = new TaskStore(dir)
  const captains = new CaptainStore(dir)
  const subagents = new FakeSubagents()
  if (options?.failCreation !== undefined) subagents.failNext = options.failCreation
  const agents = new FakeAgents()
  const managerAgent = agents.add('session-manager')
  const deps: TaskManagerDeps = {
    store,
    captains,
    resolveRuntime: () => ({ subagents, agents }),
    now: () => 1_000,
  }
  const service = createTaskManager(deps)
  const seedTask = async (id: string): Promise<void> => {
    await store.mutate((tasks) => {
      tasks.push({
        id,
        title: `task ${id}`,
        content: `content of ${id}`,
        status: 'not-started',
        runMode: 'cwd',
        directory: '/home/sx/projects/MyAI/demo',
        dispatchRound: 0,
        needsFinalReview: false,
        createdAt: 1,
        updatedAt: 1,
      })
    })
  }
  return { dir, store, captains, subagents, agents, managerAgent, service, seedTask }
}

describe('assign — create branch (a3 前半)', () => {
  it('creates a captain session via startContinuable with persona + toolFilter + parent', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      const result = await t.service.assign('task-a', 'research', {
        charter: '研究类章程：只做调研，不改代码。',
        managerSessionId: 'session-manager',
      })

      expect(result.created).toBe(true)
      expect(result.dispatchRound).toBe(1)
      expect(t.subagents.continuableCalls).toHaveLength(1)
      const spec = t.subagents.continuableCalls[0]?.spec
      expect(spec?.provider).toBe('spawn')
      expect(spec?.label).toBe('队长·research')
      expect(spec?.request.parent).toBe(t.managerAgent)
      // persona = 类别章程 + 任务简报（含任务目录）
      const persona = spec?.request.persona ?? ''
      expect(persona).toContain('研究类章程：只做调研，不改代码。')
      expect(persona).toContain('task-a')
      expect(persona).toContain('/home/sx/projects/MyAI/demo')
      expect(spec?.request.prompt).toEqual([{ type: 'text', text: persona }])
      // toolFilter = 排除全部管理工具（deny-list，定案补记配置面）
      expect(spec?.request.toolFilter).toEqual(CAPTAIN_TOOL_FILTER)
      expect(CAPTAIN_TOOL_FILTER.deny).toEqual([...MANAGEMENT_TOOL_NAMES])
      // 首条消息（prompt）与 persona 同文
      expect(spec?.request.prompt[0]?.text).toContain('队长·research')

      // 注册表落盘 sessionId；任务字段落盘
      const registry = await t.captains.load()
      expect(registry['research']?.sessionId).toBe(result.captainSessionId)
      expect(registry['research']?.charter).toBe('研究类章程：只做调研，不改代码。')
      expect(registry['research']?.lastDispatchAt).toBe(1_000)
      const tasks = await t.store.load()
      expect(tasks[0]?.category).toBe('research')
      expect(tasks[0]?.captainSessionId).toBe(result.captainSessionId)
      expect(tasks[0]?.dispatchRound).toBe(1)
      expect(tasks[0]?.status).toBe('in-progress')
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('requires a live manager session for creation', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      await expect(t.service.assign('task-a', 'research')).rejects.toMatchObject({ code: 'MANAGER_AGENT_REQUIRED' })
      expect(t.subagents.continuableCalls).toHaveLength(0)
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('rolls back the reserved sessionId when creation fails', async () => {
    const t = await makeService({ failCreation: new Error('boom') })
    try {
      await t.seedTask('task-a')
      await expect(
        t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' }),
      ).rejects.toMatchObject({ code: 'CREATION_FAILED' })
      const registry = await t.captains.load()
      expect(registry['research']?.sessionId).toBeUndefined()
      expect(registry['research']?.charter).toBe('') // charter 与 createdAt 保留
      const tasks = await t.store.load()
      expect(tasks[0]?.captainSessionId).toBeUndefined()
      expect(tasks[0]?.status).toBe('not-started')
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
})

describe('assign — reuse branch (a3 后半)', () => {
  it('reuses the same sessionId for an existing category and delivers the brief', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      await t.seedTask('task-b')
      const first = await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      const captain = t.agents.add(first.captainSessionId) // 会话 live

      const second = await t.service.assign('task-b', 'research', { managerSessionId: 'session-manager' })
      expect(second.created).toBe(false)
      expect(second.captainSessionId).toBe(first.captainSessionId) // 同一队长复用
      expect(second.dispatchRound).toBe(1)
      expect(t.subagents.continuableCalls).toHaveLength(1) // 没有第二次建会话
      expect(t.subagents.coldFollowups).toHaveLength(0) // 走热路径
      const brief = captain.lastFollowupText()
      expect(brief).toContain('task-b')
      expect(brief).toContain('/home/sx/projects/MyAI/demo')
      expect(brief).not.toContain('研究类章程') // 章程只在创建期 persona 注入

      const tasks = await t.store.load()
      const taskB = tasks.find((task) => task.id === 'task-b')
      expect(taskB?.captainSessionId).toBe(first.captainSessionId)
      expect(taskB?.dispatchRound).toBe(1)
      expect(taskB?.status).toBe('in-progress')
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('re-assigns the same task with dispatchRound+1 (重派)', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      const first = await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      const again = await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      expect(again.captainSessionId).toBe(first.captainSessionId)
      expect(again.dispatchRound).toBe(2)
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('cold-resumes an absent captain through subagents.followup with the manager parent', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      const first = await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      t.agents.map.delete(first.captainSessionId) // 会话不 live
      await t.seedTask('task-b')
      await t.service.assign('task-b', 'research', { managerSessionId: 'session-manager' })
      expect(t.subagents.coldFollowups).toHaveLength(1)
      expect(t.subagents.coldFollowups[0]?.childId).toBe(first.captainSessionId)
      expect(t.subagents.coldFollowups[0]?.text).toContain('task-b')
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('serializes concurrent assigns to one new category into a single session', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      await t.seedTask('task-b')
      const [r1, r2] = await Promise.all([
        t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' }),
        t.service.assign('task-b', 'research', { managerSessionId: 'session-manager' }),
      ])
      expect(t.subagents.continuableCalls).toHaveLength(1)
      expect(r1.captainSessionId).toBe(r2.captainSessionId)
      const registry = await t.captains.load()
      expect(registry['research']?.sessionId).toBe(r1.captainSessionId)
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
})

describe('report — identity enforcement (a4)', () => {
  it('rejects a sessionId that is not the dispatched captain', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      const assigned = await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      await expect(
        t.service.report('session-imposter', 'task-a', 'done', '假装完成'),
      ).rejects.toSatisfy((error: unknown) => error instanceof OrchestratorError && error.code === 'NOT_CAPTAIN')
      // 未派发任务同样拒绝任意身份
      await expect(
        t.service.report(assigned.captainSessionId, 'task-nope', 'done', 'x'),
      ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' })
      const tasks = await t.store.load()
      expect(tasks[0]?.report).toBeUndefined()
      expect(tasks[0]?.status).toBe('in-progress') // 回报被拒，状态未被污染
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('accepts the captain sessionId and writes status + report + evidence', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      const assigned = await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      const reported = await t.service.report(
        assigned.captainSessionId,
        'task-a',
        'waiting-check',
        '调研完成，结论见报告',
        ['/home/sx/projects/MyAI/demo/out.md', 'cmd output #1'],
      )
      expect(reported.status).toBe('waiting-check')
      expect(reported.report).toEqual({
        text: '调研完成，结论见报告',
        at: 1_000,
        evidence: ['/home/sx/projects/MyAI/demo/out.md', 'cmd output #1'],
      })
      expect(reported.updatedAt).toBe(1_000)
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('clamps a done report on a needsFinalReview task to waiting-check (终审线)', async () => {
    const t = await makeService()
    try {
      await t.store.mutate((tasks) => {
        tasks.push({
          id: 'task-final',
          title: '需终审',
          content: 'x',
          status: 'not-started',
          runMode: 'cwd',
          directory: '/tmp',
          dispatchRound: 0,
          needsFinalReview: true,
          createdAt: 1,
          updatedAt: 1,
        })
      })
      const assigned = await t.service.assign('task-final', 'review', { managerSessionId: 'session-manager' })
      const reported = await t.service.report(assigned.captainSessionId, 'task-final', 'done', '完成')
      expect(reported.status).toBe('waiting-check') // 钳制，不关单
      expect(reported.needsFinalReview).toBe(true)
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('validates status vocabulary and human supplement has no identity gate', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      // 运行时词表校验：类型系统拦不住的脏输入要被服务端拒绝
      await expect(
        t.service.report('any', 'task-a', 'done-please' as unknown as Status, 'x'),
      ).rejects.toMatchObject({ code: 'INVALID_STATUS' })
      // 人类手动补录：无身份语义（ADR-0001），但终审钳制不变
      const human = await t.service.applyReportHuman('task-a', {
        status: 'done',
        text: 'GUI 手动补录',
        evidence: ['a.txt'],
      })
      expect(human.report?.text).toBe('GUI 手动补录')
      await t.store.mutate((tasks) => {
        const task = tasks.find((item) => item.id === 'task-a')
        if (task !== undefined) task.needsFinalReview = true
      })
      const clamped = await t.service.applyReportHuman('task-a', { status: 'done', text: '补录' })
      expect(clamped.status).toBe('waiting-check')
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
})

describe('listMine / nudge / captains / setCharter', () => {
  it('listMine returns only tasks dispatched to that captain', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      await t.seedTask('task-b')
      const assigned = await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      await t.service.assign('task-b', 'writing', { managerSessionId: 'session-manager' })
      const mine = await t.service.listMine(assigned.captainSessionId)
      expect(mine).toHaveLength(1)
      expect(mine[0]?.id).toBe('task-a')
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('nudge stamps lastNudgeAt and refuses undispatched tasks', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      await expect(t.service.nudge('task-a')).rejects.toMatchObject({ code: 'NOT_DISPATCHED' })
      const assigned = await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      const captain = t.agents.add(assigned.captainSessionId) // 会话 live
      const nudge = await t.service.nudge('task-a')
      expect(nudge.lastNudgeAt).toBe(1_000)
      expect(captain?.lastFollowupText()).toContain('task-a')
      const tasks = await t.store.load()
      expect(tasks[0]?.lastNudgeAt).toBe(1_000)
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('setCharter upserts (含预写章程) and captains() reports task counts', async () => {
    const t = await makeService()
    try {
      const prewritten = await t.service.setCharter('writing', '写作类章程')
      expect(prewritten.charter).toBe('写作类章程')
      expect(prewritten.sessionId).toBeUndefined()
      await t.seedTask('task-a')
      await t.service.assign('task-a', 'writing', { managerSessionId: 'session-manager' })
      const captains = await t.service.captains()
      expect(captains).toHaveLength(1)
      expect(captains[0]?.category).toBe('writing')
      expect(captains[0]?.taskCount).toBe(1)
      expect(captains[0]?.sessionId).toBeDefined()
      // 章程编辑覆盖既有条目，sessionId 保留
      await t.service.setCharter('writing', '修订后的章程')
      const after = await t.service.captains()
      expect(after[0]?.charter).toBe('修订后的章程')
      expect(after[0]?.sessionId).toBe(captains[0]?.sessionId)
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
})

describe('reply — 回复框的答投递给队长会话', () => {
  it('delivers a live captain the user reply and stamps lastReply', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      const assigned = await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      const captain = t.agents.add(assigned.captainSessionId)
      const result = await t.service.reply('task-a', '  用方案 B  ')

      expect(result.delivery).toBe('live')
      expect(result.at).toBe(1_000)
      const delivered = captain?.lastFollowupText() ?? ''
      expect(delivered).toContain('【用户回复】')
      expect(delivered).toContain('task-a')
      expect(delivered).toContain('用方案 B')

      const tasks = await t.store.load()
      expect(tasks[0]?.lastReply).toEqual({ text: '用方案 B', at: 1_000 })
      expect(tasks[0]?.updatedAt).toBe(1_000)
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('refuses undispatched tasks and empty text', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      await expect(t.service.reply('task-a', '答案')).rejects.toMatchObject({ code: 'NOT_DISPATCHED' })
      await expect(t.service.reply('nope', '答案')).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' })
      const assigned = await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      t.agents.add(assigned.captainSessionId)
      await expect(t.service.reply('task-a', '   ')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
})

describe('setStatus — 关门即落地', () => {
  it('把任务分支合回项目分支，并把合并提交写进卡片', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'task-manager-merge-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
    await writeFile(join(repo, 'base.txt'), 'base\n')
    git('init', '-q', '-b', 'main')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
    // 任务分支上放一个文件，模拟执行会话的产出
    git('checkout', '-q', '-b', 'task/abc12345')
    await writeFile(join(repo, 'done.txt'), 'work\n')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work')
    git('checkout', '-q', 'main')

    const t = await makeService()
    try {
      await t.store.mutate((tasks) => {
        tasks.push({
          id: 'task-merge', title: 'x', content: 'y', status: 'waiting-check', runMode: 'cwd',
          directory: repo, project: repo, worktreeBranch: 'task/abc12345',
          dispatchRound: 0, needsFinalReview: false, createdAt: 1, updatedAt: 1,
        })
      })
      const done = await t.service.setStatus('task-merge', 'done' as Status)
      expect(done.status).toBe('done')
      expect(done.mergeCommit).toMatch(/^[0-9a-f]{7,}$/)
      expect(existsSync(join(repo, 'done.txt'))).toBe(true)
      // 再点一次 done 不应重复合并（幂等）
      const again = await t.service.setStatus('task-merge', 'done' as Status)
      expect(again.mergeCommit).toBe(done.mergeCommit)
    } finally {
      await rm(t.dir, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('合并冲突时把原因写进卡片，并且不把项目工作区留在冲突状态', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'task-manager-conflict-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
    const commit = (...notes: string[]) =>
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.')
    // 同一个文件两侧都改，模拟两张卡先后合并到同一个基线
    await writeFile(join(repo, 'calc.py'), 'def add(a, b):\n    return a + b\n')
    git('init', '-q', '-b', 'main')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
    git('checkout', '-q', '-b', 'task/conflict')
    await writeFile(join(repo, 'calc.py'), 'def add(a, b):\n    return a + b\n\n\ndef other(c):\n    return c\n')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'branch work')
    git('checkout', '-q', 'main')
    await writeFile(join(repo, 'calc.py'), 'def add(a, b):\n    return a + b\n\n\ndef main_side(d):\n    return d\n')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'main work')

    const t = await makeService()
    try {
      await t.store.mutate((tasks) => {
        tasks.push({
          id: 'task-conflict', title: 'x', content: 'y', status: 'waiting-check', runMode: 'cwd',
          directory: repo, project: repo, worktreeBranch: 'task/conflict',
          dispatchRound: 0, needsFinalReview: false, createdAt: 1, updatedAt: 1,
        })
      })
      const closed = await t.service.setStatus('task-conflict', 'done' as Status)
      expect(closed.status).toBe('done')
      expect(closed.mergeError).toBeTruthy()
      expect(closed.mergeCommit).toBeUndefined()
      // 卡片上留得住原因（面板刷新后还能看到），而且工作区没停在 UU/AA。
      const stored = (await t.store.load()).find((item) => item.id === 'task-conflict')
      expect(stored?.mergeError).toBeTruthy()
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, stdio: 'pipe' }).toString().trim()).toBe('')
    } finally {
      await rm(t.dir, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('待测试环节（测试文档 + 测试简报）', () => {
  it('报 waiting-check 时生成测试文档，并把测试简报投给执行会话一次', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      const assigned = await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      const captain = t.agents.add(assigned.captainSessionId) // 执行会话 live
      const reported = await t.service.report(
        assigned.captainSessionId,
        'task-a',
        'waiting-check',
        '做完了',
        ['/repo/out.md'],
      )
      expect(reported.status).toBe('waiting-check')
      // report() 返回的是回报那一刻的快照：测试文档与发起的时刻落在落盘状态上。
      const stored = (await t.store.load()).find((item) => item.id === 'task-a')
      expect(stored?.testDoc?.origin).toBe('generated')
      expect(stored?.testDoc?.text).toContain('write-manual-test-doc')
      expect(stored?.testDoc?.text).toContain('content of task-a')
      expect(stored?.testStartedAt).toBe(1_000)
      expect(captain.followups).toHaveLength(1)
      expect(captain.lastFollowupText()).toContain('write-manual-test-doc')
      // 停在待测试的会话又报一次 waiting-check：不是新一轮测试，不再投简报。
      await t.service.report(assigned.captainSessionId, 'task-a', 'waiting-check', '测完补一句')
      expect(captain.followups).toHaveLength(1)
      // 再次显式转待测试同样不重复投。
      await t.service.setStatus('task-a', 'waiting-check')
      expect(captain.followups).toHaveLength(1)
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('setTestDoc 只认该任务的队长，并把文档换成正式版', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      const assigned = await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      await expect(
        t.service.setTestDoc('session-imposter', 'task-a', '## 假文档'),
      ).rejects.toBeInstanceOf(OrchestratorError)
      const task = await t.service.setTestDoc(assigned.captainSessionId, 'task-a', '## 正式测试文档\n用例：…')
      expect(task.testDoc).toEqual({ text: '## 正式测试文档\n用例：…', at: 1_000, origin: 'session' })
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
})

describe('answerQuestion — 答复确定性重新派发', () => {
  const seedDispatched = async (t: Awaited<ReturnType<typeof makeService>>, recommendation?: string): Promise<void> => {
    await t.seedTask('task-a')
    await t.store.mutate((tasks) => {
      const task = tasks.find((item) => item.id === 'task-a')
      if (task === undefined) throw new Error('missing task')
      task.captainSessionId = 'session-captain'
      task.consoleSessionId = 'session-manager'
      task.questions = [{ id: 'q1', text: '选哪个？', at: 1, ...(recommendation === undefined ? {} : { recommendation }) }]
    })
  }

  it('答复直送活着的执行会话，管理器副本注明无需转发，source 署名生产者', async () => {
    const t = await makeService()
    try {
      await seedDispatched(t)
      const captain = t.agents.add('session-captain')
      const out = await t.service.answerQuestion('task-a', 'q1', '选 A')
      expect(out.delivered).toBe('live')
      expect(captain.lastFollowupText()).toContain('选 A')
      expect(t.managerAgent.lastFollowupText()).toContain('无需转发')
      expect((captain.followups[0] as { source: { kind: string } }).source.kind).toBe('task-manager')
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('一键采纳推荐答案时正文注明采纳，执行会话冷恢复走 subagents.followup', async () => {
    const t = await makeService()
    try {
      await seedDispatched(t, '建议用 A')
      const out = await t.service.answerQuestion('task-a', 'q1', '建议用 A')
      expect(out.delivered).toBe('resumed')
      expect(t.subagents.coldFollowups).toHaveLength(1)
      expect(t.subagents.coldFollowups[0]?.text).toContain('采纳了推荐答案')
      expect(t.subagents.coldFollowups[0]?.text).toContain('建议用 A')
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
})

describe('deleteTask — 面板删除', () => {
  it('只删目标卡，其余卡不动', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      await t.seedTask('task-b')
      await expect(t.service.deleteTask('task-a')).resolves.toEqual({ taskId: 'task-a' })
      expect((await t.store.load()).map((task) => task.id)).toEqual(['task-b'])
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('未知 id 报 TASK_NOT_FOUND', async () => {
    const t = await makeService()
    try {
      await expect(t.service.deleteTask('nope')).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' })
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('in-progress 拒绝删除；改状态后可删', async () => {
    const t = await makeService()
    try {
      await t.seedTask('task-a')
      await t.service.setStatus('task-a', 'in-progress')
      await expect(t.service.deleteTask('task-a')).rejects.toMatchObject({ code: 'TASK_IN_PROGRESS' })
      expect(await t.store.load()).toHaveLength(1)
      await t.service.setStatus('task-a', 'problem')
      await expect(t.service.deleteTask('task-a')).resolves.toEqual({ taskId: 'task-a' })
      expect(await t.store.load()).toHaveLength(0)
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
})

