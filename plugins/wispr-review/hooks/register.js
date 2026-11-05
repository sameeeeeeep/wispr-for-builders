// wispr-review — made for Wispr (unofficial). On session start: link ~/.wispr-review/bin/wispr-review and start the
// local inbox the Chrome extension posts notes to. /wispr-review: notes · install · done <n> · doctor.
export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'wispr-review', description: 'Wispr Review: notes · install · done <n> · doctor', argumentHint: '[notes|install|done <n> [--site h]|doctor]', immediate: true })
    } catch {}
    try { await cli($, ['install'], 20) } catch {}
    try { await cli($, ['serve', '--daemon'], 20) } catch {}
    return next(e)
  })
  on('command.run', { command: 'wispr-review' }, async ($, e) => {
    const [sub = 'notes', ...rest] = (e.args || '').trim().split(/\s+/).filter(Boolean)
    if (sub === 'notes') return { text: await cli($, ['notes'], 20) }
    if (sub === 'install') return { text: await cli($, ['install'], 20) }
    if (sub === 'done') return { text: await cli($, ['done', ...rest], 20) }
    if (sub === 'doctor') return { text: await cli($, ['doctor'], 20) }
    return { text: 'usage: /wispr-review [notes | install | done <n> [what changed] | doctor]' }
  })
}
async function cli($, args, timeoutS) {
  const r = await $.process.run([$.plugin.root + '/bin/wispr-review', ...args], { timeoutMs: timeoutS * 1000 })
  return (r.stdout || '').trim() || (r.stderr || '').trim() || 'no output'
}
