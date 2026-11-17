/**
 * 执行座位登记（2026-11-17）：执行会话的 cwd 是它自己的任务 worktree，这样才能挂进
 * 对应的工作区；但工具可见性由 `agent-configs.yaml` 按 cwd 发放，新目录**必须先登记**
 * 再建会话，否则那个会话一个工具都没有。
 *
 * 这里只做两件事：把 worktree 路径写进 `<stateDir>/seats.json`，然后重跑生成器
 * （`~/.dsh/bin/agent-configs.py`，它读 tasks.json 与 seats.json，两个 home 一起写）。
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 生成器脚本（写两个 home 的 agent-configs.yaml）；不在就不动配置。 */
const GENERATOR = '/home/sx/.dsh/bin/agent-configs.py'

/** 登记一个执行座位目录，并让生成器把它写进白名单。 */
export async function registerExecSeat(stateDir: string, path: string): Promise<void> {
  try {
    const file = join(stateDir, 'seats.json')
    await mkdir(stateDir, { recursive: true })
    let list: string[] = []
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (Array.isArray(parsed)) list = parsed.filter((item): item is string => typeof item === 'string')
    } catch {
      list = []
    }
    // 只留还存在的目录，并给新路径留位置（避免无限增长）。
    const kept = list.filter((item) => existsSync(item) && item !== path).slice(-40)
    await writeFile(file, JSON.stringify([...kept, path], null, 0), 'utf8')
  } catch {
    // 登记失败最多是那个会话没工具，别让派单整体失败。
    return
  }
  if (!existsSync(GENERATOR)) return
  try {
    await run('python3', [GENERATOR], { timeout: 60_000 })
  } catch {
    // 生成器失败同样不阻断：会话照起，工具缺失由简报里的结论暴露。
  }
}
