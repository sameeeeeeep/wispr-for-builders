// wispr-guru — a second cursor for Claude. Guru points at things on your screen and walks you
// through them; each step moves on when you do it (or click Next / press ↵).
//
// All drawing is helper/guru, a one-shot native program (see ../API.md). This module gives Claude
// four tools (guide, point, present, look), the /guru command, and copies the helper to a stable
// path (~/.wispr-guru/guru) so the other Wispr pack mods can call it too.

const WAIT_S = 540

export function register(on) {
  on('session.start', async ($, e, next) => {
    project = (e.cwd || '').split('/').filter(Boolean).pop() || 'Claude'
    try { await installHelper($) } catch {}
    const reg = (t) => $.tool.register(t).catch(() => {})
    await reg({
      name: 'guide',
      description:
        'Walk the person through a task on their Mac, one step at a time, with a second cursor that points at the control to use and a small step card beside it. ' +
        'Call it once per step: it shows the step, waits for their reply, and returns it. The step moves on by itself when they do it (see until), or when they click Next or press return; they can also type or dictate a question into the card. Never tell them to say "done" or "next". ' +
        'Returns reply: next | back | where | stop | text (with what they said) | timeout, plus targetFound and the rect pointed at. ' +
        'The step also ends by itself when it is done: a click on a labelled control counts by default (reply next, auto: true). Use `until` for other signs of done: a value changing, something appearing or going away, a window title; `until: false` turns it off. ' +
        'Target the control by its visible label (found through Accessibility, follows the window if it moves) and the app; give x/y screen points from a `look` screenshot only when there is no label. ' +
        'On "where", call `look` and retry with a better target or a clearer step. On "text", answer what they said and continue. Before the first step, open the app if needed. ' +
        'Use it whenever the person asks how to do something in an app, says "show me", "guide me", "walk me through", or when a task needs them to click something only they can.',
      inputSchema: {
        type: 'object',
        properties: {
          say: { type: 'string', description: 'The step, short and imperative: "Click Wallpaper in the sidebar".' },
          detail: { type: 'string', description: 'Optional one line of help under the step.' },
          target: {
            type: 'object',
            description: 'What to point at.',
            properties: {
              label: { type: 'string', description: 'Visible text of the control (button title, sidebar row, menu item).' },
              app: { type: 'string', description: 'App name, e.g. "System Settings". Default: frontmost app.' },
              role: { type: 'string', description: 'Optional: button, row, menuitem, field, checkbox, tab, link.' },
              x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
              relativeTo: { type: 'string', enum: ['screen', 'window'] },
            },
          },
          task: { type: 'string', description: 'The whole task, shown in the card header: "Change your wallpaper".' },
          index: { type: 'number', description: 'This step number (1-based).' },
          total: { type: 'number', description: 'Total steps, if known.' },
          size: { type: 'string', enum: ['full', 'mini'], description: 'mini = a one-line pill for quick hints.' },
          until: {
            description: 'How Guru knows the step is done without being told (default for a labelled control that is not a text field: {click:true}). false = only voice/keys.',
            anyOf: [
              { type: 'boolean', enum: [false] },
              {
                type: 'object',
                properties: {
                  click: { type: 'boolean', description: 'A click inside the target.' },
                  axChanged: { type: 'object', properties: { label: { type: 'string' }, attr: { type: 'string', description: 'AXValue (default), AXSelected, AXFocused, AXTitle…' } }, description: 'An attribute of the target (or of the control named by label) changes.' },
                  appears: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], description: 'A control with this label shows up (a sheet, a dialog, a new tab).' },
                  gone: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], description: 'A control with this label goes away.' },
                  windowTitle: { type: 'string', description: "The app's front window title contains this." },
                },
              },
            ],
          },
        },
        required: ['say'],
      },
    })
    await reg({
      name: 'point',
      description: 'Point the second cursor at something on screen for a few seconds without waiting for a reply ("this one, here"). Same target shape as guide.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'object', description: 'label/app/role or x/y/w/h, as in guide.' },
          say: { type: 'string' },
          ttl: { type: 'number', description: 'Seconds to show it (default 4).' },
        },
        required: ['target'],
      },
    })
    await reg({
      name: 'present',
      description: 'Show the person up to 9 numbered options (or image tiles) in a card and wait for their pick. They click one or press 1-9, and can add a note in their own words ("1 but make it shorter"). Returns {pick, label} or {reply:"text", text}.',
      inputSchema: {
        type: 'object',
        properties: {
          say: { type: 'string', description: 'The question.' },
          options: {
            type: 'array',
            items: { type: 'object', properties: { label: { type: 'string' }, detail: { type: 'string' }, image: { type: 'string', description: 'Absolute path to an image.' } }, required: ['label'] },
          },
          at: { type: 'string', enum: ['cursor', 'notch', 'center'] },
        },
        required: ['say', 'options'],
      },
    })
    await reg({
      name: 'look',
      description: 'See the person\'s screen before guiding: returns a screenshot path (Read it to look), the app\'s front window rect, screen sizes in points, and controls whose label matches `find` with their rects. Coordinates are screen points, top-left origin.',
      inputSchema: {
        type: 'object',
        properties: { app: { type: 'string' }, find: { type: 'string', description: 'Label text to search for.' }, shot: { type: 'boolean', description: 'false skips the screenshot (faster).' } },
      },
    })
    try {
      await $.command.register({
        name: 'guru',
        description: 'Guru, your second cursor: /guru <what you want to do> · /guru test',
        argumentHint: '[how do I…] | test',
        immediate: true,
      })
    } catch {}
    return next(e)
  })

  // ── wispr back: when a long turn ends, play your sound and show a reply card for this thread ──
  on('prompt.submit', async ($, e, next) => {
    if (!(e.origin && e.origin.kind === 'plugin')) lastAsk = String(e.text || '').replace(/\s+/g, ' ').slice(0, 80)
    closeReplyCard()   // they answered here themselves
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      const cfg = await loadCfg($)
      if (cfg.back && !e.isAborted && (e.durationMs || 0) >= cfg.minTurnS * 1000) void offerReply($, cfg, r && r.text ? r.text : e.answer)
    } catch {}
    return r
  })

  on('command.run', { command: 'guru' }, async ($, e) => {
    const arg = (e.args || '').trim()
    const cfg = await loadCfg($)
    const [verb, ...rest] = arg.split(/\s+/)
    if (verb === 'sound') {
      const v = rest[0]
      if (v && v !== 'off' && !SOUNDS.includes(v)) return { text: 'sounds: ' + SOUNDS.join(' · ') + ' · off' }
      if (v) { if (rest[1] === 'here') cfg.projects[project] = v; else cfg.sound = v; await saveCfg($, cfg) }
      if (v && v !== 'off') await $.audio.play({ asset: 'sounds/' + v + '.wav' }).catch(() => {})
      return { text: 'guru sound: ' + soundFor(cfg) + (cfg.projects[project] ? ' (for ' + project + ')' : '') }
    }
    if (verb === 'mute' || verb === 'unmute') { cfg.mute = verb === 'mute'; await saveCfg($, cfg); return { text: 'guru sounds ' + (cfg.mute ? 'muted' : 'on') } }
    if (verb === 'quiet') {
      const m = (rest[0] || '').match(/^(\d{1,2})-(\d{1,2})$/)
      cfg.quiet = rest[0] === 'off' ? null : m ? [Number(m[1]), Number(m[2])] : cfg.quiet
      await saveCfg($, cfg)
      return { text: 'quiet hours: ' + (cfg.quiet ? cfg.quiet[0] + ':00–' + cfg.quiet[1] + ':00 (cards still show, no sound)' : 'off') }
    }
    if (verb === 'back') { cfg.back = rest[0] !== 'off'; await saveCfg($, cfg); return { text: 'wispr back ' + (cfg.back ? 'on' : 'off') } }
    if (verb === 'ping') { void offerReply($, cfg, 'Test: this thread is waiting on you. Hold your Wispr key and answer here.'); return { text: 'reply card shown' } }
    if (arg === 'test') {
      const r = await runGuru($, { mode: 'step', say: 'Guru is working.', detail: 'Click Next or press return.', task: 'Test', index: 1, total: 1, target: { label: 'Help', role: 'menuitem' } })
      return { text: 'guru test → ' + JSON.stringify(r) }
    }
    if (!arg) return { text: 'Usage: /guru <what you want to do> (e.g. /guru make this text bold) · test · ping · sound [meow|metal|pspsps|boop|off] [here] · mute · unmute · quiet 22-8|off · back on|off' }
    $.clock.after(50, () => $.prompt.submit({ text: guideAsk(arg) }))
    return { text: 'guru: ' + arg }
  })

  on('tool.call', { tool: 'mcp__wispr-guru__guide' }, async ($, e) => wrap(await runGuru($, withUntil({ ...pick(e), mode: 'step' }))))
  on('tool.call', { tool: 'mcp__wispr-guru__point' }, async ($, e) => wrap(await runGuru($, { ...pick(e), mode: 'point' })))
  on('tool.call', { tool: 'mcp__wispr-guru__present' }, async ($, e) => wrap(await runGuru($, { ...pick(e), mode: 'present' })))
  on('tool.call', { tool: 'mcp__wispr-guru__look' }, async ($, e) => wrap(await runGuru($, { ...pick(e), mode: 'look' })))
}

