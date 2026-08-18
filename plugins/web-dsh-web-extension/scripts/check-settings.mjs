// Interactive settings-row verification with step-by-step progress output.
// Runs entirely from this file to avoid shell-quoting issues.
const port = process.argv[2] ?? '9222'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  const resolve = pending.get(msg.id)
  if (resolve) { pending.delete(msg.id); resolve(msg) }
})
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
async function evaluate(expression) {
  const id = ++seq
  const promise = new Promise((resolve) => pending.set(id, resolve))
  ws.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression, returnByValue: true, awaitPromise: true },
  }))
  const msg = await Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`eval timeout: ${expression.slice(0, 60)}`)), 10000)),
  ])
  if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 300))
  return msg.result?.result?.value ?? null
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const state = () => evaluate(`JSON.stringify({
  wide: document.documentElement.hasAttribute('data-wde-wide'),
  left: document.documentElement.hasAttribute('data-wde-left'),
  width: getComputedStyle(document.querySelector('[data-phase]')).getPropertyValue('--dsh-chat-content-width'),
  stored: localStorage.getItem('dsh-web-extension')
})`)

const rowExpr = `document.querySelector('[data-wde-row]')`

console.log('step 1 initial:', await state())

// Ensure the settings panel is open (refresh closes it).
console.log('step 1.5 open-settings:', await evaluate(`(() => {
  if (document.querySelector('[data-wde-row]')) return 'already-open'
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent ?? '').trim() === '设置')
  if (!b) return 'no-trigger'
  b.click(); return 'clicked'
})()`))
await sleep(1500)

// Open the align menu (second selector).
console.log('step 2 open-align:', await evaluate(`(() => {
  const row = ${rowExpr}; if (!row) return 'no-row'
  const bs = [...row.querySelectorAll('button')]; if (bs.length < 2) return 'buttons=' + bs.length
  bs[1].click(); return 'clicked'
})()`))
await sleep(1000)
console.log('step 3 menu dump:', await evaluate(`JSON.stringify({
  menus: [...document.querySelectorAll('[role="menu"], [role="listbox"], [class*="menu"]')].slice(-3).map(m => (m.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 100)),
  bodySnippet: document.body.textContent.includes('居中')
})`))

// Pick 居中 by scanning for a clickable element with that text.
console.log('step 4 pick-center:', await evaluate(`(() => {
  const el = [...document.querySelectorAll('button, [role="menuitem"], li, [class*="item"]')].filter(x => (x.textContent ?? '').trim() === '居中').pop()
  if (!el) return 'no-center-item'
  el.click(); return 'picked'
})()`))
await sleep(1000)
console.log('step 5 after-center:', await state())

// Open the width menu (first selector) and pick 标准.
console.log('step 6 open-width:', await evaluate(`(() => {
  const row = ${rowExpr}; if (!row) return 'no-row'
  const bs = [...row.querySelectorAll('button')]; if (bs.length < 2) return 'buttons=' + bs.length
  bs[0].click(); return 'clicked'
})()`))
await sleep(1000)
console.log('step 7 pick-standard:', await evaluate(`(() => {
  const el = [...document.querySelectorAll('button, [role="menuitem"], li, [class*="item"]')].filter(x => (x.textContent ?? '').trim() === '标准').pop()
  if (!el) return 'no-standard-item'
  el.click(); return 'picked'
})()`))
await sleep(1000)
console.log('step 8 after-standard:', await state())

// Restore both defaults.
await evaluate(`(() => { const row = ${rowExpr}; if (!row) return; [...row.querySelectorAll('button')][0]?.click() })()`)
await sleep(800)
await evaluate(`(() => { const el = [...document.querySelectorAll('button, [role="menuitem"], li, [class*="item"]')].filter(x => (x.textContent ?? '').trim() === '铺满').pop(); el?.click() })()`)
await sleep(800)
await evaluate(`(() => { const row = ${rowExpr}; if (!row) return; [...row.querySelectorAll('button')][1]?.click() })()`)
await sleep(800)
await evaluate(`(() => { const el = [...document.querySelectorAll('button, [role="menuitem"], li, [class*="item"]')].filter(x => (x.textContent ?? '').trim() === '左对齐').pop(); el?.click() })()`)
await sleep(1000)
console.log('step 9 restored:', await state())
ws.close()
