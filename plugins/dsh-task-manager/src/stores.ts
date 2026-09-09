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
  normalizeCaptainEntry,
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
