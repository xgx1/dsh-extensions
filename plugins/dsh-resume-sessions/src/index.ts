/**
 * `dsh-resume-sessions` — after a host restart, the conversations whose turn was
 * still open when the previous process stopped are cold-resumed and handed one
 * follow-up message, so the model picks the interrupted work back up.
 *
 * The in-progress set is a host-side fact, not a projection: the live
 * `session/event` listener is the only place that knows a turn started or ended
 * at the moment it happens, so tracking there keeps the boot sweep to one
 * `resume.db` read instead of a log scan over every stored session.
 *
 * A turn closed by `cancel({ kind: 'disposed' })` is the host going away, not a
 * finished turn: its row stays and the session comes back on the next boot.
 * Every other ending (completion, failure, a human stop) drops the row.
 *
 * The sweep resumes through `sessionController.resolveAgent`, the same cold
 * resume path a reply delivery uses: it restores the recorded Agent preset and
 * model route, which a bare `agents.resume` cannot.
 *
 * @module dsh-resume-sessions
 */
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import { ActiveStore } from './store.ts'

export const name = 'resume-sessions'

/** The Session store dispatches the turn boundaries this plugin tracks. */
export const inject = ['sessions']

/** Plugin configuration; both fields are deployment choices, not protocol constants. */
export interface Config {
  /** Resume interrupted conversations after boot. `false` keeps tracking and resumes nothing. */
  readonly enabled?: boolean
  /** Spacing between two resumed conversations, in milliseconds; the sweep is serial. */
  readonly delayMs?: number
}

/** Default spacing: enough for the previous turn to reach its first request before the next starts. */
const DEFAULT_DELAY_MS = 2000

/** Upper bound that still leaves a sweep inside an ordinary boot window. */
const MAX_DELAY_MS = 60_000

/** The Harness-home path resolver `app-boot` provides. */
type HomePath = (...segments: string[]) => string

/** The launcher-provided successful-startup signal. */
interface AppReady {
  onReady(listener: () => void): () => void
}

/** The loader-readiness slice: `await` settles the whole plugin tree. */
interface LoaderSlice {
  await(): Promise<unknown>
}

/** The stored header fields this plugin reads. */
export interface ResumeHeader {
  readonly origin?: 'subagent'
}

/** A stored session header, as the persistence listing reports it. */
interface PersistenceSnapshot {
  readonly header: ResumeHeader & { readonly id: string }
}

/** The persistence list slice the sweep needs. */
interface PersistenceSlice {
  list(): Promise<readonly PersistenceSnapshot[]>
}

/** A live conversation this plugin can wake; only the delivery method is used. */
interface ResumeTarget {
  followup(message: unknown): void
}
/** The cold-resume slice, the same one a reply delivery uses. */
interface SessionControllerSlice {
  resolveAgent(sessionId: string): Promise<{ agent?: ResumeTarget; error?: unknown }>
}

/** The archive set the sweep honors. */
interface WorkspaceSlice {
  readonly archivedSessionIds: readonly string[]
}

/** The live goal view the sweep honors. */
interface GoalsSlice {
  get(agent: ResumeTarget): { readonly phase: string } | undefined
}

/** The Agents registry slice: a session that is already live needs no resume. */
interface AgentsSlice {
  get(sessionId: string): unknown
}

/** A `turn/end` reason, read only for the host-stop case. */
export interface TurnEndReason {
  readonly kind: string
  readonly reason?: { readonly kind?: string }
}

/** The model-visible account of the restart and of what to do with a half-finished step. */
const RESUME_TEXT = [
  'The Harness stopped while this turn was running and the process has restarted.',
  'The interrupted turn is closed; a tool call whose result was never recorded is reported as unknown.',
  'Continue the work from where it stopped. Re-check the external state of anything that may have been half-done instead of repeating a finished step.',
].join(' ')

/**
 * Whether this turn ending was the host going away mid-turn rather than the turn
 * reaching its own end. Only `cancel({ kind: 'disposed' })` marks a host stop;
 * a human stop, a failure, and a completion all finish the work.
 * @param reason - the logged `turn/end` reason.
 * @returns whether the session must be resumed after the next boot.
 */
