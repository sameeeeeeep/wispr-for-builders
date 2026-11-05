// wispr-bridge — the ultralight harness every "made for Wispr" pack mod uses. Unofficial.
// See ../API.md. Zero dependencies: Node 18+ built-ins only.
//
//   import { present, notify, progress, classify, route, ask } from '~/.wispr-bridge/lib/bridge.mjs'

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)))
export const PKG_ROOT = dirname(HERE)
export const HOME_DIR = process.env.WISPR_BRIDGE_HOME || join(homedir(), '.wispr-bridge')
const HELPER = process.env.WB_CARD || join(PKG_ROOT, 'helper', 'wb-card')
const INTENTS_FILE = join(HOME_DIR, 'intents.json')
const PROGRESS_DIR = join(HOME_DIR, 'progress')

export const INTENTS = ['file.find', 'wish.run', 'convert', 'review.note', 'guide', 'ask']

// ── process helper ──────────────────────────────────────────────────────────
function run(argv, { input, timeoutMs = 600_000, cwd, detached = false } = {}) {
  return new Promise((resolve) => {
    let out = '', err = ''
    let p
    try {
      p = spawn(argv[0], argv.slice(1), { cwd, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached })
    } catch (e) { return resolve({ code: 127, stdout: '', stderr: String(e) }) }
    const t = setTimeout(() => { try { p.kill('SIGTERM') } catch {} }, timeoutMs)
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => { clearTimeout(t); resolve({ code: 127, stdout: out, stderr: err + String(e) }) })
    p.on('close', (code) => { clearTimeout(t); resolve({ code, stdout: out, stderr: err }) })
    if (input != null) { p.stdin.end(input) }
  })
}

function lastJsonLine(s) {
  const lines = String(s || '').trim().split('\n').reverse()
  for (const l of lines) { try { return JSON.parse(l) } catch {} }
  return null
}

async function card(spec, timeoutS = 600) {
  if (!existsSync(HELPER)) throw Object.assign(new Error('wb-card helper missing: run build.sh'), { code: 3 })
  const r = await run([HELPER, JSON.stringify(spec)], { timeoutMs: (timeoutS + 15) * 1000 })
  if (r.code === 2) throw Object.assign(new Error(r.stderr.trim() || 'bad spec'), { code: 2 })
  return lastJsonLine(r.stdout)
}

// ── presenter ───────────────────────────────────────────────────────────────
export async function present(spec) {
  if (!spec || !spec.title || !Array.isArray(spec.options) || !spec.options.length) {
    throw Object.assign(new Error('present needs {title, options:[{label}]}'), { code: 2 })
  }
  const options = spec.options.slice(0, 9).map((o) =>
    typeof o === 'string' ? { label: o } : { label: String(o.label ?? ''), detail: o.detail, image: o.image })
  const timeout = spec.timeout ?? 540
  const r = await card({ ...spec, mode: 'present', options, timeout }, timeout)
  return r || { cancelled: true, reason: 'helper' }
}

export async function notify(text, { title, ttl = 3, wait = false, at } = {}) {
  const spec = { mode: 'notify', text: String(text), title, ttl, at }
  if (wait) { await card(spec, ttl + 5); return }
  // Fire and forget: the toast outlives the caller.
  if (!existsSync(HELPER)) return
  const p = spawn(HELPER, [JSON.stringify(spec)], { stdio: 'ignore', detached: true })
  p.unref()
}

export async function progress(text, { id = 'default', done = false, title } = {}) {
  mkdirSync(PROGRESS_DIR, { recursive: true })
  const file = join(PROGRESS_DIR, id.replace(/[^\w.-]/g, '_') + '.json')
  const pidFile = file + '.pid'
  writeFileSync(file, JSON.stringify({ text: String(text ?? ''), title, done }))
  let alive = false
  try { const pid = Number(readFileSync(pidFile, 'utf8')); process.kill(pid, 0); alive = true } catch {}
  if (done) {
    if (!alive) rmSync(file, { force: true })
    return
  }
  if (!alive && existsSync(HELPER)) {
    const p = spawn(HELPER, [JSON.stringify({ mode: 'progress', id, file, title, text })], { stdio: 'ignore', detached: true })
    writeFileSync(pidFile, String(p.pid))
    p.unref()
  }
}

export async function ask({ placeholder, title, at } = {}) {
  const r = await card({ mode: 'ask', placeholder, title, at, timeout: 300 }, 300)
  return r && r.text ? r.text : null
}

// ── router ──────────────────────────────────────────────────────────────────
const CLASSIFY_PROMPT = (text) => `You are the router for "Wispr Bridge", a voice harness on a Mac. The user dictated a request.
Classify it into exactly one intent and extract args. Reply with ONE JSON object and nothing else (no prose, no code fence).

Intents:
- "file.find": find a file, folder, image, screenshot or document on this Mac. args: {"query": string, "kind"?: string (e.g. "image","pdf","keynote","video","folder"), "where"?: string, "when"?: string}
- "wish.run": make, build, fix, change or automate something; a task for a coding agent. args: {"wish": string, "project"?: string}
- "convert": convert, resize, compress, export or transcode a file. args: {"input"?: string, "to": string, "options"?: string}
- "review.note": a review comment or feedback on a page, design, screen or doc ("this button is too small"). args: {"note": string, "target"?: string, "severity"?: "nit"|"fix"|"blocker"}
- "guide": "how do I / show me where / walk me through" steps in an app. args: {"task": string, "app"?: string}
- "ask": a plain question, chit-chat, or anything else. args: {"question": string}

Shape: {"intent": "...", "args": {...}, "confidence": 0..1, "say": "<5-9 word present-tense status for the user, e.g. Looking for your Q3 deck>"}

Request: ${JSON.stringify(text)}`

