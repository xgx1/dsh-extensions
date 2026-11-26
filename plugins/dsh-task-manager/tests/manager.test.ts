/**
 * a5 — 项目管理器写卡片、用户答卡片：问题落卡、答复回投、状态回摆。
 * 只测服务层（route 是十行转发，host 面没有身份语义）。
 */
import { describe, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskManager } from '../src/orchestrator.ts'
import { CaptainStore, ConsoleStore, SettingsStore, TaskStore } from '../src/stores.ts'
import { FakeAgent, FakeAgents, FakeSubagents } from './fakes.ts'
import type { TaskRecord } from '../src/records.ts'

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
      // 会话坐在它自己的任务工作区里（cwd 必须等于工作区 path 才挂得进去）
      expect(created[0]?.cwd).toMatch(/-abcdef12$/)
      // 执行会话要能收尾回报，所以默认挂 task-exec 预设（内含 dsh-task-manager/tools）。
      expect(created[0]?.agentPreset).toBe('task-exec')
      const task = (await service.list()).find((item) => item.id === 'abcdef123456')
      expect(task?.worktreeBranch).toBe('task/abcdef12')
      expect(task?.directory).toBe(`${repo}-abcdef12`)
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(`${repo}-abcdef12`, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

describe('执行落点：worktree 复用 / 情形模型（2026-11-22）', () => {
  const gitSync = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  const initRepo = async (): Promise<string> => {
    const repo = await mkdtemp(join(tmpdir(), 'task-manager-reuse-'))
    gitSync(repo, ['init', '-q'])
    await writeFile(join(repo, 'f.txt'), 'base\n')
    gitSync(repo, ['add', '.'])
    gitSync(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
    return repo
  }
  const execRig = async (dir: string, options?: { settings?: SettingsStore }) => {
    const store = new TaskStore(dir)
    const created: Array<{ cwd?: string; agentPreset?: string }> = []
    const selected: Array<{ sessionId: string; provider: string; model: string }> = []
    const service = createTaskManager({
      store,
      captains: new CaptainStore(dir),
      consoleStore: new ConsoleStore(dir),
      settings: options?.settings,
      resolveRuntime: () => ({
        subagents: new FakeSubagents(),
        agents: new FakeAgents(),
        sessionController: {
          create: async (request) => {
            created.push(request)
            return { sessionId: `session-exec-${created.length}` }
          },
          resolveAgent: async () => ({ agent: { followup: () => undefined } }),
          selectModel: async (request) => { selected.push(request) },
        },
      }),
      now: () => 2_000,
    })
    return { store, service, created, selected }
  }
  const seed = async (store: TaskStore, id: string, repo: string, overrides?: Partial<TaskRecord>): Promise<void> => {
    await store.mutate((tasks) => {
      tasks.push({
        id, title: `task ${id}`, content: '内容', status: 'not-started', runMode: 'cwd',
        directory: repo, project: repo, dispatchRound: 0, needsFinalReview: false,
        createdAt: 1, updatedAt: 1, ...overrides,
      })
    })
  }

  it('新任务复用已完成任务的干净 worktree，从项目 HEAD 切新分支', async () => {
    const repo = await initRepo()
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-reuse-state-'))
    try {
      const { store, service, created } = await execRig(dir)
      await seed(store, 'aaaaaaaa1111', repo)
      await service.startExecution('aaaaaaaa1111')
      await service.setStatus('aaaaaaaa1111', 'done')
      await seed(store, 'bbbbbbbb2222', repo)
      await service.startExecution('bbbbbbbb2222')
      expect(created[1]?.cwd).toBe(`${repo}-aaaaaaaa`)
      const taskB = (await service.list()).find((item) => item.id === 'bbbbbbbb2222')
      expect(taskB?.worktreeBranch).toBe('task/bbbbbbbb')
      expect(gitSync(`${repo}-aaaaaaaa`, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('task/bbbbbbbb')
      expect(gitSync(`${repo}-aaaaaaaa`, ['rev-parse', 'HEAD']).trim()).toBe(gitSync(repo, ['rev-parse', 'HEAD']).trim())
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(`${repo}-aaaaaaaa`, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('脏树的完成 worktree 不复用，另建新目录', async () => {
    const repo = await initRepo()
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-dirty-state-'))
    try {
      const { store, service, created } = await execRig(dir)
      await seed(store, 'aaaaaaaa1111', repo)
      await service.startExecution('aaaaaaaa1111')
      await service.setStatus('aaaaaaaa1111', 'done')
      await writeFile(join(`${repo}-aaaaaaaa`, 'f.txt'), 'dirty\n')
      await seed(store, 'cccccccc3333', repo)
      await service.startExecution('cccccccc3333')
      expect(created[1]?.cwd).toBe(`${repo}-cccccccc`)
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(`${repo}-aaaaaaaa`, { recursive: true, force: true })
      await rm(`${repo}-cccccccc`, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('existing-worktree 卡直接在自己的 worktree 里执行，不再套一层', async () => {
    const repo = await initRepo()
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-existing-state-'))
    try {
      gitSync(repo, ['worktree', 'add', `${repo}-wt`, '-b', 'feature/x'])
      const { store, service, created } = await execRig(dir)
      await seed(store, 'dddddddd4444', repo, { runMode: 'existing-worktree', directory: `${repo}-wt`, worktreeBranch: 'feature/x' })
      await service.startExecution('dddddddd4444')
      expect(created[0]?.cwd).toBe(`${repo}-wt`)
      const task = (await service.list()).find((item) => item.id === 'dddddddd4444')
      expect(task?.worktreeBranch).toBe('feature/x')
      expect(task?.directory).toBe(`${repo}-wt`)
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(`${repo}-wt`, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('情形模型：白名单内的路由覆盖执行会话模型', async () => {
    const repo = await initRepo()
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-model-state-'))
    try {
      const settings = new SettingsStore(dir)
      const { store, service, selected } = await execRig(dir, { settings })
      await service.saveSettings({ allowedModels: ['prov/model-x'], situationModels: { complex: 'prov/model-x' } })
      await seed(store, 'eeeeeeee5555', repo, { situation: 'complex' })
      await service.startExecution('eeeeeeee5555')
      expect(selected[0]).toEqual({ sessionId: 'session-exec-1', provider: 'prov', model: 'model-x' })
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(`${repo}-eeeeeeee`, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('情形模型不在白名单：不覆盖；设置保存规范化并落盘', async () => {
    const repo = await initRepo()
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-settings-state-'))
    try {
      const settings = new SettingsStore(dir)
      const { store, service, selected } = await execRig(dir, { settings })
      const saved = await service.saveSettings({
        allowedModels: ['prov/a', 'bad route', 'prov/a', '/x'],
        situationModels: { complex: 'prov/a', simple: 'prov/not-allowed' },
      })
      expect(saved.allowedModels).toEqual(['prov/a'])
      expect(saved.situationModels).toEqual({ complex: 'prov/a' })
      expect(await service.getSettings()).toEqual(saved)
      await seed(store, 'ffffffff6666', repo, { situation: 'simple' })
      await service.startExecution('ffffffff6666')
      expect(selected).toEqual([])
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(`${repo}-ffffffff`, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

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
describe('execution session continuity', () => {
  it('resumes the recorded execution session instead of starting a new one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-resume-'))
    try {
      const store = new TaskStore(dir)
      const created: Array<{ sessionId?: string; agentPreset?: string }> = []
      const agents = new FakeAgents()
      const session = agents.add('session-old')
      const service = createTaskManager({
        store,
        captains: new CaptainStore(dir),
        consoleStore: new ConsoleStore(dir),
        resolveRuntime: () => ({
          subagents: new FakeSubagents(),
          agents,
          sessionController: {
            create: async (request) => {
              created.push(request)
              return { sessionId: 'session-new' }
            },
            resolveAgent: async () => ({ agent: session }),
          },
        }),
        now: () => 2_000,
      })
      await store.mutate((tasks) => {
        tasks.push({
          id: 'resume01',
          title: '续跑示例',
          content: '接着上次的活干',
          status: 'problem',
          runMode: 'cwd',
          directory: '/tmp',
          project: '/tmp',
          captainSessionId: 'session-old',
          dispatchRound: 1,
          needsFinalReview: false,
          createdAt: 1,
          updatedAt: 1,
        })
      })
      const result = await service.startExecution('resume01')
      expect(result.sessionId).toBe('session-old')
      expect(created).toHaveLength(0)
      expect(session.lastFollowupText()).toContain('接着上次的活干')
      const task = (await service.list()).find((item) => item.id === 'resume01')
      expect(task?.status).toBe('in-progress')
      expect(task?.captainSessionId).toBe('session-old')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('starts a fresh session only when the recorded one cannot be resumed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-manager-resume-gone-'))
    try {
      const store = new TaskStore(dir)
      const created: Array<{ sessionId?: string; agentPreset?: string }> = []
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
              return { sessionId: 'session-fresh' }
            },
            // 记着的会话恢复不了；新建出来的会话要能收简报。
            resolveAgent: async (sessionId: string) =>
              sessionId === 'session-fresh'
                ? { agent: { followup: () => undefined } }
                : { error: new Error('session was archived') },
          },
        }),
        now: () => 2_000,
      })
      await store.mutate((tasks) => {
        tasks.push({
          id: 'resume02',
          title: '会话没了',
          content: '重新开工',
          status: 'problem',
          runMode: 'cwd',
          directory: '/tmp',
          project: '/tmp',
          captainSessionId: 'session-gone',
          dispatchRound: 1,
          needsFinalReview: false,
          createdAt: 1,
          updatedAt: 1,
        })
      })
      const result = await service.startExecution('resume02')
      expect(created).toHaveLength(1)
      expect(result.sessionId).toBe('session-fresh')
      const task = (await service.list()).find((item) => item.id === 'resume02')
      expect(task?.captainSessionId).toBe('session-fresh')
      expect(task?.conversations?.map((item) => item.id)).toContain('session-fresh')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('resumes the recorded session right after a restart instead of waiting out the idle window', async () => {
    const home = await mkdtemp(join(tmpdir(), 'task-manager-restart-'))
    try {
      // 会话日志目录刚写过（< 10 分钟），但宿主重启后会话对象不在内存。
      await mkdir(join(home, 'sessions', 'bucket', 'session-old'), { recursive: true })
      const store = new TaskStore(join(home, 'task-manager'))
      const resumed = new FakeAgent()
      const created: unknown[] = []
      let resolves = 0
      const service = createTaskManager({
        store,
        captains: new CaptainStore(join(home, 'task-manager')),
        consoleStore: new ConsoleStore(join(home, 'task-manager')),
        resolveRuntime: () => ({
          subagents: new FakeSubagents(),
          agents: new FakeAgents(),
          sessionController: {
            create: async (request) => {
              created.push(request)
              return { sessionId: 'session-new' }
            },
            resolveAgent: async () => {
              resolves += 1
              return { agent: resumed }
            },
          },
        }),
      })
      await store.mutate((tasks) => {
        tasks.push({
          id: 'restart1',
          title: '重启后续跑',
          content: '继续把场景搭完',
          status: 'in-progress',
          runMode: 'cwd',
          directory: '/tmp',
          project: '/tmp',
          captainSessionId: 'session-old',
          dispatchRound: 1,
          needsFinalReview: false,
          createdAt: 1,
          updatedAt: 1,
        })
      })
      const summary = await service.reconcile()
      expect(summary.retried).toBe(1)
      expect(summary.left).toBe(0)
      expect(created).toHaveLength(0)
      expect(resolves).toBe(1)
      expect(resumed.lastFollowupText()).toContain('继续把场景搭完')
      const task = (await service.list()).find((item) => item.id === 'restart1')
      expect(task?.status).toBe('in-progress')
      expect(task?.captainSessionId).toBe('session-old')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 30_000)
})
