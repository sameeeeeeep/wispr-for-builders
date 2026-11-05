// wispr-wish — made for Wispr (unofficial). See ../README.md.
// On session start: link ~/.wispr-wish/bin/wispr-wish and register it with Wispr Bridge for the
// `convert` and `wish.run` intents. Adds /wish <what you said> · /wish ask · /wish test.
// Never opens the microphone: Wispr types the request; files come from the Finder selection.

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'wish',
        description: 'Wispr Wish: "make this a PDF", "a timer for 25 min", "a QR for this link"',
        argumentHint: '<what you want> | ask | test | doctor',
        immediate: true,
      })
    } catch {}
    try { await cli($, ['install'], 20) } catch {}
    return next(e)
  })

  on('command.run', { command: 'wish' }, async ($, e) => {
    const raw = (e.args || '').trim()
    if (!raw || raw === 'ask') return { text: 'wish → ' + (await cli($, ['ask'], 900)) }
    if (raw === 'doctor') return { text: await cli($, ['doctor'], 30) }
    if (raw === 'test') return { text: 'test → ' + (await cli($, ['a timer for 1 min'], 60)) }
    return { text: 'wish → ' + (await cli($, [raw], 1800)) }
  })
}

async function cli($, args, timeoutS) {
  $.ui.status('wispr wish…')
  try {
    const r = await $.process.run([$.plugin.root + '/bin/wispr-wish', ...args], { timeoutMs: timeoutS * 1000 })
    return (r.stdout || '').trim() || (r.stderr || '').trim() || 'no output'
  } finally {
    $.ui.status(undefined)
  }
}
