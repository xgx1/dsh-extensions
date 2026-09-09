/**
 * M2 — the seven task tools: name contract, identity semantics, and
 * service delegation, driven through the real defineTool wrappers.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAPTAIN_TOOL_FILTER, MANAGEMENT_TOOL_NAMES, createTaskManager } from '../src/orchestrator.ts'
import { registerTaskTools } from '../src/tools.ts'
import { CaptainStore, TaskStore } from '../src/stores.ts'
import { FakeAgents, FakeSubagents } from './fakes.ts'

interface RegisteredDefinition {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** Collect registered tool definitions instead of mounting a runtime. */
function collect(): { defs: Map<string, RegisteredDefinition>; registrar: { register: (definition: unknown) => () => void } } {
  const defs = new Map<string, RegisteredDefinition>()
  const registrar = {
    register: (definition: unknown) => {
      const def = definition as RegisteredDefinition
      defs.set(def.name, def)
      return () => undefined
    },
  }
  return { defs, registrar }
}

/** Tool exec with an owning agent session id. */
const execAs = (id: string | undefined) => ({ agent: id === undefined ? undefined : { id } })

async function rig() {
  const dir = await mkdtemp(join(tmpdir(), 'task-manager-tools-'))
  const store = new TaskStore(dir)
  const captains = new CaptainStore(dir)
  const subagents = new FakeSubagents()
  const agents = new FakeAgents()
  agents.add('session-manager')
  const service = createTaskManager({
    store,
    captains,
    resolveRuntime: () => ({ subagents, agents }),
    now: () => 1_000,
  })
  const { defs, registrar } = collect()
  registerTaskTools(registrar, service, (factory) => void factory())
  const seedTask = async (id: string, needsFinalReview = false): Promise<void> => {
    await store.mutate((tasks) => {
      tasks.push({
        id,
        title: `task ${id}`,
        content: `content of ${id}`,
        status: 'not-started',
        runMode: 'cwd',
        directory: '/home/sx/MyAI/demo',
        dispatchRound: 0,
        needsFinalReview,
        createdAt: 1,
        updatedAt: 1,
      })
    })
  }
  return { dir, defs, service, subagents, agents, seedTask }
}