const KEYS = ['say', 'detail', 'target', 'task', 'index', 'total', 'size', 'options', 'at', 'ttl', 'app', 'find', 'shot', 'until']
// A step on a clickable control finishes when it is clicked, unless the caller said otherwise.
const TYPING_ROLES = /^(field|text|textfield|textarea|search|searchfield|combobox)$/i
function withUntil(spec) {
  if (spec.until === false) { const { until, ...rest } = spec; return rest }
  if (spec.until && typeof spec.until === 'object') return spec
  const t = spec.target
  if (t && t.label && !TYPING_ROLES.test(t.role || '')) return { ...spec, until: { click: true } }
  return spec
}
function pick(e) {
  const o = {}
  for (const k of KEYS) if (e[k] !== undefined) o[k] = e[k]
  return o
}

function wrap(r) {
  if (r && r.error) return { deny: 'guru: ' + r.error }
  return { result: JSON.stringify(r) }
}

function guideAsk(goal) {
  return [
    `/guru: the person wants to: "${goal}".`,
    '',
    'Guide them through it on their own screen with the wispr-guru tools; do not do it for them.',
    'Plan the steps, open the app if needed, call `look` to see where things are, then call `guide` once per step (say, target.label + target.app, index, total, task).',
    'Advance on reply "next"; on "where" call `look` again and re-point; on "back" repeat the previous step; on "text" answer them and carry on; on "stop" end.',
    'After the last step, check with `look` that it worked and tell them in one line. Never ask them to say "done" or "next": steps move on when they do them or click Next.',
  ].join('\n')
}

