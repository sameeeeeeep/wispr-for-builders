#!/usr/bin/env node
// wispr-wish CLI. Made for Wispr (unofficial). See ../README.md.
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { wish, handleIntent, parse, convert, miniApp, PKG_ROOT, HOME } from '../lib/wish.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const BRIDGE = join(process.env.WISPR_BRIDGE_HOME || join(homedir(), '.wispr-bridge'), 'bin', 'wispr-bridge')
const SELF = join(HOME, 'bin', 'wispr-wish')

function install({ register = true } = {}) {
  mkdirSync(join(HOME, 'bin'), { recursive: true })
  try { rmSync(SELF, { force: true }) } catch {}
  symlinkSync(join(PKG_ROOT, 'bin', 'wispr-wish'), SELF)
  const res = { home: HOME, bin: SELF, registered: [] }
  if (register && existsSync(BRIDGE)) {
    // The bridge runs `<cmd> <intent-json>`: route both intents here.
    for (const intent of ['convert', 'wish.run', 'ask']) {
      const intents = join(process.env.WISPR_BRIDGE_HOME || join(homedir(), '.wispr-bridge'), 'intents.json')
      let h = {}; try { h = JSON.parse(readFileSync(intents, 'utf8')) } catch {}
      const want = [SELF, 'handle']
      if (JSON.stringify(h[intent]) !== JSON.stringify(want)) {
        h[intent] = want; writeFileSync(intents, JSON.stringify(h, null, 2))
      }
      res.registered.push(intent)
    }
  } else if (register) res.note = 'wispr-bridge not installed; wispr-wish still works on its own'
  return res
}

async function main() {
  try {
    if (!cmd || cmd === 'help' || cmd === '--help') {
      console.log(`wispr-wish (made for Wispr, unofficial)
  wispr-wish "<what you said>" [files...]    convert the Finder selection, or open a mini app
  wispr-wish ask                             floating field: dictate with Wispr, Enter
  wispr-wish parse "<text>"                  show how it was understood (no side effects)
  wispr-wish handle '<intent json>'          bridge handler (convert, wish.run, ask)
  wispr-wish install | uninstall | doctor`)
      return
    }
    if (cmd === 'install') return out(install())
    if (cmd === 'uninstall') {
      const intents = join(process.env.WISPR_BRIDGE_HOME || join(homedir(), '.wispr-bridge'), 'intents.json')
      let h = {}; try { h = JSON.parse(readFileSync(intents, 'utf8')) } catch {}
      for (const k of ['convert', 'wish.run', 'ask']) if (h[k] && h[k][0] === SELF) delete h[k]
      try { writeFileSync(intents, JSON.stringify(h, null, 2)) } catch {}
      return out({ ok: true, unregistered: ['convert', 'wish.run', 'ask'] })
    }
    if (cmd === 'parse') return out(parse(rest.join(' ')))
    if (cmd === 'doctor') {
      const { execFileSync } = await import('node:child_process')
      const has = (b) => { try { return execFileSync('/bin/sh', ['-c', `command -v ${b}`], { env: { ...process.env, PATH: process.env.PATH + ':/opt/homebrew/bin:/usr/local/bin' } }).toString().trim() } catch { return null } }
      return out({ bridge: existsSync(BRIDGE), ffmpeg: has('ffmpeg'), whisper_cli: has('whisper-cli'), whisper_py: has('whisper'), cwebp: has('cwebp'),
        pandoc: has('pandoc'), chrome: existsSync('/Applications/Google Chrome.app'), claude: has('claude'), installed: existsSync(SELF) })
    }
    if (cmd === 'handle') {
      let raw = rest[0]
      if (!raw || raw === '-') raw = readFileSync(0, 'utf8')
      return out(await handleIntent(JSON.parse(raw)))
    }
    if (cmd === 'ask') {
      const { ask } = await import(join(process.env.WISPR_BRIDGE_HOME || join(homedir(), '.wispr-bridge'), 'lib', 'bridge.mjs'))
      const text = await ask({ placeholder: 'Make this a PDF · a timer for 25 min · a QR for this link' })
      if (!text) { out({ cancelled: true }); process.exitCode = 1; return }
      return out({ text, ...(await wish(text)) })
    }
    if (cmd === 'convert') return out(await convert({ kind: 'convert', to: rest[0], options: {} }, rest.slice(1)))
    if (cmd === 'app') return out(await miniApp(parse(rest.join(' ')) || { kind: 'app', app: 'gen', idea: rest.join(' ') }))
    // Free text, then optional file paths at the end.
    const all = [cmd, ...rest]
    const files = []
    while (all.length > 1 && existsSync(all[all.length - 1].replace(/^~(?=\/)/, homedir()))) files.unshift(all.pop())
    out(await wish(all.join(' '), { files }))
  } catch (e) {
    out({ ok: false, error: e.message })
    process.exitCode = 3
  }
}
main()
