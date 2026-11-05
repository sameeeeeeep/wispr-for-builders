#!/usr/bin/env node
// Wispr PM CLI. See ../README.md.
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as pm from '../lib/pm.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o, null, 1)) + '\n')
const BRIDGE_HOME = process.env.WISPR_BRIDGE_HOME || join(homedir(), '.wispr-bridge')
const BRIDGE = join(BRIDGE_HOME, 'bin', 'wispr-bridge')
const SELF = join(pm.HOME, 'bin', 'wispr-pm')
const flag = (f) => { const i = rest.indexOf(f); if (i >= 0) { rest.splice(i, 1); return true } return false }

function install({ chain = false } = {}) {
  mkdirSync(join(pm.HOME, 'bin'), { recursive: true })
  try { rmSync(SELF, { force: true }) } catch {}
  symlinkSync(join(pm.PKG_ROOT, 'bin', 'wispr-pm'), SELF)
  pm.projects()
  const res = { home: pm.HOME, bin: SELF, bridge: existsSync(BRIDGE) }
  if (chain && existsSync(BRIDGE)) {
    // Opt-in: sit in front of whoever handles wish.run / ask, take board phrasings, pass the rest on.
    const f = join(BRIDGE_HOME, 'intents.json'); let h = {}; try { h = JSON.parse(readFileSync(f, 'utf8')) } catch {}
    const cf = join(pm.HOME, 'chain.json'); let c = {}; try { c = JSON.parse(readFileSync(cf, 'utf8')) } catch {}
    const me = [SELF, 'handle']
    for (const intent of ['wish.run', 'ask']) {
      if (JSON.stringify(h[intent]) !== JSON.stringify(me)) { if (h[intent]) c[intent] = h[intent]; h[intent] = me }
    }
    writeFileSync(f, JSON.stringify(h, null, 2)); writeFileSync(cf, JSON.stringify(c, null, 2))
    res.chained = c
  }
  return res
}

function board(project) {
  const list = pm.cards(project)
  const open = list.filter((t) => !t.done)
  const lines = [`${project} — ${open.length} open (${list.length - open.length} done)`]
  for (const col of ['doing', 'review', 'todo', 'blocked', 'backlog']) {
    const c = open.filter((t) => t.col === col); if (!c.length) continue
    lines.push(`  ${col}:`); for (const t of c.slice(0, 12)) lines.push(`    - ${t.title}${t.prio ? ' [' + t.prio + ']' : ''}`)
  }
  return lines.join('\n')
}

const HELP = `Wispr PM — task boards by voice
  wispr-pm "<what you said>"        park / next / waiting / split / thread / done, by voice
  wispr-pm ask                      floating field: dictate with Wispr, Enter
  wispr-pm park [project] <text>    wispr-pm next [project]    wispr-pm waiting
  wispr-pm split [project] <dump>   wispr-pm thread [project] <card words>
  wispr-pm done [project] <words>   wispr-pm board [project]   wispr-pm projects | threads
  wispr-pm notch                    refresh the waiting-on-you pill
  wispr-pm parse "<text>"           show how a phrase is understood (no side effects)
  wispr-pm install [--chain]        link ~/.wispr-pm/bin; --chain also takes board phrasings from Wispr Bridge
Env: WISPR_PM_NOCARD=1 (no cards, take the recommended), WISPR_PM_HOME, WISPR_PM_SB_BOARD.`

// `wispr-pm park portfolio fix the hero` → explicit project as first word if it is one
function projAndText(words) {
  const ps = pm.projects()
  if (words.length && ps[words[0]]) return [words[0], words.slice(1).join(' ')]
  const f = pm.findProject(words.join(' '))
  return [f ? f.name : pm.currentProject(), words.join(' ')]
}

try {
  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h': out(HELP); break
    case 'install': out(install({ chain: flag('--chain') })); break
    case 'parse': out(pm.parse(rest.join(' '), { write: false })); break
    case 'ask': {
      const b = await import(join(BRIDGE_HOME, 'lib', 'bridge.mjs'))
      const text = await b.ask({ placeholder: 'park this for portfolio · what\'s next on nailinit · what\'s waiting on me', title: 'wispr pm' })
      if (!text) { out({ cancelled: true }); process.exit(1) }
      out(await pm.say(text)); break
    }
    case 'park': { const [p, t] = projAndText(rest); out(pm.park(p, t)); break }
    case 'next': case 'split': case 'thread': case 'done': {
      const words = rest.length ? rest : []
      const [p, t] = projAndText(words)
      const phrase = { next: `what's next on ${p}`, split: `split into tasks for ${p}: ${t}`, thread: `start a thread on ${p} for ${t}`, done: `mark ${t} done on ${p}` }[cmd]
      out(await pm.say(phrase)); break
    }
    case 'waiting': out(await pm.say("what's waiting on me")); break
    case 'board': { const [p] = projAndText(rest); out(board(p)); break }
    case 'projects': out(Object.fromEntries(Object.entries(pm.projects()).map(([k, v]) => [k, { dir: v.dir, tag: v.tag || null, open: pm.cards(k).filter((t) => !t.done).length }]))); break
    case 'threads': out(pm.threads()); break
    case 'thread-done': out(await pm.threadDone(rest[0], rest[1])); break
    case 'notch': out(await pm.refreshNotch()); break
    case 'snooze': { out(pm.snooze(Number(rest[0]) || 60)); await pm.refreshNotch(); break }
    case 'handle': {
      let json = rest[0]
      if (!json) { json = ''; for await (const c of process.stdin) json += c }
      out(await pm.handleIntent(json)); break
    }
    case 'doctor': out({ home: pm.HOME, bin: existsSync(SELF), bridge: existsSync(BRIDGE), projects: Object.keys(pm.projects()), waiting: pm.waiting().length }); break
    default: out(await pm.say([cmd, ...rest].join(' ')))
  }
} catch (e) {
  process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(3)
}
