// CDP verify helper: evaluate one expression on the first page target.
// Usage: node verify-cdp.mjs <expression> [port]
const port = process.argv[3] ?? '9222'
const expression = process.argv[2]
if (!expression) {
  console.error('usage: node verify-cdp.mjs <js-expression> [port]')
  process.exit(1)
}
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.error('no page target')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('cdp timeout')), 15000)
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }))
  })
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id !== 1) return
    clearTimeout(timer)
    resolve(msg)
    ws.close()
  })
  ws.addEventListener('error', () => {
    clearTimeout(timer)
    reject(new Error('cdp websocket error'))
  })
})
if (result.result?.exceptionDetails) {
  console.error('EXCEPTION:', JSON.stringify(result.result.exceptionDetails, null, 2))
  process.exit(1)
}
console.log(JSON.stringify(result.result?.result?.value ?? null, null, 2))
