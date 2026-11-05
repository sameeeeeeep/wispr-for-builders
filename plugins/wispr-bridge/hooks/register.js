// Wispr Bridge. See ../API.md.
// On session start: link ~/.wispr-bridge/{bin,lib} to this plugin so every pack mod and shell can
// call `~/.wispr-bridge/bin/wispr-bridge`. Adds /wispr: ask · route <text> · test · handlers.
// The mod never opens the microphone: voice arrives as text Wispr types into the card's field.

const T = 900

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'wispr',
        description: 'Wispr Bridge: ask · route <text> · test · handlers',
        argumentHint: '[ask|route <text>|test|handlers]',
        immediate: true,
      })
    } catch {}
    try { await cli($, ['install'], 20) } catch {}
    return next(e)
  })

  on('command.run', { command: 'wispr' }, async ($, e) => {
    const raw = (e.args || '').trim()
    const [sub, ...rest] = raw.split(/\s+/)
    const text = rest.join(' ')
    if (!sub || sub === 'ask') return { text: 'wispr → ' + (await cli($, ['ask'], T)) }
    if (sub === 'route') return { text: 'routed → ' + (await cli($, ['route', text], T)) }
    if (sub === 'classify') return { text: await cli($, ['classify', text], 120) }
    if (sub === 'handlers') return { text: await cli($, ['handlers'], 20) }
    if (sub === 'test') {
      const spec = {
        title: 'Wispr Bridge is working. Which layout do you like?',
        subtitle: 'Say "two", press 1-3, or click',
        options: [
          { label: 'Rows', detail: 'Numbered list, like the notch card' },
          { label: 'Tiles', detail: 'Image thumbnails numbered 1/2/3' },
          { label: 'Both', detail: 'Rows with a small thumbnail' },
        ],
        recommended: 2,
      }
      return { text: 'test card → ' + (await cli($, ['present', JSON.stringify(spec)], T)) }
    }
    return { text: 'usage: /wispr [ask | route <text> | classify <text> | test | handlers]' }
  })
}

async function cli($, args, timeoutS) {
  $.ui.status('wispr bridge…')
  try {
    const r = await $.process.run([$.plugin.root + '/bin/wispr-bridge', ...args], { timeoutMs: timeoutS * 1000 })
    return (r.stdout || '').trim() || (r.stderr || '').trim() || 'no output'
  } finally {
    $.ui.status(undefined)
  }
}
