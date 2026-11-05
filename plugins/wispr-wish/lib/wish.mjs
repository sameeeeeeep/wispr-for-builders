// wispr-wish — made for Wispr (unofficial). Run conversions and tiny mini apps by voice.
//
//   wish("turn these PNGs into WebP")      -> converts the Finder selection next to the originals
//   wish("a timer for 25 min")             -> opens a small timer window, instantly (no model call)
//   wish("a dice roller for 2 dice")       -> claude -p writes a one-file HTML app, opened in a small window
//
// Voice arrives as text (Wispr types it). This mod never opens the microphone.
// Results come back through the Wispr Bridge card: present() / notify() / progress().
// Zero dependencies: Node 18+ built-ins plus the Mac's own sips, textutil, ffmpeg, whisper-cli, Chrome.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync, realpathSync, renameSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)))
export const PKG_ROOT = dirname(HERE)
export const HOME = process.env.WISPR_WISH_HOME || join(homedir(), '.wispr-wish')
const APPS_OUT = join(HOME, 'apps')
const BRIDGE_HOME = process.env.WISPR_BRIDGE_HOME || join(homedir(), '.wispr-bridge')
const QUIET = () => process.env.WISPR_WISH_QUIET === '1'   // tests: no cards, no windows

// ── bridge (soft dependency: works without it, just silently) ───────────────
let bridge = null
async function B() {
  if (bridge !== null) return bridge
  const cands = [process.env.WISPR_BRIDGE_LIB, join(BRIDGE_HOME, 'lib', 'bridge.mjs'),
    join(PKG_ROOT, '..', 'wispr-bridge', 'lib', 'bridge.mjs')].filter(Boolean)
  for (const c of cands) {
    if (existsSync(c)) { try { bridge = await import(pathToFileURL(c).href); return bridge } catch {} }
  }
  bridge = false
  return bridge
}
async function notify(text, opts = {}) { if (QUIET()) return log('notify', text); const b = await B(); if (b) await b.notify(text, opts) }
async function progress(text, opts = {}) { if (QUIET()) return; const b = await B(); if (b) await b.progress(text, { id: 'wish', ...opts }) }
async function present(spec) {
  if (QUIET()) { log('present', spec.title); return { cancelled: true, quiet: true } }
  const b = await B(); if (!b) return { cancelled: true, reason: 'no bridge' }
  return b.present({ at: 'notch', focus: false, timeout: 120, ...spec })
}
function log(...a) { if (process.env.WISPR_WISH_DEBUG) console.error('[wish]', ...a) }

// ── process helper ──────────────────────────────────────────────────────────
function run(argv, { input, timeoutMs = 900_000, cwd } = {}) {
  return new Promise((res) => {
    let out = '', err = ''
    let p
    try { p = spawn(argv[0], argv.slice(1), { cwd, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] }) }
    catch (e) { return res({ code: 127, stdout: '', stderr: String(e) }) }
    const t = setTimeout(() => { try { p.kill('SIGTERM') } catch {} }, timeoutMs)
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => { clearTimeout(t); res({ code: 127, stdout: out, stderr: err + String(e) }) })
    p.on('close', (code) => { clearTimeout(t); res({ code, stdout: out, stderr: err }) })
    if (input != null) { p.stdin.on('error', () => {}); p.stdin.end(input) }
  })
}
const which = (() => { const c = {}; return (bin) => {
  if (bin in c) return c[bin]
  const dirs = (process.env.PATH || '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/usr/sbin'])
  for (const d of dirs) { const f = join(d, bin); if (existsSync(f)) return (c[bin] = f) }
  return (c[bin] = null)
} })()
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'].find(existsSync) || null
const PDFJOIN = '/System/Library/Automator/Combine PDF Pages.action/Contents/MacOS/join'

// ── file kinds ──────────────────────────────────────────────────────────────
const KIND = {
  image: ['png', 'jpg', 'jpeg', 'heic', 'heif', 'webp', 'gif', 'tif', 'tiff', 'bmp', 'avif'],
  video: ['mov', 'mp4', 'm4v', 'webm', 'mkv', 'avi'],
  audio: ['mp3', 'm4a', 'wav', 'aac', 'aiff', 'aif', 'flac', 'ogg', 'opus', 'caf'],
  doc: ['docx', 'doc', 'rtf', 'rtfd', 'odt', 'txt', 'html', 'htm', 'md', 'markdown', 'webarchive', 'wordml'],
  pdf: ['pdf'],
}
export function kindOf(p) { const e = extname(p).slice(1).toLowerCase(); for (const [k, v] of Object.entries(KIND)) if (v.includes(e)) return k; return 'other' }

// ── parsing what was said (fast path: no model call) ────────────────────────
const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, 'twenty five': 25, 'twenty-five': 25, thirty: 30, forty: 40, 'forty five': 45, 'forty-five': 45, fifty: 50, sixty: 60, ninety: 90, a: 1, an: 1, half: 0.5 }
const numify = (s) => s.replace(/\b(twenty[ -]five|forty[ -]five|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety)\b/gi, (m) => String(NUMWORDS[m.toLowerCase()]))

const FORMAT_WORDS = {
  pdf: 'pdf', webp: 'webp', png: 'png', jpg: 'jpg', jpeg: 'jpg', heic: 'heic', tiff: 'tiff', tif: 'tiff', gif: 'gif', bmp: 'bmp',
  mp4: 'mp4', mov: 'mov', webm: 'webm', mp3: 'mp3', m4a: 'm4a', wav: 'wav', aac: 'm4a',
  docx: 'docx', word: 'docx', rtf: 'rtf', txt: 'txt', text: 'txt', html: 'html', markdown: 'md', md: 'md', srt: 'srt', subtitles: 'srt', captions: 'srt',
}

export function parseOptions(t) {
  const o = {}
  const mb = t.match(/(?:under|below|less than|max(?:imum)?|smaller than|<)\s*(\d+(?:\.\d+)?)\s*(mb|megs?|megabytes?|m\b|kb|k\b)/i)
  if (mb) o.maxMB = /^k/i.test(mb[2]) ? Number(mb[1]) / 1024 : Number(mb[1])
  const px = t.match(/(\d{2,5})\s*(?:px|pixels?|p\b|wide|width)/i)
  if (px) o.maxPx = Number(px[1])
  if (/\bhalf (the )?size\b|\bhalve\b/i.test(t)) o.scale = 0.5
  if (/\bquarter size\b/i.test(t)) o.scale = 0.25
  if (/\bwhats ?app\b/i.test(t)) { o.preset = 'whatsapp'; o.maxMB = o.maxMB || 15 }
  if (/\b(slack|discord|email|e-mail|mail)\b/i.test(t)) { o.preset = o.preset || 'share'; o.maxMB = o.maxMB || (/discord/i.test(t) ? 9.5 : 20) }
  if (/\bcompress|smaller|shrink|reduce|lighter|optimi[sz]e\b/i.test(t)) o.compress = true
  if (/\bmute|no audio|without (the )?(audio|sound)|remove (the )?(audio|sound)\b/i.test(t)) o.mute = true
  if (/\b(replace|overwrite)\b.*\b(originals?|them|it|files?)\b|\bin place\b|\b(delete|trash|remove|bin)\b.*\boriginals?\b/i.test(t)) o.replace = true
  return o
}

