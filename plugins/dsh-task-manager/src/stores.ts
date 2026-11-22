/**
 * dsh-task-manager — durable stores (M1).
 *
 * Two single-JSON-file stores under the plugin stateDir:
 * - `tasks.json`    — the task list (唯一任务事实源, ADR-0001)
 * - `captains.json` — the captain registry: category → CaptainRecord
 *
 * Both serialize every mutation through one promise queue per store and
 * persist atomically (write `.tmp` then rename), so concurrent callers never
 * interleave reads-modify-writes and readers never observe partial files.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type CaptainRecord,
  type CaptainRegistryData,
  type TaskRecord,
  type TaskSettings,
  normalizeCaptainEntry,
  normalizeSettings,
  normalizeTask,
} from './records.ts'

/** Serialized, atomic single-file JSON store over one directory. */
abstract class JsonStore<T> {
  private readonly file: string
  private readonly dir: string
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(dir: string, fileName: string) {
    this.dir = dir
    this.file = join(dir, fileName)
  }

  /** Path of the backing file (diagnostics). */
  get path(): string {
    return this.file
  }

  /** Load the freshest on-disk state, normalizing each entry. Missing file → empty. */
  async load(): Promise<T> {
    try {
      const raw = await readFile(this.file, 'utf8')
      return this.parse(raw)
    } catch {
      return this.empty()
    }
  }

  /** Run one mutation against the freshest on-disk state, serialized. */
  mutate<R>(fn: (state: T) => R | Promise<R>): Promise<R> {
    const run = this.writeQueue.then(async () => {
      const state = await this.load()
      const result = await fn(state)
      await this.persist(state)
      return result
    })
    this.writeQueue = run.catch(() => undefined)
    return run
  }

  protected abstract parse(raw: string): T
  protected abstract empty(): T
  protected abstract serialize(state: T): string

  private async persist(state: T): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, this.serialize(state), 'utf8')
    await rename(tmp, this.file)
  }
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

/** console.json 的持久形态。 */
export interface ConsoleState {
  global?: ConsoleManagerRecord
  projects?: Record<string, ConsoleManagerRecord>
}

/** 管理器注册表 store：console.json。 */
export class ConsoleStore extends JsonStore<ConsoleState> {
  constructor(dir: string) {
    super(dir, 'console.json')
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

  protected empty(): ConsoleState {
    return {}
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
export class TaskStore extends JsonStore<TaskRecord[]> {
  constructor(dir: string) {
    super(dir, 'tasks.json')
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

  protected empty(): TaskRecord[] {
    return []
  }

  protected serialize(state: TaskRecord[]): string {
    return JSON.stringify(state, null, 2)
  }
}

/** Captain registry store: a JSON object mapping category → CaptainRecord. */
export class CaptainStore extends JsonStore<CaptainRegistryData> {
  constructor(dir: string) {
    super(dir, 'captains.json')
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

  protected empty(): CaptainRegistryData {
    return {}
  }

  protected serialize(state: CaptainRegistryData): string {
    return JSON.stringify(state, null, 2)
  }
}

/** 设置面板存储（settings.json）：允许的模型 + 情形→模型映射。 */
export class SettingsStore extends JsonStore<TaskSettings> {
  constructor(dir: string) {
    super(dir, 'settings.json')
  }

  protected parse(raw: string): TaskSettings {
    try {
      return normalizeSettings(JSON.parse(raw))
    } catch {
      return { allowedModels: [], situationModels: {} }
    }
  }

  protected empty(): TaskSettings {
    return { allowedModels: [], situationModels: {} }
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
