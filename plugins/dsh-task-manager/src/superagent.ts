/**
 * 把任务台的执行交给 Super Agent（2026-11-17 用户选定方案 B）。
 *
 * Super Agent 是另一套组件（Router + Worker、自带 watchdog 与投递），它有自己的
 * `POST /api/super-agent/command` 路由；命令是 `{command:'dispatch', args:{title, brief, cwd}}`，
 * 返回 `{workerId, threadId, queued}` —— Worker 就在 `cwd` 里干活。
 *
 * 宿主机内部的这次调用要过认证：本进程拿 `DSH_WEB_TOKEN` 换一次 cookie，再打接口。
 * 没有固定 token（例如生产实例还没启用）就返回 undefined，调用方退回"自己起执行会话"。
 */

/** 从命令行读出 web 端口（`dsh web --port 3081`）。 */
function webPort(): string {
  const index = process.argv.findIndex((arg) => arg === '--port')
  const fromArgs = index === -1 ? undefined : process.argv[index + 1]
  return fromArgs ?? process.env['DSH_WEB_PORT'] ?? '3080'
}

/** 用 DSH_WEB_TOKEN 换一个登录 cookie（`/?token=…` 会下发）。 */
async function authCookie(base: string, token: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
    const header = response.headers.getSetCookie?.() ?? []
    const cookies = header.map((item) => item.split(';')[0]).filter((item) => item.includes('='))
    return cookies.length === 0 ? undefined : cookies.join('; ')
  } catch {
    return undefined
  }
}

/** 读一次状态，看那个 Worker 是不是模拟出来的。 */
async function isSimulatedWorker(base: string, cookie: string, workerId: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/api/super-agent/state`, {
      headers: { cookie },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return false
    const body = (await response.json()) as { workers?: Array<{ id?: string; simulated?: boolean }> }
    const worker = (body.workers ?? []).find((item) => item.id === workerId)
    return worker?.simulated === true
  } catch {
    return false
  }
}

/** 派一张单给 Super Agent；成功返回 worker 信息。 */
export async function dispatchToSuperAgent(request: {
  title: string
  brief: string
  cwd: string
}): Promise<{ workerId: string; threadId?: string; simulated: boolean } | undefined> {
  const token = process.env['DSH_WEB_TOKEN']
  if (token === undefined || token === '') return undefined
  const base = `http://127.0.0.1:${webPort()}`
  const cookie = await authCookie(base, token)
  if (cookie === undefined) return undefined
  try {
    const response = await fetch(`${base}/api/super-agent/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        command: 'dispatch',
        args: { title: request.title, brief: request.brief, cwd: request.cwd },
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { ok?: boolean; result?: { workerId?: string; threadId?: string } }
    if (body.ok !== true || body.result?.workerId === undefined) return undefined
    // Super Agent 在 observe 模式（或没配真跑运行时）会开一个 **simulated** Worker：秒回"已修复"但
    // 一个文件都不写。这种要识别出来，否则卡片看起来有人干、实际什么都没发生。
    const workerId = body.result.workerId
    const simulated = await isSimulatedWorker(base, cookie, workerId)
    return { workerId, ...(body.result.threadId === undefined ? {} : { threadId: body.result.threadId }), simulated }
  } catch {
    return undefined
  }
}
