/**
 * Turso store for the in-progress session set: one `resume.db` under the Harness
 * home, one row per session whose turn had not ended when the host stopped.
 *
 * The set is kept out of the Session logs on purpose: answering "which sessions
 * were mid-turn" from the logs at boot would mean reading every stored log, while
 * the live listener already knows the answer at the moment it changes.
 */
import { connect, type Database } from '@tursodatabase/database'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Table DDL: membership only, one row per in-progress session. */
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS active (
  session_id TEXT PRIMARY KEY
) STRICT`

/**
 * Open the database, creating its directory and the `active` table.
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

/** The Turso in-progress set. Rows are inserted and deleted individually. */
export class ActiveStore {
  private readonly ready: Promise<Database>
  /** Tail of the write queue: a turn/start and a turn/end never land out of order. */
  private writes: Promise<void> = Promise.resolve()

  /**
   * @param path - the database file to keep the in-progress set in.
   */
  constructor(path: string) {
    this.ready = openDatabase(path)
    // Every operation re-awaits `ready`, so an open failure surfaces to its caller.
    this.ready.catch(() => {})
  }

  /**
   * Read every tracked session id.
   * @returns the ids, in no promised order.
   */
  async list(): Promise<string[]> {
    const db = await this.ready
    const statement = await db.prepare('SELECT session_id FROM active')
    const rows: unknown[] = await statement.all()
    return rows.map((value) => {
      const row = value as { session_id?: unknown }
      if (typeof row.session_id !== 'string') throw new Error('resume database row does not match the active layout')
      return row.session_id
    })
  }

  /**
   * Record one session as in progress. Idempotent.
   * @param sessionId - the session whose turn started.
   */
  keep(sessionId: string): Promise<void> {
    return this.serialize(async () => {
      const db = await this.ready
      await (await db.prepare('INSERT OR REPLACE INTO active (session_id) VALUES (?)')).run(sessionId)
    })
  }

  /**
   * Drop one session from the set. Idempotent.
   * @param sessionId - the session whose turn ended, or that needs no resume.
   */
  drop(sessionId: string): Promise<void> {
    return this.serialize(async () => {
      const db = await this.ready
      await (await db.prepare('DELETE FROM active WHERE session_id = ?')).run(sessionId)
    })
  }

  /**
   * Retire every tracked session the boot sweep will handle differently, in one
   * write, so a restart does not turn into one round trip per row.
   * @param sessionIds - rows to remove; absent rows are ignored.
   */
  async dropAll(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return
    await this.serialize(async () => {
      const db = await this.ready
      await db.exec('BEGIN IMMEDIATE')
      try {
        const statement = await db.prepare('DELETE FROM active WHERE session_id = ?')
        for (const id of sessionIds) await statement.run(id)
        await db.exec('COMMIT')
      } catch (error: unknown) {
        await db.exec('ROLLBACK')
        throw error
      }
    })
  }

  /**
   * Release the connection. Idempotent; an opening database is awaited first,
   * and queued writes land before it closes — the row for a turn that started
   * just before a host stop is the one the next boot depends on.
   * @returns resolution after the connection is closed.
   */
  async close(): Promise<void> {
    await this.writes.catch(() => {})
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
