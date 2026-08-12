// F-05 reference research: drive a TUI (claude / codex CLI) through a real pty,
// reconstruct the visible terminal grid, and dump it as text.
//
// Usage:
//   node tui-capture.mjs --cmd claude --cwd <dir> --cols 120 --rows 40 \
//        --step 8000 --key "/" --step 2500 --out shot1.txt \
//        --key "rev" --step 1500 --out shot2.txt
//
// Keys support escapes: \r \t \e , and named: <up> <down> <esc> <tab> <enter> <bs>
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const argv = process.argv.slice(2)
const opts = { cmd: null, cwd: process.cwd(), cols: 120, rows: 40, args: [] }
const steps = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const v = argv[i + 1]
  if (a === '--cmd') { opts.cmd = v; i++ }
  else if (a === '--cwd') { opts.cwd = v; i++ }
  else if (a === '--cols') { opts.cols = +v; i++ }
  else if (a === '--rows') { opts.rows = +v; i++ }
  else if (a === '--arg') { opts.args.push(v); i++ }
  else if (a === '--key') { steps.push({ type: 'key', value: v }); i++ }
  else if (a === '--step') { steps.push({ type: 'wait', value: +v }); i++ }
  else if (a === '--out') { steps.push({ type: 'out', value: v }); i++ }
}
if (!opts.cmd) { console.error('need --cmd'); process.exit(2) }

const NAMED = {
  '<up>': '[A', '<down>': '[B', '<right>': '[C', '<left>': '[D',
  '<esc>': '', '<tab>': '\t', '<enter>': '\r', '<bs>': '',
  '<c-n>': '', '<c-p>': '', '<c-c>': '',
}
function decodeKeys(s) {
  let out = s
  for (const [k, v] of Object.entries(NAMED)) out = out.split(k).join(v)
  return out.replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\e/g, '').replace(/\\n/g, '\n')
}

// ---- minimal VT screen model: enough for layout truth (CUP/ED/EL/cursor moves/wrap) ----
class Screen {
  constructor(cols, rows) {
    this.cols = cols; this.rows = rows
    this.buf = Array.from({ length: rows }, () => Array(cols).fill(' '))
    this.x = 0; this.y = 0
  }
  clampY() { if (this.y < 0) this.y = 0; if (this.y >= this.rows) { const over = this.y - this.rows + 1; this.buf.splice(0, over); for (let i = 0; i < over; i++) this.buf.push(Array(this.cols).fill(' ')); this.y = this.rows - 1 } }
  put(ch) {
    if (this.x >= this.cols) { this.x = 0; this.y++; this.clampY() }
    this.clampY()
    this.buf[this.y][this.x] = ch
    // account for wide (CJK/emoji) cells so columns stay aligned
    const w = wcwidth(ch)
    this.x += 1
    if (w === 2) { if (this.x < this.cols) this.buf[this.y][this.x] = '' ; this.x += 1 }
  }
  eraseLine(mode) {
    const row = this.buf[this.y]; if (!row) return
    if (mode === 0) for (let i = this.x; i < this.cols; i++) row[i] = ' '
    else if (mode === 1) for (let i = 0; i <= this.x && i < this.cols; i++) row[i] = ' '
    else row.fill(' ')
  }
  eraseDisplay(mode) {
    if (mode === 2 || mode === 3) { this.buf = Array.from({ length: this.rows }, () => Array(this.cols).fill(' ')); this.x = 0; this.y = 0; return }
    if (mode === 0) { this.eraseLine(0); for (let r = this.y + 1; r < this.rows; r++) this.buf[r].fill(' ') }
    else { this.eraseLine(1); for (let r = 0; r < this.y; r++) this.buf[r].fill(' ') }
  }
  toText() {
    return this.buf.map(r => r.join('').replace(/\s+$/, '')).join('\n').replace(/\n+$/, '\n')
  }
}
function wcwidth(ch) {
  const c = ch.codePointAt(0)
  if (c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
    (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1f64f) || (c >= 0x1f900 && c <= 0x1f9ff) ||
    (c >= 0x20000 && c <= 0x3fffd))) return 2
  return 1
}

