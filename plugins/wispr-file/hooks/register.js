// Wispr File — find any file by voice. See ../README.md.
// On session start: link ~/.wispr-file/bin/wispr-file, register it as the wispr-bridge handler for
// file.find (so "find my passport photo" dictated into `wispr-bridge ask` lands here), and pre-render
// thumbnails for recent files in the background (at most every 6 hours).
// Adds /find <request> (e.g. /find the GST invoice from October, reveal it).
// Never opens the microphone; Spotlight and Quick Look run locally.

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'find',
        description: 'Wispr File: find a file by voice or text, pick from thumbnails',
        argumentHint: '<what to find>  e.g. the GST invoice from October',
        immediate: true,
      })
    } catch {}
    try { await cli($, ['install'], 20, false) } catch {}
    try { $.process.run([$.plugin.root + '/bin/wispr-file', 'warm', '--if-stale'], { timeoutMs: 600_000 }).catch(() => {}) } catch {}
    return next(e)
  })

  on('command.run', { command: 'find' }, async ($, e) => {
    const text = (e.args || '').trim()
    const raw = await cli($, text ? [text] : ['ask'], 300, true)
    let r = null; try { r = JSON.parse(raw) } catch {}
    if (!r) return { text: 'wispr-file → ' + raw }
    if (r.cancelled) return { text: 'wispr-file → cancelled' }
    if (!r.ok) return { text: `wispr-file → ${r.error || 'no match'}` }
    const how = { paste: r.pasted ? `pasted into ${r.app || 'the front app'}` : 'copied (press ⌘V)', copy: 'copied', reveal: 'shown in Finder', open: 'opened', path: 'path copied', attach: r.pasted ? `attached in ${r.app}` : 'copied (press ⌘V)' }[r.action] || r.action
    return { text: `wispr-file → ${r.file} (${how})` }
  })
}

async function cli($, args, timeoutS, status) {
  if (status) $.ui.status('finding…')
  try {
    const r = await $.process.run([$.plugin.root + '/bin/wispr-file', ...args], { timeoutMs: timeoutS * 1000 })
    return (r.stdout || '').trim() || (r.stderr || '').trim() || 'no output'
  } finally {
    if (status) $.ui.status(undefined)
  }
}
