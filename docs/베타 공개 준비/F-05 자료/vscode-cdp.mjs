// F-05 reference research: launch VS Code with the Claude Code extension in an
// isolated profile, attach over CDP, and measure the slash-command palette DOM.
//
// Usage: node vscode-cdp.mjs [--keep]
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('C:/Project/AgentPartyApp/package.json')
const WebSocket = require('ws')

const HERE = 'C:/Users/Dev/AppData/Local/Temp/claude/C--Project-AgentPartyApp/a679dd17-8b84-42fe-8493-dc685c510992/scratchpad/f05'
const PORT = 9333
const CODE = 'C:/Users/Dev/AppData/Local/Programs/Microsoft VS Code/Code.exe'
const EXTS = 'C:/Users/Dev/.vscode/extensions'
const UD = `${HERE}/vscode-profile`
const PROJ = 'C:/Project/AgentPartyApp'

const sleep = ms => new Promise(r => setTimeout(r, ms))
mkdirSync(`${HERE}/shots`, { recursive: true })

const child = spawn(CODE, [
  '--user-data-dir', UD,
  '--extensions-dir', EXTS,
  `--remote-debugging-port=${PORT}`,
  '--new-window',
  '--disable-workspace-trust',
  '--skip-release-notes',
  '--skip-welcome',
  PROJ,
], { detached: false, stdio: 'ignore' })

async function targets() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    return await r.json()
  } catch { return null }
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map() }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url, { maxPayload: 256 * 1024 * 1024 })
      this.ws.on('open', () => res())
      this.ws.on('error', rej)
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
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails))
    return r.result.value
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(file, Buffer.from(r.data, 'base64'))
    console.log('shot ->', file)
  }
  close() { try { this.ws.close() } catch {} }
}

;(async () => {
  console.log('waiting for CDP on', PORT)
  let list = null
  for (let i = 0; i < 90; i++) { list = await targets(); if (list && list.length) break; await sleep(1000) }
  if (!list) { console.error('no CDP'); process.exit(1) }
  console.log('targets:')
  for (const t of list) console.log(`  [${t.type}] ${t.title} :: ${t.url.slice(0, 110)}`)
  writeFileSync(`${HERE}/targets.json`, JSON.stringify(list, null, 2))
  console.log('\nVS Code left running on port', PORT, '- inspect further with vscode-probe.mjs')
})()
