// node --test tests/   (parser only: no files, cards or windows)
import test from 'node:test'
import assert from 'node:assert/strict'
import { parse } from '../lib/wish.mjs'

const cases = [
  ['make this a PDF', { kind: 'convert', to: 'pdf' }],
  ['compress this video for WhatsApp', { kind: 'convert', to: 'mp4' }],
  ['turn these PNGs into WebP', { kind: 'convert', to: 'webp' }],
  ['transcribe this audio', { kind: 'convert', to: 'transcript' }],
  ['turn this mov into a gif under five megs', { kind: 'convert', to: 'gif' }],
  ['resize these screenshots to 1200px', { kind: 'convert', to: 'same-image' }],
  ['a timer for 25 min', { kind: 'app', app: 'timer' }],
  ['set a pomodoro', { kind: 'app', app: 'timer' }],
  ['split this bill', { kind: 'app', app: 'split' }],
  ['a QR for this link', { kind: 'app', app: 'qr' }],
  ['make me a dice roller', { kind: 'app', app: 'gen' }],
]
for (const [text, want] of cases) test(text, () => { const got = parse(text); for (const k in want) assert.equal(got?.[k], want[k]) })

test('not ours', () => assert.equal(parse('fix the hero headline on my site'), null))
test('timer minutes', () => assert.equal(parse('a timer for my tea 4 minutes').params.minutes, 4))
test('gif size', () => assert.equal(parse('turn this into a gif under five megs').options.maxMB, 5))
test('split args', () => assert.deepEqual(parse('split 2400 rupees between 3 people with 10% tip').params, { amount: 2400, people: 3, tip: 10, currency: '₹' }))
test('destructive flag', () => assert.equal(parse('convert these to jpg and delete the originals').options.replace, true))
test('whatsapp size', () => assert.equal(parse('compress this for whatsapp').options.maxMB, 15))

// questions are answers, not wishes (the `ask` intent must not hijack them)
for (const q of ['what is the best QR code library for react', "what's a good tool for making a chart of my sales",
  'give me a quick summary of the board meeting', 'how do I convert a docx to pdf in python', 'can a QR code hold a vcard?'])
  test('question: ' + q, () => assert.equal(parse(q), null))
test('polite request still counts', () => assert.equal(parse('can you make this a PDF')?.to, 'pdf'))
test('target format, not source', () => assert.equal(parse('convert a docx to pdf')?.to, 'pdf'))
test('make this a word doc', () => assert.equal(parse('make this a word doc')?.to, 'docx'))
test('ask intent: no generated apps', () => assert.equal(parse('a dice roller', { builtinOnly: true }), null))
test('ask intent: built-in apps ok', () => assert.equal(parse('a timer for 2 min', { builtinOnly: true })?.app, 'timer'))
test('timer with no time is flagged', () => assert.equal(parse('set a timer').noDuration, true))
test('timer with a time is not', () => assert.equal(parse('set a timer for 3').noDuration, undefined))
