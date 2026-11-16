/**
 * dsh-task-manager — model-facing task tools (M2).
 *
 * Seven tools registered into the shared host tools registry; preset wiring
 * decides visibility (管理模式 gets all seven; the captain face drops the five
 * management tools via the per-child toolFilter, ADR-0003):
 * - Management: task_assign / task_create / task_set_status / task_list /
 *   task_nudge — names MUST stay identical to MANAGEMENT_TOOL_NAMES in
 *   orchestrator.ts (the captain toolFilter denies them by name).
 * - Captain: task_claim (read one's dispatched queue) / task_report (identity-
 *   checked write-back; the NOT_CAPTAIN line lives in the taskManager service).
 *
 * Identity comes from `exec.agent.id` — the calling agent's session id.
 * Definitions go through the real `defineTool` so argument validation is
 * registry-enforced.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { STATUSES, type Status } from './records.ts'
import { type TaskManagerService } from './orchestrator.ts'

/** Minimal structural view of the tool execution context (agent is optional). */
export interface ToolExec {
  agent?: { id: string }
}

/** Structural slice of the host tools registry this module registers into. */
export interface ToolsRegistrar {
  register(definition: unknown): () => void
}

const STATUS_ENUM = [...STATUSES]

/** Short display form of an id (first 8 chars). */
function short(id: string): string {
  return id.replace(/^session-/, '').slice(0, 8) || id.slice(0, 8)
}

