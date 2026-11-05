// node --test tests/  — parser and reply tests (no Spotlight, no UI).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse, parseReply, parseWhen, queries, dupName } from '../lib/find.mjs'

const NOW = new Date(2026, 10, 5, 12) // 5 Nov 2026

test('passport photo -> image kind, term passport, no action', () => {
  const p = parse('find my passport photo')
  assert.deepEqual(p.terms, ['passport']); assert.equal(p.kind, 'image'); assert.equal(p.action, null)
})
test('GST invoice from October -> two terms + October range', () => {
  const p = parse('the GST invoice from October')
  assert.deepEqual(p.terms, ['gst', 'invoice']); assert.equal(p.range.label, 'october')
})
test('last screenshot of the admin panel -> screenshot, recent', () => {
  const p = parse('last screenshot of the admin panel')
  assert.equal(p.kind, 'screenshot'); assert.equal(p.recent, true); assert.deepEqual(p.terms, ['admin', 'panel'])
})
test('actions and apps', () => {
  assert.equal(parse('reveal the q3 deck').action, 'reveal')
  assert.equal(parse('open the board resolution doc').action, 'open')
  assert.equal(parse('copy the path of my resume').action, 'path')
  const s = parse('attach the passport scan in slack'); assert.equal(s.app, 'slack'); assert.equal(s.action, 'attach')
})
test('where', () => { assert.match(parse('the logo on my desktop').where, /Desktop$/) })
test('dates', () => {
  assert.equal(new Date(parseWhen(' from october ', NOW).from).getMonth(), 9)
  assert.equal(new Date(parseWhen(' in december ', NOW).from).getFullYear(), 2025)
  assert.equal(parseWhen(' yesterday ', NOW).label, 'yesterday')
  assert.equal(parseWhen(' the may invoice ', NOW), null) // bare "may" is ambiguous
})
test('card replies', () => {
  assert.deepEqual(parseReply('two', 6), { pick: 2, action: null })
  assert.deepEqual(parseReply('the third one, reveal it', 6), { pick: 3, action: 'reveal' })
  assert.deepEqual(parseReply('3 and open it', 6), { pick: 3, action: 'open' })
  assert.equal(parseReply('nine', 6).pick, null)
  assert.equal(parseReply('nine', 6).outOfRange, true)
  assert.deepEqual(parseReply('the blue one please', 6), { pick: null, action: null })
  assert.equal(parseReply('number one, open it', 6).pick, 1)
})
test('bridge hint fills gaps', () => {
  const p = parse('find that thing', { query: 'q3 deck', kind: 'keynote', when: 'last week' })
  assert.equal(p.kind, 'deck'); assert.ok(p.range)
})
test('words + kind + date never adds a words-free kind query', () => {
  const qs = queries(parse('zzqqxxyyvv blorptasticqq pdf from march'))
  assert.ok(!qs.some((x) => x.tag === 'kind'))
  assert.ok(qs.every((x) => /zzqqxxyyvv/.test(x.q)))
})
test('kind-only image search is scoped to user folders', () => {
  const qs = queries(parse('images'))
  assert.ok(qs.length > 1 && qs.every((x) => x.tag === 'kind'))
  assert.ok(qs.filter((x) => x.where).every((x) => !/Projects/.test(x.where)))
})
test('duplicate names fold', () => {
  assert.equal(dupName('G&G Invoice (1) (1).pdf'), dupName('G&G Invoice.pdf'))
  assert.equal(dupName('Deck copy 2.key'), dupName('Deck.key'))
  assert.notEqual(dupName('report-2.pdf'), dupName('report-3.pdf'))
})
test('bridge where hint is a place, not a word', () => {
  const p = parse('GST invoice pdf October in downloads', { query: 'GST invoice', where: 'downloads' })
  assert.deepEqual(p.terms, ['gst', 'invoice']); assert.match(p.where, /Downloads$/)
})
