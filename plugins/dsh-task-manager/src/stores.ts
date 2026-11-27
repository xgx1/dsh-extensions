/**
 * dsh-task-manager — durable stores (M2, 2026-11-26: 全部数据走 Turso).
 *
 * One embedded database `<stateDir>/task-manager.db` holds every store as a JSON document row
 * in `docs(kind, body)`:
 * - `tasks`     — the task list (唯一任务事实源, ADR-0001)
 * - `captains`  — the captain registry: category → CaptainRecord
 * - `console`   — 两层管理器注册表 (ADR-0014)
 * - `settings`  — 设置面板：允许的模型 + 情形→模型
 *
 * `seats.json` 仍是纯 JSON 文件：外部生成器 `~/.dsh/bin/agent-configs.py` 直接读它。
 * 首次打开把旧的每状态一个 JSON 文件一次性导入（`meta` 标记防重复），旧文件留在磁盘上做
 * 迁移证据。每次变更都在写队列里串行、在一个事务里读-改-写。
 */
import { connect, type Database } from '@tursodatabase/database'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  type CaptainRecord,
  type CaptainRegistryData,
  type TaskRecord,
  type TaskSettings,
  normalizeCaptainEntry,
  normalizeSettings,
  normalizeTask,
} from './records.ts'

/** 数据库文件名；`path` 仍以它结尾，orchestrator 靠 dirname 找 seats.json。 */
const DB_FILE = 'task-manager.db'

/** 建表（IF NOT EXISTS，重复打开无副作用）。 */
const DDL = `CREATE TABLE IF NOT EXISTS docs (kind TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`

/** 旧的分文件 JSON → 文档 kind（一次性导入用）。 */
const LEGACY_DOCS: ReadonlyArray<readonly [kind: string, file: string]> = [
  ['tasks', 'tasks.json'],
  ['captains', 'captains.json'],
  ['console', 'console.json'],
  ['settings', 'settings.json'],
]

/** 一个 db 文件的连接与写队列；四个 store 共用，事务绝不能嵌套。 */
interface DatabaseHandle {
  ready: Promise<Database>
  /** 该库的写队列：同一连接上同一时刻只有一个事务。 */
  queue: Promise<unknown>
}

/** 每个 db 文件一个句柄：四个 store 同库，同进程内复用同一连接与队列。 */
const databases = new Map<string, DatabaseHandle>()

/** 打开（或复用）某个 db 文件的句柄：建目录、建表、一次性导入旧 JSON。 */
function database(path: string): DatabaseHandle {
  const cached = databases.get(path)
  if (cached !== undefined) return cached
  const ready = (async (): Promise<Database> => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = await connect(path)
    await db.exec('PRAGMA journal_mode = WAL')
    await db.exec(DDL)
    await importLegacy(db, dirname(path))
    return db
  })()
  const handle: DatabaseHandle = { ready, queue: Promise.resolve() }
  // 打开失败要能被重试：不留失败的句柄在表里，也不让它变成未处理拒绝。
  ready.catch(() => {
    if (databases.get(path) === handle) databases.delete(path)
  })
  databases.set(path, handle)
  return handle
}

