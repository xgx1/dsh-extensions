/**
 * 工作区席位（2026-11-17 用户要求）：任务台自己起的会话必须落在真正的工作区里，
 * 而不是 GUI 侧栏的「未分组」。管理器会话进「任务台·管理器」，执行会话进它自己的
 * 任务工作区（path = worktree，标题 = 项目 · 任务）。
 *
 * 工作区的成员校验要求会话 header 的 cwd 等于工作区 path，所以座位目录就是 cwd ——
 * 调用方必须用同一个 path 建会话，这里只负责 create + attach。
 */

import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** list() 行的结构切片（宿主 WorkspaceRegistry.list()：path/title 可能包在 record 里）。 */
export interface WorkspaceListRow {
  readonly path?: unknown
  readonly title?: unknown
  readonly record?: { readonly path?: unknown; readonly title?: unknown }
}

/** 大控制台简报里的一条工作区：路径 + 用途关键词。 */
export interface WorkspaceBrief {
  readonly path: string
  readonly purpose: string
}

/** The slice of `ctx.workspaceRegistry` this module needs. */
export interface WorkspaceSeatRegistry {
  create(path: string, title?: string): Promise<{
    readonly workspaceId?: string
    readonly sessionIds?: readonly string[]
    attachSession?(sessionId: string): Promise<void>
  }>
  list?(): WorkspaceListRow[]
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

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 用途关键词：.dsh/skills 里前几个 SKILL.md frontmatter 的 description（触发词就在里面）。 */
async function skillKeywords(path: string): Promise<string | undefined> {
  const descriptions: string[] = []
  try {
    const skillsDir = join(path, '.dsh', 'skills')
    for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || descriptions.length >= 3) continue
      const nested = join(skillsDir, entry.name)
      const files = [join(nested, 'SKILL.md')]
      try {
        for (const child of await readdir(nested, { withFileTypes: true })) {
          if (child.isDirectory()) files.push(join(nested, child.name, 'SKILL.md'))
        }
      } catch {
        // 组目录读不了就看下一个。
      }
      for (const file of files) {
        if (descriptions.length >= 3) break
        try {
          const head = (await readFile(file, 'utf8')).slice(0, 2000)
          const match = /^description:\s*(.+)$/m.exec(head)
          if (match?.[1] !== undefined) descriptions.push(match[1].trim().slice(0, 120))
        } catch {
          // 没有 SKILL.md 就跳过。
        }
      }
    }
  } catch {
    return undefined
  }
  return descriptions.length === 0 ? undefined : descriptions.join('；')
}

/**
 * 收集大控制台的工作区清单（2026-11-22 用户要求）：路径 + 用途，供路由匹配。
 * 过滤任务台自家座位（stateDir 下）与 /tmp、home 杂项；用途取技能关键词，退回人工标题。
 * 上限 20 条、每条 240 字符，避免简报膨胀。
 */
export async function collectWorkspaceBriefs(
  registry: { list?(): WorkspaceListRow[] } | undefined,
  stateDir: string,
): Promise<WorkspaceBrief[]> {
  if (registry?.list === undefined) return []
  let rows: WorkspaceListRow[]
  try {
    rows = registry.list()
  } catch {
    return []
  }
  const home = process.env['HOME'] ?? ''
  const briefs: WorkspaceBrief[] = []
  for (const row of rows) {
    const path = text(row.record?.path) ?? text(row.path)
    if (path === undefined || !path.startsWith('/')) continue
    if (path.startsWith(stateDir) || path === home || path === '/tmp') continue
    const title = text(row.record?.title) ?? text(row.title) ?? basename(path)
    const purpose = (await skillKeywords(path)) ?? title
    briefs.push({ path, purpose: purpose.slice(0, 240) })
    if (briefs.length >= 20) break
  }
  return briefs
}
