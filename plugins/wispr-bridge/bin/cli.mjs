#!/usr/bin/env node
// wispr-bridge CLI — see API.md. Exit: 0 ok, 1 cancelled/no answer, 2 bad input, 3 helper/claude failed.
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))))
const B = await import(pathToFileURL(join(root, 'lib', 'bridge.mjs')).href)

const [cmd, ...rest] = process.argv.slice(2)
const BOOL = new Set(['dry-run', 'done', 'wait', 'no-route'])
const flag = (n) => {
  const i = rest.indexOf('--' + n); if (i < 0) return undefined
  if (BOOL.has(n)) { rest.splice(i, 1); return true }
  const v = rest[i + 1]; rest.splice(i, 2); return v
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const readSpec = (a) => {
  if (!a || a === '-') return JSON.parse(readFileSync(0, 'utf8'))
  if (a.startsWith('@')) return JSON.parse(readFileSync(a.slice(1), 'utf8'))
  return JSON.parse(a)
}

try {
  switch (cmd) {
    case 'present': {
      const r = await B.present(readSpec(rest[0])); out(r); process.exit(r.cancelled ? 1 : 0)
    }
    case 'notify': {
      const ttl = flag('ttl'); const title = flag('title'); const wait = flag('wait')
      await B.notify(rest.join(' '), { ttl: ttl ? Number(ttl) : 3, title, wait: !!wait }); break
    }
    case 'progress': {
      const id = flag('id'); const done = flag('done'); const title = flag('title')
      await B.progress(rest.join(' '), { id: id || 'default', done: !!done, title }); break
    }
    case 'classify': out(await B.classify(rest.join(' '))); break
    case 'route': {
      const dryRun = !!flag('dry-run'); out(await B.route(rest.join(' '), { dryRun })); break
    }
    case 'ask': {
      const noRoute = !!flag('no-route')
      const t = await B.ask({ placeholder: rest.join(' ') || undefined })
      if (!t) { out({ cancelled: true }); process.exit(1) }
      out(noRoute ? { text: t } : await B.route(t)); break
    }
    case 'register': out(B.register(rest[0], rest.slice(1))); break
    case 'unregister': out(B.unregister(rest[0])); break
    case 'handlers': out(B.handlers()); break
    case 'install': out({ home: B.installStable() }); break
    case 'doctor': {
      const helper = join(root, 'helper', 'wb-card')
      let claude = null; try { claude = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim() } catch {}
      out({ helper: existsSync(helper) ? helper : null, claude, handlers: B.handlers(), home: B.HOME_DIR }); break
    }
    default:
      process.stderr.write('usage: wispr-bridge present <json|@file|-> | notify <text> | progress <text> [--id x] [--done]\n' +
        '       | classify <text> | route <text> [--dry-run] | ask | register <intent> <cmd...> | unregister <intent>\n' +
        '       | handlers | install | doctor\n')
      process.exit(cmd ? 2 : 0)
  }
} catch (e) {
  process.stderr.write(String(e.message || e) + '\n'); process.exit(e.code === 2 ? 2 : 3)
}