/** 首次打开时把旧 JSON 文件导入一次；`meta` 有标记就不再导入。 */
async function importLegacy(db: Database, dir: string): Promise<void> {
  const marker = await (await db.prepare('SELECT value FROM meta WHERE key = ?')).get('legacy-import')
  if (marker !== undefined) return
  for (const [kind, file] of LEGACY_DOCS) {
    let body: string
    try {
      body = await readFile(join(dir, file), 'utf8')
    } catch {
      continue
    }
    if (body.trim() === '') continue
    // OR IGNORE：库里已有的行优先，导入只补空位。
    await (await db.prepare('INSERT OR IGNORE INTO docs (kind, body) VALUES (?, ?)')).run(kind, body)
  }
  await (await db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')).run('legacy-import', String(Date.now()))
}

/** 串行、事务化的 Turso 文档 store：一个 kind 一行 JSON。 */
abstract class DocumentStore<T> {
  private readonly dir: string
  private readonly kind: string
  constructor(dir: string, kind: string) {
    this.dir = dir
    this.kind = kind
  }

  /** 数据库路径（诊断 + orchestrator 靠 dirname 定位 seats.json）。 */
  get path(): string {
    return join(this.dir, DB_FILE)
  }

  /** Load the freshest stored state, normalizing each entry. 缺行 → empty。 */
  async load(): Promise<T> {
    const db = await database(this.path).ready
    return this.parse(await this.read(db))
  }

  /**
   * Run one mutation against the freshest stored state, serialized and in one transaction.
   * 队列挂在**数据库**上（不是 store 上）：同一连接同一时刻只能有一个事务，
   * 两个 store（tasks / settings）并发写同一个库时各自排队，不会 "transaction within a transaction"。
   */
  mutate<R>(fn: (state: T) => R | Promise<R>): Promise<R> {
    const handle = database(this.path)
    const run = handle.queue.then(async () => {
      const db = await handle.ready
      await db.exec('BEGIN IMMEDIATE')
      try {
        const state = this.parse(await this.read(db))
        const result = await fn(state)
        await (await db.prepare('INSERT OR REPLACE INTO docs (kind, body) VALUES (?, ?)')).run(this.kind, this.serialize(state))
        await db.exec('COMMIT')
        return result
      } catch (error: unknown) {
        await db.exec('ROLLBACK').catch(() => undefined)
        throw error
      }
    })
    handle.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** 读本 kind 的 JSON 正文；没有行（或正文丢了）返回空串。 */
  private async read(db: Database): Promise<string> {
    const row = (await (await db.prepare('SELECT body FROM docs WHERE kind = ?')).get(this.kind)) as { body?: unknown } | undefined
    return typeof row?.body === 'string' ? row.body : ''
  }

  protected abstract parse(raw: string): T
  protected abstract serialize(state: T): string
}

/** 任务台管理器注册表：全局大管理器 + 每个项目一个项目管理器（ADR-0014）。 */
export interface ConsoleManagerRecord {
  /** 管理器会话 id。 */
  sessionId: string
  /** 该管理器的工作目录（项目主键的 cwd 或控制台目录）。 */
  cwd: string
  /** 会话运行时使用的预设 id。 */
  preset: string
  /** 本项目订阅的触发器键（inbox / github / ci）；配置挂项目，任务只引用。 */
  sources?: string[]
  createdAt: number
  updatedAt: number
}

/** console 文档的持久形态。 */
export interface ConsoleState {
  global?: ConsoleManagerRecord
  projects?: Record<string, ConsoleManagerRecord>
}

/** 管理器注册表 store：console 文档。 */
export class ConsoleStore extends DocumentStore<ConsoleState> {
  constructor(dir: string) {
    super(dir, 'console')
  }

  protected parse(raw: string): ConsoleState {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {}
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const source = parsed as Record<string, unknown>
    const state: ConsoleState = {}
    const global = normalizeManager(source['global'])
    if (global !== undefined) state.global = global
    const projectsRaw = source['projects']
    if (typeof projectsRaw === 'object' && projectsRaw !== null && !Array.isArray(projectsRaw)) {
      const projects: Record<string, ConsoleManagerRecord> = {}
      for (const [key, value] of Object.entries(projectsRaw as Record<string, unknown>)) {
        const record = normalizeManager(value)
        if (record !== undefined) projects[key] = record
      }
      if (Object.keys(projects).length > 0) state.projects = projects
    }
    return state
  }

  protected serialize(state: ConsoleState): string {
    return JSON.stringify(state, null, 2)
  }
}

/** 容错读一条管理器记录：缺 sessionId/cwd 的条目丢弃。 */
function normalizeManager(raw: unknown): ConsoleManagerRecord | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const source = raw as Record<string, unknown>
  const sessionId = source['sessionId']
  const cwd = source['cwd']
  if (typeof sessionId !== 'string' || sessionId === '' || typeof cwd !== 'string' || cwd === '') return undefined
  const now = Date.now()
  const createdAt = typeof source['createdAt'] === 'number' ? source['createdAt'] : now
  const updatedAt = typeof source['updatedAt'] === 'number' ? source['updatedAt'] : createdAt
  const preset = typeof source['preset'] === 'string' && source['preset'] !== '' ? source['preset'] : ''
  const rawSources = source['sources']
  const sources = Array.isArray(rawSources)
    ? rawSources.filter((item): item is string => typeof item === 'string' && item !== '')
    : []
  return { sessionId, cwd, preset, ...(sources.length === 0 ? {} : { sources }), createdAt, updatedAt }
}

/** Task list store: a JSON array of TaskRecord entries. */
export class TaskStore extends DocumentStore<TaskRecord[]> {
  constructor(dir: string) {
    super(dir, 'tasks')
  }

  protected parse(raw: string): TaskRecord[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => normalizeTask(item))
      .filter((item): item is TaskRecord => item !== null)
  }

  protected serialize(state: TaskRecord[]): string {
    return JSON.stringify(state, null, 2)
  }
}

/** Captain registry store: a JSON object mapping category → CaptainRecord. */
export class CaptainStore extends DocumentStore<CaptainRegistryData> {
  constructor(dir: string) {
    super(dir, 'captains')
  }

  protected parse(raw: string): CaptainRegistryData {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {}
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const entries: CaptainRegistryData = {}
    for (const [category, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = normalizeCaptainEntry(value)
      if (record !== null) entries[category] = record
    }
    return entries
  }

  protected serialize(state: CaptainRegistryData): string {
    return JSON.stringify(state, null, 2)
  }
}

/** 设置面板存储（settings 文档）：允许的模型 + 情形→模型映射。 */
export class SettingsStore extends DocumentStore<TaskSettings> {
  constructor(dir: string) {
    super(dir, 'settings')
  }

  protected parse(raw: string): TaskSettings {
    try {
      return normalizeSettings(JSON.parse(raw))
    } catch {
      return { allowedModels: [], situationModels: {} }
    }
  }

  protected serialize(state: TaskSettings): string {
    return JSON.stringify(state, null, 2)
  }
}

/** Read-only captain registry snapshot entry with derived task count. */
export interface CaptainSummary extends CaptainRecord {
  readonly category: string
  /** Number of tasks currently registered under this category. */
  readonly taskCount: number
}

/** Project the registry into a sorted snapshot annotated with task counts. */
export function summarizeCaptains(
  registry: CaptainRegistryData,
  tasks: readonly TaskRecord[],
): CaptainSummary[] {
  return Object.entries(registry)
    .map(([category, record]) => ({
      ...record,
      category,
      taskCount: tasks.filter((task) => task.category === category).length,
    }))
    .sort((a, b) => a.category.localeCompare(b.category))
}
