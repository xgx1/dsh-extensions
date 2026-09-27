/**
 * Aggregation over the decision log, for the `/route stats` dashboard.
 *
 * The log is JSON Lines written by the plugin itself, one line per decided
 * turn. Reading is deliberately tolerant: a truncated last line (a process
 * killed mid-append) must not make the dashboard unusable.
 *
 * @module dsh-laya-router/stats
 */

/** One parsed decision line, narrowed to what the dashboard reports. */
interface DecisionLine {
  readonly time?: string
  readonly mode?: string
  readonly route?: { key?: string; basis?: string } | null
  readonly effort?: string
  readonly compaction?: { decided?: boolean; applied?: boolean }
  readonly response?: { latencyMs?: number }
  readonly state?: { elided?: number }
}

/** What the dashboard shows. */
export interface DecisionSummary {
  /** Lines that parsed as decisions. */
  readonly total: number
  /** Decisions that changed something (`mode: live`). */
  readonly live: number
  /** Decisions per route key, `(none)` for turns that changed nothing. */
  readonly byRoute: Record<string, number>
  /** Decisions per basis: what Laya judged versus the unlabeled fallback. */
  readonly byBasis: Record<string, number>
  /** Turns where compaction was decided, and where it actually ran. */
  readonly compacted: { readonly decided: number; readonly applied: number }
  /** Mean sidecar latency across decisions that reported one. */
  readonly meanLatencyMs?: number
  /** Timestamp of the newest parsed decision. */
  readonly lastAt?: string
  /** Turns whose decision state had to elide messages to fit the budget. */
  readonly elided: number
}

/**
 * Summarize the newest `limit` decision lines.
 *
 * @param lines - Raw JSONL text (an array of lines is also accepted).
 * @param limit - Keep only the newest N decisions; omitted means all of them.
 * @returns The aggregated summary; zeroed when nothing parses.
 */
export function summarize(lines: string | readonly string[], limit?: number): DecisionSummary {
  const all = typeof lines === 'string' ? lines.split('\n') : [...lines]
  const parsed: DecisionLine[] = []
  for (const line of all) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      parsed.push(JSON.parse(trimmed) as DecisionLine)
    } catch {
      // A truncated final line is expected after an abrupt stop; skip it.
    }
  }
  const window = limit === undefined ? parsed : parsed.slice(Math.max(0, parsed.length - limit))

  const byRoute: Record<string, number> = {}
  const byBasis: Record<string, number> = {}
  let live = 0
  let decided = 0
  let applied = 0
  let elided = 0
  let latencySum = 0
  let latencyCount = 0
  let lastAt: string | undefined

  for (const line of window) {
    if (line.mode === 'live') live += 1
    const key = line.route?.key ?? '(none)'
    byRoute[key] = (byRoute[key] ?? 0) + 1
    const basis = line.route?.basis ?? '(none)'
    byBasis[basis] = (byBasis[basis] ?? 0) + 1
    if (line.compaction?.decided === true) decided += 1
    if (line.compaction?.applied === true) applied += 1
    if ((line.state?.elided ?? 0) > 0) elided += 1
    const latency = line.response?.latencyMs
    if (typeof latency === 'number' && Number.isFinite(latency)) {
      latencySum += latency
      latencyCount += 1
    }
    if (typeof line.time === 'string') lastAt = line.time
  }

  return {
    total: window.length,
    live,
    byRoute,
    byBasis,
    compacted: { decided, applied },
    ...latencyCount === 0 ? {} : { meanLatencyMs: latencySum / latencyCount },
    ...lastAt === undefined ? {} : { lastAt },
    elided,
  }
}

/** Render a summary as the compact text a human command returns. */
export function formatSummary(summary: DecisionSummary, mode: string): string {
  const parts = [
    `laya-router mode=${mode} · ${summary.total} 条记录（其中 live ${summary.live}）`,
  ]
  const routes = Object.entries(summary.byRoute)
    .sort((left, right) => right[1] - left[1])
    .map(([key, count]) => `${key}×${count}`)
    .join(' ')
  if (routes.length > 0) parts.push(`路由：${routes}`)
  const bases = Object.entries(summary.byBasis)
    .map(([key, count]) => `${key}×${count}`)
    .join(' ')
  if (bases.length > 0) parts.push(`依据：${bases}`)
  parts.push(`压缩：判定 ${summary.compacted.decided} 次，执行 ${summary.compacted.applied} 次`)
  if (summary.meanLatencyMs !== undefined) parts.push(`平均判定耗时 ${summary.meanLatencyMs.toFixed(1)} ms`)
  if (summary.elided > 0) parts.push(`判断状态被裁剪过 ${summary.elided} 次`)
  if (summary.lastAt !== undefined) parts.push(`最后一条 ${summary.lastAt}`)
  return parts.join('\n')
}