async function installHelper($) {
  // Stable path for the other pack mods; refreshed every session so it tracks this plugin's version.
  // fonts/ goes along so the copy draws in Figtree / EB Garamond too (the helper looks for ./fonts next to itself).
  await $.process.run(['/bin/sh', '-c', 'mkdir -p "$HOME/.wispr-guru" && cp -f "$1" "$HOME/.wispr-guru/guru" && chmod +x "$HOME/.wispr-guru/guru" && if [ -d "$2" ]; then rm -rf "$HOME/.wispr-guru/fonts" && cp -R "$2" "$HOME/.wispr-guru/fonts"; fi', 'sh', $.plugin.root + '/helper/guru', $.plugin.root + '/fonts'], { timeoutMs: 5000 })
}

async function runGuru($, spec) {
  $.ui.status(spec.mode === 'look' ? 'guru is looking' : spec.mode === 'point' ? 'guru is pointing' : 'guru: waiting for you')
  try {
    const r = await $.process.run([$.plugin.root + '/helper/guru', JSON.stringify({ timeout: WAIT_S, ...spec })], { timeoutMs: (WAIT_S + 15) * 1000 })
    const line = r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop()
    if (!line) return { error: 'the helper did not answer. ' + (r.stderr || '').trim().split('\n').slice(-2).join(' ') }
    return JSON.parse(line)
  } catch (err) {
    return { error: String(err?.message || err) }
  } finally {
    $.ui.status(undefined)
  }
}

// ── wispr back ──
const SOUNDS = ['meow', 'metal', 'pspsps', 'boop']
let project = 'Claude'
let lastAsk = ''
let replyCard = null   // the open reply card's spawn stream, if any

async function loadCfg($) {
  const saved = (await $.store.get('cfg').catch(() => null)) || {}
  return { back: true, sound: 'meow', mute: false, quiet: null, minTurnS: 20, ...saved, projects: { ...(saved.projects || {}) } }
}
async function saveCfg($, cfg) { await $.store.set('cfg', cfg) }
function soundFor(cfg) { return cfg.projects[project] || cfg.sound }
function quietNow(cfg) {
  if (!cfg.quiet) return false
  const h = new Date().getHours(), [a, b] = cfg.quiet
  return a <= b ? h >= a && h < b : h >= a || h < b
}
// `touch ~/.wispr-guru/mute` silences every session at once (and `rm` brings the sound back).
async function muteFile($) {
  const r = await $.process.run(['/bin/sh', '-c', 'test -e "$HOME/.wispr-guru/mute"'], { timeoutMs: 3000 }).catch(() => null)
  return !!r && r.exitCode === 0
}
function closeReplyCard() { if (replyCard) { try { replyCard.return() } catch {} replyCard = null } }

// One card per waiting thread (cards stack); the helper draws it without taking the keyboard, so
// typing elsewhere can't answer it. Click it (or hover), hold Fn, speak, ↵: the words go back here.
async function offerReply($, cfg, answer) {
  closeReplyCard()
  const s = soundFor(cfg)
  if (s !== 'off' && !cfg.mute && !quietNow(cfg) && !(await muteFile($))) $.audio.play({ asset: 'sounds/' + s + '.wav' }).catch(() => {})
  const spec = {
    mode: 'reply', task: project, say: lastAsk ? '“' + lastAsk + '”' : 'Claude finished',
    detail: String(answer || '').replace(/\s+/g, ' ').slice(0, 220), timeout: 3600,
  }
  const stream = $.process.spawn({ argv: [$.plugin.root + '/helper/guru', JSON.stringify(spec)] })
  replyCard = stream
  let out = ''
  try {
    for await (const piece of stream) if (piece && piece.stream === 'stdout') out += piece.text
  } catch {}
  if (replyCard === stream) replyCard = null
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop()
  if (!line) return
  const r = JSON.parse(line)
  if (r.reply === 'text' && r.text) await $.prompt.submit({ text: r.text, asUser: true }).catch(() => {})
}