function extractJson(s) {
  if (!s) return null
  try { return JSON.parse(s) } catch {}
  const m = String(s).match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  return null
}

function normalize(obj, text) {
  const fallback = { intent: 'ask', args: { question: text }, confidence: 0, say: 'Thinking about that' }
  if (!obj || typeof obj !== 'object' || !INTENTS.includes(obj.intent)) return fallback
  const args = obj.args && typeof obj.args === 'object' ? obj.args : {}
  const need = { 'file.find': 'query', 'wish.run': 'wish', convert: 'to', 'review.note': 'note', guide: 'task', ask: 'question' }[obj.intent]
  if (!args[need]) args[need] = text
  return {
    intent: obj.intent,
    args,
    confidence: typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5,
    say: typeof obj.say === 'string' && obj.say ? obj.say : '',
    text,
  }
}

// Fastest headless claude: no tools, no MCP, no plugins/hooks, no session file. Prompt goes on stdin.
// With ANTHROPIC_API_KEY set, --bare also skips OAuth/keychain and CLAUDE.md discovery.
function leanFlags(model) {
  const f = ['-p', '--model', model, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '']
  if (process.env.ANTHROPIC_API_KEY) f.push('--bare')
  return f
}

export async function classify(text) {
  text = String(text || '').trim()
  if (!text) throw Object.assign(new Error('classify needs text'), { code: 2 })
  const model = process.env.WISPR_BRIDGE_MODEL || 'haiku'
  const claude = process.env.WISPR_BRIDGE_CLAUDE || 'claude'
  const r = await run([claude, ...leanFlags(model), '--output-format', 'json'],
    { input: CLASSIFY_PROMPT(text), timeoutMs: 90_000, cwd: homedir() })
  let inner = null
  const outer = extractJson(r.stdout)
  if (outer && typeof outer.result === 'string') inner = extractJson(outer.result)
  else inner = outer
  const out = normalize(inner, text)
  if (r.code !== 0 && !inner) out.error = (r.stderr || r.stdout || '').trim().slice(0, 300)
  return out
}

// ── handlers ────────────────────────────────────────────────────────────────
export function handlers() {
  try { return JSON.parse(readFileSync(INTENTS_FILE, 'utf8')) } catch { return {} }
}
export function register(intent, argv) {
  if (!INTENTS.includes(intent)) throw Object.assign(new Error('unknown intent ' + intent), { code: 2 })
  mkdirSync(HOME_DIR, { recursive: true })
  const h = handlers(); h[intent] = argv
  writeFileSync(INTENTS_FILE, JSON.stringify(h, null, 2))
  return h
}
export function unregister(intent) {
  const h = handlers(); delete h[intent]
  mkdirSync(HOME_DIR, { recursive: true })
  writeFileSync(INTENTS_FILE, JSON.stringify(h, null, 2))
  return h
}

async function builtin(it) {
  const claude = process.env.WISPR_BRIDGE_CLAUDE || 'claude'
  if (it.intent === 'ask') {
    const r = await run([claude, ...leanFlags(process.env.WISPR_BRIDGE_MODEL || 'haiku')],
      { input: 'Answer in at most 2 short sentences, plain text: ' + it.args.question, timeoutMs: 120_000, cwd: homedir() })
    const a = r.stdout.trim() || 'No answer'
    await notify(a, { title: 'Answer', ttl: 8 })
    return { handler: 'builtin:ask', result: a }
  }
  if (it.intent === 'wish.run') {
    const cwd = it.args.project && existsSync(it.args.project) ? it.args.project : process.cwd()
    await progress('Working: ' + it.args.wish, { id: 'wish' })
    const r = await run([claude, '-p'], { input: it.args.wish, timeoutMs: 1_800_000, cwd })
    await progress('Done', { id: 'wish', done: true })
    const a = r.stdout.trim().split('\n').slice(-3).join(' ').slice(0, 240) || 'Finished'
    await notify(a, { title: 'Wish done', ttl: 6 })
    return { handler: 'builtin:wish.run', result: r.stdout.trim() }
  }
  return null
}

export async function route(text, { dryRun = false } = {}) {
  const it = await classify(text)
  if (dryRun) return { ...it, handler: null, result: null, dryRun: true }
  const argv = handlers()[it.intent]
  if (argv && argv.length) {
    if (it.say) notify(it.say, { ttl: 2 })
    const payload = JSON.stringify(it)
    const r = await run([...argv, payload], { input: payload, timeoutMs: 1_800_000 })
    const result = extractJson(r.stdout.trim()) ?? r.stdout.trim()
    return { ...it, handler: argv.join(' '), exit: r.code, result }
  }
  const b = await builtin(it)
  if (b) return { ...it, ...b }
  await notify(`No mod handles "${it.intent}" yet`, { title: it.say || 'Wispr Bridge', ttl: 4 })
  return { ...it, handler: null, result: null }
}

// ── install: stable paths any mod can call ──────────────────────────────────
export function installStable() {
  mkdirSync(join(HOME_DIR, 'bin'), { recursive: true })
  mkdirSync(join(HOME_DIR, 'lib'), { recursive: true })
  const links = [[join(PKG_ROOT, 'bin', 'wispr-bridge'), join(HOME_DIR, 'bin', 'wispr-bridge')],
    [join(PKG_ROOT, 'lib', 'bridge.mjs'), join(HOME_DIR, 'lib', 'bridge.mjs')]]
  for (const [src, dst] of links) {
    try { rmSync(dst, { force: true }) } catch {}
    try { symlinkSync(src, dst) } catch {}
  }
  return HOME_DIR
}