describe('工具名契约（t11 预设与 CAPTAIN_TOOL_FILTER 对齐）', () => {
  it('注册恰好 7 个工具，名字与 MANAGEMENT_TOOL_NAMES + task_claim/task_report 逐字一致', async () => {
    const t = await rig()
    try {
      const names = [...t.defs.keys()].sort()
      expect(names).toEqual([...MANAGEMENT_TOOL_NAMES, 'task_claim', 'task_report'].sort())
      expect(names).toHaveLength(7)
      // 队长面 deny 的 5 个名字都真实存在于注册表（否则 restrict() 会在建会话时报 unknown name）
      for (const denied of CAPTAIN_TOOL_FILTER.deny) {
        expect(t.defs.has(denied)).toBe(true)
      }
      // 队长面保留的两个工具不在 deny 内
      expect(CAPTAIN_TOOL_FILTER.deny).not.toContain('task_claim')
      expect(CAPTAIN_TOOL_FILTER.deny).not.toContain('task_report')
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
})

describe('管理工具（exec.agent.id 作为派发父会话）', () => {
  it('task_assign 用调用者会话身份派发并返回结果', async () => {
    const t = await rig()
    try {
      await t.seedTask('task-a')
      const result = await t.defs.get('task_assign')?.execute(
        { taskId: 'task-a', category: 'research', charter: '章程' },
        execAs('session-manager'),
      ) as { captainSessionId: string; dispatchRound: number; created: boolean }
      expect(result.created).toBe(true)
      expect(result.dispatchRound).toBe(1)
      expect(t.subagents.continuableCalls[0]?.spec.request.parent).toBeDefined()
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('task_create 建单（needsFinalReview + 缺省标题取首行）', async () => {
    const t = await rig()
    try {
      const created = await t.defs.get('task_create')?.execute(
        { content: '第一行标题\n第二行需求', needsFinalReview: true },
        execAs('session-manager'),
      ) as { id: string; title: string; needsFinalReview: boolean; status: string }
      expect(created.title).toBe('第一行标题')
      expect(created.needsFinalReview).toBe(true)
      expect(created.status).toBe('not-started')
      expect(created.id).toBeTruthy()
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('task_set_status 显式关单不受终审钳制（set-status 是用户终审通道）', async () => {
    const t = await rig()
    try {
      await t.seedTask('task-final', true) // needsFinalReview
      const result = await t.defs.get('task_set_status')?.execute(
        { taskId: 'task-final', status: 'done' },
        execAs('session-manager'),
      ) as { status: string }
      expect(result.status).toBe('done') // 不钳制
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('task_list 返回总数+有界列表（含回报摘要）', async () => {
    const t = await rig()
    try {
      await t.seedTask('task-a')
      const assigned = await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      const captain = t.agents.add(assigned.captainSessionId)
      await t.service.report(assigned.captainSessionId, 'task-a', 'waiting-check', '做完了一半', ['a.md'])
      void captain
      const result = await t.defs.get('task_list')?.execute({ category: 'research' }, execAs('session-manager')) as {
        total: number
        tasks: Array<{ id: string; reportText?: string; category?: string }>
      }
      expect(result.total).toBe(1)
      expect(result.tasks[0]?.reportText).toBe('做完了一半')
      expect(result.tasks[0]?.category).toBe('research')
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('task_nudge 催办已派发任务', async () => {
    const t = await rig()
    try {
      await t.seedTask('task-a')
      const assigned = await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      const captain = t.agents.add(assigned.captainSessionId)
      const result = await t.defs.get('task_nudge')?.execute({ taskId: 'task-a' }, execAs('session-manager')) as { lastNudgeAt: number }
      expect(result.lastNudgeAt).toBe(1_000)
      expect(captain.lastFollowupText()).toContain('task-a')
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
})

describe('队长工具（身份线走 exec.agent.id）', () => {
  it('task_claim 只返回派发给本会话的任务', async () => {
    const t = await rig()
    try {
      await t.seedTask('task-a')
      await t.seedTask('task-b')
      await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      await t.service.assign('task-b', 'writing', { managerSessionId: 'session-manager' })
      // research 队长视角
      const researchCap = (await t.service.listMine(
        (await t.service.captains()).find((c) => c.category === 'research')?.sessionId ?? '',
      ))[0]?.captainSessionId ?? ''
      const mine = await t.defs.get('task_claim')?.execute({}, execAs(researchCap)) as { tasks: Array<{ id: string }> }
      expect(mine.tasks).toHaveLength(1)
      expect(mine.tasks[0]?.id).toBe('task-a')
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('task_claim / task_report 拒绝非 agent 调用（无 owning session）', async () => {
    const t = await rig()
    try {
      await expect(t.defs.get('task_claim')?.execute({}, execAs(undefined))).rejects.toThrow(/owning agent session/)
      await expect(t.defs.get('task_report')?.execute(
        { taskId: 'x', status: 'done', text: 'y' },
        execAs(undefined),
      )).rejects.toThrow(/owning agent session/)
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })

  it('task_report 携带调用者身份；冒名者被服务层 NOT_CAPTAIN 拒绝', async () => {
    const t = await rig()
    try {
      await t.seedTask('task-a')
      const assigned = await t.service.assign('task-a', 'research', { managerSessionId: 'session-manager' })
      const result = await t.defs.get('task_report')?.execute(
        { taskId: 'task-a', status: 'waiting-check', text: '完成', evidence: ['out.md'] },
        execAs(assigned.captainSessionId),
      ) as { status: string; evidenceCount: number }
      expect(result.status).toBe('waiting-check')
      expect(result.evidenceCount).toBe(1)
      // 队长报 done 被终审钳制（数据层不变量经工具透传）
      await t.seedTask('task-final', true)
      const finalAssigned = await t.service.assign('task-final', 'research', { managerSessionId: 'session-manager' })
      const clamped = await t.defs.get('task_report')?.execute(
        { taskId: 'task-final', status: 'done', text: '直接关单' },
        execAs(finalAssigned.captainSessionId),
      ) as { status: string }
      expect(clamped.status).toBe('waiting-check')
      // 冒名者
      await expect(t.defs.get('task_report')?.execute(
        { taskId: 'task-a', status: 'done', text: '冒名' },
        execAs('session-imposter'),
      )).rejects.toMatchObject({ code: 'NOT_CAPTAIN' })
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
})
