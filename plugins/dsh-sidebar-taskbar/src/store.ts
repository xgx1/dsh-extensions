/**
 * Turso store for the finished group of the sidebar task bar: one `taskbar.db`
 * under the Harness home, one row per session the bar still owes a look at.
 * The classification and dismissal rules stay in the client; this owns
 * durability only, which browser-local storage cannot give across browsers
 * and host restarts.
 */
import { connect, type Database } from '@tursodatabase/database'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The persisted finished-group state: the two sets the client folds. */
export interface DoneState {
  /** Sessions still listed in the finished group until closed. */
  readonly shown: readonly string[]
  /** Sessions whose current completion the bar already announced. */
  readonly unread: readonly string[]
}

/** One `done` row as read back. */
interface DoneRow {
  readonly session_id: string
  readonly shown: number
  readonly unread: number
}

/** Table DDL. `shown`/`unread` are per-session flags, not list membership. */
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS done (
  session_id TEXT PRIMARY KEY,
  shown      INTEGER NOT NULL,
  unread     INTEGER NOT NULL
) STRICT`

/** Validate a durable row read back from the task bar database. */
function storedRow(value: unknown): DoneRow {
  const row = value as Partial<Record<keyof DoneRow, unknown>>
  if (typeof row.session_id !== 'string' || typeof row.shown !== 'number' || typeof row.unread !== 'number') {
    throw new Error('taskbar database row does not match the done layout')
  }
  return { session_id: row.session_id, shown: row.shown, unread: row.unread }
}

/**
 * Open the database, creating its directory and the `done` table.
 * @param path - the database file, created owner-only when missing.
 * @returns the open connection.
 */
async function openDatabase(path: string): Promise<Database> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const db = await connect(path)
  await db.exec('PRAGMA journal_mode = WAL')
  await db.exec(CREATE_TABLE)
  return db
}

/**
 * The Turso {@link DoneState} store. Writes replace the whole set, so a row
 * for a session the bar forgot cannot outlive the request that forgot it.
 */
export class DoneStore {
  private readonly ready: Promise<Database>
  /** Tail of the write queue: a concurrent write never interleaves transactions. */
  private writes: Promise<void> = Promise.resolve()

  /**
   * @param path - the database file to keep the finished group in.
   */
  constructor(path: string) {
    this.ready = openDatabase(path)
    // Every operation re-awaits `ready`, so an open failure surfaces to its caller.
    this.ready.catch(() => {})
  }

  /**
   * Read every stored session.
   * @returns the two sets, in no promised order.
   */
  async read(): Promise<DoneState> {
    const db = await this.ready
    const statement = await db.prepare('SELECT session_id, shown, unread FROM done')
    const rows: unknown[] = await statement.all()
    const stored = rows.map(storedRow)
    return {
      shown: stored.filter(row => row.shown !== 0).map(row => row.session_id),
      unread: stored.filter(row => row.unread !== 0).map(row => row.session_id),
    }
  }

  /**
   * Replace the stored sets with this state in one transaction.
   * @param state - the sets to keep; every other stored row is dropped.
   */
  async write(state: DoneState): Promise<void> {
    const db = await this.ready
    const shown = new Set(state.shown)
    const unread = new Set(state.unread)
    const ids = new Set([...shown, ...unread])
    await this.serialize(async () => {
      await db.exec('BEGIN IMMEDIATE')
      try {
        await (await db.prepare('DELETE FROM done')).run()
        const insert = await db.prepare('INSERT INTO done (session_id, shown, unread) VALUES (?, ?, ?)')
        for (const id of ids) await insert.run(id, shown.has(id) ? 1 : 0, unread.has(id) ? 1 : 0)
        await db.exec('COMMIT')
      } catch (error: unknown) {
        await db.exec('ROLLBACK')
        throw error
      }
    })
  }

  /**
   * Release the connection. Idempotent; an opening database is awaited first.
   * @returns resolution after the connection is closed.
   */
  async close(): Promise<void> {
    const db = await this.ready.catch(() => undefined)
    await db?.close()
  }

  /**
   * Run one write past every other write.
   * @param work - the write to run once the queue reaches it.
   * @returns the write's own result.
   */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work, work)
    this.writes = run.then(() => {}, () => {})
    return run
  }
}
