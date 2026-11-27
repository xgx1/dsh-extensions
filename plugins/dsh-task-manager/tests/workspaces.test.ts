/**
 * 大控制台工作区清单：用途取 .dsh/skills 的 SKILL.md description，退回标题；
 * 任务台自家座位与 /tmp、home 杂项过滤掉，免得误导路由。
 */
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectWorkspaceBriefs } from '../src/workspaces.ts'

describe('collectWorkspaceBriefs', () => {
  it('技能关键词优先、标题兜底，过滤自家座位与杂项', async () => {
    const root = await mkdtemp(join(tmpdir(), 'task-manager-ws-'))
    try {
      const nested = join(root, 'proj', '.dsh', 'skills', 'group', 'demo')
      const direct = join(root, 'proj2', '.dsh', 'skills', 'solo')
      await mkdir(nested, { recursive: true })
      await mkdir(direct, { recursive: true })
      await writeFile(join(nested, 'SKILL.md'), '---\nname: demo\ndescription: 演示技能。触发词：演示、demo\n---\n正文')
      await writeFile(join(direct, 'SKILL.md'), '---\nname: solo\ndescription:  solo 技能触发词  \n---\n正文')
      const stateDir = join(root, 'task-manager')
      const registry = {
        list: () => [
          { path: join(root, 'proj'), title: '演示项目' },
          { record: { path: join(root, 'proj2'), title: '二号项目' } },
          { path: join(root, 'bare'), title: '无技能项目' },
          { record: { path: join(stateDir, 'console'), title: '任务台·管理器' } },
          { path: join(stateDir, 'console-aaaaaaaa'), title: 'console-aaaaaaaa' },
          { path: '/tmp', title: 'tmp' },
          { path: process.env['HOME'] ?? '/home/sx', title: 'home' },
        ],
      }
      const briefs = await collectWorkspaceBriefs(registry, stateDir)
      expect(briefs.map((brief) => brief.path)).toEqual([join(root, 'proj'), join(root, 'proj2'), join(root, 'bare')])
      expect(briefs[0]?.purpose).toContain('演示')
      expect(briefs[1]?.purpose).toBe('solo 技能触发词')
      expect(briefs[2]?.purpose).toBe('无技能项目')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
