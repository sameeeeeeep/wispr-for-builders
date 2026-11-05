#!/usr/bin/env node
// wispr-review (made for Wispr, unofficial) — the local side of the Wispr Review Chrome extension.
//   wispr-review serve [--daemon]       local sink on 127.0.0.1:4377: the extension posts notes here, they land in ~/.wispr-review
//   wispr-review notes [--json] [--all] [--site host]   open notes as markdown (what Claude reads)
//   wispr-review done <n|id> [--site host] [what changed] / reopen <n|id> [--site host]
//   wispr-review install                stable path ~/.wispr-review/bin + prints the Chrome steps
//   wispr-review doctor | path
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, symlinkSync, unlinkSync, rmSync, openSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const U = createRequire(import.meta.url)(join(PKG, 'extension', 'untrusted.js'));
const HOME = process.env.WISPR_REVIEW_HOME || join(homedir(), '.wispr-review');
const FILE = join(HOME, 'notes.json'), MD = join(HOME, 'notes.md'), SHOTS = join(HOME, 'shots');
const PORT = Number(process.env.WISPR_REVIEW_PORT || 4377);
mkdirSync(SHOTS, { recursive: true });
// the extension's id is pinned by the "key" in extension/manifest.json; WISPR_REVIEW_EXT_IDS adds others (comma separated)
const EXT_IDS = ['cihnhajclopemnhjgalpoffmlklhleik', ...String(process.env.WISPR_REVIEW_EXT_IDS || '').split(',').map((x) => x.trim()).filter(Boolean)];
const ORIGINS = new Set(EXT_IDS.map((id) => `chrome-extension://${id}`));
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return []; } };
const save = (ns) => { writeFileSync(FILE + '.tmp', JSON.stringify(ns, null, 1)); renameSync(FILE + '.tmp', FILE); writeFileSync(MD, markdown(ns.filter((n) => n.status !== 'done'))); };
// page-derived fields are untrusted: the same split as the extension's Send to Claude (extension/untrusted.js)
const markdown = (list) => U.markdown(list, { ids: true });
// by id, or by number; a number that exists on more than one site needs --site
function find(ns, key, site) {
  const byId = ns.find((n) => n.id === key); if (byId) return { n: byId };
  const hits = ns.filter((n) => String(n.n) === String(key) && (!site || n.site === site));
  const sites = [...new Set(hits.map((n) => n.site))];
  if (sites.length > 1) return { err: `note ${key} exists on ${sites.join(', ')}: add --site <host> or use its id` };
  return { n: hits.sort((a, b) => b.ts - a.ts)[0] };
}