export function parseConvert(text) {
  const t = numify(' ' + text.toLowerCase() + ' ')
  const opts = parseOptions(t)
  if (/\btranscri(be|ption|pt)\b|\bspeech to text\b|\bwrite (out|down) what\b/.test(t)) {
    const to = /\b(srt|subtitles?|captions?)\b/.test(t) ? 'srt' : 'txt'
    return { kind: 'convert', to: 'transcript', fmt: to, options: opts }
  }
  if (/\b(gif)\b/.test(t) && /\b(make|turn|convert|into|to|as|export|save)\b/.test(t)) return { kind: 'convert', to: 'gif', options: opts }
  // "<verb> ... into/to/as (a|an) <format>"
  const FMT = '(pdf|webp|png|jpe?g|heic|tiff?|bmp|mp4|mov|webm|mp3|m4a|wav|aac|docx|word|rtf|txt|text|html|markdown|md)s?\\b'
  const targets = [...t.matchAll(new RegExp(`\\b(?:into|to|as|in)\\s+(?:a |an )?(?:\\.)?${FMT}`, 'g'))]
  const fm = targets.length ? targets[targets.length - 1]
    : t.match(new RegExp(`\\b(?:this|these|that|those|it|them)\\s+(?:into\\s+)?(?:a |an )?(?:\\.)?${FMT}`))
  const verb = /\b(make|turn|convert|change|export|save|compress|shrink|resize|reduce|transcode|render|extract|rip|get)\b/.test(t)
  if (fm && verb) return { kind: 'convert', to: FORMAT_WORDS[fm[1].replace(/s$/, '')] || fm[1], options: opts }
  if (/\bextract (the )?audio\b|\baudio only\b|\bjust the audio\b/.test(t)) return { kind: 'convert', to: 'm4a', options: opts }
  if ((opts.compress || opts.preset) && /\b(video|recording|clip|movie|mov|mp4|screen ?cap)\b/.test(t)) return { kind: 'convert', to: 'mp4', options: { ...opts, compress: true } }
  if ((opts.compress || opts.maxPx || opts.scale) && /\b(image|images|photo|photos|picture|pictures|screenshot|screenshots|png|pngs|jpg|jpgs)\b/.test(t)) return { kind: 'convert', to: 'same-image', options: opts }
  if (/\bresize\b/.test(t)) return { kind: 'convert', to: 'same-image', options: opts }
  if ((opts.compress || opts.preset) && /\b(this|these|it|them|file|files)\b/.test(t)) return { kind: 'convert', to: 'auto-compress', options: opts }
  return null
}

const APP_NOUNS = 'app|calculator|counter|converter|tracker|stopwatch|picker|generator|checklist|clock|quiz|game|randomi[sz]er|dice|coin|tally|scoreboard|metronome|breathing|flashcards?|wheel|spinner|palette|countdown|todo|to-do|notepad|scratchpad'
export function parseApp(text) {
  const t = numify(' ' + text.toLowerCase() + ' ')
  if (/\b(timer|countdown|pomodoro)\b/.test(t) && !/\bcountdown (app|page|site)\b.*\bfor (my|the) (site|website)\b/.test(t)) {
    let sec = 0
    const h = t.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\b/); if (h) sec += Number(h[1]) * 3600
    const m = t.match(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes?)\b/); if (m) sec += Number(m[1]) * 60
    const s = t.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b/); if (s) sec += Number(s[1])
    if (!sec && /\bhalf an? hour\b/.test(t)) sec = 1800
    if (!sec && /\bpomodoro\b/.test(t)) sec = 1500
    let unset = false
    if (!sec) { const n = t.match(/\b(\d+(?:\.\d+)?)\b/); sec = n ? Number(n[1]) * 60 : 0 }
    if (!sec) { sec = 600; unset = true }
    const lab = t.match(/\bfor (?:my |the |a )?([a-z][a-z ]{2,30}?)(?=\s+\d|\s+(?:for|of|in)\b|\s*$)/)
    let label = /pomodoro/.test(t) ? 'Focus' : ''
    if (lab && !/^\d|minute|hour|second/.test(lab[1].trim())) label = lab[1].trim().replace(/\b\w/g, (c) => c.toUpperCase())
    return { kind: 'app', app: 'timer', params: { minutes: Math.round(sec / 6) / 10, label }, ...(unset ? { noDuration: true } : {}) }
  }
  if (/\bsplit\b.*\b(bill|check|cheque|tab|dinner|lunch|cost|total|\d)/.test(t) || /\b(bill|tip) (split|splitter|calculator)\b/.test(t)) {
    const cur = (t.match(/[$₹€£]/) || [])[0] || (/\b(rupees?|rs\.?|inr)\b/.test(t) ? '₹' : /\b(dollars?|usd|bucks)\b/.test(t) ? '$' : /\b(euros?|eur)\b/.test(t) ? '€' : /\b(pounds?|gbp|quid)\b/.test(t) ? '£' : '')
    const ppl = t.match(/(\d+)\s*(?:people|persons|ways|of us|friends|guys)\b/) || t.match(/\bbetween (\d+)\b/) || t.match(/\bamong (\d+)\b/)
    const tip = t.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s*tip|tip (?:of )?(\d+(?:\.\d+)?)\s*(?:%|percent)/)
    let rest = t
    if (ppl) rest = rest.replace(ppl[0], ' ')
    if (tip) rest = rest.replace(tip[0], ' ')
    const amt = rest.match(/(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/)
    const amount = amt ? Number(amt[1].replace(/,/g, '')) * (amt[2] ? 1000 : 1) : 0
    return { kind: 'app', app: 'split', params: { amount, people: ppl ? Number(ppl[1]) : 2, tip: tip ? Number(tip[1] || tip[2]) : 0, currency: cur } }
  }
  if (/\b(qr|q r)\b/.test(t) && !/\b(library|libraries|package|sdk|api|npm|scanner|reader)\b/.test(t)) {
    const url = text.match(/https?:\/\/\S+|\b[\w-]+(?:\.[\w-]+)+\.(?:com|ai|io|dev|app|co|org|net|in|me|so|xyz|live)(?:\/\S*)?/i)
    return { kind: 'app', app: 'qr', params: { text: url ? url[0].replace(/[).,]+$/, '') : '' }, needsLink: !url }
  }
  const generic = new RegExp(`\\b(${APP_NOUNS})\\b`)
  if (generic.test(t) && /\b(a|an|me|make|build|give|open|show|need|want|quick|little|tiny|simple)\b/.test(t)
      && !/\b(repo|codebase|component|bug|deploy|pull request|pr|site|website|landing page|my project|this project)\b/.test(t)) {
    return { kind: 'app', app: 'gen', idea: text.trim() }
  }
  return null
}