export function interruptedByShutdown(reason: TurnEndReason): boolean {
  return reason.kind === 'aborted' && reason.reason?.kind === 'disposed'
}

/**
 * Split the tracked set into the sessions the next boot resumes and the rows it
 * retires: a vanished session, a subagent child, and an archived conversation
 * are all things a bot sweep must not resurrect.
 * @param tracked - the session ids the store holds.
 * @param headers - every stored session header, keyed by id.
 * @param archived - the archive set the Workspace registry owns.
 * @returns the ids to resume and the ids to drop.
 */
export function selectResumes(
  tracked: readonly string[],
  headers: ReadonlyMap<string, ResumeHeader>,
  archived: ReadonlySet<string>,
): { resume: string[]; drop: string[] } {
  const resume: string[] = []
  const drop: string[] = []
  for (const id of tracked) {
    const header = headers.get(id)
    if (header === undefined || header.origin === 'subagent' || archived.has(id)) drop.push(id)
    else resume.push(id)
  }
  return { resume, drop }
}

/**
 * Validate and default the deployment config, refusing values the sweep cannot honor.
 * @param config - the profile row's config.
 * @returns the resolved switch and spacing.
 */
export function resolveConfig(config: Config): { enabled: boolean; delayMs: number } {
  const delayMs = config.delayMs ?? DEFAULT_DELAY_MS
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) {
    throw new Error(`resume-sessions: delayMs must be an integer between 0 and ${MAX_DELAY_MS}`)
  }
  return { enabled: config.enabled ?? true, delayMs }
}

/** One human-readable line for a thrown value. */
function renderThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One identified user-role message: `followup` consumes `createUserMessage`'s value shape. */
function resumeMessage(): unknown {
  return Object.freeze({
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text: RESUME_TEXT }],
    source: { kind: name },
  })
}

/**
 * Report one tracking write without letting it fail the fiber or the turn.
 * @param ctx - the plugin context, used for its logger.
 * @param write - the pending store write.
 */
function reportWrite(ctx: Context, write: Promise<void>): void {
  void write.catch((error: unknown) => {
    ctx.logger.warn(`resume-sessions: could not persist the in-progress set: ${renderThrown(error)}`)
  })
}

/**
 * Drop one row, contained. A failed retire is reported, not retried forever.
 * @param ctx - the plugin context.
 * @param store - the in-progress set.
 * @param id - the session to retire.
 */
async function retire(ctx: Context, store: ActiveStore, id: string): Promise<void> {
  try {
    await store.drop(id)
  } catch (error: unknown) {
    ctx.logger.warn(`resume-sessions: could not retire conversation "${id}": ${renderThrown(error)}`)
  }
}

/**
 * Resume one tracked conversation and hand it the follow-up. Every outcome is
 * contained here so one conversation can never fail the boot.
 * @param ctx - the plugin context.
 * @param controller - the cold-resume seam.
 * @param id - the tracked session id.
 */
async function resumeOne(ctx: Context, controller: SessionControllerSlice, id: string): Promise<void> {
  if ((ctx.get('agents') as AgentsSlice | undefined)?.get(id) !== undefined) return
  const resolved = await controller.resolveAgent(id)
  const agent = resolved.error === undefined ? resolved.agent : undefined
  if (agent === undefined) {
    ctx.logger.warn(`resume-sessions: could not resume conversation "${id}": ${renderThrown(resolved.error ?? 'no agent')}`)
    return
  }
  const goals = ctx.get('goals') as GoalsSlice | undefined
  let phase: string | undefined
  try {
    phase = goals?.get(agent)?.phase
  } catch (error: unknown) {
    // A goal that cannot be read is not permission to spend another model call.
    ctx.logger.warn(`resume-sessions: could not read the goal of conversation "${id}": ${renderThrown(error)}`)
    return
  }
  if (phase !== undefined && phase !== 'active') {
    ctx.logger.info(`resume-sessions: conversation "${id}" has a ${phase} goal; leaving it stopped`)
    return
  }
  agent.followup(resumeMessage())
  ctx.logger.info(`resume-sessions: resumed conversation "${id}"`)
}

