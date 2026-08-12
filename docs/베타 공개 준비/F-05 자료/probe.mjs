// Generic CDP probe against the already-running VS Code (port 9333).
//   node probe.mjs list                       -> list targets
//   node probe.mjs eval <idx> "<js>"          -> Runtime.evaluate in target idx
//   node probe.mjs shot <idx> out.png         -> screenshot target idx
//   node probe.mjs bounds <w> <h>             -> resize the browser window
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('C:/Project/AgentPartyApp/package.json')
const WebSocket = require('ws')
const PORT = 9333

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return await r.json()
}
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map() }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url, { maxPayload: 512 * 1024 * 1024, perMessageDeflate: false })
      this.ws.on('open', res); this.ws.on('error', rej)
      this.ws.on('message', d => {
        const m = JSON.parse(d.toString())
        if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id) }
      })
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, m => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)))
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}
const [cmd, ...rest] = process.argv.slice(2)
const list = await targets()

if (cmd === 'list') {
  list.forEach((t, i) => console.log(`${i}: [${t.type}] ${(t.title || '').slice(0, 70)}\n     ${t.url.slice(0, 150)}`))
  process.exit(0)
}
if (cmd === 'bounds') {
  const c = new CDP(list[0].webSocketDebuggerUrl); await c.connect()
  const { windowId } = await c.send('Browser.getWindowForTarget', { targetId: list[0].id })
  await c.send('Browser.setWindowBounds', { windowId, bounds: { left: 40, top: 40, width: +rest[0], height: +rest[1], windowState: 'normal' } })
  console.log('resized to', rest[0], rest[1]); process.exit(0)
}
const idx = +rest[0]
const t = list[idx]
if (!t) { console.error('no target', idx); process.exit(2) }
const c = new CDP(t.webSocketDebuggerUrl); await c.connect()

const KEYMAP = {
  ArrowDown: { windowsVirtualKeyCode: 40, code: 'ArrowDown' },
  ArrowUp: { windowsVirtualKeyCode: 38, code: 'ArrowUp' },
  ArrowLeft: { windowsVirtualKeyCode: 37, code: 'ArrowLeft' },
  ArrowRight: { windowsVirtualKeyCode: 39, code: 'ArrowRight' },
  Enter: { windowsVirtualKeyCode: 13, code: 'Enter', text: '\r' },
  Escape: { windowsVirtualKeyCode: 27, code: 'Escape' },
  Tab: { windowsVirtualKeyCode: 9, code: 'Tab', text: '\t' },
  Backspace: { windowsVirtualKeyCode: 8, code: 'Backspace' },
}
if (cmd === 'type') {
  // probe.mjs type <idx> "text"       -> insert literal text
  await c.send('Input.insertText', { text: rest[1] })
  console.log('typed')
} else if (cmd === 'key') {
  // probe.mjs key <idx> ArrowDown [count]
  const name = rest[1]
  const n = +(rest[2] || 1)
  const k = KEYMAP[name]
  if (!k) { console.error('unknown key', name); process.exit(2) }
  for (let i = 0; i < n; i++) {
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, ...k })
    if (k.text) await c.send('Input.dispatchKeyEvent', { type: 'char', key: name, text: k.text })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, ...k })
    await new Promise(r => setTimeout(r, 60))
  }
  console.log('key', name, 'x' + n)
} else if (cmd === 'eval') {
  const r = await c.send('Runtime.evaluate', { expression: rest[1], returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) { console.error('EXC:', r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)); process.exit(1) }
  const v = r.result.value
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
} else if (cmd === 'shot') {
  const clip = rest[2] ? (([x, y, w, h]) => ({ x: +x, y: +y, width: +w, height: +h, scale: 2 }))(rest[2].split(',')) : undefined
  const r = await c.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) })
  writeFileSync(rest[1], Buffer.from(r.data, 'base64'))
  console.log('wrote', rest[1])
}
process.exit(0)