// "how do I convert a docx to pdf", "what is the best QR library", "give me a summary of ..." are
// questions for Claude, not wishes. Requests phrased politely ("can you make this a PDF") still count.
const QUESTION = /^\s*(?:(?:so|ok(?:ay)?|hey|um+|and)[,\s]+)?(?:how|what(?:'s|s)?|which|why|who|where|when|is|are|was|were|does|do|did|should|would|whats|tell me|explain|give me (?:a |an |the )?(?:quick |short |brief )?(?:summary|overview|rundown|recap|list|idea|answer)|summari[sz]e|recommend|suggest|compare)\b/i
export function isQuestion(text) {
  const s = String(text || '').trim()
  if (/^\s*(?:can|could|will|would) you\b/i.test(s)) return false
  return QUESTION.test(s) || /\?\s*$/.test(s)
}

export function parse(text, { builtinOnly = false } = {}) {
  text = String(text || '').trim()
  if (!text || isQuestion(text)) return null
  const job = parseConvert(text) || parseApp(text)
  if (builtinOnly && job?.app === 'gen') return null
  return job
}

// ── inputs: explicit paths, Finder selection, wispr-file's last find, or a picker card ─
export async function finderSelection() { return (await finderSelectionInfo()).shown }
async function finderSelectionInfo() {
  // Finder keeps reporting the last selection even when no window shows it (another Space, hidden,
  // minimised, or closed days ago), so a selection only counts as "this" when it is on screen: Finder
  // is frontmost (desktop or window selection), or the selected items sit in a Finder window that
  // CoreGraphics reports as on screen right now.
  const script = `set out to ""
tell application "Finder"
  set sel to selection
  if (count of sel) is 0 then return ""
  set out to out & "FRONT" & tab & (frontmost as text) & linefeed
  repeat with w in (get every Finder window whose collapsed is false)
    try
      set b to bounds of w
      set out to out & "WIN" & tab & POSIX path of ((target of w) as alias) & tab & (item 1 of b) & "," & (item 2 of b) & "," & (item 3 of b) & "," & (item 4 of b) & linefeed
    end try
  end repeat
  repeat with f in sel
    try
      set out to out & "SEL" & tab & POSIX path of (f as alias) & tab & POSIX path of ((container of f) as alias) & linefeed
    end try
  end repeat
end tell
return out`
  const r = await run(['osascript', '-e', script], { timeoutMs: 8000 })
  const lines = r.stdout.split('\n').map((l) => l.split('\t'))
  const sel = lines.filter((l) => l[0] === 'SEL' && l[1] && existsSync(l[1]))
  if (!sel.length) return { shown: [], hidden: [] }
  if (lines.some((l) => l[0] === 'FRONT' && l[1] === 'true')) return { shown: sel.map((l) => l[1]), hidden: [] }
  const onScreen = await finderWindowsOnScreen()
  const shown = new Set(lines.filter((l) => l[0] === 'WIN').filter((l) => {
    const [x1, y1, x2, y2] = l[2].split(',').map(Number)
    return onScreen.some(([x, y, w, h]) => Math.abs(x - x1) < 3 && Math.abs(y - y1) < 3 && Math.abs(w - (x2 - x1)) < 3 && Math.abs(h - (y2 - y1)) < 3)
  }).map((l) => l[1]))
  const ok = sel.filter((l) => shown.has(l[2])).map((l) => l[1])
  return ok.length ? { shown: ok, hidden: [] } : { shown: [], hidden: sel.map((l) => l[1]) }
}
async function finderWindowsOnScreen() {
  const js = `ObjC.import('CoreGraphics');const a=ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly|$.kCGWindowListExcludeDesktopElements,0));const o=[];for(let i=0;i<a.count;i++){const d=a.objectAtIndex(i);if(ObjC.unwrap(d.objectForKey('kCGWindowOwnerName'))!=='Finder'||ObjC.unwrap(d.objectForKey('kCGWindowLayer'))!==0)continue;const b=d.objectForKey('kCGWindowBounds');o.push(['X','Y','Width','Height'].map(k=>ObjC.unwrap(b.objectForKey(k))).join(','))}o.join('\\n')`
  const r = await run(['osascript', '-l', 'JavaScript', '-e', js], { timeoutMs: 8000 })
  return r.stdout.split('\n').filter(Boolean).map((l) => l.split(',').map(Number))
}
function lastFound() {
  for (const f of [join(BRIDGE_HOME, 'last-found.json'), join(homedir(), '.wispr-file', 'last.json')]) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'))
      const st = statSync(f)
      if (Date.now() - st.mtimeMs > 15 * 60_000) continue        // only a find from the last 15 minutes counts as "this"
      const paths = Array.isArray(j) ? j : j.paths || (j.path ? [j.path] : j.picked ? [j.picked] : [])
      const ok = paths.map(String).filter(existsSync)
      if (ok.length) return ok
    } catch {}
  }
  return []
}
function recentFiles(kinds, n = 6) {
  const out = []
  for (const d of [join(homedir(), 'Desktop'), join(homedir(), 'Downloads'), join(homedir(), 'Movies')]) {
    let names = []; try { names = readdirSync(d) } catch { continue }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const p = join(d, name)
      if (!kinds.includes(kindOf(p))) continue
      try { const s = statSync(p); if (s.isFile()) out.push({ p, t: s.mtimeMs }) } catch {}
    }
  }
  return out.sort((a, b) => b.t - a.t).slice(0, n).map((x) => x.p)
}
function sourceKinds(job) {
  const to = job.to
  if (to === 'transcript') return ['audio', 'video']
  if (to === 'gif') return ['video', 'image']
  if (['mp4', 'mov', 'webm'].includes(to)) return ['video']
  if (['mp3', 'm4a', 'wav'].includes(to)) return ['audio', 'video']
  if (['webp', 'png', 'jpg', 'heic', 'tiff', 'bmp', 'same-image'].includes(to)) return ['image', 'pdf']
  if (to === 'pdf') return ['image', 'doc']
  if (['docx', 'rtf', 'txt', 'html', 'md'].includes(to)) return ['doc']
  return ['video', 'image', 'audio', 'doc', 'pdf']
}
async function resolveInputs(job, given = []) {
  let files = given.map((p) => resolve(String(p).replace(/^~(?=\/)/, homedir()))).filter(existsSync)
  let hidden = []
  if (!files.length) { const s = await finderSelectionInfo(); files = s.shown; hidden = s.hidden }
  if (!files.length) files = lastFound()
  const kinds = sourceKinds(job)
  hidden = hidden.filter((f) => kinds.includes(kindOf(f)))
  const fit = files.filter((f) => kinds.includes(kindOf(f)))
  if (files.length && !fit.length) {
    throw new Error(`The selection (${basename(files[0])}${files.length > 1 ? ' +' + (files.length - 1) : ''}) can't become ${job.to}`)
  }
  if (fit.length) return fit
  // Nothing selected: offer the most recent matching files as a numbered card.
  // A Finder selection that is not on screen (old, or in a hidden window) is offered, never assumed.
  const choices = []
  if (hidden.length) choices.push({ files: hidden, label: hidden.length > 1 ? `${basename(hidden[0])} +${hidden.length - 1}` : basename(hidden[0]), detail: 'Last selected in Finder (not on screen)' })
  for (const f of recentFiles(kinds)) if (!hidden.includes(f)) choices.push({ files: [f], label: basename(f), detail: dirname(f).replace(homedir(), '~') })
  if (!choices.length) throw new Error('Select a file in Finder first, then say it again')
  const allImg = choices.every((c) => ['image', 'pdf'].includes(kindOf(c.files[0])))
  const pick = await present({
    title: 'Which file?', subtitle: hidden.length ? 'Nothing selected on screen' : 'Nothing selected in Finder. Most recent first',
    options: choices.map((c) => ({ label: c.label, detail: c.detail, ...(allImg ? { image: c.files[0] } : {}) })),
    multi: job.to === 'pdf' || job.to === 'webp', recommended: 1, focus: true, timeout: 60,
  })
  if (pick.picks) return pick.picks.flatMap((i) => choices[i - 1].files)
  if (pick.pick) return choices[pick.pick - 1].files
  throw new Error('No file picked')
}

