// Wispr PM — task boards by voice. See ../README.md.
//
// Reuses, does not rebuild:
//   - the Switchboard board dialect + transforms (vendor/tasks.mjs is a verbatim copy of
//     relay/packages/bank-mcp/tasks.mjs: parseTasks / addTask / setStatus / completeTask)
//   - the Switchboard board itself (~/SwitchboardBrain/tasks.md) for projects that already live there
//     (#switchboard, #pptlive), filtered by their #tag
//   - Wispr Bridge (~/.wispr-bridge/lib/bridge.mjs) for every card, toast, pill and the ask field
//   - adhd-pm's rules for "split this": dedupe against the board, classify, prioritise, one recommended
//
// Never opens the microphone: text arrives from Wispr dictation (the bridge ask field, a CLI arg, the
// /pm command) or the clipboard when you say "this".

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTasks, addTask, setStatus } from '../vendor/tasks.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = dirname(HERE)
export const HOME = process.env.WISPR_PM_HOME || join(homedir(), '.wispr-pm')
const BOARDS = join(HOME, 'boards')
const THREADS_DIR = join(HOME, 'threads')
const PROJECTS_FILE = join(HOME, 'projects.json')
const STATE_FILE = join(HOME, 'state.json')
const THREADS_FILE = join(HOME, 'threads.json')
const SB_BOARD = process.env.WISPR_PM_SB_BOARD || join(homedir(), 'SwitchboardBrain', 'tasks.md')
const PROJECTS_ROOT = process.env.WISPR_PM_PROJECTS_ROOT || join(homedir(), 'Documents', 'Projects')
const BRIDGE_LIB = join(process.env.WISPR_BRIDGE_HOME || join(homedir(), '.wispr-bridge'), 'lib', 'bridge.mjs')
const CLAUDE = process.env.WISPR_PM_CLAUDE || 'claude'
const NOCARD = !!process.env.WISPR_PM_NOCARD   // tests / headless: never show a card, take the recommended

// ── tiny io ─────────────────────────────────────────────────────────────────
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }
const writeJson = (f, o) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(o, null, 2)) }
const norm = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, ' ').trim()
const slug = (s) => norm(s).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'inbox'
const shortId = () => Math.random().toString(36).slice(2, 6)

export function run(argv, { input, cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((res) => {
    let out = '', err = ''
    const p = spawn(argv[0], argv.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, timeoutMs)
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => { clearTimeout(t); res({ code: 127, stdout: out, stderr: String(e) }) })
    p.on('close', (code) => { clearTimeout(t); res({ code, stdout: out, stderr: err }) })
    if (input != null) p.stdin.end(input); else p.stdin.end()
  })
}

// ── bridge (cards, toasts, pill) — degrade to no-ops if it is not installed ──────────────────────
let _bridge
async function bridge() {
  if (_bridge !== undefined) return _bridge
  try { _bridge = existsSync(BRIDGE_LIB) ? await import(BRIDGE_LIB) : null } catch { _bridge = null }
  return _bridge
}
export async function present(spec) {
  const b = await bridge()
  if (NOCARD && spec.noAuto) return { cancelled: true, auto: true }   // never auto-run side effects headless
  if (NOCARD || !b) return { pick: spec.recommended || 1, label: spec.options[(spec.recommended || 1) - 1]?.label, auto: true }
  const { noAuto, ...rest } = spec
  return b.present({ at: 'notch', focus: false, timeout: Number(process.env.WISPR_PM_TIMEOUT) || 300, ...rest, title: spec.title.slice(0, 90) })
}
export async function notify(text, opts = {}) { if (NOCARD) return; const b = await bridge(); if (b) await b.notify(text, { title: 'wispr pm', ttl: 4, ...opts }) }
// The waiting pill: a status, not a loader (no spinner). Clicking it opens the list (`wispr-pm waiting`); × hides it.
const SELF_BIN = join(HOME, 'bin', 'wispr-pm')
async function pill(text, done = false) {
  if (NOCARD) return
  const b = await bridge(); if (!b) return
  await b.progress(text, { id: 'wispr-pm', title: 'Waiting on you', done, busy: false, closable: true, run: existsSync(SELF_BIN) ? [SELF_BIN, 'waiting'] : undefined })
}

