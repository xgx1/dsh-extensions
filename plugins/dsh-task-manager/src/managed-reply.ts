/**
 * dsh-task-manager — 回复框的投递面（ADR-0011）。
 *
 * 用户的答复以**人类消息**身份进入管理会话：管理端的 pre-step 明确放行
 * `source.kind === 'user'` 的消息，所以这是一条真实输入，不是伪装成用户的插件指令。
 * 管理会话此刻不在线时走 `sessionController.resolveAgent` 冷恢复——与队列投递同一原语。
 */
import { randomUUID } from 'node:crypto'
import { OrchestratorError } from './records.ts'

/** 投递目标的最小形状（Agent 的 followup 就够了）。 */
export interface ReplyTarget {
  followup(message: unknown): void
}

/** 建会话的入参（结构化切片，等于 sessionController.create 的请求）。 */
export interface SessionCreateRequest {
  /** 复用已存在的会话时给它的 id；省略则新开一个。 */
  sessionId?: string
  /** 会话自有的工作目录；与 workspaceId 二选一。 */
  cwd?: string
  /** 会话加入的工作区；与 cwd 二选一。 */
  workspaceId?: string
  /** 会话运行的预设 id。 */
  agentPreset?: string
}

/** 回复投递需要的运行时服务；两者都可能缺席，缺席时明确失败而不是静默丢弃。 */
export interface ReplyRuntime {
  agents?: { get(sessionId: string): ReplyTarget | undefined }
  /** `ctx.workspaceRegistry`：把任务台起的会话放进工作区，而不是「未分组」。 */
  workspaces?: WorkspaceSeatRegistry
  sessionController?: {
    resolveAgent(sessionId: string): Promise<{ agent?: ReplyTarget; error?: unknown }>
    /** 任务台的两层管理器用它在无宿主会话的情况下建 / 唤醒会话（ADR-0014）。 */
    create?(request: SessionCreateRequest): Promise<{ sessionId?: string }>
  }
}

import type { WorkspaceSeatRegistry } from './workspaces.ts'

/** 一条人类消息：与 `createOutboundMessage` 同构，只有 source 不同。 */
function humanMessage(text: string): unknown {
  return Object.freeze({
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user' as const },
  })
}

/**
 * 把一条答复送进管理会话。
 * @param runtime - 持有 Agent 注册表与会话控制器的运行时。
 * @param managerSessionId - 接收答复的管理会话。
 * @param text - 用户在回复框里写的正文。
 * @returns `live` 表示目标本来就活着，`resumed` 表示这次冷恢复把它唤醒。
 */
export async function deliverHumanMessage(
  runtime: ReplyRuntime,
  managerSessionId: string,
  text: string,
): Promise<'live' | 'resumed'> {
  const live = runtime.agents?.get(managerSessionId)
  if (live !== undefined) {
    live.followup(humanMessage(text))
    return 'live'
  }
  if (runtime.sessionController === undefined) {
    throw new OrchestratorError('DELIVERY_UNAVAILABLE', `manager conversation ${managerSessionId} is not live and cannot be resumed`)
  }
  const resolved = await runtime.sessionController.resolveAgent(managerSessionId)
  if (resolved.agent === undefined) {
    throw new OrchestratorError('DELIVERY_UNAVAILABLE', `manager conversation ${managerSessionId} could not be resolved`)
  }
  resolved.agent.followup(humanMessage(text))
  return 'resumed'
}