// ── output naming: never overwrite ──────────────────────────────────────────
function outPath(src, ext, tag = '') {
  const dir = dirname(src), stem = basename(src, extname(src))
  let p = join(dir, `${stem}${tag}.${ext}`), i = 2
  while (existsSync(p) || p === src) p = join(dir, `${stem}${tag} ${i++}.${ext}`)
  return p
}
const sizeMB = (p) => { try { return statSync(p).size / 1048576 } catch { return 0 } }
const fmtMB = (p) => { const m = sizeMB(p); return m >= 1 ? m.toFixed(1) + ' MB' : Math.max(1, Math.round(m * 1024)) + ' KB' }

async function ffprobeDuration(f) {
  const ffprobe = which('ffprobe'); if (!ffprobe) return 0
  const r = await run([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f], { timeoutMs: 30000 })
  return Number(r.stdout.trim()) || 0
}
async function hasAudio(f) {
  const ffprobe = which('ffprobe'); if (!ffprobe) return true
  const r = await run([ffprobe, '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', f], { timeoutMs: 30000 })
  return !!r.stdout.trim()
}
function need(bin, hint) { const p = which(bin); if (!p) throw new Error(`${bin} is not installed. ${hint || 'brew install ' + bin}`); return p }

// ── converters ──────────────────────────────────────────────────────────────
async function imageTo(src, fmt, o) {
  const sips = '/usr/bin/sips'
  const sipsFmt = { jpg: 'jpeg', png: 'png', heic: 'heic', tiff: 'tiff', gif: 'gif', bmp: 'bmp', pdf: 'pdf' }[fmt]
  let ext = fmt === 'same' ? (extname(src).slice(1).toLowerCase() || 'png') : fmt
  if (ext === 'jpeg') ext = 'jpg'
  const tag = fmt === 'same' ? (o.maxPx ? ` ${o.maxPx}px` : o.scale ? ' small' : ' compressed') : ''
  const out = outPath(src, ext, tag)
  // size: --maxPx or --scale
  let resizeArgs = []
  if (o.maxPx) resizeArgs = ['-Z', String(o.maxPx)]
  else if (o.scale) {
    const r = await run([sips, '-g', 'pixelWidth', '-g', 'pixelHeight', src])
    const w = Number((r.stdout.match(/pixelWidth: (\d+)/) || [])[1]), h = Number((r.stdout.match(/pixelHeight: (\d+)/) || [])[1])
    if (w && h) resizeArgs = ['-Z', String(Math.round(Math.max(w, h) * o.scale))]
  }
  if (ext === 'webp') return webp(src, out, o, resizeArgs)
  const q = o.compress || o.maxMB ? ['-s', 'formatOptions', '72'] : ['-s', 'formatOptions', 'best']
  const args = [sips, ...resizeArgs, '-s', 'format', sipsFmt || (ext === 'jpg' ? 'jpeg' : ext), ...(['jpg', 'heic'].includes(ext) ? q : []), src, '--out', out]
  const r = await run(args, { timeoutMs: 120000 })
  if (r.code !== 0 || !existsSync(out)) throw new Error('sips failed: ' + (r.stderr || r.stdout).trim().slice(0, 200))
  return out
}

// WebP: cwebp if installed, else ffmpeg with libwebp, else headless Chrome's canvas encoder (always on a Mac with Chrome).
async function webp(src, out, o, resizeArgs) {
  const quality = o.compress || o.maxMB ? 72 : 85
  let input = src, tmp = null
  if (resizeArgs.length || !['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extname(src).slice(1).toLowerCase())) {
    tmp = join(tmpdir(), `wish-${process.pid}-${Date.now()}.png`)
    await run(['/usr/bin/sips', ...resizeArgs, '-s', 'format', 'png', src, '--out', tmp], { timeoutMs: 120000 })
    input = tmp
  }
  try {
    const cwebp = which('cwebp')
    if (cwebp) { const r = await run([cwebp, '-quiet', '-q', String(quality), input, '-o', out]); if (r.code === 0) return out }
    const ff = which('ffmpeg')
    if (ff) {
      const enc = await run([ff, '-hide_banner', '-encoders'], { timeoutMs: 20000 })
      if (/libwebp/.test(enc.stdout)) { const r = await run([ff, '-y', '-v', 'error', '-i', input, '-quality', String(quality), out]); if (r.code === 0) return out }
    }
    // Pillow is often already there (it is on this Mac): fast, no browser start.
    for (const py of [...new Set([which('python3'), '/usr/bin/python3'].filter(Boolean))]) {
      const r = await run([py, '-I', '-c', 'import sys;from PIL import Image;Image.open(sys.argv[1]).save(sys.argv[2],"WEBP",quality=int(sys.argv[3]),method=4)', input, out, String(quality)], { timeoutMs: 120000 })
      if (r.code === 0 && existsSync(out)) return out
    }
    if (!CHROME) throw new Error('WebP needs cwebp (brew install webp), Pillow, or Google Chrome')
    const mime = extname(input).toLowerCase() === '.png' ? 'image/png' : extname(input).toLowerCase() === '.gif' ? 'image/gif' : extname(input).toLowerCase() === '.webp' ? 'image/webp' : 'image/jpeg'
    const b64 = readFileSync(input).toString('base64')
    const page = join(tmpdir(), `wish-webp-${process.pid}-${Date.now()}.html`)
    writeFileSync(page, `<!doctype html><body><script>const i=new Image();i.onload=()=>{const c=document.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;c.getContext('2d').drawImage(i,0,0);document.body.textContent='WEBP:'+c.toDataURL('image/webp',${quality / 100})};i.onerror=()=>{document.body.textContent='WEBP:ERR'};i.src='data:${mime};base64,${b64}'</script></body>`)
    const r = await chromeHeadless(['--virtual-time-budget=15000', '--dump-dom', pathToFileURL(page).href])
    rmSync(page, { force: true })
    const m = r.stdout.match(/WEBP:data:image\/webp;base64,([A-Za-z0-9+/=]+)/)
    if (!m) throw new Error('Chrome could not encode WebP')
    writeFileSync(out, Buffer.from(m[1], 'base64'))
    return out
  } finally { if (tmp) rmSync(tmp, { force: true }) }
}

async function chromeHeadless(args) {
  const prof = join(tmpdir(), `wish-chrome-${process.pid}`)
  const r = await run([CHROME, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    `--user-data-dir=${prof}`, ...args], { timeoutMs: 180000 })
  rmSync(prof, { recursive: true, force: true })
  return r
}

function mdToHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|\W)\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  const out = []; let list = null, code = false
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) { if (list) { out.push(`</${list}>`); list = null } out.push(code ? '</pre>' : '<pre>'); code = !code; continue }
    if (code) { out.push(esc(line)); continue }
    const h = line.match(/^(#{1,6})\s+(.*)/), li = line.match(/^\s*[-*+]\s+(.*)/), ol = line.match(/^\s*\d+[.)]\s+(.*)/)
    if ((li || ol) && list !== (li ? 'ul' : 'ol')) { if (list) out.push(`</${list}>`); list = li ? 'ul' : 'ol'; out.push(`<${list}>`) }
    if (!li && !ol && list) { out.push(`</${list}>`); list = null }
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
    else if (li || ol) out.push(`<li>${inline((li || ol)[1])}</li>`)
    else if (/^>\s?/.test(line)) out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`)
    else if (/^\s*(---|\*\*\*)\s*$/.test(line)) out.push('<hr>')
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`)
  }
  if (list) out.push(`</${list}>`); if (code) out.push('</pre>')
  return `<!doctype html><meta charset="utf-8"><style>body{font:11pt/1.5 -apple-system,Helvetica,sans-serif;max-width:46em;margin:2em auto;color:#111}pre{background:#f4f4f4;padding:.8em;white-space:pre-wrap}code{background:#f4f4f4;padding:0 .2em}img{max-width:100%}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:1em;color:#555}</style>${out.join('\n')}`
}

