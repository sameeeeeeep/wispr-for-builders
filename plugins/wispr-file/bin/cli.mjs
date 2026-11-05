#!/usr/bin/env node
// Wispr File — find any file by voice.
//   wispr-file "find my passport photo"            search, show the card, act on the pick
//   wispr-file "<request>" --dry-run               print plan, timings and top hits (no card)
//   wispr-file "<request>" --smart                 also let Claude re-rank (file names + metadata only)
//   wispr-file "<request>" --local                 never call Claude (also WISPR_FILE_LOCAL=1)
//   wispr-file "<request>" --action reveal|open|copy|paste|path
//   wispr-file '{"intent":"file.find",...}'        as a wispr-bridge handler (intent JSON in argv[1])
//   wispr-file "<request>" --pick 1 --action copy  skip the card (tests, automations)
//   wispr-file ask                                 floating field: dictate the request with Wispr
//   wispr-file register                            register as the bridge's file.find handler
//   wispr-file warm                                pre-render thumbnails for recent Desktop/Downloads/Documents files
// Exit: 0 ok, 1 cancelled/no match, 2 bad input, 3 bridge missing.
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))))
const F = await import(pathToFileURL(join(root, 'lib', 'find.mjs')).href)
const args = process.argv.slice(2)
const has = (n) => { const i = args.indexOf('--' + n); if (i < 0) return false; args.splice(i, 1); return true }
const val = (n) => { const i = args.indexOf('--' + n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v }
const out = (o) => process.stdout.write(JSON.stringify(o, null, process.stdout.isTTY ? 2 : 0) + '\n')

const dryRun = has('dry-run'), smart = has('smart') || process.env.WISPR_FILE_SMART === '1', local = has('local')
const action = val('action'), max = Number(val('max') || 6), timeout = val('timeout'), pick = val('pick')

try {
  const first = (args[0] || '').trim()
  if (first === 'register') {
    const B = await F.bridge()
    out(B.register('file.find', [join(root, 'bin', 'wispr-file')])); process.exit(0)
  }
  if (first === 'warm') {
    const { statSync, writeFileSync, mkdirSync } = await import('node:fs')
    const stamp = join(F.STATE, 'warm.stamp')
    if (has('if-stale')) { try { if (Date.now() - statSync(stamp).mtimeMs < 6 * 3600_000) { out({ skipped: 'fresh' }); process.exit(0) } } catch {} }
    mkdirSync(F.STATE, { recursive: true }); writeFileSync(stamp, String(Date.now()))
    out(await F.warm()); process.exit(0)
  }
  if (first === 'install') {
    // Stable path any shell, hotkey tool or mod can call: ~/.wispr-file/bin/wispr-file
    const { mkdirSync, rmSync, symlinkSync } = await import('node:fs')
    mkdirSync(join(F.STATE, 'bin'), { recursive: true })
    const dst = join(F.STATE, 'bin', 'wispr-file'); try { rmSync(dst, { force: true }) } catch {}
    symlinkSync(join(root, 'bin', 'wispr-file'), dst)
    let handler = null
    try { const B = await F.bridge(); handler = B.register('file.find', [dst])['file.find'] } catch {}
    out({ bin: dst, bridgeHandler: handler }); process.exit(0)
  }
  if (first === 'unregister') { const B = await F.bridge(); out(B.unregister('file.find')); process.exit(0) }
  let text = args.join(' ').trim(), hint = {}
  if (first.startsWith('{')) {
    // Bridge handler: {"intent":"file.find","args":{"query","kind","where","when"},"text":"..."}
    const it = JSON.parse(first)
    hint = it.args || {}
    // "in downloads", not "downloads": a bare place would become a search word.
    text = it.text || [hint.query, hint.kind, hint.when, hint.where && 'in ' + hint.where].filter(Boolean).join(' ')
  } else if (dryRun && !text) {
    out({ ok: false, error: 'nothing to search for (a dry run never opens the ask field)' }); process.exit(2)
  } else if (first === 'ask' || !text) {
    const B = await F.bridge()
    text = await B.ask({ placeholder: 'Find a file… e.g. "the GST invoice from October"' })
    if (!text) { out({ cancelled: true }); process.exit(1) }
  }
  const r = await F.findFlow(text, { hint, dryRun, smart, max, action, timeout: timeout ? Number(timeout) : undefined, pick: pick ? Number(pick) : undefined, local })
  out(r)
  process.exit(r.ok ? 0 : 1)
} catch (e) {
  process.stderr.write(String(e && e.stack || e) + '\n')
  process.exit(e && e.code === 3 ? 3 : 2)
}