const screen = new Screen(opts.cols, opts.rows)
let pending = ''
function feed(chunk) {
  const s = pending + chunk; pending = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '') {
      const m = /^(\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)|[@-Z\\-_]|P[\s\S]*?\\)/.exec(s.slice(i))
      if (!m) { pending = s.slice(i); return }
      handleEsc(m[1]); i += m[0].length; continue
    }
    if (ch === '\r') { screen.x = 0; i++; continue }
    if (ch === '\n') { screen.y++; screen.clampY(); i++; continue }
    if (ch === '\b') { screen.x = Math.max(0, screen.x - 1); i++; continue }
    if (ch === '\t') { screen.x = Math.min(opts.cols - 1, (Math.floor(screen.x / 8) + 1) * 8); i++; continue }
    if (ch < ' ') { i++; continue }
    screen.put(ch); i++
  }
}
function handleEsc(seq) {
  if (!seq.startsWith('[')) return
  const fin = seq[seq.length - 1]
  const body = seq.slice(1, -1).replace(/^\?/, '')
  const ps = body.split(';').map(x => (x === '' ? null : parseInt(x, 10)))
  const p0 = ps[0]
  switch (fin) {
    case 'H': case 'f': screen.y = (p0 ?? 1) - 1; screen.x = (ps[1] ?? 1) - 1; screen.clampY(); break
    case 'A': screen.y -= (p0 ?? 1); screen.clampY(); break
    case 'B': screen.y += (p0 ?? 1); screen.clampY(); break
    case 'C': screen.x = Math.min(opts.cols - 1, screen.x + (p0 ?? 1)); break
    case 'D': screen.x = Math.max(0, screen.x - (p0 ?? 1)); break
    case 'G': screen.x = (p0 ?? 1) - 1; break
    case 'd': screen.y = (p0 ?? 1) - 1; screen.clampY(); break
    case 'J': screen.eraseDisplay(p0 ?? 0); break
    case 'K': screen.eraseLine(p0 ?? 0); break
    case 'L': { const n = p0 ?? 1; for (let k = 0; k < n; k++) { screen.buf.splice(screen.y, 0, Array(opts.cols).fill(' ')); screen.buf.length = opts.rows } break }
    case 'M': { const n = p0 ?? 1; for (let k = 0; k < n; k++) { screen.buf.splice(screen.y, 1); screen.buf.push(Array(opts.cols).fill(' ')) } break }
    case 'X': { const n = p0 ?? 1; for (let k = 0; k < n && screen.x + k < opts.cols; k++) screen.buf[screen.y][screen.x + k] = ' ' ; break }
    default: break
  }
}

const winpty = 'C:\\Program Files\\Git\\usr\\bin\\winpty.exe'
const child = spawn(winpty, ['-Xallow-non-tty', opts.cmd, ...opts.args], {
  cwd: opts.cwd,
  env: { ...process.env, TERM: 'xterm-256color', COLUMNS: String(opts.cols), LINES: String(opts.rows), CI: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let raw = ''
child.stdout.on('data', d => { const t = d.toString('utf8'); raw += t; feed(t) })
child.stderr.on('data', d => process.stderr.write('[stderr] ' + d.toString()))
child.on('error', e => { console.error('spawn error', e.message); process.exit(1) })

const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  for (const st of steps) {
    if (st.type === 'wait') await sleep(st.value)
    else if (st.type === 'key') child.stdin.write(decodeKeys(st.value))
    else if (st.type === 'out') {
      const p = resolve(st.value)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, screen.toText(), 'utf8')
      writeFileSync(p.replace(/\.txt$/, '.raw'), raw, 'utf8')
      console.log('wrote ' + p)
    }
  }
  child.kill()
  await sleep(300)
  process.exit(0)
})()
