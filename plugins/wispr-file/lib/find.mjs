// wispr-file — find any file by voice. Made for Wispr (unofficial). See ../README.md.
//
// Fast path (no model): parse the dictated request locally -> parallel Spotlight queries (mdfind)
// -> rank by name/content/kind/date/location -> thumbnails -> bridge present() card -> act.
// Private: Spotlight and Quick Look run on this Mac. Claude (claude -p) is only used with --smart or
// when nothing matched, and then it gets the request text plus file NAMES and metadata, never contents.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { stat as statAsync } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HOME = homedir()
const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)))
export const PKG_ROOT = dirname(HERE)
export const STATE = process.env.WISPR_FILE_HOME || join(HOME, '.wispr-file')
const THUMBS = join(STATE, 'thumbs')
const CLIP = join(PKG_ROOT, 'helper', 'wf-clip')

// ── bridge (present / notify / progress) ─────────────────────────────────────
let _bridge
export async function bridge() {
  if (_bridge) return _bridge
  const tries = [process.env.WISPR_BRIDGE_LIB, join(process.env.WISPR_BRIDGE_HOME || join(HOME, '.wispr-bridge'), 'lib', 'bridge.mjs'),
    join(PKG_ROOT, '..', 'wispr-bridge', 'lib', 'bridge.mjs'),
    // package.sh vendors the bridge into the zip so a plugin-url install works on its own.
    join(PKG_ROOT, 'vendor', 'wispr-bridge', 'lib', 'bridge.mjs')].filter(Boolean)
  for (const t of tries) if (existsSync(t)) { _bridge = await import(pathToFileURL(t).href); return _bridge }
  throw Object.assign(new Error('wispr-bridge not found: install the wispr-bridge plugin first'), { code: 3 })
}

// ── process helper ───────────────────────────────────────────────────────────
export function run(argv, { input, timeoutMs = 30_000, cwd } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', killed = false, p
    try { p = spawn(argv[0], argv.slice(1), { cwd, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] }) }
    catch (e) { return resolve({ code: 127, stdout: '', stderr: String(e) }) }
    const t = setTimeout(() => { killed = true; try { p.kill('SIGTERM') } catch {} }, timeoutMs)
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => { clearTimeout(t); resolve({ code: 127, stdout: out, stderr: err + String(e), killed }) })
    p.on('close', (code) => { clearTimeout(t); resolve({ code, stdout: out, stderr: err, killed }) })
    if (input != null) p.stdin.end(input)
  })
}

// ── 1. parse the request (local, instant) ────────────────────────────────────
const KINDS = {
  screenshot: { label: 'screenshot', pred: 'kMDItemIsScreenCapture == 1' },
  image: { label: 'image', pred: 'kMDItemContentTypeTree == "public.image"' },
  pdf: { label: 'PDF', pred: 'kMDItemContentTypeTree == "com.adobe.pdf"' },
  deck: { label: 'deck', pred: 'kMDItemContentTypeTree == "public.presentation"' },
  sheet: { label: 'spreadsheet', pred: '(kMDItemContentTypeTree == "public.spreadsheet" || kMDItemContentTypeTree == "public.comma-separated-values-text")' },
  doc: { label: 'document', pred: '(kMDItemContentTypeTree == "org.openxmlformats.wordprocessingml.document" || kMDItemContentTypeTree == "com.microsoft.word.doc" || kMDItemContentTypeTree == "com.apple.iwork.pages.sffpages" || kMDItemContentTypeTree == "public.rtf")' },
  video: { label: 'video', pred: 'kMDItemContentTypeTree == "public.movie"' },
  audio: { label: 'audio', pred: 'kMDItemContentTypeTree == "public.audio"' },
  folder: { label: 'folder', pred: 'kMDItemContentTypeTree == "public.folder"' },
  archive: { label: 'archive', pred: 'kMDItemContentTypeTree == "public.archive"' },
}
const KIND_WORDS = [
  [/\bscreen ?(shot|grab|cap(ture)?)s?\b|\bsnip\b/, 'screenshot'],
  [/\bscreen ?recordings?\b/, 'video', 'screen recording'],
  [/\b(photos?|pictures?|pics?|images?|selfies?|jpe?gs?|pngs?|heics?|scans?)\b/, 'image'],
  [/\bpdfs?\b/, 'pdf'],
  [/\b(decks?|presentations?|slides?|keynotes?|pptx?|powerpoints?)\b/, 'deck'],
  [/\b(spreadsheets?|sheets?|excel|xlsx?|csvs?|numbers file)\b/, 'sheet'],
  [/\b(docx?|word (doc|file|document)s?|pages doc)\b/, 'doc'],
  [/\b(videos?|movies?|clips?|recordings?|movs?|mp4s?|footage)\b/, 'video'],
  [/\b(audio|voice ?notes?|voice memos?|songs?|mp3s?|podcasts?)\b/, 'audio'],
  [/\b(folders?|directory|directories)\b/, 'folder'],
  [/\b(zips?|archives?|dmgs?)\b/, 'archive'],
]
const EXT_KIND = {
  image: 'png jpg jpeg gif heic heif tif tiff bmp webp raw cr2 nef dng svg',
  pdf: 'pdf', deck: 'key ppt pptx', sheet: 'xls xlsx numbers csv tsv', doc: 'doc docx pages rtf odt',
  video: 'mov mp4 m4v webm mkv avi', audio: 'mp3 m4a wav aiff aif flac ogg', archive: 'zip rar 7z tar gz tgz dmg',
}
const extKind = {}
for (const [k, v] of Object.entries(EXT_KIND)) for (const e of v.split(' ')) extKind[e] = k
const CODE_EXT = new Set('js mjs cjs ts tsx jsx py rb go rs swift java kt c h cpp m json map lock yml yaml toml sh css scss html xml plist log sql'.split(' '))
// NSImage can draw these straight from disk (first page for PDF), so no thumbnail is needed.
const NATIVE_IMG = new Set('png jpg jpeg gif heic heif tif tiff bmp webp pdf'.split(' '))

