/**
 * dsh-task-manager 端到端冒烟工具（2026-11-26）：对一个**运行中**的 DSH web 实例
 * 跑 create → list → set-status(done) → delete 全链路，任一步不符预期就非零退出。
 *
 * 用法（不需要编译，Node 直接跑 TS）：
 *   node --experimental-strip-types tools/tm-e2e.ts [baseUrl]
 *   DSH_WEB_TOKEN=<token> node ...            # 默认读 ~/.dsh-dev/.web-token
 *
 * 只碰自己建的那张卡：失败时尽力删掉，不留下垃圾，也不动别人的任务。
 */
import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] ?? process.env['DSH_E2E_BASE'] ?? 'http://127.0.0.1:3081'
const TOKEN_FILE = process.env['DSH_E2E_TOKEN_FILE'] ?? join(homedir(), '.dsh-dev', '.web-token')

/** 断言的失败详情：把实际拿到的响应当证据打出来。 */
class Failed extends Error {}

/** 打印一步结果（成功的路径也要留痕，人看日志就知道走到哪了）。 */
function step(text: string): void {
  console.log(`  ✓ ${text}`)
}

/** 取 token：环境变量优先，否则读实例的 token 文件。 */
async function readToken(): Promise<string> {
  const env = process.env['DSH_WEB_TOKEN']
  if (env !== undefined && env !== '') return env
  try {
    return (await readFile(TOKEN_FILE, 'utf8')).trim()
  } catch {
    throw new Failed(`找不到 token：设 DSH_WEB_TOKEN，或把实例 token 放到 ${TOKEN_FILE}`)
  }
}

/** 用 ?token= 换会话 cookie；返回可直接放进请求头的 `name=value`。 */
async function login(token: string): Promise<string> {
  const res = await fetch(`${BASE}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const cookie = res.headers.get('set-cookie') ?? ''
  const pair = cookie.split(';')[0]?.trim() ?? ''
  if (pair === '') throw new Failed(`登录没拿到 cookie（${res.status}）；token 过期或实例不在 ${BASE}`)
  return pair
}

/** 带 cookie 调一个插件路由，返回解析后的 JSON。 */
async function call(cookie: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}/plugins/dsh-task-manager/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  if (res.status !== 200) throw new Failed(`${path} → ${res.status} ${text.slice(0, 300)}`)
  return { status: res.status, body: parsed }
}

/** 列表里的任务 id。 */
async function listIds(cookie: string): Promise<string[]> {
  const { body } = await call(cookie, 'state')
  const tasks = (body as { tasks?: Array<{ id?: unknown }> }).tasks ?? []
  return tasks.map((task) => (typeof task.id === 'string' ? task.id : '')).filter((id) => id !== '')
}

async function main(): Promise<void> {
  const cookie = await login(await readToken())
  step(`登录 ${BASE}`)

  const title = `e2e-${new Date().toISOString()}`
  const created = (await call(cookie, 'create', {
    title, content: '端到端冒烟：建一张卡走完整个链路，跑完自己删掉。', runMode: 'cwd', directory: tmpdir(),
  })).body as { id?: unknown; title?: unknown }
  const id = typeof created.id === 'string' ? created.id : ''
  if (id === '') throw new Failed(`create 没回任务 id：${JSON.stringify(created)}`)
  step(`create → ${id}`)

  let deleted = false
  try {
    if (!(await listIds(cookie)).includes(id)) throw new Failed(`list 里没有刚建的 ${id}`)
    step('list 能看到它')

    const done = (await call(cookie, 'set-status', { id, status: 'done' })).body as { status?: unknown }
    if (done.status !== 'done') throw new Failed(`set-status 没生效：${JSON.stringify(done)}`)
    step('set-status(done) 已生效')

    const removed = (await call(cookie, 'delete', { id })).body as { taskId?: unknown }
    deleted = true
    if (removed.taskId !== id) throw new Failed(`delete 回了别的东西：${JSON.stringify(removed)}`)
    if ((await listIds(cookie)).includes(id)) throw new Failed(`delete 之后 list 里还有 ${id}`)
    step('delete 之后列表里没有了')
  } finally {
    // 中途失败也要收拾干净；这一步自己失败不再掩盖真正的失败原因。
    if (!deleted) await call(cookie, 'delete', { id }).catch(() => undefined)
  }

  console.log('PASS 端到端链路通了')
}

main().catch((error: unknown) => {
  console.error('FAIL ' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
})
