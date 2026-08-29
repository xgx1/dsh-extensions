/**
 * dsh-task-manager — host half.
 *
 * Owns the durable task registry and every filesystem/git operation, and
 * exposes them to the browser half over same-origin HTTP routes registered on
 * the host web server (`/plugins/dsh-task-manager/*`) — the same channel the
 * `dsh-agent-teams` bundle uses for its web surface.
 *
 * - Tasks persist to a single JSON file under `~/.dsh/task-manager/tasks.json`
 *   (overridable via `config.stateDir`).
 * - Worktrees are read/created through the `git` CLI (`worktree list` /
 *   `worktree add`), resolved against the active session's working directory,
 *   then the first workspace, then the host process cwd.
 * - "Conversations that took over a task" are derived at read time by matching
 *   durable sessions whose `header.cwd` is the task's directory (or inside it).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

const execFileAsync = promisify(execFile)

/** Task status vocabulary (stable keys; labels live in the client dictionaries). */
const STATUSES = ['not-started', 'in-progress', 'waiting-reply', 'problem', 'waiting-check', 'done'] as const
type Status = (typeof STATUSES)[number]

/** Run-location modes the create dialog offers. */
type RunMode = 'cwd' | 'new-worktree' | 'existing-worktree'

/** One persisted task record. */
interface TaskRecord {
  id: string
  title: string
  content: string
  status: Status
  runMode: RunMode
  directory: string
  worktreeBranch?: string
  conversations?: ConversationSummary[]
  createdAt: number
  updatedAt: number
}

/** Compact, owned summary of one durable session that took over a task. */
interface ConversationSummary {
  id: string
  shortId: string
  cwd?: string
  createdAt?: number
  origin?: string
}

/** Worktree row returned by `git worktree list --porcelain`. */
interface WorktreeRow {
  path: string
  branch?: string
  head?: string
  isCurrent: boolean
}

/** Plugin configuration. */
interface Config {
  /** Directory holding `tasks.json`. Defaults to `<dsh home>/task-manager`. */
  stateDir?: string
}

/** Structural slice of the host web server service. */
interface WebServer {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Structural slice of the durable session store. */
interface SessionLike {
  id: string
  header: {
    cwd?: string
    createdAt?: number
    origin?: string
  }
}
interface SessionStore {
  list(): SessionLike[]
  get(id: string): SessionLike | undefined
}

/** Structural slice of the workspace registry (optional in headless profiles). */
interface WorkspaceRegistry {
  list(): Array<WorkspaceLike>
}
interface WorkspaceLike {
  record?: { path?: unknown; title?: unknown }
  path?: unknown
  title?: unknown
}

export const name = 'dsh-task-manager'

/** Run a `git` command and return its trimmed stdout. */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, env: process.env })
    return stdout.trim()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`git ${args.join(' ')} failed: ${message}`)
  }
}

/** Resolve the git repository root at or above `start`; null when not in a repo. */
async function findRepoRoot(start: string): Promise<string | null> {
  try {
    return await git(start, ['rev-parse', '--show-toplevel'])
  } catch {
    return null
  }
}

/** Parse `git worktree list --porcelain` into owned worktree rows. */
async function listWorktrees(repoRoot: string, currentDir: string): Promise<WorktreeRow[]> {
  let raw: string
  try {
    raw = await git(repoRoot, ['worktree', 'list', '--porcelain'])
  } catch {
    return []
  }
  const rows: WorktreeRow[] = []
  let pending: Partial<WorktreeRow> | undefined
  const flush = (): void => {
    if (pending === undefined || pending.path === undefined) return
    rows.push({
      path: pending.path,
      branch: pending.branch,
      head: pending.head,
      isCurrent: pending.path === repoRoot || pending.path === currentDir,
    })
    pending = undefined
  }
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.startsWith('worktree ')) {
      flush()
      pending = { path: line.slice('worktree '.length).trim() }
    } else if (line.startsWith('HEAD ')) {
      const head = line.slice('HEAD '.length).trim()
      if (pending !== undefined) pending.head = head
    } else if (line.startsWith('branch ')) {
      const branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
      if (pending !== undefined) pending.branch = branch
    }
  }
  flush()
  return rows
}

/** Turn a branch name into a safe directory suffix for a sibling worktree. */
function branchDirName(branch: string): string {
  const cleaned = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'worktree' : cleaned
}

/** Serialize a single JSON value write path between concurrent requests. */
class TaskStore {
  private readonly file: string
  private readonly dir: string
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(dir: string) {
    this.dir = dir
    this.file = join(dir, 'tasks.json')
  }

