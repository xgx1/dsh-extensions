/**
 * 把任务台的执行交给 Super Agent（2026-11-17 用户选定方案 B）。
 *
 * 2026-11-22 融合修复：改走 super-agent 插件的进程内服务 `ctx.get('superAgent')`
 * （dispatch/snapshot），不再用 DSH_WEB_TOKEN 换 cookie 打 HTTP——生产实例每次启动
 * 随机 token，HTTP 自调用在结构上不可能成功，派单从未出过插件。
 * 服务缺席（没挂 super-agent）返回 undefined，调用方退回「自己起执行会话」。
 */

/** super-agent 插件 ctx.provide('superAgent') 的结构切片。 */
export interface SuperAgentService {
  dispatch(args: { title?: string; brief?: string; cwd?: string; model?: string }): Promise<{ workerId?: string; threadId?: string; blocked?: boolean } | undefined>
  snapshot(): { workers?: Array<{ id?: string; simulated?: boolean; status?: string; summary?: string }> }
}

/** 派一张单给 Super Agent；成功返回 worker 信息。模拟 Worker 不算融合，返回 undefined。 */
export async function dispatchToSuperAgent(
  service: SuperAgentService | undefined,
  request: { title: string; brief: string; cwd: string; model?: string },
): Promise<{ workerId: string; threadId?: string } | undefined> {
  if (service === undefined) return undefined
  try {
    const result = await service.dispatch({ title: request.title, brief: request.brief, cwd: request.cwd, ...(request.model === undefined ? {} : { model: request.model }) })
    const workerId = result?.workerId
    if (result?.blocked === true || workerId === undefined || workerId === '') return undefined
    // observe 模式/创建降级会开 simulated Worker：秒回「已修复」但一个文件都不写，必须识别出来。
    const worker = service.snapshot()?.workers?.find((item) => item.id === workerId)
    if (worker?.simulated === true) return undefined
    return { workerId, ...(result?.threadId === undefined ? {} : { threadId: result.threadId }) }
  } catch {
    return undefined
  }
}
