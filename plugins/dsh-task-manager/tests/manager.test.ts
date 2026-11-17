/**
 * a5 — 项目管理器写卡片、用户答卡片：问题落卡、答复回投、状态回摆。
 * 只测服务层（route 是十行转发，host 面没有身份语义）。
 */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskManager } from '../src/orchestrator.ts'
import { CaptainStore, ConsoleStore, TaskStore } from '../src/stores.ts'
import { FakeAgents, FakeSubagents } from './fakes.ts'

async function rig() {
  const dir = await mkdtemp(join(tmpdir(), 'task-manager-manager-'))
  const store = new TaskStore(dir)
  const captains = new CaptainStore(dir)
  const consoleStore = new ConsoleStore(dir)
  const subagents = new FakeSubagents()
  const agents = new FakeAgents()
  const service = createTaskManager({
    store,
    captains,
    consoleStore,
    resolveRuntime: () => ({ subagents, agents }),
    now: () => 1_000,
  })
  await store.mutate((tasks) => {
    tasks.push({
      id: 'task-1',
      title: '示例任务',
      content: '内容',
      status: 'not-started',
      runMode: 'cwd',
      directory: '/tmp',
      project: '/tmp',
      consoleSessionId: 'session-project-manager',
      dispatchRound: 0,
      needsFinalReview: false,
      createdAt: 1,
      updatedAt: 1,
    })
  })
  return { dir, service, agents, store }
}

describe('card questions and answers', () => {
  it('stores a question with its recommendation without touching the task status', async () => {
    const { dir, service } = await rig()
    try {
      // ADR-0012: 提问只是待办提示，不是任务状态。
      const task = await service.addQuestion('task-1', '要保留旧入口吗？', '保留')
      expect(task.status).toBe('not-started')
      expect(task.questions?.[0]).toMatchObject({ text: '要保留旧入口吗？', recommendation: '保留' })
      expect(task.questions?.[0]?.answer).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('records the answer and delivers it to the project manager', async () => {
    const { dir, service, agents } = await rig()
    try {
      const asked = await service.addQuestion('task-1', '要保留旧入口吗？', '保留')
      const questionId = asked.questions?.[0]?.id ?? ''
      const live = agents.add('session-project-manager')
      const out = await service.answerQuestion('task-1', questionId, '保留')
      expect(out.delivered).toBe('live')
      expect(out.task.questions?.[0]?.answer?.text).toBe('保留')
      expect(out.task.lastReply?.text).toBe('保留')
      expect(live.lastFollowupText()).toContain('用户答复: 保留')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stores the project trigger subscription on the project manager record', async () => {
    const { dir, service } = await rig()
    try {
      const consoleStore = new ConsoleStore(dir)
      await consoleStore.mutate((state) => {
        state.projects = {
          '/tmp': { sessionId: 'session-project-manager', cwd: '/tmp', preset: 'task-console-project', createdAt: 1, updatedAt: 1 },
        }
      })
      const record = await service.setProjectSources('/tmp', ['inbox', 'ci', 'inbox', ' '])
      expect(record.sources).toEqual(['inbox', 'ci'])
      const state = await service.consoleState()
      expect(state.projects?.['/tmp']?.sources).toEqual(['inbox', 'ci'])
      await expect(service.setProjectSources('/nope', ['inbox'])).rejects.toThrow(/no project manager/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runs the execution session in a task worktree when the project is a git repo', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'task-manager-repo-'))
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-exec-'))
    try {
      await execFile('git', ['init', '-q', repo])
      await execFile('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
      const store = new TaskStore(dir)
      const created: Array<{ cwd?: string; agentPreset?: string }> = []
      const service = createTaskManager({
        store,
        captains: new CaptainStore(dir),
        consoleStore: new ConsoleStore(dir),
        resolveRuntime: () => ({
          subagents: new FakeSubagents(),
          agents: new FakeAgents(),
          sessionController: {
            create: async (request) => {
              created.push(request)
              return { sessionId: 'session-exec-1' }
            },
            resolveAgent: async () => ({ agent: { followup: () => undefined } }),
          },
        }),
        now: () => 2_000,
      })
      await store.mutate((tasks) => {
        tasks.push({
          id: 'abcdef123456',
          title: '示例',
          content: '内容',
          status: 'not-started',
          runMode: 'cwd',
          directory: repo,
          project: repo,
          dispatchRound: 0,
          needsFinalReview: false,
          createdAt: 1,
          updatedAt: 1,
        })
      })
      const result = await service.startExecution('abcdef123456')
      expect(result.status).toBe('in-progress')
      // 会话坐在执行位（白名单内），项目路径靠简报给出
      expect(created[0]?.cwd).toBe(`${dir}/exec`)
      expect(created[0]?.agentPreset).toBe('all')
      const task = (await service.list()).find((item) => item.id === 'abcdef123456')
      expect(task?.worktreeBranch).toBe('task/abcdef12')
      expect(task?.directory).toBe(`${repo}-abcdef12`)
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(`${repo}-abcdef12`, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects an empty answer and an already answered question', async () => {
    const { dir, service } = await rig()
    try {
      const asked = await service.addQuestion('task-1', '要保留旧入口吗？')
      const questionId = asked.questions?.[0]?.id ?? ''
      await expect(service.answerQuestion('task-1', questionId, '   ')).rejects.toThrow(/answer is required/)
      await service.answerQuestion('task-1', questionId, '保留')
      await expect(service.answerQuestion('task-1', questionId, '再来一次')).rejects.toThrow(/already answered/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