async function docToHtmlFile(src) {
  const e = extname(src).slice(1).toLowerCase()
  if (['html', 'htm'].includes(e)) return { file: src, tmp: false }
  const tmp = join(tmpdir(), `wish-doc-${process.pid}-${Date.now()}.html`)
  if (['md', 'markdown', 'txt'].includes(e)) {
    const body = readFileSync(src, 'utf8')
    writeFileSync(tmp, e === 'txt' ? `<!doctype html><meta charset="utf-8"><pre style="font:10.5pt/1.45 Menlo,monospace;white-space:pre-wrap">${body.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>` : mdToHtml(body))
    return { file: tmp, tmp: true }
  }
  const r = await run(['/usr/bin/textutil', '-convert', 'html', src, '-output', tmp], { timeoutMs: 120000 })
  if (r.code !== 0) throw new Error('textutil could not read ' + basename(src))
  return { file: tmp, tmp: true }
}

async function toPdf(files) {
  const imgs = files.filter((f) => kindOf(f) === 'image'), docs = files.filter((f) => kindOf(f) === 'doc')
  const outs = []
  if (imgs.length) {
    const pages = []
    for (const f of imgs) {
      const p = join(tmpdir(), `wish-page-${process.pid}-${pages.length}.pdf`)
      const r = await run(['/usr/bin/sips', '-s', 'format', 'pdf', f, '--out', p], { timeoutMs: 120000 })
      if (r.code !== 0 || !existsSync(p)) throw new Error('sips could not make a PDF from ' + basename(f))
      pages.push(p)
    }
    const out = imgs.length === 1 ? outPath(imgs[0], 'pdf')
      : outPath(join(dirname(imgs[0]), `${basename(imgs[0], extname(imgs[0]))} +${imgs.length - 1}${extname(imgs[0])}`), 'pdf')
    if (pages.length === 1) renameSync(pages[0], out)
    else {
      const r = await run([PDFJOIN, '-o', out, ...pages], { timeoutMs: 120000 })
      pages.forEach((p) => rmSync(p, { force: true }))
      if (r.code !== 0 || !existsSync(out)) throw new Error('Could not combine pages: ' + r.stderr.trim().slice(0, 160))
    }
    outs.push(out)
  }
  for (const f of docs) {
    const out = outPath(f, 'pdf')
    const { file, tmp } = await docToHtmlFile(f)
    try {
      if (CHROME) {
        const r = await chromeHeadless(['--no-pdf-header-footer', `--print-to-pdf=${out}`, pathToFileURL(file).href])
        if (!existsSync(out)) throw new Error('Chrome print failed: ' + r.stderr.trim().slice(-160))
      } else {
        const r = await run(['/usr/sbin/cupsfilter', '-m', 'application/pdf', file], { timeoutMs: 120000 })
        writeFileSync(out, r.stdout)
      }
    } finally { if (tmp) rmSync(file, { force: true }) }
    outs.push(out)
  }
  return outs
}

async function docTo(src, fmt) {
  const out = outPath(src, fmt)
  const e = extname(src).slice(1).toLowerCase()
  let input = src, tmp = null
  if (['md', 'markdown'].includes(e) && fmt !== 'txt') { const h = await docToHtmlFile(src); input = h.file; tmp = h.tmp ? h.file : null }
  if (fmt === 'md') {
    const r = await run(['/usr/bin/textutil', '-convert', 'txt', '-stdout', input], { timeoutMs: 120000 })
    writeFileSync(out, r.stdout)
  } else {
    const tf = { docx: 'docx', rtf: 'rtf', txt: 'txt', html: 'html' }[fmt]
    const r = await run(['/usr/bin/textutil', '-convert', tf, input, '-output', out], { timeoutMs: 120000 })
    if (r.code !== 0) throw new Error('textutil failed: ' + r.stderr.trim().slice(0, 160))
  }
  if (tmp) rmSync(tmp, { force: true })
  return out
}

async function pdfTo(src, fmt) {
  if (['png', 'jpg', 'heic', 'tiff', 'webp'].includes(fmt)) return imageTo(src, fmt, {})   // first page
  if (fmt === 'txt') {
    const out = outPath(src, 'txt')
    // PDFKit through JXA: no extra installs.
    const r = await run(['osascript', '-l', 'JavaScript', '-e', `ObjC.import('PDFKit');const d=$.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(${JSON.stringify(src)}));d.string.js`], { timeoutMs: 120000 })
    if (r.code !== 0) throw new Error('Could not read text from the PDF')
    writeFileSync(out, r.stdout)
    return out
  }
  throw new Error(`PDF to ${fmt} is not supported yet`)
}

