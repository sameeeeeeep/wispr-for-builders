// wispr-pm — made for Wispr (unofficial). See ../README.md.
// session.start: link ~/.wispr-pm/bin/wispr-pm and refresh the waiting-on-you pill at the notch.
// /pm <what you said> runs it like a dictated command; /pm ask opens the floating field for Wispr.
// Never opens the microphone: Wispr types the words.

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'pm',
        description: 'Wispr PM: "park this for portfolio" · "what\'s next on nailinit" · "what\'s waiting on me" · ask · board',
        argumentHint: '<what you said> | ask | board [project] | waiting',
        immediate: true,
      })
    } catch {}
    try { await cli($, ['install'], 20) } catch {}
    try { await cli($, ['notch'], 20) } catch {}
    return next(e)
  })

  on('command.run', { command: 'pm' }, async ($, e) => {
    const raw = (e.args || '').trim()
    if (!raw || raw === 'ask') return { text: 'pm → ' + (await cli($, ['ask'], 600)) }
    const [sub, ...rest] = raw.split(/\s+/)
    if (['board', 'projects', 'threads', 'doctor', 'notch', 'parse'].includes(sub)) return { text: await cli($, [sub, ...rest], 30) }
    return { text: 'pm → ' + (await cli($, [raw], 600)) }
  })
}

async function cli($, args, timeoutS) {
  $.ui.status('wispr pm…')
  try {
    const r = await $.process.run([$.plugin.root + '/bin/wispr-pm', ...args], { timeoutMs: Math.min(600, timeoutS) * 1000 })   // host max is 600000 ms
    return (r.stdout || '').trim() || (r.stderr || '').trim() || 'no output'
  } finally {
    $.ui.status(undefined)
  }
}