/** Register the seven task tools. Pure dependency injection, no cordis types. */
export function registerTaskTools(
  registrar: ToolsRegistrar,
  service: TaskManagerService,
  effect: (factory: () => () => void, label?: string) => void,
): void {
  const register = (definition: object, label: string): void => {
    effect(() => registrar.register(definition), label)
  }

  // ── 两层管理器（ADR-0014）────────────────────────────────────────────────
  register(defineTool({
    name: 'task_console_state',
    description:
      '查任务台的管理器注册表：全局大管理器是哪个会话、每个项目（git 仓库根）的项目管理器是哪个会话、' +
      '以及各项目现有几张未关单的任务。路由或巡查前先用它看看现状。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          global: { type: 'string', description: '大管理器会话 id；尚未创建时缺失。' },
          projects: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                project: { type: 'string', required: true },
                sessionId: { type: 'string', required: true },
                open: { type: 'integer', required: true },
                sources: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const rows = (value.projects ?? []) as Array<{ project: string; sessionId: string; open: number; sources?: string[] }>
        const lines = [
          `大管理器：${value.global === undefined ? '未创建' : short(String(value.global))}`,
          ...(rows.length === 0
            ? ['项目管理器：还没有']
            : rows.map((row) => `- ${row.project}（${short(row.sessionId)}）未关单 ${row.open} 张；触发器：${(row.sources ?? []).length === 0 ? '无' : (row.sources ?? []).join('/')}`)),
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async () => {
      const state = await service.consoleState()
      const tasks = await service.list()
      const projects = Object.entries(state.projects ?? {}).map(([project, record]) => ({
        project,
        sessionId: record.sessionId,
        open: tasks.filter((task) => task.project === project && task.status !== 'done').length,
        sources: record.sources ?? [],
      }))
      return state.global === undefined ? { projects } : { global: state.global.sessionId, projects }
    },
  }), 'task-manager: task_console_state tool')

  register(defineTool({
    name: 'task_dispatch_project',
    description:
      '把一张任务派给某个项目的项目管理器：确保该项目的项目管理器会话存在（首次创建，之后复用），' +
      '建一张任务卡并把简报投给项目管理器。大管理器只做这一步；动手执行是项目管理器与执行会话的事。',
    parameters: {
      text: { type: 'string', required: true, description: '任务正文（用户的原始描述，不要改写需求）。' },
      project: { type: 'string', description: '项目主键：git 仓库根路径（绝对路径）。省略时从 cwd 探测。' },
      cwd: { type: 'string', description: '判断项目的目录提示；project 已给时可省略。' },
      title: { type: 'string', description: '短标题（40 字内）；省略时取正文首行。' },
      sources: {
        type: 'array',
        items: { type: 'string' },
        description: '本单订阅的触发器键（inbox / github / ci 等）；触发器配置本身挂在项目上。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: { type: 'string', required: true },
          managerSessionId: { type: 'string', required: true },
          taskId: { type: 'string', required: true },
          delivered: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已派给项目管理器：${value.project}（会话 ${short(String(value.managerSessionId))}，任务 ${String(value.taskId).slice(0, 8)}，投递 ${value.delivered === 'live' ? '在线' : '冷恢复'}）。`,
      }],
    },
    execute: async (args) => {
      const input: { project?: string; cwd?: string; text: string; title?: string; sources?: string[] } = {
        text: typeof args.text === 'string' ? args.text : '',
      }
      if (typeof args.project === 'string' && args.project !== '') input.project = args.project
      if (typeof args.cwd === 'string' && args.cwd !== '') input.cwd = args.cwd
      if (typeof args.title === 'string' && args.title !== '') input.title = args.title
      if (Array.isArray(args.sources)) input.sources = args.sources.filter((item: unknown): item is string => typeof item === 'string')
      return service.dispatchToProject(input)
    },
  }), 'task-manager: task_dispatch_project tool')

  register(defineTool({
    name: 'task_project_sources',
    description:
      '配置某个项目订阅的触发器（inbox / github / ci）。配置挂在项目上，任务卡只引用；' +
      '巡查时按这里列出的触发器检查有没有需要跟进的事件。',
    parameters: {
      project: { type: 'string', required: true, description: '项目主键：git 仓库根路径。' },
      sources: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '订阅的触发器键；传空数组表示取消订阅。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: { type: 'string', required: true },
          sources: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.project} 的触发器：${(value.sources ?? []).length === 0 ? '（无）' : (value.sources ?? []).join(' / ')}`,
      }],
    },
    execute: async (args) => {
      const sources = Array.isArray(args.sources)
        ? args.sources.filter((item: unknown): item is string => typeof item === 'string')
        : []
      const record = await service.setProjectSources(String(args.project), sources)
      return { project: String(args.project), sources: record.sources ?? [] }
    },
  }), 'task-manager: task_project_sources tool')

  register(defineTool({
    name: 'task_question',
    description:
      '在本任务卡上留一条待用户拍板的问题（不阻塞：你按推荐且保险的方式继续做别的）。' +
      '能自己决定的不要留问题，直接 task_next_step 记下来。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id。' },
      text: { type: 'string', required: true, description: '问题正文（一句话说清要用户定什么）。' },
      recommendation: { type: 'string', description: '你推荐的答案；用户点一下就能采纳。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          openQuestions: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `问题已落到任务卡（现 ${value.openQuestions} 条待答，状态 ${value.status}）。`,
      }],
    },
    execute: async (args) => {
      const task = await service.addQuestion(
        String(args.taskId),
        String(args.text),
        typeof args.recommendation === 'string' ? args.recommendation : undefined,
      )
      return {
        taskId: task.id,
        status: task.status,
        openQuestions: (task.questions ?? []).filter((item) => item.answer === undefined).length,
      }
    },
  }), 'task-manager: task_question tool')

  register(defineTool({
    name: 'task_next_step',
    description: '把一条已裁决的下一步动作记到任务卡上（你决定的和人决定的都记，写清是谁定的）。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id。' },
      text: { type: 'string', required: true, description: '下一步动作（动词开头，一句话）。' },
      decidedBy: { type: 'string', enum: ['project-manager', 'human'], description: '谁裁决的；默认 project-manager。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          nextSteps: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `下一步已记录（共 ${value.nextSteps} 条）。` }],
    },
    execute: async (args) => {
      const task = await service.addNextStep(
        String(args.taskId),
        String(args.text),
        args.decidedBy === 'human' ? 'human' : 'project-manager',
      )
      return { taskId: task.id, nextSteps: (task.nextSteps ?? []).length }
    },
  }), 'task-manager: task_next_step tool')

  register(defineTool({
    name: 'task_start_execution',
    description:
      '为这张任务卡起一个执行会话（项目目录里的普通会话），投开工简报并把卡片转 in-progress。' +
      '允许清单 v0.1：只产 patch，不 push、不开 PR、不碰受保护分支、不跨仓库。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id。' },
      agentPreset: { type: 'string', description: '执行会话的预设 id；省略用 standard。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `执行会话已起：${short(String(value.sessionId))}，卡片状态 ${value.status}。`,
      }],
    },
    execute: async (args) => {
      const preset = typeof args.agentPreset === 'string' && args.agentPreset !== '' ? args.agentPreset : undefined
      return service.startExecution(String(args.taskId), preset === undefined ? {} : { agentPreset: preset })
    },
  }), 'task-manager: task_start_execution tool')

  register(defineTool({
    name: 'task_assign',
    description:
      '把清单中的一个任务派发给某类别的队长。新类别会自动创建常驻队长子会话（首条消息=类别章程+任务简报）；' +
      '已有类别复用同一队长会话并投递任务简报（派发轮次+1，任务状态转为 in-progress）。',
    parameters: {
      taskId: { type: 'string', required: true, description: '要派发的任务 id（task_list 可查）。' },
      category: { type: 'string', required: true, description: '队长类别（动态划定，如 research/implementation）。' },
      charter: { type: 'string', description: '新类别的类别章程全文；仅在创建新队长会话时生效，已有队长忽略。' },
      managerSessionId: { type: 'string', description: '缺省用你自己的会话身份作为派发父会话；一般无需填写。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          category: { type: 'string', required: true },
          captainSessionId: { type: 'string', required: true },
          dispatchRound: { type: 'integer', required: true },
          created: { type: 'boolean', required: true },
          charter: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已派发：任务 ${value.taskId} → 队长·${value.category}（会话 ${short(String(value.captainSessionId))}，第 ${value.dispatchRound} 轮，${value.created === true ? '新建队长' : '复用队长'}）。队长将收到任务简报${value.created === true ? '与类别章程' : ''}。`,
      }],
    },
    execute: async (args, exec) => {
      const managerSessionId = typeof args.managerSessionId === 'string' && args.managerSessionId !== ''
        ? args.managerSessionId
        : exec.agent?.id
      return service.assign(args.taskId, args.category, {
        ...(args.charter !== undefined ? { charter: args.charter } : {}),
        ...(managerSessionId !== undefined ? { managerSessionId } : {}),
      })
    },
  }), 'task-manager: task_assign tool')

  register(defineTool({
    name: 'task_create',
    description:
      '在任务清单中新建一个任务（cwd 模式）。worktree 流程请用 GUI 建单；「需终审」的任务在队长回报 done 时会停在 waiting-check，等你（或用户）显式关单。',
    parameters: {
      content: { type: 'string', required: true, description: '任务需求正文（多行可含验收标准）。' },
      title: { type: 'string', description: '标题；缺省取正文第一行前 60 字。' },
      directory: { type: 'string', description: '任务目录；缺省当前会话工作目录。' },
      needsFinalReview: { type: 'boolean', description: '是否需用户终审后才能关单；缺省 false。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: STATUS_ENUM },
          directory: { type: 'string', required: true },
          needsFinalReview: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已建单：「${value.title}」（${short(String(value.id))}）状态 not-started${value.needsFinalReview === true ? '，需终审' : ''}。用 task_assign 派发给队长。`,
      }],
    },
    execute: async (args) =>
      service.create({
        content: args.content,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.directory !== undefined ? { directory: args.directory } : {}),
        ...(args.needsFinalReview !== undefined ? { needsFinalReview: args.needsFinalReview } : {}),
      }),
  }), 'task-manager: task_create tool')

  register(defineTool({
    name: 'task_set_status',
    description:
      '改任务状态（6 状态词表）。这是形式核验后的关单（done）与打回（problem）通道：需终审任务经此显式关单不受终审钳制；队长的 done 回报请先做形式核验再关单。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id。' },
      status: { type: 'string', required: true, enum: STATUS_ENUM, description: 'not-started|in-progress|waiting-reply|problem|waiting-check|done。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: STATUS_ENUM },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `任务「${value.title}」状态 → ${value.status}。`,
      }],
    },
    execute: async (args) => {
      const task = await service.setStatus(args.taskId, args.status as Status)
      return { id: task.id, title: task.title, status: task.status }
    },
  }), 'task-manager: task_set_status tool')

  register(defineTool({
    name: 'task_list',
    description: '列出任务清单（可按类别/状态过滤，最近更新在前）。派发前用查 taskId，巡检时用看回报。',
    parameters: {
      category: { type: 'string', description: '只列该队长类别的任务。' },
      status: { type: 'string', enum: STATUS_ENUM, description: '只列该状态的任务。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: STATUS_ENUM },
                category: { type: 'string' },
                captainSessionId: { type: 'string' },
                dispatchRound: { type: 'integer', required: true },
                needsFinalReview: { type: 'boolean', required: true },
                reportText: { type: 'string' },
                directory: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = (value.tasks as Array<Record<string, unknown>>).map((task) => {
          const report = typeof task['reportText'] === 'string' && task['reportText'] !== ''
            ? `｜回报：${String(task['reportText']).slice(0, 80)}`
            : ''
          return `- [${task['status']}] ${task['title']}（${short(String(task['id']))}${task['category'] !== undefined ? `，${String(task['category'])}` : ''}，第 ${task['dispatchRound']} 轮${task['needsFinalReview'] === true ? '，需终审' : ''}）${report}`
        })
        return [{
          type: 'text',
          text: `共 ${value.total} 个任务${(value.tasks as unknown[]).length < value.total ? '（显示最近更新的前 50 个）' : ''}：\n${lines.join('\n') || '（无）'}`,
        }]
      },
    },
    execute: async (args) => {
      const tasks = await service.list({
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(args.status !== undefined ? { status: args.status as Status } : {}),
      })
      return {
        total: tasks.length,
        tasks: tasks.slice(0, 50).map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          ...(task.category !== undefined ? { category: task.category } : {}),
          ...(task.captainSessionId !== undefined ? { captainSessionId: task.captainSessionId } : {}),
          dispatchRound: task.dispatchRound,
          needsFinalReview: task.needsFinalReview,
          ...(task.report !== undefined ? { reportText: task.report.text } : {}),
          directory: task.directory,
        })),
      }
    },
  }), 'task-manager: task_list tool')

  register(defineTool({
    name: 'task_nudge',
    description: '催办一个已派发的任务：向其队长会话投递催办文本并记录催办时间。未派发的任务会被告知无法催办。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          lastNudgeAt: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已催办任务 ${short(String(value.taskId))}（队长会话收到催办文本）。`,
      }],
    },
    execute: async (args, exec) =>
      service.nudge(args.taskId, ...(exec.agent?.id !== undefined ? [{ managerSessionId: exec.agent.id }] : [])),
  }), 'task-manager: task_nudge tool')

  register(defineTool({
    name: 'task_claim',
    description: '领取派发给本会话的任务：列出所有 captainSessionId 等于本会话的任务（即你的工作队列）。开工前先领取，完成后用 task_report 回报。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: STATUS_ENUM },
                content: { type: 'string', required: true },
                directory: { type: 'string', required: true },
                needsFinalReview: { type: 'boolean', required: true },
                dispatchRound: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const tasks = value.tasks as Array<Record<string, unknown>>
        if (tasks.length === 0) return [{ type: 'text', text: '你名下暂无派发任务；等待 Manager 派发（task_assign）。' }]
        const lines = tasks.map((task) =>
          `- [${task['status']}] ${task['title']}（${short(String(task['id']))}${task['needsFinalReview'] === true ? '，需终审' : ''}）\n  目录：${task['directory']}\n  需求：${String(task['content']).slice(0, 200)}`)
        return [{
          type: 'text',
          text: `你名下 ${tasks.length} 个派发任务：\n${lines.join('\n')}\n\n开工后完成或受阻时务必 task_report 回报（状态 + 报告 + 证据路径）。`,
        }]
      },
    },
    execute: async (_args, exec) => {
      if (exec.agent?.id === undefined) {
        // The dispatch queue is per-agent identity; a non-agent caller has no
        // owning session to claim for.
        throw new Error('task_claim requires an owning agent session')
      }
      return { tasks: (await service.listMine(exec.agent.id)).map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        content: task.content,
        directory: task.directory,
        needsFinalReview: task.needsFinalReview,
        dispatchRound: task.dispatchRound,
      })) }
    },
  }), 'task-manager: task_claim tool')

  register(defineTool({
    name: 'task_report',
    description:
      '队长回报：把状态+报告+证据路径写回一个派发给本会话的任务。完成用 waiting-check（或 done）；受阻用 problem。缺证据的完成回报会被打回。只能回报派发给自己的任务。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id（task_claim 可查）。' },
      status: { type: 'string', required: true, enum: STATUS_ENUM, description: '回报状态；需终审任务的 done 会被停在 waiting-check 等用户终审。' },
      text: { type: 'string', required: true, description: '报告正文：做了什么、结论、遗留。' },
      evidence: { type: 'array', description: '证据路径/引用列表（文件、命令输出等），供形式核验。', items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: STATUS_ENUM },
          evidenceCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `回报已记录：任务「${value.title}」→ ${value.status}（证据 ${value.evidenceCount} 项）。等待 Manager 形式核验${value.status === 'waiting-check' ? '；需终审任务将等用户终审' : ''}。`,
      }],
    },
    execute: async (args, exec) => {
      if (exec.agent?.id === undefined) {
        // The identity line (ADR-0003): reports must carry the calling
        // captain's session id for the service-side ownership check.
        throw new Error('task_report requires an owning agent session')
      }
      const task = await service.report(exec.agent.id, args.taskId, args.status as Status, args.text, args.evidence)
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        evidenceCount: task.report?.evidence?.length ?? 0,
      }
    },
  }), 'task-manager: task_report tool')
}
