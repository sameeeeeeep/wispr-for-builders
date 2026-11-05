// node --test test/   — present() against fake wb-card helpers (no window is drawn).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.mjs')
const dir = mkdtempSync(join(tmpdir(), 'wb-'))
const fake = (name, body) => { const f = join(dir, name); writeFileSync(f, '#!/bin/sh\n' + body + '\n'); chmodSync(f, 0o755); return f }
const present = (helper, spec, env = {}) => new Promise((res) => {
  execFile(process.execPath, [CLI, 'present', JSON.stringify(spec)], { env: { ...process.env, WB_CARD: helper, ...env } },
    (err, stdout) => res({ code: err ? err.code : 0, out: JSON.parse(stdout.trim().split('\n').pop()) }))
})
// the spec from the live bug: escaped quotes, a ’ and a ⌘, at center, details
const SPEC = { title: 'New Wispr card: hold Flow and say "two, but make it shorter"', at: 'center', timeout: 1,
  options: [{ label: 'Dictation works', detail: 'Wispr text lands in the field' }, { label: 'Paste works', detail: '⌘V lands, dictation doesn’t' }, { label: 'Neither', detail: 'The field takes nothing' }] }

test('the spec reaches the helper intact, with mode present', async () => {
  const echo = fake('echo', `printf '%s' "$1" > "${dir}/got.json"; echo '{"pick":2,"label":"Paste works"}'`)
  const r = await present(echo, SPEC)
  assert.deepEqual(r.out, { pick: 2, label: 'Paste works' })
  const got = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'got.json'), 'utf8'))
  assert.equal(got.mode, 'present'); assert.equal(got.title, SPEC.title); assert.equal(got.options[1].detail, SPEC.options[1].detail)
})

test('a slow start (longer than the old 15 s margin, scaled down) still returns the card’s own answer', async () => {
  // card timeout 1 s, margin 3 s; the helper takes 2.5 s to start and then times out itself
  const slow = fake('slow', `sleep 2.5; echo '{"cancelled":true,"timeout":true,"reason":"timeout"}'`)
  const r = await present(slow, SPEC, { WISPR_BRIDGE_MARGIN_S: '3' })
  assert.equal(r.out.reason, 'timeout'); assert.equal(r.code, 1)
})

test('a helper that never answers is reported as a timeout, not a helper failure', async () => {
  const hang = fake('hang', 'exec sleep 30')
  const r = await present(hang, SPEC, { WISPR_BRIDGE_MARGIN_S: '1' })
  assert.equal(r.out.reason, 'timeout'); assert.match(r.out.detail, /no answer in \d+s/)
})

test('a helper that dies says why', async () => {
  const dies = fake('dies', 'echo "dyld: something broke" >&2; exit 6')
  const r = await present(dies, SPEC)
  assert.equal(r.out.reason, 'helper'); assert.match(r.out.detail, /something broke/)
})