async function videoTo(src, fmt, o, onProgress) {
  const ff = need('ffmpeg')
  const dur = await ffprobeDuration(src)
  const audio = !o.mute && await hasAudio(src)
  const ffrun = async (args, label) => {
    const p = spawn(ff, ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)))
    p.stdout.on('data', (d) => {
      const m = String(d).match(/out_time_ms=(\d+)/g)
      if (m && dur) onProgress?.(`${label} ${Math.min(99, Math.round(Number(m.pop().split('=')[1]) / 1e4 / dur))}%`)
    })
    const code = await new Promise((r) => p.on('close', r))
    if (code !== 0) throw new Error('ffmpeg: ' + err.trim().split('\n').pop())
  }
  if (fmt === 'gif') {
    const maxMB = o.maxMB || 0
    let width = o.maxPx || 720, fps = 12
    for (let tries = 0; tries < 4; tries++) {
      const out = outPath(src, 'gif')
      const vf = `fps=${fps},scale='min(${width},iw)':-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`
      await ffrun(['-i', src, '-vf', vf, '-loop', '0', out], 'GIF')
      if (!maxMB || sizeMB(out) <= maxMB || tries === 3) return out
      const ratio = Math.sqrt(maxMB / sizeMB(out)) * 0.92
      rmSync(out, { force: true })
      width = Math.max(240, Math.round(width * ratio / 2) * 2); if (width === 240) fps = Math.max(6, fps - 3)
    }
  }
  if (['mp3', 'm4a', 'wav'].includes(fmt)) {
    const out = outPath(src, fmt)
    const codec = { mp3: ['-c:a', 'libmp3lame', '-q:a', '3'], m4a: ['-c:a', 'aac', '-b:a', '160k'], wav: ['-c:a', 'pcm_s16le'] }[fmt]
    await ffrun(['-i', src, '-vn', ...codec, out], 'Audio')
    return out
  }
  // mp4 / mov / webm (compress or just change container)
  const ext = fmt === 'same' ? 'mp4' : fmt
  const tag = o.preset === 'whatsapp' ? ' whatsapp' : o.compress || o.maxMB ? ' small' : ''
  const out = outPath(src, ext, tag)
  const maxH = o.maxPx || (o.preset === 'whatsapp' ? 720 : o.compress || o.maxMB ? 1080 : 0)
  const vf = maxH ? ['-vf', `scale=-2:'min(${maxH},ih)'`] : []
  const a = audio ? (ext === 'webm' ? ['-c:a', 'libopus', '-b:a', '96k'] : ['-c:a', 'aac', '-b:a', o.compress || o.maxMB ? '96k' : '160k']) : ['-an']
  if (ext === 'webm') { await ffrun(['-i', src, ...vf, '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-row-mt', '1', ...a, out], 'WebM'); return out }
  const shrinking = o.compress || o.maxMB
  // Quality-first (CRF). A size cap only adds a ceiling (-maxrate); it never sets the bitrate, so a
  // clip that already fits is not inflated to fill the cap.
  const v = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', shrinking ? '26' : '20', '-pix_fmt', 'yuv420p']
  let capKbps = 0
  if (o.maxMB && dur) {
    capKbps = Math.floor((o.maxMB * 8192 * 0.94) / dur - (audio ? 96 : 0))
    if (capKbps < 120) throw new Error(`${Math.round(dur)}s is too long to fit in ${o.maxMB} MB`)
  }
  const srcKbps = dur ? Math.floor((sizeMB(src) * 8192) / dur - (audio ? 128 : 0)) : 0
  if (shrinking && srcKbps > 150) capKbps = capKbps ? Math.min(capKbps, srcKbps) : srcKbps
  const cap = (k) => (k ? ['-maxrate', `${k}k`, '-bufsize', `${k * 2}k`] : [])
  const label = o.preset === 'whatsapp' ? 'For WhatsApp' : 'Video'
  await ffrun(['-i', src, ...vf, ...v, ...cap(capKbps), ...a, '-movflags', '+faststart', out], label)
  // Still over the cap, or (when shrinking) not smaller than the source: one tighter pass.
  const over = (o.maxMB && sizeMB(out) > o.maxMB) || (shrinking && sizeMB(out) >= sizeMB(src))
  if (over && dur) {
    const target = Math.max(120, Math.floor(Math.min(capKbps || Infinity, srcKbps || Infinity) * 0.7))
    if (Number.isFinite(target)) {
      await ffrun(['-i', src, ...vf, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${target}k`, ...cap(target), '-pix_fmt', 'yuv420p', ...a, '-movflags', '+faststart', out], label)
    }
  }
  return out
}

async function transcribe(src, fmt, onProgress) {
  const ff = need('ffmpeg')
  const wav = join(tmpdir(), `wish-asr-${process.pid}-${Date.now()}.wav`)
  onProgress?.('Preparing audio')
  let r = await run([ff, '-y', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { timeoutMs: 600000 })
  if (r.code !== 0) throw new Error('ffmpeg could not read the audio')
  const outBase = outPath(src, fmt, ' transcript').replace(/\.[^.]+$/, '')
  try {
    const cli = which('whisper-cli') || which('whisper-cpp')
    const model = [process.env.WISPR_WISH_WHISPER_MODEL, join(homedir(), '.relay/models/ggml-base.en.bin'), join(homedir(), '.wispr-wish/models/ggml-base.en.bin'),
      '/opt/homebrew/share/whisper-cpp/ggml-base.en.bin', join(homedir(), '.cache/whisper/ggml-base.en.bin')].filter(Boolean).find(existsSync)
    if (cli && model) {
      onProgress?.('Transcribing')
      r = await run([cli, '-m', model, '-f', wav, fmt === 'srt' ? '-osrt' : '-otxt', '-of', outBase, '-np'], { timeoutMs: 3_600_000 })
      if (r.code === 0 && existsSync(`${outBase}.${fmt}`)) return `${outBase}.${fmt}`
    }
    const py = which('whisper')
    if (py) {
      onProgress?.('Transcribing (python whisper)')
      const dir = join(tmpdir(), `wish-asr-${process.pid}`); mkdirSync(dir, { recursive: true })
      r = await run([py, wav, '--model', 'base', '--output_format', fmt, '--output_dir', dir], { timeoutMs: 3_600_000 })
      const f = join(dir, basename(wav, '.wav') + '.' + fmt)
      if (existsSync(f)) { writeFileSync(`${outBase}.${fmt}`, readFileSync(f)); rmSync(dir, { recursive: true, force: true }); return `${outBase}.${fmt}` }
    }
    throw new Error('Transcribing needs whisper-cli + a ggml model (brew install whisper-cpp) or openai-whisper')
  } finally { rmSync(wav, { force: true }) }
}

async function convertOne(src, job, onProgress) {
  const k = kindOf(src), o = job.options || {}
  let to = job.to
  if (to === 'auto-compress') to = k === 'video' ? 'mp4' : k === 'image' ? 'same-image' : null
  if (!to) throw new Error(`Don't know how to compress ${basename(src)}`)
  if (to === 'transcript') return transcribe(src, job.fmt || 'txt', onProgress)
  if (to === 'same-image') return imageTo(src, 'same', o)
  if (k === 'image' && to === 'gif' && extname(src).toLowerCase() !== '.gif') return imageTo(src, 'gif', o)
  if (k === 'image') return imageTo(src, to, o)
  if (k === 'pdf') return pdfTo(src, to)
  if (k === 'video' || k === 'audio') {
    if (k === 'audio' && ['mp4', 'mov', 'webm', 'gif'].includes(to)) throw new Error('That is an audio file; it has no picture to make a ' + to)
    return videoTo(src, to === 'mp4' && o.compress && extname(src).toLowerCase() === '.mp4' ? 'mp4' : to, o, onProgress)
  }
  if (k === 'doc') return docTo(src, to)
  throw new Error(`Can't convert ${basename(src)} to ${to}`)
}

export async function convert(job, given = []) {
  let files
  try { files = await resolveInputs(job, given) }
  catch (e) { await notify(e.message, { title: 'Wish', ttl: 6 }); throw e }
  if (files.length > 25) {
    const c = await present({ title: `Convert all ${files.length} files?`, options: [{ label: 'Yes, all of them' }, { label: 'No, cancel' }], recommended: 1, focus: true, timeout: 45 })
    if (c.pick !== 1) { await notify('Cancelled, nothing converted', { title: 'Wish', ttl: 3 }); return { ok: false, cancelled: true } }
  }
  const label = job.to === 'transcript' ? 'Transcribing' : `Making ${job.to === 'same-image' || job.to === 'auto-compress' ? 'smaller copies' : job.to.toUpperCase()}`
  await progress(`${label}: ${basename(files[0])}${files.length > 1 ? ` +${files.length - 1}` : ''}`)
  const outputs = [], errors = []
  try {
    if (job.to === 'pdf' && files.length > 1 && files.every((f) => kindOf(f) === 'image')) outputs.push(...(await toPdf(files)))
    else for (const [i, f] of files.entries()) {
      try {
        const tick = (t) => progress(`${t}${files.length > 1 ? ` · ${i + 1}/${files.length}` : ''}`)
        if (job.to === 'pdf' && kindOf(f) !== 'pdf') outputs.push(...(await toPdf([f])))
        else outputs.push(await convertOne(f, job, tick))
      } catch (e) { errors.push(`${basename(f)}: ${e.message}`) }
    }
  } finally { await progress('', { done: true }) }
  if (!outputs.length) { await notify(errors[0] || 'Nothing converted', { title: 'Wish failed', ttl: 6 }); return { ok: false, errors } }

  // Destructive step: only when asked, always confirmed, originals go to the Trash (recoverable).
  let trashed = [], askedAndIgnored = false
  if (job.options?.replace) {
    const c = await present({
      title: `Move ${files.length} original${files.length > 1 ? 's' : ''} to the Trash?`,
      subtitle: 'The new files are saved. Originals stay recoverable in the Trash',
      options: [{ label: 'Keep the originals', detail: 'Safe default' }, { label: 'Move originals to Trash' }],
      recommended: 1, focus: true, timeout: 45,
    })
    if (c.pick === 2) { trashed = await toTrash(files) }
    else if (!c.pick) askedAndIgnored = true
  }

  const summary = outputs.length === 1 ? `${basename(outputs[0])} · ${fmtMB(outputs[0])}` : `${outputs.length} files saved next to the originals`
  await notify(summary + (errors.length ? ` (${errors.length} failed)` : '') + (askedAndIgnored ? ' · originals kept' : ''), { title: 'Done', ttl: 4 })
  if (process.env.WISPR_WISH_RESULT_CARD !== '0' && !askedAndIgnored) await resultCard(outputs)
  return { ok: true, outputs, errors, trashed }
}

async function toTrash(files) {
  const list = files.map((f) => `POSIX file ${JSON.stringify(f)}`).join(', ')
  const r = await run(['osascript', '-e', `tell application "Finder" to delete {${list}}`], { timeoutMs: 20000 })
  return r.code === 0 ? files : []
}

async function resultCard(outputs) {
  const shown = outputs.slice(0, 6)
  const imgs = shown.every((f) => ['image', 'pdf'].includes(kindOf(f)))
  const r = await present({
    title: outputs.length === 1 ? 'Saved. Open it?' : `Saved ${outputs.length} files`,
    subtitle: imgs ? 'Pick one to open · esc to close' : 'esc to close',
    options: imgs ? shown.map((f) => ({ label: basename(f), detail: fmtMB(f), image: f }))
      : [{ label: outputs.length === 1 ? 'Open it' : 'Open the first', detail: basename(outputs[0]) }, { label: 'Show in Finder' }, { label: 'Copy the path' }],
    focus: false, timeout: 20,
  })
  if (!r.pick) return
  if (imgs) return run(['open', shown[r.pick - 1]])
  if (r.pick === 1) return run(['open', outputs[0]])
  if (r.pick === 2) return run(['open', '-R', ...outputs])
  if (r.pick === 3) return run(['pbcopy'], { input: outputs.join('\n') })
}

// ── mini apps ───────────────────────────────────────────────────────────────
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'app'

function fillTemplate(name, params) {
  let html = readFileSync(join(PKG_ROOT, 'apps', name + '.html'), 'utf8')
  html = html.replace('/*BASE*/', readFileSync(join(PKG_ROOT, 'apps', '_base.css'), 'utf8'))
  html = html.replace(/\/\*PARAMS\*\/\{[^\n]*?\};/, JSON.stringify(params).replace(/</g, '\\u003c') + ';')
  if (html.includes('/*QRLIB*/')) html = html.replace('/*QRLIB*/', () => readFileSync(join(PKG_ROOT, 'vendor', 'qrcode-generator.js'), 'utf8'))
  return html
}

async function linkForQr() {
  const clip = (await run(['pbpaste'], { timeoutMs: 4000 })).stdout.trim()
  if (/^https?:\/\/\S+$/.test(clip)) return { text: clip, from: 'clipboard' }
  for (const [app, expr] of [['Google Chrome', 'URL of active tab of front window'], ['Safari', 'URL of front document'], ['Arc', 'URL of active tab of front window']]) {
    const running = await run(['osascript', '-e', `application "${app}" is running`], { timeoutMs: 4000 })
    if (running.stdout.trim() !== 'true') continue
    const r = await run(['osascript', '-e', `tell application "${app}" to get ${expr}`], { timeoutMs: 6000 })
    if (/^https?:/.test(r.stdout.trim())) return { text: r.stdout.trim(), from: app }
  }
  // Only a link counts. Arbitrary clipboard text (paths, notes, passwords) is never encoded or saved.
  return { text: '', from: 'none' }
}

const GEN_PROMPT = (idea, css) => `Write a tiny single-file HTML mini app for this request, dictated by voice: ${JSON.stringify(idea)}

Rules:
- Output ONLY the complete HTML document, starting with <!doctype html>. No prose, no code fences.
- Everything inline (CSS + JS). No external scripts, fonts, images or network calls. Must work from file://.
- It opens in a small window about 380x520: call try{window.resizeTo(W,H)}catch(e){} with W at least 380. Nothing may clip or overflow horizontally at 360px wide (flex children need min-width:0).
- Prefill everything you can from the request (numbers, names, amounts). Usable immediately, zero setup.
- Keyboard friendly; big readable primary output; at most one screen; no scrolling at that size.
- Use this house CSS verbatim at the top of the <style> and build on its tokens (it handles light and dark):
${css}
- Put <footer><span>made for Wispr</span><span>(a one-line hint)</span></footer> at the bottom of body, after <main>.
- Keep it under 250 lines. No alerts, no localStorage requirement (wrap any storage in try/catch).`

async function generateApp(idea) {
  // "make me a dice roller" and "a dice roller" are the same app: key the cache on the idea itself.
  const key = idea.toLowerCase().replace(/^\s*(?:(?:please|hey|ok(?:ay)?)[,\s]+)?(?:can you |could you )?(?:make|build|give|open|show|create|get)?\s*(?:me\s+)?(?:a|an|the)?\s*(?:quick|little|tiny|simple)?\s*/, '')
  const file = join(APPS_OUT, `gen-${slug(key || idea)}.html`)
  if (existsSync(file) && !process.env.WISPR_WISH_FRESH) return { file, cached: true }
  const claude = process.env.WISPR_WISH_CLAUDE || 'claude'
  const model = process.env.WISPR_WISH_MODEL || 'sonnet'
  const flags = ['-p', '--model', model, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', '--output-format', 'text']
  if (process.env.ANTHROPIC_API_KEY) flags.push('--bare')
  await progress('Building your mini app')
  let r
  try { r = await run([claude, ...flags], { input: GEN_PROMPT(idea, readFileSync(join(PKG_ROOT, 'apps', '_base.css'), 'utf8')), timeoutMs: 240000, cwd: homedir() }) }
  finally { await progress('', { done: true }) }
  let html = r.stdout.trim().replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '')
  const i = html.search(/<!doctype html>|<html/i)
  if (i < 0) throw new Error('The app builder returned no HTML' + (r.stderr ? ': ' + r.stderr.trim().slice(0, 160) : ''))
  html = html.slice(i)
  mkdirSync(APPS_OUT, { recursive: true })
  writeFileSync(file, html)
  return { file, cached: false }
}

export async function openWindow(file, { w = 380, h = 520 } = {}) {
  if (QUIET()) return log('open', file)
  const url = pathToFileURL(file).href
  if (CHROME && /Google Chrome/.test(CHROME)) {
    // An --app window is a small chromeless window; the page sizes itself with resizeTo().
    const r = await run(['open', '-na', 'Google Chrome', '--args', `--app=${url}`, `--window-size=${w},${h}`], { timeoutMs: 15000 })
    if (r.code === 0) return 'chrome-app'
  }
  await run(['open', file])
  return 'default'
}

export async function miniApp(job) {
  mkdirSync(APPS_OUT, { recursive: true })
  let file, title
  if (job.app === 'gen') {
    let g
    try { g = await generateApp(job.idea) }
    catch (e) { await notify(e.message, { title: 'Mini app failed', ttl: 6 }); throw e }
    file = g.file; title = job.idea; job.cached = g.cached
  } else {
    const params = { ...job.params }
    if (job.app === 'timer' && job.noDuration) {
      const mins = [5, 10, 15, 25]
      const c = await present({ title: 'Timer for how long?', options: mins.map((m) => ({ label: `${m} min` })), recommended: 2, focus: true, timeout: 30 })
      if (c.pick) params.minutes = mins[c.pick - 1]
      else if (!c.quiet && c.reason !== 'no bridge') { await notify('No time picked, no timer', { title: 'Timer', ttl: 3 }); return { ok: false, cancelled: true } }
    }
    if (job.app === 'qr' && !params.text) {
      const l = await linkForQr(); params.text = l.text
      if (!params.text) { await notify('Copy a link (or open it in Chrome/Safari), then ask again', { title: 'QR code', ttl: 5 }); return { ok: false, error: 'no link on the clipboard or in the front browser tab' } }
    }
    file = join(APPS_OUT, `${job.app}.html`)
    writeFileSync(file, fillTemplate(job.app, params))
    title = { timer: `Timer · ${params.minutes} min`, split: 'Split the bill', qr: 'QR code' }[job.app]
  }
  const how = await openWindow(file)
  await notify(`Opened ${title}`, { title: 'Mini app', ttl: 2 })
  return { ok: true, app: job.app, file, opened: how, ...(job.app === 'gen' ? { cached: !!job.cached } : {}) }
}

// ── entry points ────────────────────────────────────────────────────────────
// From the bridge: intent JSON. convert -> convert; wish.run -> mini app if it is one, else Claude Code.
export async function handleIntent(it) {
  const a = it.args || {}
  const text = it.text || a.wish || a.question || [a.to, a.options].filter(Boolean).join(' ')
  if (it.intent === 'convert') {
    const job = parseConvert(text) || parseConvert(`convert to ${a.to} ${a.options || ''}`) || { kind: 'convert', to: String(a.to || '').toLowerCase(), options: parseOptions(String(a.options || '')) }
    job.options = { ...parseOptions(String(a.options || '')), ...job.options }
    const given = a.input && existsSync(String(a.input).replace(/^~(?=\/)/, homedir())) ? [a.input] : []
    return convert(job, given)
  }
  // Under `ask` only the instant built-in apps (timer, split, QR) are taken, and never for a question:
  // an ask is someone wanting an answer, so it must not touch files or spend minutes building an app.
  const job = parse(text, { builtinOnly: it.intent === 'ask' })
  if (job?.kind === 'app') return miniApp(job)
  if (job?.kind === 'convert' && it.intent !== 'ask') return convert(job)
  if (it.intent === 'ask') {
    // The router files "a timer for 25 min" under ask, so wish listens there too. Anything else gets
    // exactly the bridge's built-in answer: a two-sentence Haiku reply as a toast.
    const flags = ['-p', '--model', process.env.WISPR_BRIDGE_MODEL || 'haiku', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '']
    if (process.env.ANTHROPIC_API_KEY) flags.push('--bare')
    const r = await run([process.env.WISPR_WISH_CLAUDE || 'claude', ...flags], { input: 'Answer in at most 2 short sentences, plain text: ' + (a.question || text), timeoutMs: 120_000, cwd: homedir() })
    const ans = r.stdout.trim() || 'No answer'
    await notify(ans, { title: 'Answer', ttl: 8 })
    return { handler: 'ask', result: ans }
  }
  // Not ours: same behaviour as the bridge's built-in wish.run (Claude Code in the project folder).
  const cwd = a.project && existsSync(a.project) ? a.project : process.cwd()
  await progress('Working: ' + (a.wish || text))
  let r
  try { r = await run([process.env.WISPR_WISH_CLAUDE || 'claude', '-p'], { input: a.wish || text, timeoutMs: 1_800_000, cwd }) }
  finally { await progress('', { done: true }) }
  await notify(r.stdout.trim().split('\n').slice(-3).join(' ').slice(0, 240) || 'Finished', { title: 'Wish done', ttl: 6 })
  return { ok: r.code === 0, handler: 'claude -p', result: r.stdout.trim() }
}

// From a person (CLI, /wish, Wispr ask field): fast local parse first, the bridge router only if needed.
export async function wish(text, { files = [] } = {}) {
  const job = parse(text)
  if (job?.kind === 'convert') return convert(job, files)
  if (job?.kind === 'app') return miniApp(job)
  const b = await B()
  if (!b) { const m = 'Not a conversion or mini app I know, and wispr-bridge is not installed to route it'; await notify(m, { title: 'Wish', ttl: 5 }); throw new Error(m) }
  const it = await b.classify(text)
  if (it.intent === 'convert' || it.intent === 'wish.run') return handleIntent(it)
  return b.route(text)
}
