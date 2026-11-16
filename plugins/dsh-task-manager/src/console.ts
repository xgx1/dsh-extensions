/**
 * dsh-task-manager — 任务台的两层管理器（ADR-0014）。
 *
 * - **大管理器**：全局一个会话，只做路由 —— 判断这件事属于哪个项目，把它派给该项目的项目管理器。
 * - **项目管理器**：每个项目（git 仓库根路径为主键）一个会话，拆单、起执行会话、裁决下一步、巡查触发器。
 *
 * 两者都是普通会话，但**没有宿主会话**：经 `sessionController.create` 直接建立，
 * 重启后按 `console.json` 里的 sessionId 冷恢复（`reusable: () => true`）。
 * 投递复用 managed-reply 的人类消息路径，所以管理器收到的是真实用户输入。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { OrchestratorError } from './records.ts'
import { deliverHumanMessage, type ReplyRuntime, type ReplyTarget, type SessionCreateRequest } from './managed-reply.ts'
import type { ConsoleManagerRecord, ConsoleState, ConsoleStore } from './stores.ts'

const run = promisify(execFile)

/** 大管理器会话的预设 id（profile composition 里的 preset 行，config.id = task-console-global）。 */
export const GLOBAL_MANAGER_PRESET = 'task-console-global'

/** 项目管理器会话的预设 id（config.id = task-console-project）。 */
export const PROJECT_MANAGER_PRESET = 'task-console-project'

/** 取一条 Agent 的会话 id：Agent 自带 id，缺省时退到 session.id。 */
export function agentSessionId(agent: ReplyTarget): string | undefined {
  const shaped = agent as unknown as { id?: unknown; session?: { id?: unknown } }
  if (typeof shaped.id === 'string' && shaped.id !== '') return shaped.id
  const nested = shaped.session?.id
  return typeof nested === 'string' && nested !== '' ? nested : undefined
}

/** git 仓库根路径；不是仓库、目录不存在或 git 不可用时返回 undefined。 */
export async function gitRootOf(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 10_000 })
    const root = stdout.trim()
    return root === '' ? undefined : root
  } catch {
    return undefined
  }
}

/** 已注册的管理器记录（不存在时 undefined）。 */
export function registeredManager(state: ConsoleState, project?: string): ConsoleManagerRecord | undefined {
  return project === undefined ? state.global : state.projects?.[project]
}

/** 写回一条管理器记录。 */
async function persistManager(
  store: ConsoleStore,
  project: string | undefined,
  record: ConsoleManagerRecord,
): Promise<void> {
  await store.mutate((state) => {
    if (project === undefined) {
      state.global = record
      return
    }
    state.projects = { ...(state.projects ?? {}), [project]: record }
  })
}

/**
 * 建或唤醒一个管理器会话。
 * @param runtime - 持有 Agent 注册表与会话控制器的运行时。
 * @param store - `console.json` 注册表。
 * @param project - 项目主键（git 根）；大管理器传 undefined。
 * @param request - 会话的 cwd 与预设。
 * @returns 最新的管理器记录。
 */
export async function ensureManagerSession(
  runtime: ReplyRuntime,
  store: ConsoleStore,
  project: string | undefined,
  request: { cwd: string; preset: string },
): Promise<ConsoleManagerRecord> {
  const create = runtime.sessionController?.create
  if (create === undefined) {
    throw new OrchestratorError(
      'DELIVERY_UNAVAILABLE',
      'sessionController.create is unavailable; cannot start a manager conversation',
    )
  }
  const state = await store.load()
  const existing = registeredManager(state, project)
  const sessionId = await createManagerSession(create, existing, request)
  if (sessionId === undefined) {
    throw new OrchestratorError('DELIVERY_UNAVAILABLE', 'the manager conversation was created without a session id')
  }
  const now = Date.now()
  const record: ConsoleManagerRecord = {
    sessionId,
    cwd: existing?.cwd ?? request.cwd,
    preset: request.preset,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await persistManager(store, project, record)
  return record
}

/**
 * 建或唤醒管理器会话：已注册就带着 sessionId 唤醒；该会话不可复用（被归档等）时退回新开一个。
 * @returns 实际生效的会话 id。
 */
async function createManagerSession(
  create: (request: SessionCreateRequest) => Promise<{ sessionId?: string }>,
  existing: ConsoleManagerRecord | undefined,
  request: { cwd: string; preset: string },
): Promise<string | undefined> {
  if (existing !== undefined) {
    try {
      const reused = await create({ sessionId: existing.sessionId, cwd: existing.cwd, agentPreset: request.preset })
      if (reused.sessionId !== undefined) return reused.sessionId
    } catch {
      // 管理器会话可能已被归档/删除：退回新开一个，注册表随后被覆盖。
    }
  }
  const created = await create({ cwd: request.cwd, agentPreset: request.preset })
  return created.sessionId
}

/** 把一条文本投进管理器会话（活着走 followup，睡着走冷恢复）。 */
export async function deliverToManager(
  runtime: ReplyRuntime,
  managerSessionId: string,
  text: string,
): Promise<'live' | 'resumed'> {
  return deliverHumanMessage(runtime, managerSessionId, text)
}
