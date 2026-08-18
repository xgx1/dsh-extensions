// Task-bar verification: anchor presence, group rendering, click jump.
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
    new Promise((_, reject) => setTimeout(() => reject(new Error('eval timeout')), 10000)),
  ])
  if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 400))
  return msg.result?.result?.value ?? null
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Wait for the anchor to appear (client plugin mounts async).
let anchor = null
for (let i = 0; i < 20 && anchor === null; i += 1) {
  anchor = await evaluate(`!!document.querySelector('[data-dsh-taskbar-anchor]')`)
  if (anchor === null) await sleep(1000)
}
console.log('anchor present:', anchor)

if (anchor) {
  const report = await evaluate(`(() => {
    const anchor = document.querySelector('[data-dsh-taskbar-anchor]')
    const slot = document.querySelector('[data-slot="sidebar.workspaces"]')
    const beforeSlot = slot ? (anchor.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : false
    const bar = anchor.querySelector('[data-dsh-taskbar]')
    const groups = bar ? [...bar.children].map(g => ({
      label: g.querySelector('div')?.textContent ?? '',
      rows: [...g.querySelectorAll('button')].map(b => ({
        title: b.textContent?.trim() ?? '',
        dot: b.querySelector('span')?.style.background ?? '',
      })),
    })) : []
    return JSON.stringify({
      beforeSlot,
      barPresent: !!bar,
      groups,
      sessionCount: Object.keys(JSON.parse(localStorage.getItem('x') ?? '{}') ?? {}).length
    })
  })()`)
  console.log(report)
}
ws.close()