const ACTIONS = [
  [/\b(copy|grab) (the |its )?(file )?path\b|\bpath (of|to)\b/, 'path'],
  [/\b(reveal|show (it |me )?in finder|in finder|where is|where's|locate)\b/, 'reveal'],
  [/\battach(ed|ing)?\b/, 'attach'],
  [/\bpaste\b|\bdrop (it )?(in|into)\b|\bput (it )?(in|into)\b|\bsend\b/, 'paste'],
  [/\bopen\b/, 'open'],
  [/\bcopy\b/, 'copy'],
]
const WHERE = [
  [/\b(on|from|in) (my |the )?desktop\b/, join(HOME, 'Desktop')],
  [/\b(in|from) (my |the )?downloads?( folder)?\b/, join(HOME, 'Downloads')],
  [/\b(in|from) (my |the )?documents( folder)?\b/, join(HOME, 'Documents')],
  [/\b(in|from) (my |the )?pictures( folder)?\b/, join(HOME, 'Pictures')],
  [/\b(in|from) (my )?icloud( drive)?\b/, join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')],
]
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const STOP = new Set(('find get show open grab fetch pull up look search for where is the a an my me i i\'ve ive took taken ' +
  'made saved of from in on at to with that this it its which one ones please file files thing stuff some any ' +
  'and or copy paste attach reveal into send drop put finder can you could would like want need called named ' +
  'about last latest newest recent recently most document documents version copy here there them those these ' +
  'all was were be been have has had just quick quickly really kind sort type downloaded download received got sent shared emailed created edited wrote saved').split(' '))
const NUMWORDS = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5, six: 6, sixth: 6,
  seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9, ten: 10, tenth: 10 }

const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }

export function parseWhen(t, now = new Date()) {
  const today = dayStart(now), DAY = 86_400_000
  const r = (from, to, label) => ({ from: +from, to: +to, label })
  if (/\btoday\b/.test(t)) return r(today, +today + DAY, 'today')
  if (/\byesterday\b/.test(t)) return r(+today - DAY, today, 'yesterday')
  let m = t.match(/\b(?:last|past) (\d+|two|three|four|five|six|seven|ten) days\b/)
  if (m) { const n = Number(m[1]) || NUMWORDS[m[1]] || { seven: 7, ten: 10 }[m[1]] || 3; return r(+today - n * DAY, +today + DAY, `last ${n} days`) }
  if (/\bthis week\b/.test(t)) return r(+today - 7 * DAY, +today + DAY, 'this week')
  if (/\blast week\b/.test(t)) return r(+today - 14 * DAY, +today - 3 * DAY, 'last week')
  if (/\bthis month\b/.test(t)) return r(new Date(now.getFullYear(), now.getMonth(), 1), +today + DAY, 'this month')
  if (/\blast month\b/.test(t)) return r(new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1), 'last month')
  if (/\bthis year\b/.test(t)) return r(new Date(now.getFullYear(), 0, 1), +today + DAY, 'this year')
  if (/\blast year\b/.test(t)) return r(new Date(now.getFullYear() - 1, 0, 1), new Date(now.getFullYear(), 0, 1), 'last year')
  m = t.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:\s+(\d{4}))?/)
  if (m && !(m[1] === 'may' && !m[2] && !/\b(in|from|of|during) may\b/.test(t))) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3))
    let y = m[2] ? Number(m[2]) : now.getFullYear()
    if (!m[2] && mi > now.getMonth()) y -= 1
    return r(new Date(y, mi, 1), new Date(y, mi + 1, 1), m[0])
  }
  m = t.match(/\b(?:in|from) (20\d\d)\b/)
  if (m) return r(new Date(+m[1], 0, 1), new Date(+m[1] + 1, 0, 1), m[1])
  return null
}