  async load(): Promise<TaskRecord[]> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((item): item is TaskRecord => typeof item === 'object' && item !== null)
    } catch {
      return []
    }
  }

  private async persist(tasks: TaskRecord[]): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(tasks, null, 2), 'utf8')
    await rename(tmp, this.file)
  }

  /** Run one mutation against the freshest on-disk state, serialized. */
  mutate<T>(fn: (tasks: TaskRecord[]) => T | Promise<T>): Promise<T> {
    const run = this.writeQueue.then(async () => {
      const tasks = await this.load()
      const result = await fn(tasks)
      await this.persist(tasks)
      return result
    })
    this.writeQueue = run.catch(() => undefined)
    return run
  }
}

/** Coerce an unknown workspace field into a non-empty path string, else null. */
function asPath(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Read the current context for the create dialog: cwd, repo, and worktrees. */
async function buildContext(
  dump: {
    sessions: SessionStore | undefined
    workspaces: WorkspaceRegistry | undefined
    sessionId: string | undefined
  },
): Promise<{
  currentDir: string
  repoRoot: string | null
  workspaces: Array<{ title: string; path: string }>
  worktrees: WorktreeRow[]
}> {
  const sessionCwd = dump.sessionId === undefined
    ? undefined
    : dump.sessions?.get(dump.sessionId)?.header.cwd
  let workspaces: Array<{ title: string; path: string }> = []
  try {
    const raw = dump.workspaces?.list() ?? []
    workspaces = raw
      .map((workspace) => {
        const path = asPath(workspace.record?.path) ?? asPath(workspace.path)
        const title = asPath(workspace.record?.title) ?? asPath(workspace.title) ?? path ?? ''
        return path === undefined ? null : { title, path }
      })
      .filter((workspace): workspace is { title: string; path: string } => workspace !== null)
  } catch {
    workspaces = []
  }
  const fallback = (sessionCwd !== undefined && isAbsolute(sessionCwd))
    ? sessionCwd
    : (workspaces[0]?.path !== undefined && isAbsolute(workspaces[0].path))
      ? workspaces[0].path
      : process.cwd()
  const currentDir = resolve(fallback)
  const repoRoot = await findRepoRoot(currentDir)
  const worktrees = repoRoot === null ? [] : await listWorktrees(repoRoot, currentDir)
  return { currentDir, repoRoot, workspaces, worktrees }
}

/** Send a JSON response with `no-store` so the browser never caches task state. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Read a small JSON request body, rejecting oversize or malformed payloads. */
async function readJsonBody(req: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  await new Promise<void>((resolvePromise, reject) => {
    req.on('data', (chunk) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += part.length
      if (size > limit) {
        reject(new Error('request body is too large'))
        return
      }
      chunks.push(part)
    })
    req.on('end', () => resolvePromise())
    req.on('error', reject)
  })
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** Derive the conversations whose cwd is the task directory or inside it. */
function conversationsFor(task: TaskRecord, sessions: SessionLike[]): ConversationSummary[] {
  const dir = task.directory
  if (typeof dir !== 'string' || dir === '') return []
  const normalized = dir.endsWith(sep) ? dir : `${dir}${sep}`
  const summaries: ConversationSummary[] = []
  for (const session of sessions) {
    const cwd = session.header.cwd
    if (typeof cwd !== 'string' || cwd === '') continue
    const matches = cwd === dir || cwd.startsWith(normalized)
    if (!matches) continue
    summaries.push({
      id: session.id,
      shortId: session.id.replace(/^session-/, '').slice(0, 8) || session.id.slice(0, 8),
      cwd,
      createdAt: session.header.createdAt,
      origin: session.header.origin,
    })
  }
  summaries.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return summaries
}

export function apply(ctx: Context, config?: Config): void {
  const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const stateDir = config?.stateDir !== undefined && config.stateDir !== ''
    ? config.stateDir
    : join(dshHome, 'task-manager')
  const store = new TaskStore(stateDir)

  let webRegistered = false
  const registerWebSurface = (): void => {
    if (webRegistered) return
    const webServer = (ctx.get('webServer') ?? ctx.get('httpServer')) as WebServer | undefined
    if (webServer === undefined) return
    webRegistered = true

    const readServices = (): { sessions?: SessionStore; workspaces?: WorkspaceRegistry } => ({
      sessions: ctx.get('sessions') as SessionStore | undefined,
      workspaces: (ctx.get('workspaceRegistry') ?? ctx.get('workspace')) as WorkspaceRegistry | undefined,
    })

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-task-manager/context',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const sessionId = url.searchParams.get('sessionId') ?? undefined
          const { sessions, workspaces } = readServices()
          const context = await buildContext({ sessions, workspaces, sessionId })
          json(res, 200, context)
        } catch (error) {
          json(res, 500, { error: error instanceof Error ? error.message : 'context failed' })
        }
      },
    }), 'task-manager: context route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-task-manager/state',
      handler: async (_req, res) => {
        try {
          const { sessions } = readServices()
          const tasks = await store.load()
          const sessionsList = sessions?.list() ?? []
          const enriched = tasks.map((task) => ({
            ...task,
            conversations: conversationsFor(task, sessionsList),
          }))
          json(res, 200, { tasks: enriched })
        } catch (error) {
          json(res, 500, { error: error instanceof Error ? error.message : 'state failed' })
        }
      },
    }), 'task-manager: state route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-task-manager/create',
      handler: async (req, res) => {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch {
          json(res, 400, { error: 'invalid JSON body' })
          return
        }
        const title = typeof body['title'] === 'string' ? body['title'].trim() : ''
        const content = typeof body['content'] === 'string' ? body['content'] : ''
        const runMode = typeof body['runMode'] === 'string' ? body['runMode'] as RunMode : ''
        const branch = typeof body['worktreeBranch'] === 'string' ? body['worktreeBranch'].trim() : ''
        const worktreePath = typeof body['worktreePath'] === 'string' ? body['worktreePath'].trim() : ''
        if (runMode !== 'cwd' && runMode !== 'new-worktree' && runMode !== 'existing-worktree') {
          json(res, 400, { error: 'runMode must be cwd, new-worktree, or existing-worktree' })
          return
        }
        if (content === '') {
          json(res, 400, { error: 'task content is required' })
          return
        }

        try {
          const { sessions, workspaces } = readServices()
          const { currentDir, repoRoot, worktrees } = await buildContext({
            sessions,
            workspaces,
            sessionId: typeof body['sessionId'] === 'string' ? body['sessionId'] : undefined,
          })
          let directory: string
          let worktreeBranch: string | undefined
          const now = Date.now()

          if (runMode === 'cwd') {
            directory = typeof body['directory'] === 'string' && body['directory'].trim() !== ''
              ? resolve(body['directory'])
              : currentDir
          } else if (runMode === 'new-worktree') {
            if (repoRoot === null) {
              json(res, 409, { error: 'current directory is not inside a git repository' })
              return
            }
            if (branch === '' || /\s/.test(branch)) {
              json(res, 400, { error: 'a valid worktree branch name is required' })
              return
            }
            const target = join(dirname(repoRoot), `${basename(repoRoot)}-${branchDirName(branch)}`)
            await git(repoRoot, ['worktree', 'add', target, '-b', branch])
            directory = target
            worktreeBranch = branch
          } else {
            if (repoRoot === null) {
              json(res, 409, { error: 'current directory is not inside a git repository' })
              return
            }
            const chosen = worktrees.find((row) => row.path === worktreePath)
            if (chosen === undefined) {
              json(res, 400, { error: 'the selected worktree is not a worktree of this repository' })
              return
            }
            directory = chosen.path
            worktreeBranch = chosen.branch
          }

          const task: TaskRecord = {
            id: randomUUID(),
            title: title === '' ? content.split('\n')[0]?.slice(0, 60) ?? 'Untitled' : title,
            content,
            status: 'not-started',
            runMode,
            directory,
            worktreeBranch,
            createdAt: now,
            updatedAt: now,
          }
          const created = await store.mutate((tasks) => {
            tasks.push(task)
            return task
          })
          json(res, 200, created)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          json(res, 500, { error: message })
        }
      },
    }), 'task-manager: create route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-task-manager/set-status',
      handler: async (req, res) => {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch {
          json(res, 400, { error: 'invalid JSON body' })
          return
        }
        const id = typeof body['id'] === 'string' ? body['id'] : ''
        const status = typeof body['status'] === 'string' ? body['status'] : ''
        if (id === '' || !(STATUSES as readonly string[]).includes(status)) {
          json(res, 400, { error: 'id and a valid status are required' })
          return
        }
        try {
          let updated: TaskRecord | undefined
          await store.mutate((tasks) => {
            const task = tasks.find((item) => item.id === id)
            if (task === undefined) throw new Error('task not found')
            task.status = status as Status
            task.updatedAt = Date.now()
            updated = task
          })
          json(res, 200, updated)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          json(res, message === 'task not found' ? 404 : 500, { error: message })
        }
      },
    }), 'task-manager: set-status route')
  }

  registerWebSurface()
  ctx.on('internal/service', (serviceName) => {
    if (serviceName === 'webServer' || serviceName === 'httpServer' || serviceName === 'sessions') {
      registerWebSurface()
    }
  })
}