/**
 * Resume the tracked conversations once, serially, spaced by `delayMs`. One
 * attempt per tracked conversation: the row goes before the delivery, and the
 * resumed turn re-keeps it while it runs.
 * @param ctx - the plugin context.
 * @param store - the in-progress set.
 * @param delayMs - spacing between two resumed conversations.
 * @param signal - aborts the sweep when the fiber unloads.
 */
async function sweep(
  ctx: Context,
  store: ActiveStore,
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  const tracked = await store.list()
  if (tracked.length === 0) return
  const persistence = ctx.get('sessionPersistence') as PersistenceSlice | undefined
  const controller = ctx.get('sessionController') as SessionControllerSlice | undefined
  if (persistence === undefined || controller === undefined) {
    ctx.logger.warn('resume-sessions: this composition cannot resolve stored conversations; keeping the in-progress set for a later boot')
    return
  }
  const headers = new Map<string, ResumeHeader>()
  for (const snapshot of await persistence.list()) headers.set(snapshot.header.id, snapshot.header)
  const archived = new Set((ctx.get('workspaceRegistry') as WorkspaceSlice | undefined)?.archivedSessionIds ?? [])
  const selected = selectResumes(tracked, headers, archived)
  try {
    await store.dropAll(selected.drop)
  } catch (error: unknown) {
    ctx.logger.warn(`resume-sessions: could not retire un-resumable rows: ${renderThrown(error)}`)
  }
  for (const [index, id] of selected.resume.entries()) {
    if (signal.aborted) return
    if (index > 0 && delayMs > 0) {
      // The lifetime signal is the only aborter; a sleeping sweep is a stopped sweep.
      if (!await sleep(delayMs, undefined, { signal }).then(() => true, () => false)) return
    }
    // Retire before delivering: the resumed turn re-keeps its row while it runs,
    // and a delivery that fails here must not come back on the next boot.
    await retire(ctx, store, id)
    if (signal.aborted) return
    try {
      await resumeOne(ctx, controller, id)
    } catch (error: unknown) {
      ctx.logger.warn(`resume-sessions: conversation "${id}" failed to resume: ${renderThrown(error)}`)
    }
  }
}

/**
 * Run the boot sweep once the application is ready: the launcher signal when
 * present, otherwise Loader settlement.
 * @param ctx - the plugin context.
 * @param start - the sweep starter.
 * @returns the disposer that cancels a pending start.
 */
function scheduleSweep(ctx: Context, start: () => void): () => void {
  const ready = ctx.get('appReady') as AppReady | undefined
  if (ready !== undefined) return ready.onReady(start)
  const loader = ctx.get('loader') as LoaderSlice | undefined
  if (loader === undefined) {
    start()
    return () => {}
  }
  let cancelled = false
  void loader.await().then(() => { if (!cancelled) start() }, () => {})
  return () => { cancelled = true }
}

/**
 * Track turn boundaries and, after a successful startup, resume what the last
 * process left unfinished.
 * @param ctx - the host plugin context.
 * @param config - the deployment switch and sweep spacing.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const home = ctx.get('dshHomePath') as HomePath | undefined
  if (home === undefined) {
    ctx.logger.warn('resume-sessions: this composition has no Harness home path; tracking nothing')
    return
  }
  const store = new ActiveStore(home('resume.db'))
  ctx.effect(() => () => store.close(), 'resume-sessions: close the in-progress store')

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      if (session.header.origin !== 'subagent') reportWrite(ctx, store.keep(session.id))
      return
    }
    if (event.type !== 'turn/end' || interruptedByShutdown(event.data.reason)) return
    reportWrite(ctx, store.drop(session.id))
  })
  if (!resolved.enabled) return
  const lifetime = new AbortController()
  let started: Promise<void> | undefined
  const start = (): void => {
    started = sweep(ctx, store, resolved.delayMs, lifetime.signal).catch((error: unknown) => {
      ctx.logger.warn(`resume-sessions: boot sweep failed: ${renderThrown(error)}`)
    })
  }
  ctx.effect(() => {
    const cancel = scheduleSweep(ctx, start)
    return async () => {
      cancel()
      lifetime.abort()
      await started
    }
  }, 'resume-sessions: boot sweep')
}