export function parse(text, hint = {}) {
  const raw = String(text || '').trim()
  let t = ' ' + raw.toLowerCase().replace(/[’']s\b/g, '').replace(/[“”"]/g, ' ') + ' '
  const plan = { text: raw, terms: [], kind: null, extraName: null, range: null, recent: false, action: null, app: null, where: null }

  for (const [re, a] of ACTIONS) if (re.test(t)) { plan.action = a; break }
  const app = t.match(/\b(?:into|in|to|on) (slack|mail|gmail|messages|imessage|whatsapp|notion|figma|chatgpt|claude|discord|telegram)\b/)
  if (app) { plan.app = app[1]; if (!plan.action) plan.action = 'attach'; t = t.replace(app[0], ' ') }
  for (const [re, dir] of WHERE) if (re.test(t)) { plan.where = dir; t = t.replace(re, ' '); break }
  if (!plan.where && hint.where) {
    const w = String(hint.where).toLowerCase()
    for (const [re, dir] of WHERE) if (re.test(' in ' + w + ' ') || re.test(' on ' + w + ' ')) { plan.where = dir; break }
  }

  plan.range = parseWhen(t) || (hint.when ? parseWhen(' ' + String(hint.when).toLowerCase() + ' ') : null)
  if (plan.range) {
    t = t.replace(/\b(today|yesterday|this week|last week|this month|last month|this year|last year|(last|past) \S+ days)\b/g, ' ')
      .replace(/\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b(\s+20\d\d)?/g, ' ')
      .replace(/\b(in|from) may\b/g, ' ').replace(/\b(in|from) 20\d\d\b/g, ' ')
  }
  if (/\b(last|latest|newest|most recent|recent|just took|just saved|just downloaded)\b/.test(t)) plan.recent = true

  for (const [re, k, extra] of KIND_WORDS) {
    const km = t.match(re)
    if (km) { plan.kind = k; plan.kindWord = km[0].trim().replace(/s$/, ''); if (extra) plan.extraName = extra; t = t.replace(re, ' '); break }
  }
  if (!plan.kind && hint.kind) {
    const hk = ' ' + String(hint.kind).toLowerCase() + ' '
    for (const [re, k] of KIND_WORDS) if (re.test(hk)) { plan.kind = k; break }
  }

  const words = t.replace(/[^a-z0-9\u00c0-\uffff_\-. ]+/g, ' ').split(/\s+/).map((w) => w.replace(/^[.\-]+|[.\-]+$/g, ''))
  plan.code = /\b(code|script|source|function|component|test|config|json|js|ts|py)\b/.test(t)
  plan.terms = [...new Set(words.filter((w) => w && w.length > 1 && !STOP.has(w)))].slice(0, 5)
  if (!plan.terms.length && hint.query) {
    const sub = parse(hint.query)
    plan.terms = sub.terms
    plan.kind ||= sub.kind
  }
  return plan
}

// ── 2. Spotlight ─────────────────────────────────────────────────────────────
const q = (s) => s.replace(/["\\*]/g, '')
const isoDate = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
function dateRangePred(r) {
  const f = `$time.iso(${isoDate(r.from)})`, to = `$time.iso(${isoDate(r.to)})`
  return `((kMDItemContentCreationDate >= ${f} && kMDItemContentCreationDate < ${to}) || (kMDItemFSContentChangeDate >= ${f} && kMDItemFSContentChangeDate < ${to}) || (kMDItemDateAdded >= ${f} && kMDItemDateAdded < ${to}))`
}

export function queries(plan) {
  const out = []
  const kp = plan.kind ? KINDS[plan.kind].pred : null
  const name = (t) => `kMDItemFSName == "${q(t)}*"cdw`
  const content = (t) => `kMDItemTextContent == "${q(t)}*"cdw`
  const and = (xs) => xs.length > 1 ? '(' + xs.join(' && ') + ')' : xs[0]
  const or = (xs) => xs.length > 1 ? '(' + xs.join(' || ') + ')' : xs[0]
  if (plan.terms.length) {
    out.push({ tag: 'name', q: and(plan.terms.map(name)) })
    const notCode = plan.kind ? kp : 'kMDItemContentTypeTree != "public.source-code"'
    out.push({ tag: 'content', q: and([...plan.terms.map(content), notCode]) })
    if (plan.terms.length > 1) out.push({ tag: 'anyname', q: or(plan.terms.map(name)) })
    if (kp) out.push({ tag: 'kindany', q: and([kp, or([...plan.terms.map(name), ...plan.terms.map(content)])]) })
  }
  // Kind with no words ("the last screenshot", "photos from yesterday"). Never added when there are
  // words: a kind+date hit that matches none of the words is an unrelated file, not a result.
  if (kp && !plan.terms.length) {
    const homeWide = plan.kind === 'screenshot' || plan.kind === 'folder'
    if (plan.range && (homeWide || !MEDIA.has(plan.kind))) out.push({ tag: 'kind', q: and([kp, dateRangePred(plan.range)]) })
    else if (homeWide && !plan.range) out.push({ tag: 'kind', q: and([kp, `kMDItemFSContentChangeDate >= $time.today(-${BROAD_DAYS})`]) })
    else {
      // A home-wide "every image" query returns ~60k files (project assets) and is too slow for a card:
      // search the user's own folders, plus anything of that kind the user opened recently.
      const when = plan.range ? dateRangePred(plan.range) : `kMDItemFSContentChangeDate >= $time.today(-${BROAD_DAYS})`
      for (const d of plan.where ? [plan.where] : USER_DIRS) out.push({ tag: 'kind', q: and([kp, when]), where: d })
      if (!plan.where) out.push({ tag: 'kind', q: and([kp, plan.range ? dateRangePred(plan.range) : `kMDItemLastUsedDate >= $time.today(-${BROAD_DAYS})`]) })
    }
  }
  if (!plan.terms.length && !kp && plan.range) out.push({ tag: 'date', q: and([dateRangePred(plan.range), 'kMDItemContentTypeTree != "public.folder"']) })
  if (plan.extraName) out.push({ tag: 'extra', q: name(plan.extraName) })
  return out
}

const MEDIA = new Set(['image', 'video', 'audio'])
const BROAD_DAYS = 365
const USER_DIRS = ['Desktop', 'Downloads', 'Pictures', 'Movies', 'Music', 'Documents'].map((d) => join(HOME, d))
  .concat([join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')]).filter((d) => existsSync(d))

const SKIP = /\/(Library|node_modules|\.git|\.Trash|\.cache|\.npm|\.cargo|\.venv|venv|__pycache__|DerivedData|Pods|\.next|\.build|Caches)\/|\/\.[^/]+\/|\.app\/|\.photoslibrary\/|\.bundle\//
const ICLOUD = join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs') + '/'

async function mdfind(query, where, timeoutMs) {
  const r = await run(['mdfind', '-onlyin', where || HOME, query], { timeoutMs })
  const ps = r.stdout.split('\n').filter(Boolean).filter((p) => (p.startsWith(ICLOUD) || !SKIP.test(p))).slice(0, 4000)
  ps.killed = !!r.killed
  return ps
}

// ── 3. rank ──────────────────────────────────────────────────────────────────
function kindOf(path, base, tags) {
  if (tags.has('kind') && /^screen ?shot|^screenshot|^cleanshot/i.test(base)) return 'screenshot'
  if (/^(screen ?shot|screenshot|cleanshot|capture d.écran)/i.test(base)) return 'screenshot'
  return extKind[extname(base).slice(1).toLowerCase()] || null
}

const TAG_W = { name: 4, content: 3, kindany: 2, extra: 2, anyname: 1, kind: 1, date: 0 }
export async function rank(plan, hits, now = Date.now()) {
  const items = []
  // Stat the most promising 900 candidates in parallel (libuv pool), not thousands one by one.
  const cand = [...hits].map(([p, tags]) => [p, tags, [...tags].reduce((a, t) => a + (TAG_W[t] || 0), 0)])
    .sort((a, b) => b[2] - a[2]).slice(0, 900)
  const stats = await Promise.all(cand.map(([p]) => statAsync(p).catch(() => null)))
  for (let ci = 0; ci < cand.length; ci++) {
    const [path, tags] = cand[ci]
    const st = stats[ci]
    if (!st) continue
    const base = basename(path)
    const lower = base.toLowerCase()
    const stem = lower.replace(/\.[^.]+$/, '')
    const ext = extname(lower).slice(1)
    const kind = st.isDirectory() ? (ext === '' ? 'folder' : null) : kindOf(path, base, tags)
    if (st.isDirectory() && plan.kind !== 'folder' && !/\.(key|pages|numbers|rtfd)$/.test(lower)) continue
    const date = Math.max(st.mtimeMs, st.birthtimeMs || 0)
    let s = 0
    const why = []
    let nameHits = 0, kindOk = true
    for (const t of plan.terms) {
      if (lower.includes(t)) { nameHits++; s += 4; if (new RegExp('(^|[^a-z0-9])' + t.replace(/[.\-]/g, '\\$&') + '([^a-z0-9]|$)').test(stem)) s += 1.5 }
    }
    if (plan.terms.length && nameHits === plan.terms.length) { s += 3; why.push('name') }
    if (plan.terms.length && stem.replace(/[^a-z0-9]+/g, ' ').trim() === plan.terms.join(' ')) s += 3
    if (tags.has('content')) { s += nameHits ? 1.5 : 3.5; why.push('text') }
    else if (tags.has('kindany') && !nameHits) { s += 1.5; why.push('text') }
    if (plan.kind) {
      const ok = kind === plan.kind || (plan.kind === 'image' && kind === 'screenshot') ||
        (plan.kind === 'screenshot' && tags.has('kind')) || (plan.kind === 'image' && kind === 'pdf' && /scan|photo|passport|id|licen/.test(plan.text.toLowerCase()))
      s += ok ? 3 : -2
      if (ok) why.push(KINDS[plan.kind].label)
      kindOk = ok
    }
    if (plan.extraName && lower.includes(plan.extraName)) s += 3
    if (plan.kindWord && plan.kindWord.length > 2 && lower.includes(plan.kindWord)) s += 3
    const inRange = plan.range && ((st.mtimeMs >= plan.range.from && st.mtimeMs < plan.range.to) ||
      (st.birthtimeMs >= plan.range.from && st.birthtimeMs < plan.range.to) || tags.has('kind') || tags.has('date'))
    if (plan.range) { s += inRange ? 3 : -3; if (inRange) why.push(plan.range.label) }
    const ageDays = Math.max(0, (now - date) / 86_400_000)
    s += 1.5 * Math.exp(-ageDays / 45)
    if (plan.recent) s += 6 * Math.exp(-ageDays / 10)
    const dir = dirname(path)
    if ([join(HOME, 'Desktop'), join(HOME, 'Downloads'), join(HOME, 'Documents'), join(HOME, 'Pictures')].includes(dir) || path.startsWith(ICLOUD)) s += 1.2
    if (/\/(Projects|Developer|code|src|repos?)\//i.test(path)) s -= 0.8
    if (/\/(exports?|dist|build|out|tmp|cache|test|tests|fixtures?|bin)\//i.test(path)) s -= 0.6
    if (!ext && !st.isDirectory()) s -= 2
    if (CODE_EXT.has(ext) && !plan.code) s -= 8
    if (/ \(\d+\)\.[^.]+$/.test(base) || / copy(\.| \d)/.test(lower)) s -= 0.4
    items.push({ path, name: base, kind, date, size: st.size, score: Math.round(s * 100) / 100, why, dir: st.isDirectory(), kindOk, nameHits })
  }
  items.sort((a, b) => b.score - a.score || b.date - a.date)
  // Collapse near-duplicates ("Invoice.pdf", "Invoice (1).pdf", "Invoice (1) (1).pdf", "Invoice copy 2.pdf")
  // when they are the same size. A different size is a different version, so it stays.
  const seen = new Set(), out = []
  for (const it of items) {
    const key = dupName(it.name) + ':' + it.size
    if (seen.has(key)) continue
    seen.add(key); out.push(it)
  }
  return out
}

export const dupName = (name) => name.toLowerCase()
  .replace(/(?:\s*\(\d+\)|\s+copy(?:\s+\d+)?)+(?=\.[^.]+$|$)/g, '')

export async function search(plan, { timeoutMs = 1900 } = {}) {
  const qs = queries(plan)
  const t0 = Date.now()
  const at = (x) => x.where || plan.where
  let results = await Promise.all(qs.map((x) => mdfind(x.q, at(x), timeoutMs).then((ps) => [x.tag, ps])))
  // Spotlight is slow on a loaded Mac: if everything came back empty because queries were cut off,
  // give them one longer try rather than reporting "no match".
  if (results.every(([, ps]) => !ps.length) && results.some(([, ps]) => ps.killed)) {
    results = await Promise.all(qs.map((x) => mdfind(x.q, at(x), timeoutMs * 3).then((ps) => [x.tag, ps])))
  }
  // The filename query matters most; if Spotlight cut it off, give it one longer run.
  const ni = results.findIndex(([t, ps]) => t === 'name' && ps.killed && ps.length < 3)
  if (ni >= 0) { const x = qs.find((y) => y.tag === 'name'); results[ni] = ['name', await mdfind(x.q, plan.where, timeoutMs * 2)] }
  const hits = new Map()
  for (const [tag, ps] of results) for (const p of ps) { if (!hits.has(p)) hits.set(p, new Set()); hits.get(p).add(tag) }
  const t1 = Date.now()
  let ranked = await rank(plan, hits)
  // The user named a kind: a zip or an svg is not "the deck about wispr". Say nothing matched instead.
  if (plan.kind) ranked = ranked.filter((it) => it.kindOk)
  const counts = {}
  for (const [t, ps] of results) counts[t] = (counts[t] || 0) + ps.length
  const timedOut = results.filter(([, ps]) => ps.killed).map(([t]) => t)
  return { ranked, queries: qs, counts, timedOut, ms: { spotlight: t1 - t0, rank: Date.now() - t1 } }
}

// ── 4. thumbnails (Quick Look, cached; file icon as fallback) ─────────────────
const thumbKey = (it) => createHash('sha1').update(it.path + ':' + Math.round(it.date)).digest('hex').slice(0, 20)
function cachedThumb(dir) {
  try { const f = readdirSync(dir).find((x) => x.endsWith('.png')); return f ? join(dir, f) : null } catch { return null }
}

const ICON_JXA = `ObjC.import('AppKit');
function run(argv){ const ws=$.NSWorkspace.sharedWorkspace;
  for (let i=0;i<argv.length;i+=2){ const img=ws.iconForFile(argv[i]); img.size={width:256,height:256};
    const rep=$.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
    const png=rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG,$({}));
    png.writeToFileAtomically(argv[i+1],true);} return 'ok'; }`

export async function thumbnails(items, { budgetMs = 1300 } = {}) {
  mkdirSync(THUMBS, { recursive: true })
  const need = []
  for (const it of items) {
    const ext = extname(it.name).slice(1).toLowerCase()
    if (!it.dir && NATIVE_IMG.has(ext) && it.size < 60_000_000) { it.image = it.path; continue }
    const dir = join(THUMBS, thumbKey(it))
    const ql = cachedThumb(join(dir, 'ql'))
    if (ql) { it.image = ql; continue }
    mkdirSync(join(dir, 'ql'), { recursive: true })
    need.push([it, dir])
  }
  if (!need.length) return items
  // Quick Look in the background (detached): whatever finishes within the budget is used now,
  // the rest lands in the cache for next time.
  for (const [it, dir] of need) {
    if (it.dir) continue
    const p = spawn('qlmanage', ['-t', '-s', '360', '-o', join(dir, 'ql'), it.path], { stdio: 'ignore', detached: true })
    p.unref()
  }
  const iconArgs = []
  for (const [it, dir] of need) { const icon = join(dir, 'icon.png'); if (!existsSync(icon)) iconArgs.push(it.path, icon) }
  const icons = !iconArgs.length ? Promise.resolve()
    : existsSync(CLIP) ? run([CLIP, 'icon', ...iconArgs], { timeoutMs: budgetMs + 1500 })
    : run(['osascript', '-l', 'JavaScript', '-e', ICON_JXA, ...iconArgs], { timeoutMs: budgetMs + 1500 })
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline && need.some(([it, dir]) => !it.dir && !cachedThumb(join(dir, 'ql')))) await new Promise((r) => setTimeout(r, 80))
  await Promise.race([icons, new Promise((r) => setTimeout(r, Math.max(0, deadline + 400 - Date.now())))])
  for (const [it, dir] of need) {
    it.image = cachedThumb(join(dir, 'ql')) || (existsSync(join(dir, 'icon.png')) ? join(dir, 'icon.png') : undefined)
  }
  return items
}

// ── 5. card ──────────────────────────────────────────────────────────────────
const shortDir = (p) => {
  const d = dirname(p)
  if (d.startsWith(ICLOUD.slice(0, -1))) return 'iCloud' + d.slice(ICLOUD.length - 1)
  const rel = d.startsWith(HOME) ? d.slice(HOME.length + 1) : d
  const parts = rel.split('/').filter(Boolean)
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : (rel || '~')
}
const fmtDate = (ms) => {
  const d = new Date(ms), now = new Date()
  const days = Math.floor((dayStart(now) - dayStart(d)) / 86_400_000)
  if (days === 0) return 'today ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (days === 1) return 'yesterday'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}
export const detailOf = (it) => `${shortDir(it.path)} · ${fmtDate(it.date)}`

export async function frontmostApp() {
  const asn = (await run(['lsappinfo', 'front'], { timeoutMs: 1500 })).stdout.trim()
  if (!asn) return null
  return run(['lsappinfo', 'info', '-only', 'name', '-only', 'bundleid', asn], { timeoutMs: 1500 })
    .then((r) => {
      const name = (r.stdout.match(/"(?:LSDisplayName|name)"="([^"]+)"/i) || [])[1]
      const bundle = (r.stdout.match(/"CFBundleIdentifier"="([^"]+)"/) || [])[1]
      return name || bundle ? { name, bundle } : null
    }).catch(() => null)
}

const VERB = { paste: 'paste into', attach: 'attach in', copy: 'copy', reveal: 'show in Finder', open: 'open', path: 'copy the path' }

export function resolveAction(plan, front) {
  let a = plan.action
  if (front && /loginwindow|wb-card|wispr-bridge/i.test((front.name || '') + (front.bundle || ''))) front = null
  if (!a) a = front && /finder/i.test(front.name || front.bundle || '') ? 'reveal' : 'paste'
  return a
}

export function cardSpec(plan, items, action, front) {
  const what = [plan.terms.join(' '), plan.kind && KINDS[plan.kind].label, plan.range && plan.range.label].filter(Boolean).join(' · ')
  const target = plan.app ? plan.app[0].toUpperCase() + plan.app.slice(1) : front && front.name
  const verb = (action === 'paste' || action === 'attach') ? `${VERB[action]} ${target || 'the front app'}` : VERB[action]
  return {
    title: what ? `Found: ${what}` : 'Which file?',
    subtitle: `Pick one to ${verb}. Say "two", or "two, reveal it".`,
    options: items.map((it) => ({ label: it.name, detail: detailOf(it), image: it.image })),
    recommended: 1,
    at: 'center',
    focus: true,
    timeout: 180,
  }
}

// Spoken/typed follow-up on the card: "two", "the second one, reveal it", "3 and open".
export function parseReply(text, n) {
  const t = ' ' + String(text || '').toLowerCase() + ' '
  let pick = null
  // "one" alone is a pick only at the start ("one", "the one", "number one, open it"): "the blue one"
  // is a description, so it refines the search instead.
  const t1 = t.replace(/\b(?:the |that |this |a |any |blue |red |green |other |newer |older |big |small |\w+er )+one\b/g, (x) => /^(the |number |option |pick )?one$/.test(x.trim()) ? x : ' ')
  const m = t1.match(/\b([1-9])\b/) || t1.match(/\b(one|first|two|second|three|third|four|fourth|five|fifth|six|sixth)\b/)
  const m2 = m || t1.match(/\b(seven|seventh|eight|eighth|nine|ninth|ten|tenth|[1-9]\d)\b/)
  if (m2) pick = Number(m2[1]) || NUMWORDS[m2[1]]
  let outOfRange = false
  if (pick && pick > n) { pick = null; outOfRange = true }
  let action = null
  for (const [re, a] of ACTIONS) if (re.test(t)) { action = a; break }
  return outOfRange ? { pick, action, outOfRange } : { pick, action }
}

// ── 6. act on the pick ───────────────────────────────────────────────────────
const COPY_JXA = `ObjC.import('AppKit');
function run(argv){ const pb=$.NSPasteboard.generalPasteboard; pb.clearContents;
  const items=[]; for (const p of argv){ const url=$.NSURL.fileURLWithPath(p);
    const it=$.NSPasteboardItem.alloc.init; it.setStringForType(url.absoluteString,'public.file-url');
    const ext=p.split('.').pop().toLowerCase();
    const uti={png:'public.png',jpg:'public.jpeg',jpeg:'public.jpeg',gif:'com.compuserve.gif',tiff:'public.tiff',tif:'public.tiff',heic:'public.heic'}[ext];
    if (uti){ const d=$.NSData.dataWithContentsOfFile(p); if (d && d.length < 40000000) it.setDataForType(d, uti); }
    items.push(it);} return pb.writeObjects($(items)) ? 'ok' : 'fail'; }`

export async function copyFiles(paths) {
  const r = existsSync(CLIP) ? await run([CLIP, 'copy', ...paths], { timeoutMs: 8000 })
    : await run(['osascript', '-l', 'JavaScript', '-e', COPY_JXA, ...paths], { timeoutMs: 8000 })
  return r.stdout.trim() === 'ok'
}

async function pasteInto(front) {
  if (front && front.bundle) { await run(['open', '-b', front.bundle], { timeoutMs: 3000 }); await new Promise((r) => setTimeout(r, 350)) }
  if (existsSync(CLIP)) { const h = await run([CLIP, 'paste'], { timeoutMs: 3000 }); if (h.stdout.trim() === 'ok') return true }
  const r = await run(['osascript', '-e', 'tell application "System Events" to keystroke "v" using command down'], { timeoutMs: 6000 })
  return r.code === 0
}

const APP_NAMES = { mail: 'Mail', messages: 'Messages', imessage: 'Messages', slack: 'Slack', whatsapp: 'WhatsApp', notion: 'Notion', figma: 'Figma', discord: 'Discord', telegram: 'Telegram', chatgpt: 'ChatGPT', claude: 'Claude' }

export async function act(item, action, plan, front) {
  const B = await bridge()
  const p = item.path
  if (action === 'reveal') { await run(['open', '-R', p]); return { action, path: p } }
  if (action === 'open') { await run(['open', p]); return { action, path: p } }
  if (action === 'path') {
    await run(['pbcopy'], { input: p }); B.notify(p, { title: 'Path copied', ttl: 3 }); return { action, path: p }
  }
  if (action === 'attach' && plan.app === 'mail') { await run(['open', '-a', 'Mail', p]); return { action, app: 'Mail', path: p } }
  const copied = await copyFiles([p])
  if (!copied) { await run(['pbcopy'], { input: p }) }
  if (action === 'copy') { B.notify(`${item.name}. Press ⌘V to paste it.`, { title: 'Copied', ttl: 3 }); return { action, copied, path: p } }
  // paste / attach: bring the target app forward and press ⌘V.
  let target = front
  if (plan.app && APP_NAMES[plan.app] && (!front || !new RegExp(plan.app, 'i').test(front.name || ''))) {
    await run(['open', '-a', APP_NAMES[plan.app]], { timeoutMs: 4000 }); await new Promise((r) => setTimeout(r, 500)); target = null
  }
  const pasted = await pasteInto(target)
  if (!pasted) B.notify(`${item.name} is on the clipboard. Press ⌘V.`, { title: 'Copied', ttl: 4 })
  return { action, copied, pasted, app: (plan.app && APP_NAMES[plan.app]) || (front && front.name) || null, path: p }
}

// ── 7. optional model help (names + metadata only, never contents) ────────────
function leanClaude() {
  const f = [process.env.WISPR_BRIDGE_CLAUDE || 'claude', '-p', '--model', process.env.WISPR_FILE_MODEL || 'haiku', '--tools', '',
    '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', '--output-format', 'json']
  if (process.env.ANTHROPIC_API_KEY) f.push('--bare')
  return f
}
function extractJson(s) {
  try { const o = JSON.parse(s); if (typeof o.result === 'string') return extractJson(o.result); return o } catch {}
  const m = String(s || '').match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]) } catch {} }
  return null
}

// Request -> extra Spotlight name keywords (synonyms, likely filenames). Sends only the request text.
export async function expand(plan) {
  const prompt = `A Mac user asked to find a file: ${JSON.stringify(plan.text)}.
Reply with ONE JSON object only: {"terms": [3-6 short filename keywords or likely filename fragments, lowercase, single words],
"kind": one of "screenshot","image","pdf","deck","sheet","doc","video","audio","folder","archive" or null}.
Think about how such a file is usually named (e.g. passport -> "passport","pp","scan"; invoice -> "invoice","inv","bill","tax").`
  const r = await run(leanClaude(), { input: prompt, timeoutMs: Number(process.env.WISPR_FILE_CLAUDE_MS || 25_000), cwd: HOME })
  const o = extractJson(r.stdout)
  if (!o || !Array.isArray(o.terms)) return null
  return { terms: o.terms.map((x) => String(x).toLowerCase().replace(/[^a-z0-9_\-]/g, '')).filter((x) => x.length > 1).slice(0, 6), kind: KINDS[o.kind] ? o.kind : null }
}

// Re-rank the top candidates. Sends file names, folder, kind and date only.
export async function rerank(plan, items) {
  const list = items.slice(0, 25).map((it, i) => `${i + 1}. ${it.name} | ${shortDir(it.path)} | ${it.kind || 'file'} | ${new Date(it.date).toISOString().slice(0, 10)}`).join('\n')
  const prompt = `A Mac user asked: ${JSON.stringify(plan.text)}. Today is ${new Date().toISOString().slice(0, 10)}.
Candidate files (name | folder | kind | date). You only see names and metadata, not contents.
${list}
Reply with ONE JSON object only: {"order": [the numbers of the best matches, best first, at most 6]}.`
  const r = await run(leanClaude(), { input: prompt, timeoutMs: Number(process.env.WISPR_FILE_CLAUDE_MS || 25_000), cwd: HOME })
  const o = extractJson(r.stdout)
  if (!o || !Array.isArray(o.order)) return items
  const picked = o.order.map((n) => items[Number(n) - 1]).filter(Boolean)
  return [...new Set([...picked, ...items])]
}

// ── the whole flow ───────────────────────────────────────────────────────────
export async function findFlow(text, { hint = {}, dryRun = false, smart = false, max = 6, action: forced, timeout, pick, refined = false, local = false } = {}) {
  const T0 = Date.now()
  const ms = {}
  const frontP = frontmostApp()
  let plan = parse(text, hint)
  if (forced) plan.action = forced
  ms.parse = Date.now() - T0
  if (!plan.terms.length && !plan.kind && !plan.range && !plan.recent) {
    return { ok: false, error: 'nothing to search for', plan, ms }
  }
  // Claude is never called in a dry run unless --smart, and never with --local / WISPR_FILE_LOCAL=1.
  local = local || process.env.WISPR_FILE_LOCAL === '1'
  const mayAsk = !local && (!dryRun || smart)
  let s = await search(plan)
  Object.assign(ms, s.ms)
  let ranked = s.ranked
  let used = 'spotlight'
  let note = null
  const B = dryRun ? null : await bridge()

  // Relax locally before asking any model: drop the date (keep the words and the kind). The kind is
  // never dropped: "the deck about wispr" showing a zip and an svg is worse than "nothing matched".
  if (!ranked.length && plan.range) {
    const r2 = await search({ ...plan, range: null, recent: true })
    if (r2.ranked.length) { ranked = r2.ranked; used = 'spotlight-relaxed: dropped the date'; note = `Nothing from ${plan.range.label}. Closest:` }
  }
  let wouldAskClaude = false
  if (!ranked.length || smart) {
    if (!mayAsk) wouldAskClaude = !ranked.length && !local
    else {
      if (B) B.progress(ranked.length ? 'Asking Claude to rank file names…' : 'No exact match. Asking Claude for other names…', { id: 'wispr-file' })
      const tm = Date.now()
      if (!ranked.length) {
        const ex = await expand(plan)
        if (ex && ex.terms.length) {
          const plan2 = { ...plan, terms: [], kind: plan.kind || ex.kind }
          const merged = new Map()
          for (const t of ex.terms) {
            const r2 = await search({ ...plan2, terms: [t] })
            for (const it of r2.ranked) if (!merged.has(it.path) || merged.get(it.path).score < it.score) merged.set(it.path, it)
          }
          ranked = [...merged.values()].sort((a, b) => b.score - a.score || b.date - a.date)
          used = 'claude-expand'
          plan.expanded = ex.terms
        }
      } else {
        ranked = await rerank(plan, ranked)
        used = 'claude-rerank'
      }
      ms.claude = Date.now() - tm
      if (B) B.progress('', { id: 'wispr-file', done: true })
    }
  }

  const top = ranked.slice(0, max)
  let front = await frontP
  if (front && /loginwindow|wb-card/i.test((front.name || '') + (front.bundle || ''))) front = null
  const action = resolveAction(plan, front)
  if (!top.length) {
    if (B) B.notify(`Nothing on this Mac matches "${plan.text}"`, { title: 'Wispr File', ttl: 4 })
    return { ok: false, error: 'no matches', plan, ms, used, counts: s.counts, timedOut: s.timedOut, ...(wouldAskClaude ? { wouldAskClaude } : {}) }
  }
  const tt = Date.now()
  await thumbnails(top, { budgetMs: 1300 })
  ms.thumbs = Date.now() - tt
  ms.toOptions = Date.now() - T0
  const spec = cardSpec(plan, top, action, front)
  if (note) spec.subtitle = note + ' ' + spec.subtitle
  if (timeout) spec.timeout = timeout
  if (dryRun) {
    return { ok: true, dryRun: true, plan, action, front, used, counts: s.counts, timedOut: s.timedOut, ms,
      results: top.map((it) => ({ name: it.name, path: it.path, score: it.score, why: it.why, detail: detailOf(it), image: it.image })), spec }
  }

  // Ask the card. A number past the end ("nine" of 6) re-asks once; other free text refines the
  // search once (the reply is never fed back in a second time); after that it is a cancel.
  let pickN = pick || null
  let asked = 0
  while (!pickN) {
    const res = await B.present(spec)
    asked++
    if (res.pick) { pickN = res.pick; break }
    if (res.cancelled || !res.text) break
    const r = parseReply(res.text, top.length)
    if (r.pick) { pickN = r.pick; if (r.action) plan.action = r.action; break }
    if (r.outOfRange) {
      if (asked >= 2) break
      spec.subtitle = `There are only ${top.length}. Say a number from 1 to ${top.length}, or press Esc.`
      continue
    }
    if (refined) return { ok: false, cancelled: true, reason: 'reply not understood', reply: res.text, plan, ms }
    return findFlow(text + ' ' + res.text, { hint, smart, max, action: r.action || forced, timeout, refined: true, local })
  }
  if (!pickN) return { ok: false, cancelled: true, plan, ms }
  const item = top[pickN - 1]
  if (!item) return { ok: false, error: `no option ${pickN}`, plan, ms }
  const done = await act(item, resolveAction(plan, front), plan, front)
  return { ok: true, pick: pickN, file: item.path, ...done, used, ms }
}

// Pre-render Quick Look thumbnails for recent files in the usual places, so cards open with previews.
export async function warm({ days = 45, limit = 120 } = {}) {
  const since = `$time.iso(${isoDate(Date.now() - days * 86_400_000)})`
  const dirs = ['Desktop', 'Downloads', 'Documents'].map((d) => join(HOME, d))
  const lists = await Promise.all(dirs.map((d) => mdfind(`kMDItemFSContentChangeDate >= ${since} && kMDItemContentTypeTree != "public.folder"`, d, 20_000)))
  const paths = lists.flat().filter((p) => !NATIVE_IMG.has(extname(p).slice(1).toLowerCase()) && !CODE_EXT.has(extname(p).slice(1).toLowerCase()))
  const stats = await Promise.all(paths.map((p) => statAsync(p).then((st) => ({ path: p, name: basename(p), date: Math.max(st.mtimeMs, st.birthtimeMs || 0), size: st.size, dir: st.isDirectory() })).catch(() => null)))
  const items = stats.filter((x) => x && !x.dir).sort((a, b) => b.date - a.date).slice(0, limit)
  for (let i = 0; i < items.length; i += 8) await thumbnails(items.slice(i, i + 8), { budgetMs: 8000 })
  return { warmed: items.length }
}
