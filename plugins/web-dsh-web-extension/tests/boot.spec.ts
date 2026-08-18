import { describe, expect, it } from 'vitest'
import { LAYOUT_CSS, buildBootScript, injectBoot, STORAGE_KEY } from '../src/boot.ts'

describe('LAYOUT_CSS', () => {
  it('gates every rule on the extension markers', () => {
    const rules = LAYOUT_CSS.split('}').filter(chunk => chunk.includes('{'))
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule).toMatch(/html\[data-wde-(wide|left)\]/)
    }
  })

  it('carries the full-width content override', () => {
    expect(LAYOUT_CSS).toContain('--dsh-chat-content-width: 100%')
  })

  it('targets stable data attributes only, never hashed module classes', () => {
    const selectors = LAYOUT_CSS.match(/^[^{]+(?=\s*\{)/gm) ?? []
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) {
      expect(selector).not.toMatch(/^[a-z]+[A-Z]/)
      expect(selector).toMatch(/\[data-|html/)
    }
  })
})

describe('buildBootScript', () => {
  it('reads the shared storage key', () => {
    expect(buildBootScript()).toContain(STORAGE_KEY)
  })

  it('defaults to full width and left alignment when storage is empty', () => {
    const script = buildBootScript()
    expect(script).toContain("setAttribute('data-wde-wide', '')")
    expect(script).toContain("setAttribute('data-wde-left', '')")
  })
})

describe('injectBoot', () => {
  it('inserts the stylesheet into the head and the script after the body tag', () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div></body></html>'
    const out = injectBoot(html)
    expect(out.indexOf('<style data-plugin="web-dsh-web-extension">')).toBeLessThan(
      out.indexOf('<body>'),
    )
    expect(out.indexOf('<body>')).toBeLessThan(out.indexOf(buildBootScript()))
    expect(out).toContain('</html>')
  })

  it('appends both fragments when head and body are absent', () => {
    const out = injectBoot('<html></html>')
    expect(out.startsWith('<style data-plugin="web-dsh-web-extension">')).toBe(true)
    expect(out).toContain(buildBootScript())
  })
})