// ── projects ────────────────────────────────────────────────────────────────
// Seeded once; edit ~/.wispr-pm/projects.json to add aliases. Any other folder under ~/Documents/Projects
// is picked up by name too, with a local board.
const SEED = {
  portfolio: { dir: join(PROJECTS_ROOT, 'portfolio'), aliases: ['portfolio', 'sameep.ai', 'sameep ai', 'site', 'wispr application', 'my portfolio'] },
  nailinit: { dir: join(PROJECTS_ROOT, 'nailinitpoint2'), aliases: ['nailinit', 'nail in it', 'nail it', 'nailin it', 'nail init'] },
  switchboard: { dir: join(PROJECTS_ROOT, 'relay'), tag: 'switchboard', aliases: ['switchboard', 'relay'] },
  pptlive: { dir: join(PROJECTS_ROOT, 'ppt'), tag: 'pptlive', aliases: ['ppt live', 'pptlive', 'ppt.live', 'ppt'] },
  'wispr-pack': { dir: join(PROJECTS_ROOT, 'relay', 'packages'), aliases: ['wispr pack', 'wispr for builders', 'the pack', 'mods'] },
}
export function projects({ write = true } = {}) {
  let p = readJson(PROJECTS_FILE, null)
  if (!p) { p = structuredClone(SEED); if (write) writeJson(PROJECTS_FILE, p) }
  return p
}
const state = () => readJson(STATE_FILE, {})
const setState = (patch) => writeJson(STATE_FILE, { ...state(), ...patch })

/** Find a project named anywhere in `text`. Returns {name, phrase} (phrase = the words to strip). */
export function findProject(text, { write = true } = {}) {
  const t = ' ' + norm(text) + ' '
  const ps = projects({ write })
  let best = null
  for (const [name, p] of Object.entries(ps)) {
    for (const a of [name, ...(p.aliases || [])]) {
      const na = norm(a)
      if (na && t.includes(' ' + na + ' ') && (!best || na.length > best.len)) best = { name, alias: a, len: na.length }
    }
  }
  if (!best) {
    // any folder under ~/Documents/Projects named in the text
    try {
      for (const d of readdirSync(PROJECTS_ROOT)) {
        const nd = norm(d)
        if ((nd.length >= 3 || /[^\x00-\x7f]/.test(nd)) && t.includes(' ' + nd + ' ') && statSync(join(PROJECTS_ROOT, d)).isDirectory() && (!best || nd.length > best.len)) best = { name: d, alias: d, len: nd.length, dir: join(PROJECTS_ROOT, d) }
      }
    } catch {}
  }
  if (!best) return null
  if (write && best.dir && !ps[best.name]) { ps[best.name] = { dir: best.dir, aliases: [best.name] }; writeJson(PROJECTS_FILE, ps) }
  return { name: best.name, alias: best.alias }
}
/** The project to use when none was said: the folder you're in, else the last one used. */
export function currentProject(cwd = process.cwd()) {
  const ps = projects()
  let hit = null
  for (const [name, p] of Object.entries(ps)) if (p.dir && (cwd === p.dir || cwd.startsWith(p.dir + '/')) && (!hit || p.dir.length > ps[hit].dir.length)) hit = name
  return hit || state().last || 'portfolio'
}

// ── boards ──────────────────────────────────────────────────────────────────
// A project with a `tag` that the Switchboard board already uses lives THERE (filtered by #tag);
// every other project gets ~/.wispr-pm/boards/<project>.md in the same dialect.
function boardOf(project) {
  const p = projects()[project] || {}
  if (p.tag && existsSync(SB_BOARD)) return { file: SB_BOARD, tag: p.tag, shared: true }
  return { file: join(BOARDS, slug(project) + '.md'), tag: null, shared: false }
}
const readDoc = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }

export function cards(project) {
  const b = boardOf(project)
  const all = parseTasks(readDoc(b.file), b.file)
  return all.filter((t) => !b.tag || t.proj === b.tag).map((t) => ({ ...t, project }))
}
export function allCards() {
  const seen = new Set(), out = []
  for (const name of Object.keys(projects())) {
    const b = boardOf(name); const key = b.file + '#' + (b.tag || '')
    if (seen.has(key)) continue; seen.add(key)
    if (existsSync(b.file)) out.push(...cards(name))
  }
  return out
}

export function park(project, text, opts = {}) {
  const b = boardOf(project)
  const doc = readDoc(b.file) || `# ${project} — tasks\n`
  const body = b.tag ? `${text} #${b.tag}` : text
  const r = addTask(body, { list: b.shared ? 'Voice inbox' : 'Board', status: opts.status || 'backlog', prio: opts.prio, detail: opts.detail }, doc)
  if (r.added) { mkdirSync(dirname(b.file), { recursive: true }); writeFileSync(b.file, r.doc) }
  setState({ last: project })
  return { project, board: b.file, added: r.added, reason: r.reason, title: text }
}

export function move(project, match, status) {
  const b = boardOf(project)
  const r = setStatus(match, status, readDoc(b.file))
  if (r.changed) writeFileSync(b.file, r.doc)
  return { project, ...r, doc: undefined }
}

/** Insert an indented detail line under the first card whose title matches. */
function addDetail(project, title, line) {
  const b = boardOf(project)
  const lines = readDoc(b.file).split('\n')
  const i = lines.findIndex((l) => /^\s*- \[[ xX]\] /.test(l) && l.includes(title))
  if (i < 0) return false
  const ind = (lines[i].match(/^(\s*)/)[1] || '') + '      '
  lines.splice(i + 1, 0, ind + line)
  writeFileSync(b.file, lines.join('\n'))
  return true
}

const PR = { high: 0, med: 1, low: 2 }
const COL = { doing: 0, todo: 1, backlog: 2, blocked: 3 }
export function nextUp(project, n = 4) {
  return cards(project)
    .filter((t) => t.col in COL)
    .sort((a, b) => (COL[a.col] - COL[b.col]) || ((PR[a.prio] ?? 3) - (PR[b.prio] ?? 3)) || String(a.due || '9').localeCompare(String(b.due || '9')) || a.line - b.line)
    .slice(0, n)
}
/** Waiting on you: cards in review (a thread finished / needs your eyes), plus anything tagged @me. */
export function waiting() {
  return allCards().filter((t) => !t.done && (t.col === 'review' || t.tag === 'me'))
}
/** Fuzzy-find an open card in a project by spoken words. */
export function findCard(project, words) {
  const w = norm(words).split(' ').filter((x) => x.length > 2 && !STOPW.has(x))
  if (!w.length) return null
  let best = null
  for (const t of cards(project).filter((c) => !c.done)) {
    const tt = norm(t.title)
    const hit = w.filter((x) => tt.includes(x)).length / w.length
    if (hit >= 0.6 && (!best || hit > best.hit)) best = { t, hit }
  }
  return best ? best.t : null
}
const STOPW = new Set(['the', 'for', 'and', 'this', 'that', 'thread', 'task', 'card', 'fix', 'with', 'into', 'from'])

