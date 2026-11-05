// Wispr Review — background.
// Toolbar button or Option+Shift+R toggles review on the current site. Sites that are on get content.js on every
// page load (registered per hostname, like portfolio/build/review/extension). Also: screenshots for crops, and an
// optional local sink (wispr-review serve, 127.0.0.1:4377) that writes notes to ~/.wispr-review so Claude can read them.
const SINK = 'http://127.0.0.1:4377';
const host = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) || u.protocol === 'file:' ? (u.hostname || 'file') : null; } catch { return null; } };
const sites = async () => (await chrome.storage.local.get('sites')).sites || [];
const pat = (h) => (h === 'file' ? 'file:///*' : `*://${h}/*`);

async function register(list) {
  const old = await chrome.scripting.getRegisteredContentScripts({ ids: ['wr-ui'] }).catch(() => []);
  if (old.length) await chrome.scripting.unregisterContentScripts({ ids: ['wr-ui'] });
  if (list.length) await chrome.scripting.registerContentScripts([{ id: 'wr-ui', matches: list.map(pat), js: ['content.js'], runAt: 'document_idle' }]);
}
async function badge(tabId, url) {
  const on = (await sites()).includes(host(url));
  chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c5cff' }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(async () => register(await sites()));
chrome.runtime.onStartup.addListener(async () => register(await sites()));
chrome.tabs.onUpdated.addListener((id, info, tab) => { if (info.status === 'loading' || info.url) badge(id, tab.url); });
chrome.tabs.onActivated.addListener(async ({ tabId }) => { try { badge(tabId, (await chrome.tabs.get(tabId)).url); } catch {} });

async function toggle(tab) {
  const h = host(tab.url);
  if (!h) return;
  let list = await sites();
  const on = !list.includes(h);
  list = on ? [...list, h] : list.filter((x) => x !== h);
  await chrome.storage.local.set({ sites: list });
  await register(list);
  badge(tab.id, tab.url);
  if (on) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['untrusted.js', 'content.js'] }).catch(() => {});
    chrome.tabs.sendMessage(tab.id, { t: 'mode', on: true }).catch(() => {});
  } else chrome.tabs.sendMessage(tab.id, { t: 'quit' }).catch(() => {});
}
chrome.action.onClicked.addListener(toggle);
chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== 'toggle-review') return;
  tab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) return;
  // already on for this site: just flip voice mode in the page; else turn the site on
  if ((await sites()).includes(host(tab.url))) chrome.tabs.sendMessage(tab.id, { t: 'mode' }).catch(() => toggle(tab));
  else toggle(tab);
});

const sink = (path, method, body) => fetch(SINK + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) })).catch(() => ({ ok: false, body: { err: 'sink not running' } }));

// captureVisibleTab allows about 2 calls a second: space them out and retry once when Chrome says we went too fast
let lastCap = 0, capQ = Promise.resolve();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function capture(windowId) {
  const run = async () => {
    for (let i = 0; i < 3; i++) {
      const gap = lastCap + 550 - Date.now(); if (gap > 0) await wait(gap);
      lastCap = Date.now();
      // never let one stuck capture hold up the ones queued behind it
      try { return await Promise.race([chrome.tabs.captureVisibleTab(windowId, { format: 'png' }), wait(4000).then(() => { throw new Error('capture timed out'); })]); }
      catch (e) { if (!/MAX_CAPTURE|quota|per second/i.test(String(e)) || i === 2) throw e; }
    }
  };
  const p = capQ.then(run, run); capQ = p.catch(() => {}); return p;
}
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.t === 'shot') { capture(sender.tab.windowId).then((d) => reply({ d }), (e) => reply({ err: String(e) })); return true; }
  if (m.t === 'sink') { sink(m.path, m.method || 'GET', m.body).then(reply); return true; }
  if (m.t === 'off') { toggle(sender.tab).then(() => reply({})); return true; }
});
