/**
 * 工作区席位（2026-11-17 用户要求）：任务台自己起的会话必须落在真正的工作区里，
 * 而不是 GUI 侧栏的「未分组」。管理器会话进「任务台·管理器」，执行会话进它自己的
 * 任务工作区（path = worktree，标题 = 项目 · 任务）。
 *
 * 工作区的成员校验要求会话 header 的 cwd 等于工作区 path，所以座位目录就是 cwd ——
 * 调用方必须用同一个 path 建会话，这里只负责 create + attach。
 */

/** The slice of `ctx.workspaceRegistry` this module needs. */
export interface WorkspaceSeatRegistry {
  create(path: string, title?: string): Promise<{
    readonly workspaceId?: string
    readonly sessionIds?: readonly string[]
    attachSession?(sessionId: string): Promise<void>
  }>
}

/**
 * 把会话挂到 path 对应的工作区（不存在就建）。挂不上不影响任务：会话照跑，只是显示在「未分组」。
 * @param registry - `ctx.workspaceRegistry`；宿主没这个服务时静默跳过。
 * @param path - 工作区目录，必须与会话的 cwd 相同。
 * @param title - 新建工作区的标题（已存在时不改标题）。
 * @param sessionIds - 要挂进去的会话 id。
 */
export async function seatSessions(
  registry: WorkspaceSeatRegistry | undefined,
  path: string,
  title: string,
  sessionIds: readonly (string | undefined)[],
): Promise<void> {
  if (registry === undefined) return
  const ids = sessionIds.filter((id): id is string => typeof id === 'string' && id !== '')
  // 没有会话也要建：会话创建时宿主会按 cwd 自动建工作区（标题 = 目录名，带 -<任务id> 后缀），
  // 我们先建才能保住「项目 · 任务」这个标题。
  if (ids.length === 0) {
    try {
      await registry.create(path, title)
    } catch {
      // 建不出来不影响任务：会话照跑。
    }
    return
  }
  try {
    const workspace = await registry.create(path, title)
    for (const sessionId of ids) {
      if (workspace.sessionIds?.includes(sessionId) === true) continue
      await workspace.attachSession?.(sessionId)
    }
  } catch {
    // 席位只是分组的方便：挂不上不能让派单失败。
  }
}