// ── refresh the waiting-on-you pill at the notch ──────────────────────────────
// Collapsed it never cuts a title mid-sentence: just the count. The list has the details.
const SNOOZE_FILE = join(HOME, 'snooze.json')
export const snoozedUntil = () => Number(readJson(SNOOZE_FILE, {}).until) || 0
export function snooze(minutes = 60) { writeJson(SNOOZE_FILE, { until: Date.now() + minutes * 60_000 }); return { snoozedUntil: new Date(Date.now() + minutes * 60_000).toISOString() } }
export const pillText = (n) => `${n} waiting · tap to see`
export async function refreshNotch() {
  const w = waiting()
  if (!w.length || snoozedUntil() > Date.now()) { await pill('', true); return { waiting: w.length, snoozed: w.length > 0 } }
  await pill(pillText(w.length))
  return { waiting: w.length }
}
// "2h", "3d", "just now"
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso); if (!isFinite(t)) return null
  const m = Math.max(0, Math.round((now - t) / 60_000))
  return m < 1 ? 'just now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}
// a title shortened at a word, never mid-word
export function clip(s, n) { s = String(s || '').trim(); if (s.length <= n) return s; const c = s.slice(0, n - 1); return c.slice(0, Math.max(c.lastIndexOf(' '), n * 0.6)).trim() + '…' }
/** Each waiting card with its project, how long it has waited and what it needs from you. */
export function waitingItems(now = Date.now()) {
  const th = Object.values(readJson(THREADS_FILE, {}))
  return waiting().map((t) => {
    const thread = th.filter((x) => x.title === t.title && x.project === t.project).sort((a, b) => String(b.started).localeCompare(String(a.started)))[0]
    const needs = thread ? (thread.status === 'failed' ? 'the thread failed: check its log' : thread.status === 'running' ? 'a thread is still working on it' : 'review what the thread did')
      : t.tag === 'me' ? 'needs your input' : 'needs your review'
    const waited = thread ? ago(thread.ended || thread.started, now) : null
    return { card: t, thread, project: t.project, title: t.title, waited, needs }
  })
}

