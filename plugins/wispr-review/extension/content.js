// Wispr Review — the page UI.
// Voice mode: a small field follows the cursor and keeps keyboard focus, so Wispr Flow types into it. Point at
// something, hold fn and speak: when the words land, the element under the cursor is locked, a crop,
// selector and URL are taken, and the note saves itself ~2s later (Enter saves now, Esc drops it, keep talking to
// add more). Then point at the next thing. No clicking. Option tap locks/unlocks the element before you talk.
// Pins mark every note on the page; Walk (← →) steps back through them with a pointer card.
// Never touches the microphone: the words come from Wispr's own dictation, typed into the focused field.
// Selector + crop code reused from portfolio/build/review/extension/content.js.
(() => {
  if (window.__wispReview || !window.WRUntrusted) return;
  window.__wispReview = true;
  const PAGE = location.origin + location.pathname;
  const SITE = location.hostname || 'file';
  const AUTOSAVE_MS = 2200;

  // ------------------------------------------------------------ storage + background
  const store = {
    get: async () => (await chrome.storage.local.get('notes')).notes || [],
    set: (notes) => chrome.storage.local.set({ notes }),
  };
  const bg = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); }); } catch { res(null); } });

  // ------------------------------------------------------------ selector (reused)
  const clean = (s, n = 160) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const esc = (s) => (window.CSS?.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const DATA = ['data-testid', 'data-test', 'data-id', 'data-section', 'data-name', 'name', 'aria-label'];
  function step(el) {
    if (el.id && !/^\d|[:]/.test(el.id) && document.querySelectorAll('#' + esc(el.id)).length === 1) return { s: '#' + esc(el.id), anchor: true };
    let s = el.tagName.toLowerCase() + [...el.classList].filter((c) => !/^(is-|has-|wr-)|hover|active|focus|\d{3,}/.test(c)).slice(0, 2).map((c) => '.' + esc(c)).join('');
    for (const d of DATA) if (el.hasAttribute(d) && el.getAttribute(d).length < 60) { s += `[${d}="${el.getAttribute(d).replace(/"/g, '\\"')}"]`; break; }
    const sib = el.parentElement ? [...el.parentElement.children].filter((n) => { try { return n.matches(s); } catch { return false; } }) : [];
    if (sib.length > 1) s += `:nth-of-type(${[...el.parentElement.children].filter((n) => n.tagName === el.tagName).indexOf(el) + 1})`;
    return { s };
  }
  function selector(el) {
    const parts = [];
    for (let n = el; n && n !== document.body && n !== document.documentElement && n.nodeType === 1; n = n.parentElement) {
      const st = step(n);
      parts.unshift(st.s);
      try { if (document.querySelectorAll(parts.join(' > ')).length === 1 && (st.anchor || parts.length >= 3)) return parts.join(' > '); } catch { /* odd names */ }
      if (parts.length >= 8) break;
    }
    return parts.join(' > ');
  }
  const findEl = (n) => { try { const el = n.selector && document.querySelector(n.selector); if (el) return el; } catch { /* stale */ } return null; };
  function heading(el) {
    let best = null;
    for (const h of document.querySelectorAll('h1, h2, h3')) {
      if (h.contains(el) || h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = h; else break;
    }
    return best ? clean(best.textContent, 80) : null;
  }
  // the page URL without secrets: values of token-ish query params (and long opaque ones) are redacted
  const SECRET = /token|key|secret|auth|code|session|sig|pass|jwt|state|nonce|otp|ticket|cred/i;
  function safeUrl() {
    try {
      const u = new URL(location.href);
      for (const [k, v] of [...u.searchParams]) if (SECRET.test(k) || /^[\w\-.~+/=%]{24,}$/.test(v)) u.searchParams.set(k, 'REDACTED');
      if (u.hash && !u.hash.startsWith('#/')) u.hash = u.hash.length > 40 || /=/.test(u.hash) ? '' : u.hash;
      if (u.username || u.password) { u.username = ''; u.password = ''; }
      return u.href;
    } catch { return PAGE; }
  }
  const label = (el) => clean(el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.innerText || el.textContent || el.getAttribute('src') || '', 140);

  // ------------------------------------------------------------ crop of the real screen (reused)
  async function shot(rect) {
    host.style.opacity = "0"; // opacity, not visibility: hiding would blur the field Wispr types into
    let d = null;
    try {
      // hidden UI must be off the screen before the capture: two frames plus a beat (a hidden tab may not paint at all)
      await Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 90)))), new Promise((r) => setTimeout(r, 250))]);
      d = (await Promise.race([bg({ t: 'shot' }), new Promise((r) => setTimeout(() => r(null), 6000))]))?.d || null;
    } finally { host.style.opacity = ""; setTimeout(grabFocus, 0); }
    if (!d) return null;
    const img = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = d; });
    if (!img) return null;
    const k = img.width / innerWidth, pad = 24;
    const x0 = Math.max(0, rect.left - pad), y0 = Math.max(0, rect.top - pad);
    const r = { x: x0, y: y0, w: Math.min(innerWidth, rect.right + pad) - x0, h: Math.min(innerHeight, rect.bottom + pad) - y0 };
    if (r.w < 4 || r.h < 4) return null;
    const out = Math.min(1, 640 / Math.max(r.w * k, r.h * k));
    const c = document.createElement('canvas');
    c.width = Math.round(r.w * k * out); c.height = Math.round(r.h * k * out);
    const g = c.getContext('2d');
    g.drawImage(img, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, c.width, c.height);
    // mark the element inside the crop
    g.strokeStyle = '#ff6c4c'; g.lineWidth = 3;
    g.strokeRect((rect.left - r.x) * k * out, (rect.top - r.y) * k * out, rect.width * k * out, rect.height * k * out);
    for (const q of [0.75, 0.6, 0.45]) { const j = c.toDataURL('image/jpeg', q); if (j.length < 160_000) return j; }
    return null;
  }

  // ------------------------------------------------------------ UI in a shadow root (page CSS can't touch it)
  const host = document.createElement('wispr-review');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const root = host.attachShadow({ mode: 'closed' }); // closed: page scripts can't read or fill the note field
  root.innerHTML = `<style>
    /* Wispr Flow app look (wispr-theme/wispr.css tokens): sand-50 card, 1px sand-600 border, 12px radius, Figtree */
    :host{--ink:#1a1a1a;--bg:#fcfcfb;--fg:#1a1a1a;--fg2:#5b5b59;--mut:#71716e;--line:#eeebe3;--hover:#eeebe3;--mark:#ff6c4c;
      --sans:"Wispr Figtree","Figtree",-apple-system,BlinkMacSystemFont,system-ui,sans-serif;--ease:cubic-bezier(.05,.6,.4,.95);
      --shadow:0 20px 25px -5px rgb(26 26 26 / .1),0 8px 10px -6px rgb(26 26 26 / .1);font:14px/1.4 var(--sans);color:var(--fg)}
    *{box-sizing:border-box}
    .card,.dock,.toast,.walk{color:var(--fg);font:14px/1.4 var(--sans);text-align:left}
    .walk:focus{outline:none}
    .box{position:fixed;border:2px dashed var(--mark);border-radius:6px;background:rgb(255 108 76 / .06);pointer-events:none;transition:all .1s var(--ease)}
    .box.lock{border-style:solid;background:rgb(255 108 76 / .04)}
    .box[hidden],.pin[hidden],[hidden]{display:none!important}
    .tag{font:500 11.5px/1.3 var(--sans);position:absolute;left:16px;top:-24px;background:var(--ink);color:#fcfcfb;padding:3px 7px;border-radius:6px 6px 6px 0;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis}
    .card{position:fixed;width:324px;background:var(--bg);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);pointer-events:auto;padding:12px 12px 10px}
    .card.pill{width:auto;max-width:320px;padding:7px 12px;border-radius:9999px}
    .card.pill textarea{position:absolute;opacity:0;width:1px;height:1px;padding:0;border:0}
    .card.pill .hint{margin:0}
    .card.pill .bar{display:none}
    textarea{all:unset;display:block;width:100%;min-height:38px;max-height:140px;overflow:auto;white-space:pre-wrap;color:var(--fg);font:14px/1.4 var(--sans);caret-color:var(--ink)}
    .hint{color:var(--fg2);font:500 12.5px/1.3 var(--sans);margin-top:6px;display:flex;gap:7px;align-items:center;white-space:nowrap}
    .dot{width:7px;height:7px;border-radius:50%;background:var(--mark);flex:none;animation:p 1.6s infinite}
    @keyframes p{50%{opacity:.35}}
    .bar{height:3px;border-radius:2px;background:var(--line);margin-top:8px;overflow:hidden}.bar i{display:block;height:100%;width:0;background:var(--ink)}
    .bar.run i{width:100%;transition:width linear}
    .mk{display:inline-flex;align-items:center;height:20px;font:400 12px/1 var(--sans);color:#30302f;background:#fff;border:1px solid var(--line);border-radius:4px;padding:0 7px;box-shadow:0 2px 0 0 #d3ced6;vertical-align:1px}
    .toast .mk{height:18px;padding:0 6px;margin:0 1px}
    .cnt{display:inline-block;min-width:18px;margin-left:5px;padding:1px 5px;border-radius:6px;background:var(--hover);color:var(--fg2);font:500 11.5px/16px var(--sans);text-align:center}
    .cnt:empty,.cnt[data-n="0"]{display:none}
    button svg{width:14px;height:14px;display:block;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round}
    button.x{padding:7px}
    .pin{position:fixed;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;background:var(--ink);color:#fcfcfb;font:600 12px/24px var(--sans);text-align:center;pointer-events:auto;cursor:pointer;box-shadow:0 2px 8px rgb(26 26 26 / .3),0 0 0 2px #fff;transition:transform .15s var(--ease)}
    .pin.done{background:var(--hover);color:var(--fg2)}
    .pin.cur{transform:scale(1.2);box-shadow:0 0 0 2px #fff,0 0 0 6px rgb(255 108 76 / .45)}
    .dock{position:fixed;right:16px;bottom:16px;display:flex;align-items:center;gap:2px;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:6px;pointer-events:auto;box-shadow:var(--shadow)}
    .dock b{font:700 14px/1 var(--sans);letter-spacing:-.02em;padding:0 8px 0 6px;display:flex;align-items:center;gap:6px;white-space:nowrap}
    button{all:unset;cursor:pointer;color:var(--fg);padding:6px 10px;border-radius:8px;font:500 13px/1.2 var(--sans);white-space:nowrap;transition:background .15s var(--ease)}
    button:hover{background:var(--hover)} button.on{background:var(--hover)}
    button.primary{background:var(--ink);color:#fcfcfb} button.primary:hover{background:#464544}
    button:focus-visible{outline:2px solid var(--ink);outline-offset:1px}
    .walk{width:320px}
    .walk .top{display:flex;justify-content:space-between;align-items:center;color:var(--mut);font-size:12.5px;margin-bottom:8px}
    .walk p{margin:0 0 10px;font-size:14px;white-space:pre-wrap}
    .walk img{display:block;max-width:100%;max-height:160px;border-radius:8px;margin:0 0 10px;border:1px solid var(--line)}
    .walk .row{display:flex;gap:4px;flex-wrap:wrap}
    .walk .gone{color:#a6280b;font-size:12.5px;margin:-4px 0 8px}
    .arrow{position:fixed;width:0;height:0;pointer-events:none;border:9px solid transparent}
    .toast{position:fixed;left:50%;bottom:76px;transform:translateX(-50%);background:var(--ink);color:#fcfcfb;border-radius:8px;padding:9px 16px;font-weight:500;opacity:0;transition:opacity .15s var(--ease);pointer-events:none;white-space:nowrap}
    .toast.on{opacity:1}
    .toast{max-width:calc(100vw - 24px);overflow:hidden;text-overflow:ellipsis}
    .walk{max-width:calc(100vw - 16px)}
    @media (max-width:520px){
      .dock{right:8px;left:8px;bottom:8px;justify-content:space-between;gap:0;max-width:calc(100vw - 16px)}
      .dock .long{display:none}
      .dock button{padding:6px 7px}
    }
  </style>
  <div class="pins"></div>
  <div class="box" hidden><span class="tag"></span></div>
  <div class="arrow" hidden></div>
  <div class="card pill" hidden>
    <textarea spellcheck="false" aria-label="Review note (hold fn and speak, or type)"></textarea>
    <div class="hint"><span class="dot"></span><span class="msg">Point, then hold fn and speak</span></div>
    <div class="bar"><i></i></div>
  </div>
  <div class="card walk" hidden></div>
  <div class="dock">
    <b>Wispr Review</b>
    <button data-a="mode" title="Voice mode on/off (Option+Shift+R)">Voice</button>
    <button data-a="walk" title="Walk through this page's notes (← →)">Notes<span class="n cnt" data-n="0">0</span></button>
    <button data-a="claude" class="primary" title="Copy a prompt plus the notes for Claude">Send<span class="long"> to Claude</span></button>
    <button data-a="md" title="Download this site's notes as a Markdown file">Download</button>
    <button data-a="off" class="x" title="Turn review off for this site" aria-label="Turn review off"><svg viewBox="0 0 14 14"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg></button>
  </div>
  <div class="toast"></div>`;
  const $ = (s) => root.querySelector(s);
  const box = $('.box'), tag = $('.tag'), card = $('.card.pill'), ta = $('textarea'), msg = $('.msg'), barEl = $('.bar'), walkEl = $('.walk'),
    pinsEl = $('.pins'), arrow = $('.arrow'), dock = $('.dock'), toastEl = $('.toast'), modeBtn = $('[data-a=mode]'), walkBtn = $('[data-a=walk]');
  document.documentElement.append(host);
  // Figtree (SIL OFL) ships in the extension; registered under its own name so the page's fonts are untouched.
  try {
    const ff = new FontFace('Wispr Figtree', `url(${chrome.runtime.getURL('fonts/Figtree.ttf')})`, { weight: '300 900' });
    ff.load().then((f) => document.fonts.add(f)).catch(() => {});
  } catch {}

  let notes = [], mode = false, hoverEl = null, locked = null, mouse = { x: innerWidth / 2, y: innerHeight / 2 }, saveT = 0, dictated = false, walkI = -1, alive = true;
  const here = () => notes.filter((n) => n.page === PAGE).sort((a, b) => a.n - b.n);
  const siteNotes = () => notes.filter((n) => n.site === SITE).sort((a, b) => a.n - b.n);

  const ac = new AbortController(), sig = { signal: ac.signal };
  let toastT = 0;
  const toast = (t, ms = 2200, html = false) => { if (html) toastEl.innerHTML = t; else toastEl.textContent = t; toastEl.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('on'), ms); };
  const mine = (n) => n === host || host.contains(n);
  const under = (x, y) => document.elementsFromPoint(x, y).find((n) => !mine(n) && n !== document.documentElement && n !== document.body) || null;
  const editable = (el) => el && el !== host && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  function outline(el, isLock) {
    if (!el) { box.hidden = true; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left - 3 + 'px', top: r.top - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px' });
    tag.textContent = (el.tagName.toLowerCase() + (el.id ? '#' + el.id : el.classList[0] ? '.' + el.classList[0] : '')) + (label(el) ? ' · ' + label(el).slice(0, 40) : '');
    box.classList.toggle('lock', !!isLock);
    box.hidden = false;
  }
  function placeCard() {
    if (card.hidden) return;
    const w = card.offsetWidth, h = card.offsetHeight;
    let x, y;
    if (locked) {
      const r = locked.getBoundingClientRect();
      x = Math.min(Math.max(8, r.left), innerWidth - w - 8);
      y = r.bottom + 10 + h < innerHeight ? r.bottom + 10 : r.top - h - 30 > 8 ? r.top - h - 30 : Math.min(innerHeight - h - 8, mouse.y + 18);
    } else { x = Math.min(mouse.x + 16, innerWidth - w - 8); y = Math.min(mouse.y + 20, innerHeight - h - 8); }
    Object.assign(card.style, { left: Math.max(8, x) + 'px', top: Math.max(8, y) + 'px' });
  }
  function setHint() {
    const has = ta.value.trim().length > 0;
    card.classList.toggle('pill', !has && !locked);
    if (!has) msg.innerHTML = locked ? 'Locked. Hold <span class="mk">fn</span> and speak, or tap <span class="mk">option</span> to unlock' : 'Point at something, then hold <span class="mk">fn</span> and speak';
    else if (dictated) msg.innerHTML = 'Saving… <span class="mk">return</span> to save now <span class="mk">esc</span> to drop';
    else msg.innerHTML = '<span class="mk">return</span> to save <span class="mk">shift return</span> for a new line <span class="mk">esc</span> to drop';
    placeCard();
  }
  const grabFocus = () => { if (alive && mode && walkI < 0 && root.activeElement !== ta && !editable(document.activeElement)) ta.focus({ preventScroll: true }); };

  function setMode(on, remember = true) {
    mode = on;
    if (remember) chrome.storage.local.get('voice').then((o) => { const v = typeof o.voice === 'object' && o.voice ? o.voice : {}; v[SITE] = on; chrome.storage.local.set({ voice: v }); }).catch(() => {});
    modeBtn.classList.toggle('on', on);
    card.hidden = !on;
    if (on) { stopWalk(); hoverEl = under(mouse.x, mouse.y); outline(hoverEl); setHint(); grabFocus(); toast('Voice review is on. Point, hold <span class="mk">fn</span>, and speak.', 2600, true); }
    else { clearDraft(); outline(null); ta.blur(); }
  }
  function clearDraft() { ta.value = ''; dictated = false; locked = null; clearTimeout(saveT); barEl.classList.remove('run'); if (mode) { outline(hoverEl); setHint(); } }
  function lock(el) { locked = el || hoverEl; if (locked) outline(locked, true); setHint(); }

  function armAutosave() {
    clearTimeout(saveT);
    barEl.classList.remove('run'); const i = barEl.firstElementChild; i.style.transitionDuration = '0ms'; void i.offsetWidth;
    if (!dictated || !ta.value.trim()) return;
    i.style.transitionDuration = AUTOSAVE_MS + 'ms'; barEl.classList.add('run');
    saveT = setTimeout(save, AUTOSAVE_MS);
  }

  // Snapshot the draft and clear the field BEFORE any await, so words that land while a crop is being taken start
  // the next note instead of being wiped. Saves run one after another (Chrome allows ~2 captures a second).
  let queue = Promise.resolve();
  function save() {
    clearTimeout(saveT);
    const text = ta.value.trim();
    const el = locked || hoverEl;
    if (!text || !el) return queue;
    const snap = {
      text, el, via: dictated ? 'wispr' : 'typed', url: safeUrl(), title: clean(document.title, 100),
      r: el.getBoundingClientRect(), sx: scrollX, sy: scrollY,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, scroll_y: Math.round(scrollY) },
    };
    ta.value = ''; dictated = false; locked = null; barEl.classList.remove('run');
    if (mode && walkI < 0) { hoverEl = under(mouse.x, mouse.y); outline(hoverEl); setHint(); }
    queue = queue.then(() => persist(snap)).catch(() => toast('Could not save that note. Try again.'));
    return queue;
  }
  async function persist({ text, el, via, url, title, r, sx, sy, viewport }) {
    // crop where the element is now (the page may have scrolled since); skip it if it left the screen
    const now = el.isConnected ? el.getBoundingClientRect() : null;
    const onScreen = now && now.bottom > 0 && now.top < innerHeight && now.right > 0 && now.left < innerWidth;
    const crop = onScreen ? await shot(now) : null;
    const all = await store.get();
    const n = {
      id: 'wr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      n: Math.max(0, ...all.filter((x) => x.site === SITE).map((x) => x.n)) + 1,
      ts: Date.now(), status: 'open', site: SITE, url, page: PAGE, title,
      text, selector: selector(el), element: { tag: el.tagName.toLowerCase(), text: label(el), section: heading(el) },
      rect: { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) },
      viewport, via, shot: crop,
    };
    Object.assign(n, WRUntrusted.cleanNote(n));  // page-derived fields are cleaned and capped before they're stored
    all.push(n); await store.set(all); notes = all;
    const s = await bg({ t: 'sink', path: '/notes', method: 'POST', body: n });
    if (s?.ok && s.body?.shot_path) { n.shot_path = s.body.shot_path; await store.set(notes); }
    if (!alive) return;
    toast(`Note ${n.n} saved${crop ? '' : ', without a screenshot'}`);
    renderPins();
  }

  // ------------------------------------------------------------ input: Wispr types into the textarea
  ta.addEventListener('input', (e) => {
    if (!ta.value.trim()) { clearDraft(); return; }
    if (!locked) lock(hoverEl);
    const chunk = e.inputType === 'insertFromPaste' || e.inputType === 'insertReplacementText' || (e.data && e.data.length > 2) || e.inputType === undefined;
    dictated = chunk ? true : (e.inputType?.startsWith('insert') ? false : dictated);
    setHint(); armAutosave();
  });
  let altAlone = false;
  ta.addEventListener('keydown', (e) => {
    const empty = !ta.value.trim();
    if (e.key === 'Alt') { altAlone = true; return; }
    altAlone = false;
    if (e.key === 'Fn' && !locked) { lock(hoverEl); return; }   // Chrome reports the Fn key on some Macs: lock as you start talking
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!empty) save(); return; }
    if (e.key === 'Escape') { e.preventDefault(); if (!empty || locked) clearDraft(); else setMode(false); return; }
    if (!empty) { if (dictated && e.key.length === 1) { dictated = false; armAutosave(); setHint(); } return; }
    // empty field: let the page scroll and walk the notes
    const sc = { ArrowDown: 60, ArrowUp: -60, PageDown: innerHeight * 0.85, PageUp: -innerHeight * 0.85, ' ': innerHeight * 0.85 }[e.key];
    if (sc != null && !e.metaKey) { e.preventDefault(); scrollBy({ top: e.shiftKey && e.key === ' ' ? -sc : sc, behavior: 'smooth' }); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); startWalk(e.key === 'ArrowRight' ? 0 : here().length - 1); }
  });
  ta.addEventListener('keyup', (e) => { if (e.key === 'Alt' && altAlone) { altAlone = false; if (ta.value.trim()) return; locked ? clearDraft() : lock(hoverEl); } });
  ta.addEventListener('blur', () => setTimeout(grabFocus, 0));
  addEventListener('focus', () => setTimeout(grabFocus, 50), sig);
  document.addEventListener('pointerdown', (e) => {
    if (!mode || mine(e.target)) return;
    if (e.altKey) { e.preventDefault(); e.stopPropagation(); lock(under(e.clientX, e.clientY)); }  // Option-click: lock that element
  }, { capture: true, signal: ac.signal });
  addEventListener('pointermove', (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    if (!mode || walkI >= 0) return;
    if (!locked) { const el = under(e.clientX, e.clientY); if (el !== hoverEl) { hoverEl = el; outline(el); } }
    placeCard();
    if (!editable(document.activeElement)) grabFocus();
  }, { passive: true, signal: ac.signal });

  // ------------------------------------------------------------ pins + walk (the guide element)
  function pinXY(n) {
    const el = findEl(n);
    if (el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, r, found: true }; }
    return { x: n.rect.x - scrollX, y: n.rect.y - scrollY, r: new DOMRect(n.rect.x - scrollX, n.rect.y - scrollY, n.rect.w, n.rect.h), found: false };
  }
  function renderPins() {
    const list = here();
    const cnt = walkBtn.querySelector('.n'); cnt.textContent = list.length; cnt.dataset.n = list.length;
    pinsEl.replaceChildren(...list.map((n, i) => {
      const p = document.createElement('div');
      p.className = 'pin' + (n.status === 'done' ? ' done' : '');
      p.textContent = n.n; p.title = n.text; p.dataset.i = i;
      p.addEventListener('click', () => startWalk(i));
      return p;
    }));
    tick();
  }
  function tick() {
    const list = here();
    [...pinsEl.children].forEach((p, i) => {
      const n = list[i]; if (!n) return;
      const { x, y } = pinXY(n);
      const vis = y > -20 && y < innerHeight + 20 && x > -20 && x < innerWidth + 20;
      p.hidden = !vis; p.style.left = Math.max(12, x) + 'px'; p.style.top = Math.max(12, y) + 'px';
      p.classList.toggle('cur', i === walkI);
    });
    if (walkI >= 0) placeWalk();
    else if (mode) { if (locked) outline(locked, true); placeCard(); }
  }
  let raf = 0;
  const soon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; tick(); }); };
  addEventListener('scroll', soon, { passive: true, capture: true, signal: ac.signal });
  addEventListener('resize', soon, sig);
  const iv = setInterval(soon, 700); // layout shifts the page makes on its own

  function startWalk(i) {
    const list = here();
    if (!list.length) { toast('No notes on this page yet'); return; }
    clearDraft(); card.hidden = true; box.hidden = true;
    walkI = (i + list.length) % list.length;
    walkBtn.classList.add('on');
    const n = list[walkI], el = findEl(n);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); else scrollTo({ top: n.rect.y - innerHeight / 3, behavior: 'smooth' });
    walkEl.innerHTML = '';
    const top = document.createElement('div'); top.className = 'top';
    top.innerHTML = `<span>Note ${n.n} · ${walkI + 1} of ${list.length}${n.status === 'done' ? ' · done' : ''}</span><span><span class="mk">←</span> <span class="mk">→</span> <span class="mk">esc</span></span>`;
    const p = document.createElement('p'); p.textContent = n.text;
    walkEl.append(top, p);
    if (!el) { const g = document.createElement('div'); g.className = 'gone'; g.textContent = 'Element not found any more; showing where it was.'; walkEl.append(g); }
    if (n.shot) { const im = document.createElement('img'); im.src = n.shot; im.alt = 'Crop at the time of the note'; walkEl.append(im); }
    const row = document.createElement('div'); row.className = 'row';
    const b = (t, f) => { const x = document.createElement('button'); x.textContent = t; x.addEventListener('click', f); row.append(x); return x; };
    b('‹ Prev', () => startWalk(walkI - 1)); b('Next ›', () => startWalk(walkI + 1));
    b(n.status === 'done' ? 'Reopen' : 'Done', () => setStatus(n, n.status === 'done' ? 'open' : 'done'));
    b('Delete', () => del(n)); b('Close', stopWalk);
    walkEl.append(row);
    walkEl.hidden = false; arrow.hidden = false;
    walkEl.tabIndex = -1; walkEl.focus({ preventScroll: true });
    renderPins();
  }
  function stopWalk() {
    if (walkI < 0) return;
    walkI = -1; walkEl.hidden = true; arrow.hidden = true; walkBtn.classList.remove('on'); box.hidden = true;
    renderPins();
    if (mode) { card.hidden = false; hoverEl = under(mouse.x, mouse.y); outline(hoverEl); setHint(); grabFocus(); }
  }
  function placeWalk() {
    const n = here()[walkI]; if (!n) return stopWalk();
    const { r } = pinXY(n);
    outline(findEl(n), true); if (!findEl(n)) { Object.assign(box.style, { left: r.left - 3 + 'px', top: r.top - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px' }); tag.textContent = 'was here'; box.hidden = false; }
    const w = walkEl.offsetWidth, h = walkEl.offsetHeight;
    const below = r.bottom + 14 + h < innerHeight;
    const x = Math.min(Math.max(8, r.left), innerWidth - w - 8), y = below ? r.bottom + 14 : Math.max(8, r.top - h - 14);
    Object.assign(walkEl.style, { left: x + 'px', top: y + 'px' });
    const ax = Math.min(Math.max(x + 14, r.left + Math.min(r.width / 2, 40)), x + w - 24);
    Object.assign(arrow.style, below
      ? { left: ax + 'px', top: y - 18 + 'px', borderBottomColor: '#fcfcfb', borderTopColor: 'transparent' }
      : { left: ax + 'px', top: y + h + 'px', borderTopColor: '#fcfcfb', borderBottomColor: 'transparent' });
  }
  walkEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); startWalk(walkI + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); startWalk(walkI - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); stopWalk(); }
    else if (e.key === 'd' || e.key === 'Enter') { const n = here()[walkI]; if (n) setStatus(n, n.status === 'done' ? 'open' : 'done'); }
  });
  async function setStatus(n, status) {
    const all = await store.get(); const x = all.find((y) => y.id === n.id); if (!x) return;
    x.status = status; await store.set(all); notes = all;
    bg({ t: 'sink', path: '/notes/status', method: 'POST', body: { id: n.id, status } });
    startWalk(walkI);
  }
  async function del(n) {
    notes = (await store.get()).filter((y) => y.id !== n.id); await store.set(notes);
    bg({ t: 'sink', path: '/notes/delete', method: 'POST', body: { id: n.id } });
    const left = here().length;
    if (!left) stopWalk(); else startWalk(Math.min(walkI, left - 1));
    toast(`Note ${n.n} deleted`);
  }

  // ------------------------------------------------------------ export
  const slim = (n) => { const { shot, ...rest } = n; return rest; };
  // what goes to Claude lives in untrusted.js: the user's notes are the requests, page-derived fields go in a
  // labelled untrusted block, cleaned and capped
  const markdown = (list) => WRUntrusted.markdown(list.map(slim));
  const claudePrompt = (list, sinkUp) => WRUntrusted.claudePrompt(list.map(slim), { sinkUp });
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
    const t = document.createElement('textarea'); t.value = text; t.style.cssText = 'position:fixed;opacity:0'; document.body.append(t); t.select();
    const ok = document.execCommand('copy'); t.remove(); return ok;
  }
  const download = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); };

  dock.addEventListener('click', async (e) => {
    const a = e.target.closest('button')?.dataset.a; if (!a) return;
    notes = await store.get();
    const list = siteNotes().filter((n) => n.status !== 'done');
    if (a === 'mode') setMode(!mode);
    else if (a === 'walk') walkI >= 0 ? stopWalk() : startWalk(0);
    else if (a === 'claude') {
      if (!list.length) return toast('No open notes on this site');
      const s = await bg({ t: 'sink', path: '/health' });
      if (s?.ok) for (const n of list) if (!n.shot_path) { const r = await bg({ t: 'sink', path: '/notes', method: 'POST', body: n }); if (r?.ok) n.shot_path = r.body.shot_path; }
      const ok = await copy(claudePrompt(list, !!s?.ok));
      toast(ok ? `Copied ${list.length} ${list.length === 1 ? 'note' : 'notes'}. Paste into Claude Code.` : 'Could not copy. Try again.');
    } else if (a === 'md') {
      const all = siteNotes(); if (!all.length) return toast('No notes on this site');
      download(`review-${SITE}-${new Date().toISOString().slice(0, 10)}.md`, markdown(all), 'text/markdown');
      toast(`Downloaded ${all.length} notes`);
    } else if (a === 'off') { setMode(false); bg({ t: 'off' }); }
    setTimeout(grabFocus, 0);
  });

  const onMsg = (m) => {
    if (!host.isConnected) return;
    if (m.t === 'mode') setMode(m.on ?? !mode);
    if (m.t === 'quit') quit();
  };
  const onStore = (ch) => { if (ch.notes) { notes = ch.notes.newValue || []; if (walkI < 0) renderPins(); } };
  chrome.runtime.onMessage.addListener(onMsg);
  chrome.storage.onChanged.addListener(onStore);
  function quit() {
    // site turned off: drop the UI and every listener/timer this instance added
    setMode(false, false); alive = false;
    ac.abort(); clearInterval(iv); clearTimeout(saveT); clearTimeout(toastT); if (raf) cancelAnimationFrame(raf);
    try { chrome.runtime.onMessage.removeListener(onMsg); chrome.storage.onChanged.removeListener(onStore); } catch {}
    host.remove(); window.__wispReview = false; delete window.__wispReviewTest;
  }

  (async () => {
    notes = await store.get();
    // statuses Claude changed on disk (wispr-review done <n>) come back here
    const s = await bg({ t: 'sink', path: '/notes?site=' + encodeURIComponent(SITE) });
    if (s?.ok && Array.isArray(s.body?.notes)) {
      let changed = false;
      for (const d of s.body.notes) { const x = notes.find((y) => y.id === d.id); if (x && d.status && x.status !== d.status) { x.status = d.status; changed = true; } }
      if (changed) await store.set(notes);
    }
    renderPins();
    // voice mode comes back the way you left it on this site (the toolbar/shortcut turns it on the first time)
    const st = await chrome.storage.local.get('voice');
    if (alive && !mode && st.voice && typeof st.voice === 'object' && st.voice[SITE]) setMode(true, false);
  })();
  window.__wispReviewTest = { save, setMode, startWalk, stopWalk, markdown: () => markdown(siteNotes()), prompt: () => claudePrompt(siteNotes(), false), state: () => ({ mode, locked: !!locked, walkI, n: notes.length, dictated }) };
})();