function serve() {
  const srv = http.createServer((req, res) => {
    const o = req.headers.origin || '';
    // only this extension (or curl with no Origin) may talk to the sink; a web page can't read or add notes.
    // The Host check stops DNS rebinding (a page on evil.com resolving to 127.0.0.1 sends Host: evil.com).
    if (!HOSTS.has(String(req.headers.host || '').toLowerCase())) { res.writeHead(403); return res.end(); }
    if (o && !ORIGINS.has(o)) { res.writeHead(403); return res.end(); }
    const js = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/health') return js(200, { ok: true, home: HOME });
    if (req.method === 'GET' && u.pathname === '/notes') {
      const site = u.searchParams.get('site');
      return js(200, { notes: load().filter((n) => !site || n.site === site).map(({ shot, ...n }) => n) });
    }
    if (req.method !== 'POST') return js(404, { err: 'not found' });
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4e6) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(raw); } catch { return js(400, { err: 'bad json' }); }
      const ns = load();
      if (u.pathname === '/notes') {
        if (!b.id || !/^[\w-]+$/.test(b.id) || typeof b.text !== 'string') return js(400, { err: 'need id and text' });
        let shot_path = null;
        if (typeof b.shot === 'string' && b.shot.startsWith('data:image/jpeg;base64,')) {
          shot_path = join(SHOTS, `${b.site || 'site'}-${b.n}-${b.id}.jpg`.replace(/[^\w.\-]/g, '_'));
          writeFileSync(shot_path, Buffer.from(b.shot.split(',')[1], 'base64'));
        }
        const { shot, ...rest } = b; const n = U.cleanNote(rest);
        n.shot_path = shot_path || U.shotOf(rest) || null;  // never a path the request made up (delete removes it)
        const i = ns.findIndex((x) => x.id === n.id);
        if (i >= 0) ns[i] = { ...ns[i], ...n }; else ns.push(n);
        save(ns); notify(`Note ${n.n} saved for Claude`);
        return js(201, { ok: true, shot_path: n.shot_path, path: FILE });
      }
      const n = ns.find((x) => x.id === b.id);
      if (!n) return js(404, { err: 'no such note' });
      if (u.pathname === '/notes/status') { n.status = b.status === 'done' ? 'done' : 'open'; save(ns); return js(200, { ok: true }); }
      if (u.pathname === '/notes/delete') { if (n.shot_path) rmSync(n.shot_path, { force: true }); save(ns.filter((x) => x !== n)); return js(200, { ok: true }); }
      js(404, { err: 'not found' });
    });
  });
  srv.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `already running on 127.0.0.1:${PORT}` : String(e)); process.exit(e.code === 'EADDRINUSE' ? 0 : 3); });
  srv.listen(PORT, '127.0.0.1', () => console.log(`wispr-review sink on http://127.0.0.1:${PORT} → ${FILE}`));
}
// a quiet toast through wispr-bridge when it's installed (never takes focus); silent otherwise
let lastToast = 0;
function notify(text) {
  const wb = join(homedir(), '.wispr-bridge/bin/wispr-bridge');
  if (process.env.WISPR_REVIEW_QUIET || !existsSync(wb) || Date.now() - lastToast < 4000) return;
  lastToast = Date.now();
  try { spawn(wb, ['notify', text, '--ttl', '2'], { stdio: 'ignore', detached: true }).unref(); } catch {}
}
async function up() { try { return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { return false; } }

const [cmd = 'help', ...args] = process.argv.slice(2);
const flag = (k) => { const i = args.indexOf(k); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = (k) => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };

if (cmd === 'serve') {
  if (flag('--daemon')) {
    if (await up()) { console.log(`already running on 127.0.0.1:${PORT}`); process.exit(0); }
    const log = openSync(join(HOME, 'sink.log'), 'a');
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: ['ignore', log, log] }).unref();
    for (let i = 0; i < 30 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100));
    console.log((await up()) ? `sink running on 127.0.0.1:${PORT} → ${FILE}` : 'sink failed to start, see ' + join(HOME, 'sink.log'));
  } else serve();
} else if (cmd === 'notes') {
  const json = flag('--json'), all = flag('--all'), site = opt('--site');
  const ns = load().filter((n) => (all || n.status !== 'done') && (!site || n.site === site));
  console.log(json ? JSON.stringify(ns, null, 1) : markdown(ns));
} else if (cmd === 'done' || cmd === 'reopen') {
  const site = opt('--site'), ns = load(), { n, err } = find(ns, args[0], site);
  if (err) { console.error(err); process.exit(2); }
  if (!n) { console.error(`no note ${args[0]}${site ? ' on ' + site : ''}`); process.exit(2); }
  n.status = cmd === 'done' ? 'done' : 'open';
  if (cmd === 'done' && args.length > 1) n.done_note = args.slice(1).join(' ').slice(0, 600);
  save(ns); console.log(`note ${n.n} (${n.id}) → ${n.status}`);
} else if (cmd === 'install') {
  mkdirSync(join(HOME, 'bin'), { recursive: true });
  const link = join(HOME, 'bin', 'wispr-review');
  try { unlinkSync(link); } catch {}
  symlinkSync(join(PKG, 'bin', 'wispr-review'), link);
  console.log(`linked ${link}\n\nChrome (once):\n  1. open chrome://extensions and turn on Developer mode\n  2. Load unpacked → ${join(PKG, 'extension')}\n  3. pin "Wispr Review", then on any site press Option+Shift+R (or click it)\n\nThen: ${link} serve --daemon   (so "Send to Claude" includes crops on disk)`);
} else if (cmd === 'doctor') {
  console.log(`package   ${PKG}\nhome      ${HOME}\nnotes     ${load().length} (${load().filter((n) => n.status !== 'done').length} open)\nsink      ${(await up()) ? 'running on 127.0.0.1:' + PORT : 'not running (wispr-review serve --daemon)'}\nbridge    ${existsSync(join(homedir(), '.wispr-bridge/bin/wispr-bridge')) ? 'found (toasts on save)' : 'not installed (optional)'}\nextension ${join(PKG, 'extension')}`);
} else if (cmd === 'path') console.log(join(PKG, 'extension'));
else console.log('usage: wispr-review serve [--daemon] | notes [--json] [--all] [--site h] | done <n> [--site h] [note] | reopen <n> [--site h] | install | doctor | path');