// ── Claude helpers ──────────────────────────────────────────────────────────
const LEAN = (model) => ['-p', '--model', model, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', ...(process.env.ANTHROPIC_API_KEY ? ['--bare'] : [])]
function extractJson(s) {
  try { return JSON.parse(s) } catch {}
  const m = String(s || '').match(/[[{][\s\S]*[\]}]/); if (m) { try { return JSON.parse(m[0]) } catch {} }
  return null
}
async function haiku(prompt, timeoutMs = 90_000) {
  const r = await run([CLAUDE, ...LEAN(process.env.WISPR_PM_MODEL || 'haiku')], { input: prompt, timeoutMs, cwd: homedir() })
  return extractJson(r.stdout)
}

/** adhd-pm style: brain-dump → deduped, classified, prioritised tasks. */
export async function splitDump(project, dump) {
  const existing = cards(project).filter((t) => !t.done).map((t) => t.title).slice(0, 60)
  const prompt = `You are a calm project manager for a fast-moving founder. Split this brain-dump into concrete board cards.
Rules: one card per distinct action; merge restatements; drop anything already on the board (listed below); start each title with a verb, max 9 words;
kind is one of task|bug|decision|research; prio high|med|low (high = blocks other work or is due soon); order by priority; at most 8 cards.
Reply with ONE JSON object only: {"cards":[{"title":"...","kind":"task","prio":"high","why":"<6 words>"}],"dropped":["<titles skipped as duplicates>"]}
Project: ${project}
Already on the board: ${JSON.stringify(existing)}
Brain-dump: ${JSON.stringify(dump)}`
  const j = await haiku(prompt)
  const list = (j && Array.isArray(j.cards) ? j.cards : []).filter((c) => c && c.title).slice(0, 8)
  return { cards: list, dropped: (j && j.dropped) || [] }
}

/** Fallback parser for phrasings the keyword router doesn't catch. */
async function llmParse(text) {
  const j = await haiku(`Parse a spoken task-board command. Reply ONE JSON object only:
{"op":"park|next|waiting|split|thread|done|board|other","project":"<project name or empty>","text":"<the task text, without the command words or project>"}
park = save/capture/remember an item for later; next = what to work on; waiting = what needs me / what's blocked on me;
split = break a dump into tasks; thread = start working on something with an agent; done = mark something finished; board = show the board.
Command: ${JSON.stringify(text)}`)
  return j && j.op ? j : { op: 'other', text }
}

// ── the voice router ──────────────────────────────────────────────────────────
const RX = [
  ['waiting', /^show me$|\b(show me (what'?s )?waiting|waiting (on|for) me|needs? me|on my plate|blocked on me|my (inbox|queue)|what do i need to (review|check|answer)|needs? my (eyes|review|input))\b/],
  ['next', /\b(what'?s|what is|whats) (next|up next)\b|\bnext (task|thing|up)\b|\bwhat should i (do|work on|pick up)\b|\bwhat now\b/],
  ['split', /^(please )?(split|break( up| down)?|chunk|turn)\b.*\b(tasks?|cards?|pieces|steps|down|up)\b|^(split|triage|pm) (this|that)\b|^brain ?dump\b/],
// park verbs at the very start win over a trailing "is done" or a thread phrase inside the task text
  ['park', /^(please )?(remind me to|don'?t let me forget to|park|capture|note|remember|log|save|stash|add|put|jot|todo|to do)\b/],
  ['thread', /\b(start|open|spin up|kick off|fire up|launch|spawn) (a |an |the )?(new )?(claude |agent |coding )?(thread|session|agent|claude)\b/],
  ['done', /^(mark|tick( off)?|close|check off|finish(ed)?|complete(d)?|done( with)?)\b|\b(is|it'?s) (done|finished|shipped)$/],
  ['board', /\b(show|open|list|read)( me)? (the |my )?(board|tasks|cards|backlog)\b/],
]
const CMD_STRIP = {
  park: /^(please )?(remind me to|don'?t let me forget to|park|capture|note( down)?|remember|log|save|stash|add|put|jot( down)?|todo|to do)( this| that| it)?( down)?( as a task| as a card| to the board| on the board| for later| for me)?[:,]?\s*/,
  split: /^(please )?(split|break( up| down)?|chunk|turn|triage|pm|brain ?dump)( this| that| it)?( up| down)?( into| in)?( tasks?| cards?| pieces| steps)?[:,]?\s*/,
  thread: /^.*?\b(thread|session|agent|claude)\b( for| on| to| about| and)?( the)?[:,]?\s*/,
  done: /^(mark|tick( off)?|close|check off|finish(ed)?|complete(d)?|done( with)?)( the)?\s*|\s*(as )?(is |it'?s )?(done|finished|complete|shipped)$/g,
}

function stripProject(text, proj) {
  if (!proj) return text
  // Match the alias the way findProject did (normalized words), so punctuation and non-ASCII names strip too:
  // "my weird proj (1)", "café", "sameep.ai". Lookarounds instead of \b, which is ASCII-only.
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const words = norm(proj.alias).split(' ').filter(Boolean)
  if (!words.length) return text
  const sep = '[^\\p{L}\\p{N}]+'
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])\\s*(?:(?:for|on|in|to|under|into|from|of)\\s+)?(?:the\\s+)?[^\\p{L}\\p{N}\\s]*${words.map(esc).join(sep)}[^\\p{L}\\p{N}\\s]*(?:\\s+(?:project|board))?(?=$|[^\\p{L}\\p{N}])`, 'iu')
  return text.replace(re, '$1 ').replace(/\s+/g, ' ').replace(/^[\s,:;]+|[\s,:;]+$/g, '').trim()
}
const isThis = (s) => /^(this|that|it|these|the above|what i (just )?(said|copied))?$/i.test(String(s || '').trim())
async function clipboard() { const r = await run(['pbpaste'], { timeoutMs: 3000 }); return r.stdout.trim() }

export function parse(text, { write = true } = {}) {
  const raw = String(text || '').trim().replace(/[.!?]+$/, '')
  const low = raw.toLowerCase()
  let op = null
  for (const [k, re] of RX) if (re.test(low)) { op = k; break }
  const proj = findProject(raw, { write })
  let rest = proj ? stripProject(raw, proj) : raw
  if (op && CMD_STRIP[op]) rest = rest.replace(CMD_STRIP[op], '').trim()
  return { op, project: proj ? proj.name : null, text: rest, raw }
}

/** Handle one spoken command end to end. Returns a JSON-able result. */
export async function say(text, { cwd } = {}) {
  let p = parse(text)
  if (!p.op) {
    const j = await llmParse(text)
    const proj = j.project ? findProject(j.project) : null
    p = { op: j.op === 'other' ? null : j.op, project: p.project || (proj && proj.name), text: j.text || p.text, raw: p.raw, via: 'llm' }
  }
  const project = p.project || currentProject(cwd)
  switch (p.op) {
    case 'park': return doPark(project, p.text)
    case 'next': return doNext(project)
    case 'waiting': return doWaiting()
    case 'split': return doSplit(project, p.text)
    case 'thread': return doThread(project, p.text)
    case 'done': return doDone(project, p.text)
    case 'board': return doNext(project, 9)
    default: return { op: 'none', text: p.raw, note: 'not a board command' }
  }
}

async function doPark(project, text) {
  if (isThis(text)) text = (await clipboard()).split('\n')[0].slice(0, 200)
  if (!text) { await notify('Nothing to park: say what, or copy it first'); return { op: 'park', added: false, reason: 'empty' } }
  const r = park(project, text)
  await notify(r.added ? `Parked on ${project}: ${text}` : `Already on ${project}: ${text}`)
  return { op: 'park', ...r }
}

async function doNext(project, n = 4) {
  const list = nextUp(project, n)
  setState({ last: project })
  if (!list.length) { await notify(`${project} board is empty. Say "park …" to add one.`); return { op: 'next', project, cards: [] } }
  const opt = (t) => ({ label: t.title.slice(0, 70), detail: [t.col, t.prio && 'prio ' + t.prio, t.due && 'due ' + t.due].filter(Boolean).join(' · ') })
  const r = await present({ title: `Next on ${project}`, subtitle: 'Pick one to act on, or esc', options: list.map(opt), recommended: 1 })
  const base = { op: 'next', project, cards: list.map((t) => ({ title: t.title, col: t.col, prio: t.prio || null })) }
  if (!r || !r.pick) return { ...base, picked: null, answer: r }
  const card = list[r.pick - 1]
  return { ...base, picked: card.title, action: await actOn(card) }
}

async function actOn(card) {
  const r = await present({
    title: card.title.slice(0, 80),
    subtitle: `${card.project} · ${card.col}`,
    options: [
      { label: 'Start a thread on it', detail: 'claude -p in the project, pings you when done' },
      { label: 'Mark done' },
      { label: 'Park it (backlog)' },
      { label: 'Mark doing' },
    ],
    recommended: 1,
    noAuto: true,
  })
  if (!r || !r.pick) return { action: 'none' }
  if (r.pick === 1) return startThread(card.project, card, { mode: 'bg' })
  const st = { 2: 'done', 3: 'backlog', 4: 'doing' }[r.pick]
  const m = move(card.project, card.id || card.title, st)
  await notify(`${card.title.slice(0, 40)} → ${st}`); await refreshNotch()
  return { action: st, changed: m.changed }
}

async function doWaiting() {
  const w = waiting()
  await refreshNotch()
  if (!w.length) { await notify('Nothing is waiting on you'); return { op: 'waiting', cards: [] } }
  const items = waitingItems().slice(0, 8)
  const opts = items.map((it) => ({ label: clip(it.title, 70), detail: [it.project, it.waited && `waited ${it.waited}`, it.needs].filter(Boolean).join(' · ') }))
  opts.push({ label: 'Snooze for an hour', detail: 'Hide the pill; it comes back with anything new after that' })
  const r = await present({ title: `${w.length} waiting on you`, subtitle: 'Pick one to open it, or say what to do', options: opts, recommended: 1 })
  const base = { op: 'waiting', cards: items.map((it) => ({ project: it.project, title: it.title, waited: it.waited, needs: it.needs })) }
  if (!r || !r.pick) return base
  if (r.pick === opts.length) { const z = snooze(60); await refreshNotch(); await notify('Snoozed for an hour'); return { ...base, ...z } }
  const card = items[r.pick - 1].card
  const th = items[r.pick - 1].thread
  if (th && existsSync(th.log) && !NOCARD) run(['open', '-e', th.log])   // open the thread's output to read
  return { ...base, picked: card.title, opened: th ? th.log : null, action: await actOn(card) }
}

async function doSplit(project, text) {
  // Clipboard only when you said "this" / nothing: never swap real dictated words for whatever is copied.
  if (isThis(text)) text = await clipboard()
  if (!text) { await notify('Nothing to split: dictate the dump, or copy it first'); return { op: 'split', added: [] } }
  await notify('Splitting into tasks…', { ttl: 2 })
  const s = await splitDump(project, text)
  if (!s.cards.length) { await notify('Found nothing new to add'); return { op: 'split', project, added: [], dropped: s.dropped } }
  const r = await present({
    title: `${s.cards.length} cards for ${project}. Keep which?`,
    subtitle: 'Toggle the ones to keep, then Enter.',
    options: s.cards.map((c) => ({ label: c.title, detail: `${c.kind || 'task'} · ${c.prio || 'med'}${c.why ? ' · ' + c.why : ''}` })),
    multi: true,
  })
  let picks = r && r.auto ? s.cards.map((_, i) => i + 1) : r && r.picks ? r.picks : r && r.pick ? [r.pick] : []
  if (r && r.text && /\b(all|every|yes|keep them)\b/i.test(r.text)) picks = s.cards.map((_, i) => i + 1)
  const added = []
  for (const i of picks) {
    const c = s.cards[i - 1]; if (!c) continue
    const x = park(project, c.title, { prio: c.prio, detail: c.kind && c.kind !== 'task' ? [`kind: ${c.kind}`] : undefined })
    if (x.added) added.push(c.title)
  }
  await notify(`Added ${added.length} to ${project}`)
  return { op: 'split', project, proposed: s.cards, dropped: s.dropped, added }
}

async function doThread(project, text) {
  let card = findCard(project, text)
  if (!card) {
    if (isThis(text) || !text) { await notify('Say what the thread is for'); return { op: 'thread', started: false } }
    park(project, text, { status: 'todo' })
    card = cards(project).find((t) => t.title.includes(text)) || { title: text, project, detail: [] }
  }
  const r = await present({
    title: `Start a thread: ${card.title.slice(0, 60)}`,
    subtitle: project,
    options: [
      { label: 'In the background', detail: 'claude -p, pings you when done' },
      { label: 'Open in Terminal', detail: 'an interactive Claude Code thread' },
    ],
    recommended: 1,
  })
  if (!r || !r.pick) return { op: 'thread', started: false, card: card.title }
  return { op: 'thread', ...(await startThread(project, card, { mode: r.pick === 2 ? 'terminal' : 'bg' })) }
}

function threadPrompt(project, card) {
  const det = (card.detail || []).map((d) => (d.sub ? `- [${d.done ? 'x' : ' '}] ` : '') + d.text).join('\n')
  return `You are a thread started by voice from Sameep's task board (project: ${project}).
Card: ${card.title}
${det ? 'Card notes:\n' + det + '\n' : ''}Do the card. Keep the change small and verify it. Do not git commit or push, and do not publish anything.
End with 3 short lines: what you did, how to check it, and anything that needs Sameep's call.`
}

export async function startThread(project, card, { mode = 'bg' } = {}) {
  const p = projects()[project] || {}
  const dir = p.dir && existsSync(p.dir) ? p.dir : homedir()
  const id = 't-' + shortId()
  mkdirSync(THREADS_DIR, { recursive: true })
  const log = join(THREADS_DIR, id + '.log')
  const promptFile = join(THREADS_DIR, id + '.prompt.txt')
  writeFileSync(promptFile, threadPrompt(project, card))
  move(project, card.id || card.title, 'doing')
  addDetail(project, card.title, `thread:${id} log:${log}`)
  const th = readJson(THREADS_FILE, {})
  th[id] = { id, project, title: card.title, dir, log, mode, started: new Date().toISOString(), status: 'running' }
  writeJson(THREADS_FILE, th)
  const self = join(PKG_ROOT, 'bin', 'wispr-pm')
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
  if (mode === 'terminal') {
    const cmd = `cd ${q(dir)} && ${CLAUDE} "$(cat ${q(promptFile)})"`
    await run(['osascript', '-e', `tell application "Terminal" to do script ${JSON.stringify(cmd)}`, '-e', 'tell application "Terminal" to activate'])
    await notify(`Thread opened in Terminal: ${card.title.slice(0, 40)}`)
  } else {
    const perm = process.env.WISPR_PM_PERMISSION || 'acceptEdits'
    const sh = `${CLAUDE} -p --permission-mode ${perm} < ${q(promptFile)} > ${q(log)} 2>&1; ${q(self)} thread-done ${id} $?`
    const child = spawn('/bin/sh', ['-c', sh], { cwd: dir, detached: true, stdio: 'ignore', env: { ...process.env, WISPR_PM_HOME: HOME } })
    child.unref()
    await notify(`Thread started: ${card.title.slice(0, 40)}`)
  }
  return { started: true, id, mode, project, card: card.title, dir, log }
}

/** Called by the background thread's shell when claude -p exits. Moves the card to review = waiting on you. */
export async function threadDone(id, code) {
  const th = readJson(THREADS_FILE, {})
  const t = th[id]; if (!t) return { id, found: false }
  t.status = Number(code) === 0 ? 'done' : 'failed'; t.ended = new Date().toISOString(); t.exit = Number(code)
  writeJson(THREADS_FILE, th)
  move(t.project, t.title, 'review')
  const tail = readDoc(t.log).trim().split('\n').slice(-3).join(' ').slice(0, 200)
  await notify(`${t.status === 'done' ? 'Thread done' : 'Thread failed'}: ${t.title.slice(0, 40)}. ${tail}`, { ttl: 8 })
  await refreshNotch()
  return { id, ...t }
}
export const threads = () => Object.values(readJson(THREADS_FILE, {}))

async function doDone(project, text) {
  const card = findCard(project, text)
  if (!card) { await notify(`No open card on ${project} matches "${text}"`); return { op: 'done', changed: false } }
  const m = move(project, card.id || card.title, 'done')
  await notify(`Done: ${card.title.slice(0, 50)}`); await refreshNotch()
  return { op: 'done', project, title: card.title, changed: m.changed }
}

// Bridge handler: the bridge calls `<cmd> <intent-json>`. Board phrasings are handled here; anything else
// goes to the handler that was registered before wispr-pm (kept in ~/.wispr-pm/chain.json).
export async function handleIntent(json) {
  let it = {}; try { it = JSON.parse(json) } catch {}
  const text = it.text || it.args?.wish || it.args?.question || ''
  const p = parse(text)
  if (p.op) return say(text)
  const chain = readJson(join(HOME, 'chain.json'), {})[it.intent]
  if (chain && chain.length) {
    const r = await run([...chain, json], { input: json, timeoutMs: 1_800_000 })
    return extractJson(r.stdout) ?? r.stdout.trim()
  }
  return { op: 'none', text }
}
export { basename }
