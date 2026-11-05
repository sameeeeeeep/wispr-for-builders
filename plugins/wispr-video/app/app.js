// Wispr Video editor. The project is a JSON edit list on the server; every change (yours or Claude's) arrives over /api/events.
const $ = (id) => document.getElementById(id);
const h = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const SIZES = { '9:16': [1080, 1920], '4:5': [1080, 1350], '16:9': [1920, 1080], '1:1': [1080, 1080] };
const FPS = 30, fr = (x) => Math.round(Math.round(x * FPS) / FPS * 1e4) / 1e4;
const PALETTE = ['#F0D7FF', '#FFA946', '#FFBCF2', '#34D399', '#FF6C4C', '#FFFFEB'];
const BGS = ['#1A1A1A', '#034F46', '#FFFFEB', '#F0D7FF'];
const LAYOUT_NAMES = { auto: 'Auto', cam: 'Camera', screen: 'Screen', pip: 'Bubble', split: 'Split' };

const QS = new URLSearchParams(location.search), MUTE = QS.has('mute');
let pid = QS.get('p') || '';
let P = null, D = { words: [], captions: [], lines: [], pauses: [], duration: 0 };
let T = 0, playing = false, wall0 = 0, t0 = 0, sel = null, pxs = 40, drag = null, pendingClaude = {};

const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {} });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const ops = (list, note) => api(`/api/project/${pid}/ops`, { method: 'POST', body: JSON.stringify({ ops: list, note }) }).catch((e) => toast(e.message));
const fmt = (s, dec = 1) => { s = Math.max(0, s); const m = Math.floor(s / 60); const x = (s - m * 60).toFixed(dec); return `${m}:${x.padStart(dec ? 3 + dec : 2, '0')}`; };
const end = (c) => c.at + (c.dur != null ? c.dur : c.out - c.in);
const len = (c) => (c.dur != null ? c.dur : c.out - c.in);
const norm = (w) => w.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]/g, '');

function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); }
function status(msg, work) { const s = $('status'); s.textContent = msg || ''; s.className = 'status' + (work ? ' work' : ''); }

// ---------- load ----------
async function boot() {
  if (!pid) {
    const j = await api('/api/projects');
    pid = j.current || (await api('/api/projects', { method: 'POST', body: JSON.stringify({ title: 'Untitled video' }) })).project.id;
  }
  history.replaceState(null, '', `?p=${pid}${MUTE ? '&mute' : ''}`);
  api('/api/current', { method: 'POST', body: JSON.stringify({ project: pid }) });
  await load();
  events();
  if (QS.get('mode') === 'record') setMode('record');
  requestAnimationFrame(frame);
}

async function load() {
  const j = await api(`/api/project/${pid}`);
  P = j.project; D = j; if (!bubDrag) pipDrag = null;
  if (sel && !findClip(sel)) sel = null;
  renderAll();
}

function events() {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'project' && ev.project === pid && ev.rev !== P.rev && !drag) load();
    if (ev.type === 'job' && ev.project === pid) onJob(ev);
  };
  es.onerror = () => status('Reconnecting to the editor server…');
  es.onopen = () => { if ($('status').textContent.startsWith('Reconnecting')) { status('Reconnected'); load(); } };
}

function findClip(id) { for (const t of P.tracks) for (const c of t.clips) if (c.id === id) return { t, c }; return null; }
const trackOf = (kind) => P.tracks.find((t) => t.kind === kind);
const activeIn = (t, at) => t && t.clips.find((c) => c.at <= at && at < end(c) - 1e-6);

function renderAll() {
  $('title').value = P.title;
  document.title = `${P.title} · Wispr Video`;
  [...$('aspect').children].forEach((b) => b.classList.toggle('on', b.dataset.a === P.aspect));
  const has = Object.keys(P.sources).length > 0;
  $('empty').hidden = has;
  $('pauseN').textContent = D.pauses.length ? `· ${D.pauses.length}` : '';
  $('btnPauses').disabled = !D.pauses.length;
  $('tcd').textContent = '/ ' + fmt(D.duration, 0);
  if (document.activeElement !== $('script')) $('script').value = P.script || '';
  sizeStage(); renderTimeline(); renderTranscript(); renderMedia(); renderCaptionsPane(); renderLayoutPane(); renderInspector(); renderChips(); preview(T, true);
  if (P.note && P.rev !== renderAll.lastRev) { status(P.note); renderAll.lastRev = P.rev; }
  setupPrompter();
}

// ---------- preview ----------
let K = 1;
function sizeStage() {
  const [W, H] = SIZES[P.aspect]; const wrap = $('stagewrap'); const st = $('stage');
  const k = Math.min((wrap.clientWidth - 8) / W, (wrap.clientHeight - 8) / H);
  K = k; st.style.width = W * k + 'px'; st.style.height = H * k + 'px';
}
new ResizeObserver(() => P && (sizeStage(), preview(T, true))).observe($('stagewrap'));

function layoutAt(t, hasCam, hasScr) {
  const c = activeIn(P.tracks.find((x) => x.kind === 'layout'), t);
  let m = c ? c.mode : P.layout || 'auto';
  if (m === 'auto') m = hasScr && hasCam ? 'pip' : hasScr ? 'screen' : 'cam';
  if ((m === 'pip' || m === 'split') && !(hasCam && hasScr)) m = hasCam ? 'cam' : 'screen';
  if (m === 'cam' && !hasCam && hasScr) m = 'screen';
  if (m === 'screen' && !hasScr && hasCam) m = 'cam';
  return m;
}

// the bubble at time t: the project's, with the layout section's own spot on top (mirrors engine.pip_at)
let pipDrag = null;   // live position while you drag the bubble on the stage
function pipAt(t) {
  const pip = { ...(P.pip || {}) }, c = activeIn(trackOf('layout'), t);
  if (c && c.pip) { if ('x' in c.pip || 'corner' in c.pip) { delete pip.x; delete pip.y; } Object.assign(pip, c.pip); }
  if (pipDrag) { delete pip.x; delete pip.y; Object.assign(pip, pipDrag); }
  return pip;
}
function pipBox(pip, W, H) {   // [x, y, s, s] in frame px; corner unless x/y is set (its centre, 0-1)
  const portrait = H > W, s = (pip.size || 0.34) * Math.min(W, H) * (portrait ? 1 : 0.9), mx = 0.05 * Math.min(W, H), cn = pip.corner || 'br';
  let x = cn.includes('l') ? mx : W - s - mx, y = cn.includes('t') ? mx + 0.06 * H : H - s - mx - (portrait ? 0.05 * H : 0);
  if (pip.x != null && pip.y != null) { x = clamp(pip.x * W - s / 2, 0, W - s); y = clamp(pip.y * H - s / 2, 0, H - s); }
  return [x, y, s, s];
}
function geometry(mode, W, H, sw = 16, sh = 9, pip = P.pip || {}) {   // mirrors engine.geometry
  const portrait = H > W;
  if (mode === 'cam') return { cam: [0, 0, W, H] };
  if (mode === 'screen' || mode === 'pip') {
    const m = 0.04 * W; let bw = W - 2 * m, bh = bw * sh / sw;
    if (bh > H - 2 * m) { bh = H - 2 * m; bw = bh * sw / sh; }
    const y = (H - bh) / 2 - (portrait && mode === 'pip' ? 0.12 * H : 0);
    const g = { screen: [(W - bw) / 2, Math.max(m, y), bw, bh], bg: true };
    if (mode === 'pip') g.cam = pipBox(pip, W, H);
    return g;
  }
  if (mode === 'split') return portrait || W === H ? { screen: [0, 0, W, H / 2], cam: [0, H / 2, W, H / 2] } : { screen: [0, 0, W / 2, H], cam: [W / 2, 0, W / 2, H] };
  return {};
}

const lastClip = new WeakMap();
function syncVideo(v, clip, t, audible) {
  const s = P.sources[clip.src]; const url = `/media/${pid}/${s.file}`;
  if (v.dataset.src !== url) { v.src = url; v.dataset.src = url; }
  const want = clip.in + (t - clip.at);
  const jumped = lastClip.get(v) !== clip.id; lastClip.set(v, clip.id);
  v.muted = MUTE || !audible; v.volume = clamp(clip.volume ?? 1, 0, 1);
  if (playing) {
    if (jumped || Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
    if (v.paused) v.play().catch(() => {});
  } else {
    if (!v.paused) v.pause();
    if (Math.abs(v.currentTime - want) > 0.02) v.currentTime = want;
  }
}

function cropView(v, cr) {   // a clip's crop {x,y,w,h} (0-1 of the source) as CSS object-view-box
  v.style.objectViewBox = cr ? `inset(${cr.y * 100}% ${(1 - cr.x - cr.w) * 100}% ${(1 - cr.y - cr.h) * 100}% ${cr.x * 100}%)` : 'none';
}
function place(el, box, radius) {
  el.style.left = box[0] * K + 'px'; el.style.top = box[1] * K + 'px';
  el.style.width = box[2] * K + 'px'; el.style.height = box[3] * K + 'px';
  el.style.borderRadius = radius || '0';
}

const ovEls = {};
function preview(t, force) {
  if (!P) return;
  const [W, H] = SIZES[P.aspect];
  $('stage').style.background = P.bg || '#1A1A1A';
  const cam = activeIn(trackOf('cam'), t), scr = activeIn(trackOf('screen'), t);
  const mode = layoutAt(t, !!cam, !!scr);
  const ss = scr ? P.sources[scr.src] : {};
  const pip = pipAt(t);
  const sk = ((activeIn(trackOf('layout'), t) || {}).id || 'gap') + mode;
  if (sk !== preview.sk) { preview.sk = sk; pipScopeSec = null; renderSections(); }   // the playhead moved into another part
  const g = geometry(mode, W, H, ss.w || 16, ss.h || 9, pip);
  const vS = $('vScreen'), vC = $('vCam');
  const plate = P.frame && g.bg;   // Wispr-style: footage in a soft rounded frame on the plate, no blur (mirrors the export)
  if (scr && g.screen) {
    $('slotScreen').hidden = false; syncVideo(vS, scr, t, (scr.volume || 0) > 0);
    cropView(vS, scr.crop);
    if (plate) {
      const m = (P.frame.margin ?? 0.05) * Math.min(W, H), cw = (ss.w || 16) * (scr.crop?.w ?? 1), ch = (ss.h || 9) * (scr.crop?.h ?? 1);
      let bw = W - 2 * m, bh = bw * ch / cw; if (bh > H - 2 * m) { bh = H - 2 * m; bw = bh * cw / ch; }
      const box = [(W - bw) / 2, (H - bh) / 2, bw, bh];
      place($('slotScreen'), box, (P.frame.radius ?? 0.025) * Math.min(bw, bh) * K + 'px');
      vS.style.objectFit = 'cover'; $('slotScreen').style.boxShadow = '0 10px 30px rgba(26,26,26,.25)';
    } else {
      place($('slotScreen'), g.screen, mode === 'split' ? 0 : 0.025 * W * K + 'px');
      vS.style.objectFit = mode === 'split' || scr.crop ? 'cover' : 'contain'; $('slotScreen').style.boxShadow = 'none';
    }
  } else { $('slotScreen').hidden = true; if (!vS.paused) vS.pause(); }
  const bg = $('bgblur');
  if (scr && g.bg && !plate && vS.readyState >= 2) {
    bg.hidden = false; bg.width = 64; bg.height = Math.round(64 * H / W);
    const c2 = bg.getContext('2d'); const r = Math.max(bg.width / vS.videoWidth, bg.height / vS.videoHeight);
    c2.drawImage(vS, (bg.width - vS.videoWidth * r) / 2, (bg.height - vS.videoHeight * r) / 2, vS.videoWidth * r, vS.videoHeight * r);
  } else bg.hidden = true;
  if (cam && g.cam) {
    $('slotCam').hidden = false; syncVideo(vC, cam, t, true);
    const circle = mode === 'pip' && (pip.shape || 'circle') === 'circle';
    place($('slotCam'), g.cam, mode === 'pip' ? (circle ? '50%' : 0.12 * g.cam[2] * K + 'px') : '0');
    vC.style.objectFit = 'cover';
    $('slotCam').style.boxShadow = mode === 'pip' ? '0 6px 24px rgba(0,0,0,.35)' : 'none';
    $('slotCam').classList.toggle('movable', mode === 'pip');
  } else { $('slotCam').hidden = true; if (!vC.paused) vC.pause(); }
  // overlays, bottom track drawn first
  const live = new Set();
  [...P.tracks].reverse().filter((x) => x.kind === 'overlay').forEach((tr, z) => {
    const c = activeIn(tr, t); if (!c) return;
    live.add(c.id);
    if (c.kind === 'text') { textCard(c, z, W, H, t); return; }
    const s = P.sources[c.src]; if (s.kind === 'audio') return;
    let el = ovEls[c.id];
    if (!el) {
      el = h('div'); const m = s.kind === 'image' ? h('img') : h('video');
      m.src = `/media/${pid}/${s.file}`; if (m.tagName === 'VIDEO') { m.muted = true; m.playsInline = true; m.preload = 'auto'; }
      el.append(m); ovEls[c.id] = el; $('ovLayer').append(el);
    }
    const b = c.box || { x: 0, y: 0, w: 1, h: 1 };
    place(el, [b.x * W, b.y * H, b.w * W, b.h * H], (c.radius || 0) * Math.min(b.w * W, b.h * H) * K + 'px');
    el.style.zIndex = z; el.firstChild.style.objectFit = c.fit || 'cover'; cropView(el.firstChild, c.crop);
    const fade = c.anim === 'fade' ? clamp((t - c.at) / 0.18, 0, 1) : 1; el.style.opacity = fade;
    if (el.firstChild.tagName === 'VIDEO') syncVideo(el.firstChild, c, t, false);
  });
  for (const id in ovEls) if (!live.has(id)) { const v = ovEls[id].firstChild; if (v.pause) v.pause(); ovEls[id].remove(); delete ovEls[id]; }
  renderCaps(t, W, H);
}

function textCard(c, z, W, H, t) {
  const st = c.style || {}, key = c.id + JSON.stringify(st) + c.text + K;
  let el = ovEls[c.id];
  if (!el || el.dataset.key !== key) {
    el?.remove(); el = h('div', 'textcard'); el.dataset.key = key; ovEls[c.id] = el; $('ovLayer').append(el);
    el.style.cssText = `left:0;top:0;width:${W * K}px;height:${H * K}px;background:${st.fill || 'transparent'}`;
    const line = h('div', 'tline' + (st.fill ? '' : ' shadow'));
    line.style.cssText = `top:${(st.y ?? 0.5) * H * K}px;font-size:${(st.size || 0.06) * Math.min(H, W) * K}px;font-weight:${st.weight || 700};color:${st.color || (st.fill ? '#1A1A1A' : '#FFFFEB')}`;
    const span = h('span', st.bg ? 'pill' : ''); if (st.bg) span.style.background = st.bg;
    c.text.split(/\*([^*]+)\*/).forEach((part, i) => { const s = h('span', i % 2 ? 'k' : '', part); if (i % 2 && st.accent) s.style.color = st.accent; span.append(s); });
    line.append(span); el.append(line);
  }
  el.style.zIndex = z; el.style.opacity = c.anim === 'fade' && !st.fill ? clamp((t - c.at) / 0.2, 0, 1) : 1;
}

function renderCaps(t, W, H) {
  const cs = P.captions, el = $('caps');
  const ch = cs.on && D.captions.find((c) => c.s <= t && t < c.e);
  if (!ch) { el.replaceChildren(); renderCaps.key = ''; return; }
  let k = ch.words.findLastIndex((w) => w.s <= t); if (k < 0) k = 0;
  const key = `${ch.s}|${k}|${P.rev}|${K}`;
  if (key === renderCaps.key) return; renderCaps.key = key;
  el.className = 'caps ' + (cs.box ? 'box' : 'shadow');
  el.style.top = cs.y * H * K + 'px'; el.style.fontSize = cs.size * H * K + 'px'; el.style.fontWeight = cs.weight || 800;
  el.style.setProperty('--box', cs.box || '#1A1A1ACC');
  const line = h('span', 'pill');
  ch.words.forEach((w, j) => {
    const s = h('span', w.kw && cs.serifKeywords ? 'k' : '', (j ? ' ' : '') + (cs.upper ? w.w.toUpperCase() : w.w));
    s.style.color = j === k ? cs.active : w.kw ? cs.keyword : cs.color; line.append(s);
  });
  el.replaceChildren(line);
}

// ---------- transport ----------
function seek(t) { T = clamp(t, 0, D.duration || 0); if (playing) { wall0 = performance.now(); t0 = T; } preview(T, true); drawHead(); }
function play(on = !playing) {
  if (on && T >= D.duration - 0.05) T = 0;
  playing = on; wall0 = performance.now(); t0 = T;
  $('icPlay').innerHTML = on ? '<rect x="5.5" y="4.5" width="3" height="11" rx="1" class="fill"/><rect x="11.5" y="4.5" width="3" height="11" rx="1" class="fill"/>' : '<path d="M6.5 4.5v11l9-5.5z" class="fill"/>';
  preview(T, true);
}
function frame() {
  requestAnimationFrame(frame);
  if (!P) return;
  if (playing) {
    T = t0 + (performance.now() - wall0) / 1000;
    if (T >= D.duration) { T = D.duration; play(false); }
    preview(T); drawHead();
  } else if (!$('bgblur').hidden) preview(T);
}
function drawHead() {
  $('tc').textContent = fmt(T);
  $('playhead').style.left = 88 + T * pxs + 'px';
  if (playing) {
    const sc = $('tscroll'), x = 88 + T * pxs;
    if (x > sc.scrollLeft + sc.clientWidth - 60 || x < sc.scrollLeft + 88) sc.scrollLeft = x - 140;
  }
  const w = D.words.findLast((w) => w.s <= T + 0.01);
  document.querySelectorAll('.transcript .w.now').forEach((e) => e.classList.remove('now'));
  if (w && T < w.e + 0.3) document.querySelector(`.transcript .w[data-k="${D.words.indexOf(w)}"]`)?.classList.add('now');
  document.querySelectorAll('.capchunk').forEach((e) => e.classList.toggle('now', +e.dataset.s <= T && T < +e.dataset.e));
}

// ---------- timeline ----------
function renderTimeline() {
  const dur = Math.max(D.duration, 10);
  $('tinner').style.width = 88 + dur * pxs + 240 + 'px';
  const ru = $('ruler'); ru.replaceChildren();
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * pxs >= 64) || 60;
  for (let s = 0; s <= dur + 5; s += step) {
    const tk = h('div', 'tick', fmt(s, 0)); tk.style.left = 88 + s * pxs - 88 + 'px'; ru.append(tk);
    if (step >= 1) { const mn = h('div', 'tick minor'); mn.style.left = (s + step / 2) * pxs + 'px'; ru.append(mn); }
  }
  const box = $('tracks'); box.replaceChildren();
  for (const tr of P.tracks) {
    const row = h('div', `track ${tr.kind}`); row.dataset.track = tr.id;
    row.append(h('div', 'lab', tr.label));
    for (const c of tr.clips) row.append(clipEl(tr, c));
    if (tr.kind === 'cam') for (const [a, b] of D.pauses) { const p = h('div', 'pause'); p.style.left = a * pxs + 'px'; p.style.width = (b - a) * pxs + 'px'; p.title = `${(b - a).toFixed(1)}s pause`; row.append(p); }
    row.addEventListener('pointerdown', (e) => { if (e.target === row) { sel = null; renderInspector(); markSel(); seekFromX(e); } });
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('dropzone'); });
    row.addEventListener('dragleave', () => row.classList.remove('dropzone'));
    row.addEventListener('drop', (e) => dropOnTrack(e, tr, row));
    box.append(row);
  }
  const cap = h('div', 'track captions'); cap.append(h('div', 'lab', 'Captions'));
  if (P.captions.on) for (const c of D.captions) {
    const e = h('div', 'capchunk', c.words.map((w) => w.w).join(' '));
    e.style.left = c.s * pxs + 'px'; e.style.width = Math.max(4, (c.e - c.s) * pxs - 2) + 'px'; e.dataset.s = c.s; e.dataset.e = c.e;
    e.onclick = () => seek(c.s + 0.01); cap.append(e);
  }
  box.append(cap);
  drawHead();
}

function clipEl(tr, c) {
  const s = P.sources[c.src] || {};
  const e = h('div', `clip ${tr.kind}${s.kind === 'image' ? ' img' : ''}${tr.kind === 'layout' ? ' ' + c.mode : ''}${c.id === sel ? ' sel' : ''}`);
  e.dataset.id = c.id;
  e.style.left = c.at * pxs + 'px'; e.style.width = Math.max(6, len(c) * pxs - 1) + 'px';
  if (tr.kind === 'layout') e.append(h('span', 'nm', LAYOUT_NAMES[c.mode]));
  else if (c.kind === 'text') { e.classList.add('text'); e.append(h('span', 'nm', 'T  ' + c.text.replace(/\*/g, ''))); }
  else {
    if (s.kind !== 'image' && s.kind !== 'audio' && tr.kind !== 'cam') {
      const th = h('div', 'thumbs'); e.append(th);
    }
    e.append(h('span', 'nm', s.name || c.src));
    if (tr.kind === 'cam' && pxs >= 26) {
      const ws = h('div', 'words'); let right = -1;
      for (const w of D.words) if (w.clip === c.id) {
        const x = (w.s - c.at) * pxs, wd = w.w.length * 6 + 8;   // skip words that would overlap the previous one
        if (x < right + 2 || x + wd > len(c) * pxs) continue;
        const sp = h('span', w.kw ? 'kw' : '', w.w); sp.style.left = x + 'px'; ws.append(sp); right = x + wd;
      }
      e.append(ws);
    }
  }
  const L = h('div', 'h l'), R = h('div', 'h r'); e.append(L, R);
  e.addEventListener('pointerdown', (ev) => startDrag(ev, tr, c, ev.target === L ? 'l' : ev.target === R ? 'r' : 'move', e));
  return e;
}

function markSel() { document.querySelectorAll('.clip').forEach((e) => e.classList.toggle('sel', e.dataset.id === sel)); }
function xToT(ev) { const r = $('tinner').getBoundingClientRect(); return Math.max(0, (ev.clientX - r.left - 88) / pxs); }
function seekFromX(ev) {
  seek(xToT(ev));
  const mv = (e) => seek(xToT(e)), up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
}
$('ruler').addEventListener('pointerdown', seekFromX);

function snapPoints(skip) {
  const pts = [T, 0];
  for (const t of P.tracks) for (const c of t.clips) if (c.id !== skip) pts.push(c.at, end(c));
  return pts;
}
function snap(x, pts) { let best = x, d = 7 / pxs; for (const p of pts) if (Math.abs(p - x) < d) { d = Math.abs(p - x); best = p; } return best; }

function startDrag(ev, tr, c, mode, el) {
  ev.stopPropagation(); ev.preventDefault();
  sel = c.id; markSel(); renderInspector();
  const x0 = ev.clientX, orig = { ...c }, pts = snapPoints(c.id), src = P.sources[c.src] || {};
  const maxOut = src.kind === 'image' || tr.kind === 'layout' ? Infinity : src.duration;
  let moved = false;
  drag = { c };
  const mv = (e) => {
    const d = (e.clientX - x0) / pxs; if (Math.abs(e.clientX - x0) > 2) moved = true;
    if (!moved) return;
    if (mode === 'move') {
      let at = Math.max(0, orig.at + d);
      const a2 = snap(at, pts), b2 = snap(at + len(orig), pts);
      at = Math.abs(a2 - at) <= Math.abs(b2 - (at + len(orig))) ? a2 : b2 - len(orig);
      c.at = fr(Math.max(0, at));
    } else if (mode === 'l') {
      let at = snap(orig.at + d, pts); let dd = at - orig.at;
      if (c.dur != null) { dd = clamp(dd, -orig.at, orig.dur - 0.1); c.at = fr(orig.at + dd); c.dur = fr(orig.dur - dd); }
      else if (src.kind === 'image') { dd = clamp(dd, -orig.at, orig.out - 0.1); c.at = fr(orig.at + dd); c.out = +(orig.out - dd).toFixed(3); }
      else { dd = clamp(dd, -Math.min(orig.in, orig.at), orig.out - orig.in - 0.1); c.at = fr(orig.at + dd); c.in = +(orig.in + dd).toFixed(3); }
    } else {
      const e2 = snap(end(orig) + d, pts); const dd = e2 - end(orig);
      if (c.dur != null) c.dur = fr(Math.max(0.1, orig.dur + dd));
      else c.out = +clamp(orig.out + dd, orig.in + 0.1, maxOut).toFixed(3);
    }
    el.style.left = c.at * pxs + 'px'; el.style.width = Math.max(6, len(c) * pxs - 1) + 'px';
    status(`${fmt(c.at, 2)} → ${fmt(end(c), 2)}`);
  };
  const up = (e) => {
    removeEventListener('pointermove', mv); removeEventListener('pointerup', up); drag = null;
    if (!moved) { if (tr.kind !== 'layout') seek(xToT(e)); return; }
    const f = { op: 'update_clip', id: c.id, at: c.at };
    if (c.dur != null) f.dur = c.dur; else { f.in = c.in; f.out = c.out; }
    ops([f], mode === 'move' ? 'moved a clip' : 'trimmed a clip');
  };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
}

function dropOnTrack(e, tr, row) {
  e.preventDefault(); row.classList.remove('dropzone');
  const at = fr(xToT(e)), sid = e.dataTransfer.getData('text/wv-source');
  if (sid) return addSource(sid, at, tr.kind === 'layout' ? null : tr.id);
  if (e.dataTransfer.files.length) [...e.dataTransfer.files].forEach((f) => upload(f, tr.kind === 'screen' ? 'screen' : tr.kind === 'cam' ? 'cam' : 'media', at));
}

function addSource(sid, at, tid) {
  const s = P.sources[sid];
  const track = tid || (s.kind === 'cam' ? 'cam' : s.kind === 'screen' ? 'screen' : 'overlay');
  const o = { op: 'add_clip', track, src: sid, at };
  if (s.kind === 'image') o.dur = 3;
  ops([o], `added ${s.name}`);
}

$('zoom').addEventListener('input', (e) => { const sc = $('tscroll'); const tc = (sc.scrollLeft + sc.clientWidth / 2 - 88) / pxs; pxs = +e.target.value; renderTimeline(); sc.scrollLeft = tc * pxs + 88 - sc.clientWidth / 2; });
$('tscroll').addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); $('zoom').value = clamp(pxs * (e.deltaY < 0 ? 1.12 : 0.89), 10, 240); $('zoom').dispatchEvent(new Event('input')); } }, { passive: false });

// ---------- tools ----------
function splitHere() {
  const c = sel && findClip(sel);
  ops([{ op: 'split', at: fr(T), tracks: c ? [c.t.id] : P.tracks.filter((t) => t.kind !== 'layout').map((t) => t.id) }], 'split');
}
function deleteSel(ripple) {
  const c = sel && findClip(sel); if (!c) return toast('Select a clip first');
  ops([{ op: 'delete_clip', id: sel, ripple: ripple ?? c.t.kind === 'cam' }], ripple || c.t.kind === 'cam' ? 'cut a clip' : 'deleted a clip'); sel = null;
}
$('btnSplit').onclick = splitHere;
$('btnDel').onclick = (e) => deleteSel(e.shiftKey || undefined);
$('btnPauses').onclick = () => ops([{ op: 'cut_silences' }], 'cut pauses');
$('btnPlay').onclick = () => play();
$('btnUndo').onclick = () => api(`/api/project/${pid}/undo`, { method: 'POST' });
$('btnRedo').onclick = () => api(`/api/project/${pid}/redo`, { method: 'POST' });
$('title').addEventListener('change', (e) => ops([{ op: 'set', path: 'title', value: e.target.value.trim() || 'Untitled video' }]));
$('aspect').onclick = (e) => { const a = e.target.dataset.a; if (a) ops([{ op: 'set', path: 'aspect', value: a }], `aspect ${a}`); };

addEventListener('keydown', (e) => {
  if (e.target.id === 'pWispr' && !$('record').hidden) {   // in the Wispr field: Enter or arrows still drive the prompt
    if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); show(cur + 1, true); }
    else if (e.key === 'ArrowLeft' && !e.target.value) show(cur - 1, true);
    return;
  }
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (!$('record').hidden) return recordKeys(e);
  const k = e.key;
  if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'z') { e.preventDefault(); return api(`/api/project/${pid}/${e.shiftKey ? 'redo' : 'undo'}`, { method: 'POST' }); }
  if (k === ' ') { e.preventDefault(); play(); }
  else if (k === 's' || k === 'S') splitHere();
  else if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); if (trSel) cutWords(); else deleteSel(e.shiftKey || undefined); }
  else if (k === 'ArrowRight') seek(T + (e.shiftKey ? 1 : 1 / FPS));
  else if (k === 'ArrowLeft') seek(T - (e.shiftKey ? 1 : 1 / FPS));
  else if (k === 'Home') seek(0);
  else if (k === 'End') seek(D.duration);
  else if (k === 'Escape') { sel = null; markSel(); renderInspector(); }
});

// ---------- transcript ----------
let trSel = null;
function renderTranscript() {
  const box = $('transcript'); box.replaceChildren();
  $('trHint').hidden = !D.words.length;
  if (!D.words.length) {
    const any = Object.values(P.sources).some((s) => s.kind === 'cam');
    box.append(h('p', 'empty-tr', any ? 'Transcribing your take…' : 'Your words show up here after you record or import a camera take. Captions come from them.'));
    return;
  }
  const pauses = D.pauses; let p = h('p'); let lastE = 0, sentences = 0;
  D.words.forEach((w, k) => {
    const gap = pauses.find(([a, b]) => a >= lastE - 0.05 && b <= w.s + 0.05 && b - a > 0.3);
    if (gap) { p.append(' ', h('span', 'gap', `${(gap[1] - gap[0]).toFixed(1)}s`)); }
    if (k && (w.s - lastE > 1.6 || (sentences >= 3 && /[.?!]$/.test(D.words[k - 1].w)))) { box.append(p); p = h('p'); sentences = 0; }
    const s = h('span', 'w' + (w.kw || P.captions.keywords?.some((x) => norm(x) === norm(w.w)) ? ' kw' : ''), w.w);
    s.dataset.k = k;
    p.append(k ? ' ' : '', s);
    if (/[.?!]$/.test(w.w)) sentences++;
    lastE = w.e;
  });
  box.append(p);
}
$('transcript').addEventListener('click', (e) => {
  const w = e.target.closest('.w'); if (!w || !getSelection().isCollapsed) return;
  seek(D.words[+w.dataset.k].s + 0.01);
});
$('transcript').addEventListener('dblclick', (e) => {
  const el = e.target.closest('.w'); if (!el) return;
  const w = D.words[+el.dataset.k]; getSelection().removeAllRanges();
  const nw = prompt('Fix this word (captions use it):', w.w);
  if (nw && nw !== w.w) ops([{ op: 'fix_word', src: w.src, i: w.i, w: nw }], `fixed “${w.w}”`);
});
document.addEventListener('selectionchange', () => {
  const s = getSelection(); trSel = null;
  if (!s.isCollapsed && $('transcript').contains(s.anchorNode)) {
    const ks = [...$('transcript').querySelectorAll('.w')].filter((e) => s.containsNode(e, true)).map((e) => +e.dataset.k);
    if (ks.length) {
      const a = D.words[ks[0]], b = D.words[ks.at(-1)], nx = D.words[ks.at(-1) + 1];
      trSel = { start: Math.max(0, a.s - 0.03), end: nx ? nx.s - 0.04 : b.e + 0.05, n: ks.length };
    }
  }
  $('selbar').hidden = !trSel;
  if (trSel) $('selInfo').textContent = `${trSel.n} word${trSel.n > 1 ? 's' : ''} · ${(trSel.end - trSel.start).toFixed(1)}s`;
});
function cutWords() { if (!trSel) return; ops([{ op: 'cut', start: fr(trSel.start), end: fr(trSel.end) }], `cut ${trSel.n} words`); getSelection().removeAllRanges(); }
$('btnCutSel').onclick = cutWords;

// ---------- media ----------
function renderMedia() {
  const box = $('mediaList'); box.replaceChildren();
  for (const s of Object.values(P.sources)) {
    const it = h('div', 'mitem'); it.draggable = true;
    it.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/wv-source', s.id));
    const th = h('div', 'th');
    if (s.kind === 'image') { const i = h('img'); i.src = `/media/${pid}/${s.file}`; th.append(i); }
    else if (s.kind !== 'audio') { const v = h('video'); v.muted = true; v.preload = 'metadata'; v.src = `/media/${pid}/${s.file}#t=1`; th.append(v); }
    th.append(h('span', 'kind', { cam: 'Camera', screen: 'Screen', video: 'Video', image: 'Image', audio: 'Audio' }[s.kind]));
    const meta = h('div', 'meta'); meta.append(h('span', '', s.name), h('span', 'd', s.kind === 'image' ? '' : fmt(s.duration, 0)));
    const add = h('button', '', `Add at ${fmt(T)}`); add.onclick = () => addSource(s.id, fr(T));
    it.append(th, meta, add); box.append(it);
  }
}
$('btnImport').onclick = () => $('file').click();
$('btnGoImport').onclick = () => { $('importRole').value = 'cam'; $('file').click(); };
$('file').onchange = (e) => { [...e.target.files].forEach((f) => upload(f, $('importRole').value, $('importRole').value === 'media' ? fr(T) : undefined)); e.target.value = ''; };
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); [...e.dataTransfer.files].forEach((f) => upload(f, $('importRole').value, fr(T))); });
$('stagewrap').addEventListener('dragover', (e) => e.preventDefault());
$('stagewrap').addEventListener('drop', (e) => {
  e.preventDefault();
  [...e.dataTransfer.files].forEach((f) => {   // a video on an empty project is the camera take; images are always b-roll
    const cam = !Object.keys(P.sources).length && /^video\//.test(f.type);
    upload(f, cam ? 'cam' : 'media', cam ? undefined : fr(T));
  });
});

const afterImport = {};   // take file name → clip fields to set once it's on the timeline (e.g. screen-audio volume)
async function upload(file, role, at, extra = {}, fix = null) {
  const q = new URLSearchParams({ role, name: file.name || extra.name || `${role}.webm`, ...(at != null ? { at } : {}), ...extra });
  status(`Uploading ${extra.name || file.name || role}…`, true);
  if (fix && extra.name) afterImport[extra.name] = fix;
  try { await api(`/api/project/${pid}/upload?${q}`, { method: 'POST', body: file }); }
  catch (e) { toast('Upload failed: ' + e.message); }
}
async function applyAfterImport(j) {
  await load();
  const list = [];
  for (const sid of j.result.sources) {
    const s = P.sources[sid], fix = s && afterImport[s.name]; if (!fix) continue;
    delete afterImport[s.name]; if (!s.hasAudio) continue;
    for (const t of P.tracks) for (const c of t.clips) if (c.src === sid) list.push({ op: 'update_clip', id: c.id, ...fix });
  }
  if (list.length) ops(list, 'audio levels for the new take');
}

// ---------- captions + layout panes ----------
function swatches(el, list, cur, onPick) {
  el.replaceChildren(...list.map((c) => { const b = h('button'); b.style.background = c; b.title = c; b.classList.toggle('on', c.toLowerCase() === (cur || '').toLowerCase()); b.onclick = () => onPick(c); return b; }));
}
function renderCaptionsPane() {
  const cs = P.captions;
  $('capOn').checked = cs.on; $('capSize').value = cs.size; $('capY').value = cs.y; $('capSerif').checked = !!cs.serifKeywords;
  [...$('capWords').children].forEach((b) => b.classList.toggle('on', +b.textContent === cs.words));
  [...$('capStyle').children].forEach((b) => b.classList.toggle('on', b.dataset.s === 'upper' ? !!cs.upper : b.dataset.s === (cs.box ? 'box' : 'plain')));
  swatches(document.querySelector('.swatches[data-k=active]'), PALETTE, cs.active, (c) => ops([{ op: 'captions', active: c }]));
  swatches(document.querySelector('.swatches[data-k=keyword]'), PALETTE, cs.keyword, (c) => ops([{ op: 'captions', keyword: c }]));
  if (document.activeElement !== $('capKeywords')) $('capKeywords').value = (cs.keywords || []).join(', ');
}
const capLive = (k, v) => { P.captions[k] = v; renderCaps.key = ''; preview(T, true); };
$('capOn').onchange = (e) => ops([{ op: 'captions', on: e.target.checked }]);
$('capSerif').onchange = (e) => ops([{ op: 'captions', serifKeywords: e.target.checked }]);
for (const [id, k] of [['capSize', 'size'], ['capY', 'y']]) {
  $(id).addEventListener('input', (e) => capLive(k, +e.target.value));
  $(id).addEventListener('change', (e) => ops([{ op: 'captions', [k]: +e.target.value }]));
}
$('capWords').onclick = (e) => { const n = +e.target.textContent; if (n) ops([{ op: 'captions', words: n }]); };
$('capStyle').onclick = (e) => {
  const s = e.target.dataset.s; if (!s) return;
  ops([{ op: 'captions', ...(s === 'upper' ? { upper: !P.captions.upper } : { box: s === 'box' ? '#1A1A1ACC' : '' }) }]);
};
$('capKeywords').addEventListener('change', (e) => ops([{ op: 'captions', keywords: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) }]));

function renderLayoutPane() {
  [...$('layoutDefault').children].forEach((b) => b.classList.toggle('on', b.dataset.m === (P.layout || 'auto') && !trackOf('layout').clips.length));
  [...$('pipCorner').children].forEach((b) => b.classList.toggle('on', b.dataset.c === P.pip.corner));
  [...$('pipShape').children].forEach((b) => b.classList.toggle('on', b.dataset.s === P.pip.shape));
  swatches(document.querySelector('.swatches[data-k=bg]'), BGS, P.bg, (c) => ops([{ op: 'set', path: 'bg', value: c }]));
  renderSections();
}
// Sections: the layout track split into parts (camera full → bubble → screen). The part under the playhead is
// either a layout clip or the gap between two, which follows the whole-video layout.
function sectionAt(t) {
  const lt = trackOf('layout'); t = Math.min(t, Math.max(0, D.duration - 1e-3));   // the very end belongs to the last part
  const c = activeIn(lt, t);
  if (c) return { c, a: c.at, b: end(c) };
  const a = Math.max(0, ...lt.clips.filter((x) => end(x) <= t + 1e-6).map(end));
  const nx = lt.clips.filter((x) => x.at > t).map((x) => x.at);
  return { c: null, a, b: nx.length ? Math.min(...nx) : D.duration };
}
let pipScopeSec = null;   // null = automatic: this section if it has its own spot, else the whole video
function pipSection() {
  const { c } = sectionAt(T);
  if (!c || trackOf('layout').clips.length < 2 && !c.pip) return null;
  const sec = pipScopeSec ?? !!c.pip;
  return sec ? c : null;
}
function renderSections() {
  const sc = sectionAt(T), lt = trackOf('layout'), n = lt.clips.length;
  const mode = layoutAt(T + 1e-3, !!activeIn(trackOf('cam'), T), !!activeIn(trackOf('screen'), T));
  $('secInfo').textContent = n ? `This part: ${fmt(sc.a)}–${fmt(sc.b)}` : 'One part: the whole video';
  [...$('secMode').children].forEach((b) => b.classList.toggle('on', !!sc.c && b.dataset.m === sc.c.mode));
  const pipped = mode === 'pip', inSec = !!sc.c && (n > 1 || !!sc.c.pip);
  $('pipScopeRow').hidden = !(pipped && inSec);
  const ps = pipSection(), pip = ps ? { ...P.pip, ...ps.pip } : P.pip;
  [...$('pipScope').children].forEach((b) => b.classList.toggle('on', (b.dataset.s === 'sec') === !!ps));
  [...$('pipCorner').children].forEach((b) => b.classList.toggle('on', pip.x == null && b.dataset.c === pip.corner));
  [...$('pipShape').children].forEach((b) => b.classList.toggle('on', b.dataset.s === (pip.shape || 'circle')));
  if (document.activeElement !== $('pipSize')) $('pipSize').value = pip.size || P.pip.size;
  $('pipHint').textContent = !pipped ? 'Pick Bubble for this part to place the camera over the screen.'
    : pip.x != null ? `Placed by hand${ps ? ' for this part' : ''}. Drag it on the preview, or pick a corner.` : 'Drag the bubble on the preview to place it. It snaps to the corners and safe margins.';
}
function setPip(patch, label) {   // whole video, or the section under the playhead when "This section" is on
  const ps = pipSection(), clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
  if (ps) return ops([{ op: 'update_clip', id: ps.id, pip: clean({ ...(ps.pip || {}), ...patch }) }], label || 'bubble for this part');
  return ops([{ op: 'set', path: 'pip', value: clean({ ...P.pip, ...patch }) }], label || 'bubble');
}
$('layoutDefault').onclick = (e) => { const m = e.target.dataset.m; if (m) ops([{ op: 'layout', mode: m }], `layout ${LAYOUT_NAMES[m]}`); };
$('pipCorner').onclick = (e) => { const c = e.target.dataset.c; if (c) setPip({ corner: c, x: null, y: null }); };
$('pipShape').onclick = (e) => { const s = e.target.dataset.s; if (s) setPip({ shape: s }); };
$('pipSize').addEventListener('input', (e) => { pipDrag = { ...(pipDrag || {}), size: +e.target.value }; preview(T, true); });
$('pipSize').addEventListener('change', (e) => setPip({ size: +e.target.value }));
$('pipScope').onclick = (e) => { const s = e.target.dataset.s; if (!s) return; pipScopeSec = s === 'sec'; renderSections(); };
$('secSplit').onclick = () => {
  const sc = sectionAt(T), t = fr(T);
  if (t <= sc.a + 0.1 || t >= sc.b - 0.1) return toast('Move the playhead inside a part to split it');
  if (sc.c) return ops([{ op: 'split', at: t, tracks: [trackOf('layout').id] }], 'split section');
  const m = P.layout || 'auto';
  ops([{ op: 'layout', mode: m, start: fr(sc.a), end: t }, { op: 'layout', mode: m, start: t, end: fr(sc.b) }], 'split section');
};
$('secMode').onclick = (e) => {
  const m = e.target.dataset.m; if (!m) return;
  const sc = sectionAt(T);
  if (!sc.c && sc.b - sc.a < 0.05) return toast('Move the playhead inside the video first');
  if (sc.c) return ops([{ op: 'update_clip', id: sc.c.id, mode: m }], `layout ${LAYOUT_NAMES[m]} for this part`);
  if (!trackOf('layout').clips.length) return ops([{ op: 'layout', mode: m }], `layout ${LAYOUT_NAMES[m]}`);
  ops([{ op: 'layout', mode: m, start: fr(sc.a), end: fr(sc.b) }], `layout ${LAYOUT_NAMES[m]} for this part`);
};

// drag the bubble on the stage: free x/y, snapping to the corners, the centre lines and the safe margins
function snapPip(cx, cy, s, W, H) {
  const portrait = H > W, mx = 0.05 * Math.min(W, H), th = 0.03 * Math.min(W, H);
  const xs = [mx + s / 2, W / 2, W - mx - s / 2], ys = [mx + 0.06 * H + s / 2, H / 2, H - mx - (portrait ? 0.05 * H : 0) - s / 2];
  let sx = -1, sy = -1;
  xs.forEach((v, i) => { if (Math.abs(cx - v) < th) { cx = v; sx = i; } });
  ys.forEach((v, i) => { if (Math.abs(cy - v) < th) { cy = v; sy = i; } });
  cx = clamp(cx, s / 2, W - s / 2); cy = clamp(cy, s / 2, H - s / 2);
  const corner = sx !== 1 && sx >= 0 && sy !== 1 && sy >= 0 ? (sy === 0 ? 't' : 'b') + (sx === 0 ? 'l' : 'r') : null;
  return { cx, cy, sx, sy, corner, xs, ys };
}
let bubDrag = null;
$('stage').addEventListener('pointerdown', (e) => {
  const sc = $('slotCam'); if (sc.hidden || !sc.classList.contains('movable')) return;
  const r = sc.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
  e.preventDefault(); e.stopPropagation(); $('stage').setPointerCapture(e.pointerId);
  const st = $('stage').getBoundingClientRect();
  bubDrag = { dx: (e.clientX - (r.left + r.width / 2)) / K, dy: (e.clientY - (r.top + r.height / 2)) / K, st, moved: false, s: r.width / K };
  if (playing) play(false);
  sc.classList.add('dragging');
}, true);
$('stage').addEventListener('pointermove', (e) => {
  if (!bubDrag) return;
  const [W, H] = SIZES[P.aspect], st = bubDrag.st;
  const sn = snapPip((e.clientX - st.left) / K - bubDrag.dx, (e.clientY - st.top) / K - bubDrag.dy, bubDrag.s, W, H);
  bubDrag.moved = true; bubDrag.sn = sn;
  pipDrag = { ...(pipDrag || {}), x: sn.cx / W, y: sn.cy / H };
  const gx = $('gX'), gy = $('gY');
  gx.hidden = sn.sx < 0; gy.hidden = sn.sy < 0;
  if (sn.sx >= 0) gx.style.left = sn.xs[sn.sx] * K + 'px';
  if (sn.sy >= 0) gy.style.top = sn.ys[sn.sy] * K + 'px';
  preview(T, true);
});
function endBubDrag() {
  if (!bubDrag) return;
  const d = bubDrag; bubDrag = null; $('slotCam').classList.remove('dragging'); $('gX').hidden = $('gY').hidden = true;
  if (!d.moved || !d.sn) return;
  const [W, H] = SIZES[P.aspect], sn = d.sn;
  setPip(sn.corner ? { corner: sn.corner, x: null, y: null } : { x: +(sn.cx / W).toFixed(4), y: +(sn.cy / H).toFixed(4) }, sn.corner ? `bubble ${sn.corner}` : 'moved the bubble');
  setTimeout(() => { if (!bubDrag && pipDrag) { pipDrag = null; preview(T, true); } }, 2500);   // the reload normally clears it sooner
}
$('stage').addEventListener('pointerup', endBubDrag);
$('stage').addEventListener('pointercancel', endBubDrag);
$('sideTabs').onclick = (e) => { const t = e.target.dataset.tab; if (!t) return; [...$('sideTabs').children].forEach((b) => b.classList.toggle('on', b === e.target)); document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === t)); };

// ---------- inspector ----------
const OV_PRESETS = { Full: { x: 0, y: 0, w: 1, h: 1 }, Card: { x: 0.08, y: 0.12, w: 0.84, h: 0.46 }, Top: { x: 0, y: 0, w: 1, h: 0.5 }, Corner: { x: 0.58, y: 0.06, w: 0.36, h: 0.22 } };
function renderInspector() {
  const body = $('insBody'); body.replaceChildren();
  const f = sel && findClip(sel);
  if (!f) { $('insTitle').textContent = 'Inspector'; $('insSub').textContent = ''; body.append(h('p', 'hint', 'Select a clip on the timeline to change it.')); return; }
  const { t: tr, c } = f, s = P.sources[c.src] || {};
  $('insTitle').textContent = tr.kind === 'layout' ? 'Layout' : tr.label; $('insSub').textContent = s.name || LAYOUT_NAMES[c.mode] || '';
  const nums = h('div', 'nums');
  const num = (label, val, onset) => { const l = h('label', '', label); const i = h('input'); i.type = 'number'; i.step = '0.05'; i.value = (+val).toFixed(2); i.onchange = () => onset(+i.value); l.append(i); nums.append(l); };
  num('Start', c.at, (v) => ops([{ op: 'update_clip', id: c.id, at: v }]));
  if (c.dur != null) num('Length', c.dur, (v) => ops([{ op: 'update_clip', id: c.id, dur: v }]));
  else if (s.kind === 'image') num('Length', c.out, (v) => ops([{ op: 'update_clip', id: c.id, out: v }]));
  else { num('In', c.in, (v) => ops([{ op: 'update_clip', id: c.id, in: v }])); num('Out', c.out, (v) => ops([{ op: 'update_clip', id: c.id, out: v }])); }
  body.append(nums);
  const segRow = (label, opts, cur, fn) => { const fl = h('div', 'field col'); fl.append(h('span', '', label)); const sg = h('div', 'seg small'); for (const [k, v] of opts) { const b = h('button', k === cur ? 'on' : '', v); b.onclick = () => fn(k); sg.append(b); } fl.append(sg); body.append(fl); };
  if (tr.kind === 'layout') segRow('Layout', Object.entries(LAYOUT_NAMES), c.mode, (m) => ops([{ op: 'update_clip', id: c.id, mode: m }]));
  if (tr.kind === 'cam' || tr.kind === 'screen') {
    const curL = activeIn(trackOf('layout'), c.at + 0.01);
    segRow('Layout for this clip', Object.entries(LAYOUT_NAMES), curL ? curL.mode : null, (m) => ops([{ op: 'layout', mode: m, start: c.at, end: end(c) }], `layout ${LAYOUT_NAMES[m]}`));
    if (s.hasAudio) {
      const fl = h('div', 'field'); fl.append(h('span', '', 'Volume')); const r = h('input'); r.type = 'range'; r.min = 0; r.max = 1.5; r.step = 0.05; r.value = c.volume ?? 1;
      r.onchange = () => ops([{ op: 'update_clip', id: c.id, volume: +r.value }]); fl.append(r); body.append(fl);
    }
  }
  if (c.kind === 'text') {
    const fl = h('div', 'field col'); fl.append(h('span', '', 'Text (*stars* = italic serif)'));
    const ta = h('textarea'); ta.value = c.text; ta.rows = 3; ta.onchange = () => ops([{ op: 'update_clip', id: c.id, text: ta.value }]); fl.append(ta); body.append(fl);
    segRow('Style', [['over', 'Over video'], ['card', 'Cream card'], ['pill', 'Pill']], c.style?.fill ? 'card' : c.style?.bg ? 'pill' : 'over',
      (k) => ops([{ op: 'update_clip', id: c.id, style: { ...c.style, fill: k === 'card' ? '#FFFFEB' : '', bg: k === 'pill' ? '#1A1A1ACC' : '', color: k === 'card' ? '#1A1A1A' : '#FFFFEB', accent: k === 'card' ? '#034F46' : '#F0D7FF' } }]));
  }
  if (tr.kind === 'overlay' && c.kind !== 'text') {
    const b = c.box || {}; const cur = Object.entries(OV_PRESETS).find(([, v]) => Object.keys(v).every((k) => Math.abs(v[k] - (b[k] ?? -1)) < 0.005));
    segRow('Position', Object.keys(OV_PRESETS).map((k) => [k, k]), cur?.[0], (k) => ops([{ op: 'update_clip', id: c.id, box: OV_PRESETS[k], radius: k === 'Full' || k === 'Top' ? 0 : 0.05 }]));
    segRow('Fit', [['cover', 'Fill'], ['contain', 'Fit']], c.fit || 'cover', (k) => ops([{ op: 'update_clip', id: c.id, fit: k }]));
    const fl = h('div', 'field'); fl.append(h('span', '', 'Corners')); const r = h('input'); r.type = 'range'; r.min = 0; r.max = 0.3; r.step = 0.01; r.value = c.radius || 0;
    r.oninput = () => { c.radius = +r.value; preview(T, true); }; r.onchange = () => ops([{ op: 'update_clip', id: c.id, radius: +r.value }]); fl.append(r); body.append(fl);
    const sw = h('label', 'sw'); const cb = h('input'); cb.type = 'checkbox'; cb.checked = c.anim === 'fade'; cb.onchange = () => ops([{ op: 'update_clip', id: c.id, anim: cb.checked ? 'fade' : '' }]); sw.append(cb, h('span', '', 'Fade in')); body.append(sw);
  }
  const acts = h('div', 'acts');
  const btn = (t, fn, cls = '') => { const b = h('button', 'small ' + cls, t); b.onclick = fn; acts.append(b); };
  btn('Go to start', () => seek(c.at + 0.001));
  if (tr.kind !== 'layout') btn('Split at playhead', splitHere);
  btn('Delete', () => deleteSel(false), 'danger');
  if (tr.kind !== 'layout') btn('Cut + close gap', () => deleteSel(true), 'danger');
  body.append(acts);
}

// ---------- Claude ----------
function renderChips() {
  const has = D.words.length, scr = trackOf('screen').clips.length;
  const list = [];
  if (D.pauses.length) list.push('Cut the pauses and the ums');
  if (has) list.push('Make the captions bigger', 'Highlight the key words');
  if (scr) list.push('Show the screen full when I talk about the site');
  if (has && D.lines.length > 1) list.push('Put the first media over line 2');
  list.push(P.aspect === '9:16' ? 'Make it 4:5 for the feed' : 'Make it 9:16');
  $('chips').replaceChildren(...list.slice(0, 4).map((t) => { const b = h('button', '', t); b.onclick = () => askClaude(t); return b; }));
  $('chips').hidden = !Object.keys(P.sources).length;
}
async function askClaude(text) {
  text = (text || $('askInput').value).trim(); if (!text) return;
  $('askInput').value = ''; $('ask').classList.add('busy');
  const m = h('div', 'msg'); m.append(h('div', 'you', text));
  const st = h('div', 'steps'); st.innerHTML = '<span class="dots"><i></i><i></i><i></i></span> Claude is reading the timeline'; m.append(st);
  const log = $('claudeLog'); if (log.querySelector('.hint')) log.replaceChildren(); log.append(m); log.scrollTop = 1e9;
  $('claudeState').textContent = 'working';
  try { const j = await api(`/api/project/${pid}/claude`, { method: 'POST', body: JSON.stringify({ text }) }); pendingClaude[j.id] = { m, st }; }
  catch (e) { st.remove(); m.append(h('div', 'cl err', e.message)); $('ask').classList.remove('busy'); }
}
$('btnAsk').onclick = () => askClaude();
$('askInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') askClaude(); });
const STEP_NAMES = { get: 'reading the timeline', edit: 'editing', find: 'finding the words', still: 'checking the frame', undo: 'undoing', thinking: 'thinking' };

let dict = null;
$('btnMic').onclick = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Dictation needs Chrome. Or hold fn and speak into the box.');
  if (dict) { dict.stop(); return; }
  dict = new SR(); dict.interimResults = true; dict.lang = 'en-IN';
  dict.onresult = (e) => { $('askInput').value = [...e.results].map((r) => r[0].transcript).join(' '); };
  dict.onend = () => { $('btnMic').classList.remove('on'); dict = null; if ($('askInput').value.trim()) askClaude(); };
  dict.start(); $('btnMic').classList.add('on'); $('askInput').focus();
};

// ---------- jobs ----------
function onJob(j) {
  if (j.kind === 'claude' && pendingClaude[j.id]) {
    const { m, st } = pendingClaude[j.id];
    if (j.state === 'running') st.innerHTML = `<span class="dots"><i></i><i></i><i></i></span> Claude is ${STEP_NAMES[j.stage] || j.stage}`;
    else {
      st.remove(); delete pendingClaude[j.id]; $('ask').classList.remove('busy'); $('claudeState').textContent = '';
      m.append(h('div', 'cl' + (j.state === 'error' ? ' err' : ''), j.state === 'error' ? j.error : (j.result?.reply || 'Done.')));
      $('claudeLog').scrollTop = 1e9;
    }
    return;
  }
  if (j.kind === 'export') return exportProgress(j);
  if (j.state === 'running') status(`${j.stage[0].toUpperCase() + j.stage.slice(1)}…`, true);
  else if (j.state === 'error') { status(''); savedBar(null); toast((j.kind === 'import' ? 'Couldn’t add that take: ' : '') + j.error, 9000); }
  else {
    status(j.kind === 'import' ? 'Imported' : 'Done');
    if (j.kind === 'import' && j.result?.sources?.length) { toast(j.result.resumed ? 'Recovered a take that was still importing' : 'Added to the timeline'); savedBar(j.result.saved?.[0]); }
    if (j.kind === 'import' && Object.keys(afterImport).length) applyAfterImport(j);
  }
}

// "Saved to Movies › Wispr Video › …" with a Reveal button, after a take or an export lands
function savedBar(file) {
  const bar = $('savedBar'); if (!file) { bar.hidden = true; return; }
  const parts = file.split('/'); const i = parts.indexOf('Movies');
  $('savedPath').textContent = 'Saved to ' + (i >= 0 ? parts.slice(i, -1).join(' › ') : parts.slice(-3, -1).join(' › '));
  bar.hidden = false; bar.dataset.file = file;
}
$('savedReveal').onclick = () => reveal($('savedBar').dataset.file);
const reveal = (file) => api(`/api/project/${pid}/reveal`, { method: 'POST', body: JSON.stringify({ file }) }).catch((e) => toast(e.message));

// ---------- export ----------
let exAspect = null;
$('btnExport').onclick = () => {
  exAspect = P.aspect; [...$('exAspect').children].forEach((b) => b.classList.toggle('on', b.dataset.a === exAspect));
  $('exProg').hidden = true; $('exVideo').hidden = true; $('exReveal').hidden = true; $('exGo').disabled = !D.duration;
  $('dlgExport').showModal();
};
$('exAspect').onclick = (e) => { if (e.target.dataset.a) { exAspect = e.target.dataset.a; [...$('exAspect').children].forEach((b) => b.classList.toggle('on', b === e.target)); } };
$('exClose').onclick = () => { $('exVideo').pause(); $('dlgExport').close(); };
$('exGo').onclick = async () => {
  $('exGo').disabled = true; $('exProg').hidden = false; $('exVideo').hidden = true; exportProgress({ state: 'running', progress: 0, stage: 'render' });
  try { await api(`/api/project/${pid}/export`, { method: 'POST', body: JSON.stringify({ aspect: exAspect }) }); }
  catch (e) { toast(e.message); $('exGo').disabled = false; }
};
let lastExport = null;
function exportProgress(j) {
  const bar = $('exProg'); bar.hidden = false;
  bar.querySelector('i').style.width = `${Math.round((j.progress || 0) * 100)}%`;
  if (j.state === 'running') bar.querySelector('span').textContent = j.stage === 'captions' ? 'Burning in captions…' : `Rendering… ${Math.round((j.progress || 0) * 100)}%`;
  else if (j.state === 'error') { bar.querySelector('span').textContent = 'Export failed: ' + j.error; $('exGo').disabled = false; }
  else {
    lastExport = j.result; const sv = j.result.saved || j.result.file, sp = sv.split('/'), mi = sp.indexOf('Movies');
    bar.querySelector('span').textContent = 'Saved to ' + (mi >= 0 ? sp.slice(mi).join(' › ') : sp.pop()); savedBar(sv);
    const v = $('exVideo'); v.src = j.result.url; v.hidden = false; $('exReveal').hidden = false; $('exGo').disabled = false;
    if (!$('dlgExport').open) toast('Export ready');
  }
}
$('exReveal').onclick = () => lastExport && reveal(lastExport.saved || lastExport.file);

// ---------- projects ----------
$('btnProjects').onclick = async () => {
  const j = await api('/api/projects');
  $('projList').replaceChildren(...j.projects.map((x) => { const b = h('button', x.id === pid ? 'on' : ''); b.append(h('b', '', x.title), h('span', '', `${x.aspect} · ${fmt(x.duration, 0)}`)); b.onclick = () => switchTo(x.id); return b; }));
  $('dlgProjects').showModal();
};
$('pjClose').onclick = () => $('dlgProjects').close();
$('pjNew').onclick = async () => { const t = prompt('Name your video', 'Untitled video'); if (t == null) return; const j = await api('/api/projects', { method: 'POST', body: JSON.stringify({ title: t, aspect: P?.aspect || '9:16' }) }); switchTo(j.project.id); };
async function switchTo(id) { $('dlgProjects').close(); pid = id; history.replaceState(null, '', `?p=${pid}${MUTE ? '&mute' : ''}`); api('/api/current', { method: 'POST', body: JSON.stringify({ project: pid }) }); sel = null; T = 0; await load(); }

// ---------- record ----------
let mode = 'edit', what = 'both', camStream = null, recs = [], streams = [], rec0 = 0, marks = [], lines = [], cur = 0;
function setMode(m) {
  mode = m; $('edit').hidden = m !== 'edit'; $('record').hidden = m !== 'record';
  $('tabRecord').classList.toggle('on', m === 'record'); $('tabEdit').classList.toggle('on', m === 'edit');
  if (m === 'record') { setupPrompter(); } else { stopPreview(); requestAnimationFrame(() => { sizeStage(); preview(T, true); }); }
}
$('tabRecord').onclick = () => setMode('record');
$('tabEdit').onclick = () => { if (rec0) return toast('Stop recording first'); setMode('edit'); };
$('btnGoRecord').onclick = () => setMode('record');
const HINTS = {
  both: 'You pick a window to share. Camera and screen land on the timeline together, in sync.',
  cam: 'Adds a camera take to the end of the timeline. Do the screen part later if you like.',
  screen: () => `Records the screen on its own and drops it at ${fmt(T)} (the playhead), so it lines up with what you said.`,
};
function setWhat(w) {
  what = w; [...$('rWhat').children].forEach((b) => b.classList.toggle('on', b.dataset.w === w)); const x = HINTS[w]; $('rHint').textContent = typeof x === 'function' ? x() : x; $('camOn').hidden = w === 'screen' || !!camStream; if (w === 'screen') stopPreview();
  $('rScrAudioRow').hidden = w === 'cam'; $('rMicRow').hidden = w !== 'screen'; $('rFloatRow').hidden = w !== 'both';
  floatBtn();
}
$('rWhat').onclick = (e) => e.target.dataset.w && !rec0 && setWhat(e.target.dataset.w);
async function startPreview() {
  if (what === 'screen') { stopPreview(); return; }
  if (camStream) return;
  try { camStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true }, video: { width: { ideal: 1920 }, height: { ideal: 1080 } } }); $('rCam').srcObject = camStream; $('rCam').play(); $('camOn').hidden = true; floatBtn(); }
  catch (e) { $('rHint').textContent = 'Camera blocked: allow it in the browser to record yourself. (' + e.message + ')'; }
}
function stopPreview() { if (camStream && !rec0) { closeBubble(); camStream.getTracks().forEach((t) => t.stop()); camStream = null; $('rCam').srcObject = null; } $('camOn').hidden = what === 'screen'; floatBtn(); }
$('camOn').onclick = startPreview;

let scriptTimer = 0;
$('script').addEventListener('input', () => { clearTimeout(scriptTimer); scriptTimer = setTimeout(() => ops([{ op: 'script', text: $('script').value }], 'script'), 600); lines = parseLines($('script').value); show(Math.min(cur, Math.max(0, lines.length - 1))); });
function parseLines(txt) { return (txt || '').split(/\n\s*\n|\n(?=\S)/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => ({ line: l, words: l.split(/\s+/).filter(Boolean) })); }
function setupPrompter() { if (rec0) return; lines = parseLines(P?.script); show(Math.min(cur, Math.max(0, lines.length - 1))); }
function show(i, user) {
  cur = clamp(i, 0, Math.max(0, lines.length - 1));
  const p = lines[cur];
  $('pNum').textContent = lines.length ? `${cur + 1} / ${lines.length}` : 'No script';
  $('pLine').replaceChildren(...(p ? p.words.flatMap((w, k) => { const s = h('span', 'w', w); return k ? [' ', s] : [s]; }) : [h('span', 'w said', 'Paste your script on the right, then press Record.')]));
  $('pNext').textContent = lines[cur + 1] ? lines[cur + 1].line : p ? 'Last line. Press Stop when you’re done.' : '';
  $('pNext').hidden = !p;
  heard0 = heardAll.length; matchLine();
  if (rec0 && p) marks.push({ line: cur + 1, t: +((performance.now() - rec0) / 1000).toFixed(2), by: user ? 'key' : 'voice' });
}

// voice follow: the line moves on only once you've said its last word. Never on a timer.
const getSR = () => window.SpeechRecognition || window.webkitSpeechRecognition;   // read late so it can be stubbed in tests
let srec = null, heardAll = [], heard0 = 0, interim = [];
const SOUNDALIKE = [['to', 'too', 'two'], ['for', 'four'], ['a', 'an', 'uh'], ['its', 'it'], ['your', 'youre'], ['there', 'their', 'theyre'], ['one', 'won']];
const near = (a, b) => a === b || (a.length > 3 && b.length > 3 && (a.startsWith(b) || b.startsWith(a))) || lev1(a, b)
  || SOUNDALIKE.some((g) => g.includes(a) && g.includes(b));   // recognisers write "to" for "too"; don't let that block a line
function lev1(a, b) { if (Math.abs(a.length - b.length) > 1 || a.length < 4) return false; let i = 0, j = 0, d = 0; while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; continue; } if (++d > 1) return false; if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; } } return d + (a.length - i) + (b.length - j) <= 1; }
function matchLine() {
  const p = lines[cur]; if (!p) return;
  const want = p.words.map(norm).filter(Boolean), got = heardAll.slice(heard0).concat(interim);
  let j = 0;
  for (const w of got) for (let k = 0; k < 3 && j + k < want.length; k++) if (near(w, want[j + k])) { j += k + 1; break; }
  [...$('pLine').querySelectorAll('.w')].forEach((s, i) => s.classList.toggle('said', i < j));
  $('pProg').style.width = `${want.length ? (j / want.length) * 100 : 0}%`;
  if (rec0 && j >= want.length && cur < lines.length - 1) show(cur + 1);
}
// The mic problem: Chrome's recogniser opens the mic on its own, and while getUserMedia is recording, macOS can hand it
// silence. So (1) recognise from the recording's own mic track where Chrome allows it, (2) show what it hears plus a
// level meter, and (3) if you're clearly talking but nothing is recognised, switch to Wispr: dictate into a field and
// those words drive the prompt. Never a timer.
let lastHeard = 0, loudSince = 0, lastLoud = 0, meter = null, wisprT = 0;
function hearWords(ws) { heardAll.push(...ws); lastHeard = performance.now(); const el = $('pHeard'); el.textContent = 'Hearing: ' + heardAll.slice(-6).join(' '); $('pHearing').classList.add('live'); }
function startMeter(stream) {
  try {
    const ac = new AudioContext(), an = ac.createAnalyser(); an.fftSize = 512; ac.resume().catch(() => {});
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    meter = { ac, iv: setInterval(() => {
      an.getByteTimeDomainData(buf); let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v - 128));
      const lvl = Math.min(1, pk / 64); $('pLvl').style.width = lvl * 100 + '%';
      const now = performance.now();
      if (lvl > 0.18) { loudSince = loudSince || now; lastLoud = now; } else if (now - lastLoud > 1500) loudSince = 0;   // gaps between words don't count
      // talking for 5 s with nothing recognised in the last 6 s → offer the Wispr path
      if (rec0 && loudSince && now - loudSince > 5000 && now - Math.max(lastHeard, rec0) > 6000 && document.activeElement !== $('pWispr')) {
        $('pWispr').focus({ preventScroll: true });   // talking but nothing's arriving: put the cursor back in the Wispr field
      }
    }, 80) };
  } catch {}
}
function stopMeter() { if (meter) { clearInterval(meter.iv); meter.ac.close().catch(() => {}); meter = null; } }
// Wispr pastes a phrase at once; typing arrives a key at a time. Either way, take the words once the field settles.
$('pWispr').addEventListener('input', (e) => {
  clearTimeout(wisprT);
  wisprT = setTimeout(() => {
    const ws = e.target.value.split(/\s+/).map(norm).filter(Boolean);
    if (!ws.length) return;
    hearWords(ws); e.target.value = ''; matchLine();
  }, 450);
});
function startSR(r) {
  const tr = camStream?.getAudioTracks()[0];
  if (tr) { try { r.start(tr.clone()); r._track = true; return; } catch {} }   // Chrome with MediaStreamTrack support
  r._track = false; r.start();
}
function listen(on) {
  const vs = $('pVoice');
  if (!on) {
    if (srec) { srec.onend = null; srec.abort(); srec = null; }
    stopMeter(); $('pHearing').hidden = true; $('pFall').hidden = true; vs.className = 'vstat'; vs.textContent = ''; return;
  }
  // Wispr is the primary route: a focused field Wispr Flow types into while you read, matched against the script.
  // The browser's own speech recognition is an opt-in fallback, so recording never fights Wispr for the mic.
  lastHeard = 0; loudSince = 0; $('pHearing').hidden = false; $('pHearing').classList.remove('live'); $('pHeard').textContent = 'Waiting for your first words…';
  $('pFall').hidden = false; setTimeout(() => $('pWispr').focus({ preventScroll: true }), 50);
  vs.className = 'vstat on'; vs.textContent = 'Following Wispr';
  if (camStream) startMeter(camStream);
  if (!$('rVoice').checked) return;
  const SR = getSR();
  if (!SR) { vs.textContent = 'Voice-follow needs Chrome · Wispr dictation or Space moves on'; $('pFall').hidden = false; return; }
  if (srec) return;
  srec = new SR(); srec.continuous = true; srec.interimResults = true; srec.lang = 'en-IN';
  srec.onresult = (e) => { interim = []; for (let i = e.resultIndex; i < e.results.length; i++) { const ws = e.results[i][0].transcript.split(/\s+/).map(norm).filter(Boolean); if (e.results[i].isFinal) hearWords(ws); else { interim.push(...ws); lastHeard = performance.now(); } } matchLine(); };
  srec.onerror = (e) => { if (/not-allowed|audio-capture/.test(e.error)) { vs.className = 'vstat'; vs.textContent = 'Voice-follow blocked · Wispr dictation or Space moves on'; $('pFall').hidden = false; srec = null; } };
  srec.onend = () => { if (srec) try { startSR(srec); } catch {} };   // Chrome stops after silences; keep listening
  try { startSR(srec); vs.className = 'vstat on'; vs.textContent = 'Following Wispr + browser'; } catch {}
}
$('rVoice').onchange = () => listen($('rVoice').checked && !!rec0);

function pickType(audioOnly) {
  const list = audioOnly ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  for (const t of list) if (MediaRecorder.isTypeSupported(t)) return t; return '';
}

// ---- the floating camera: a small always-on-top window with your face, a rec dot, the timer and Stop ----
// Document Picture-in-Picture where Chrome has it, else the video element's own picture-in-picture.
let bub = null;
function floatBtn() {
  const on = !!camStream && what !== 'screen';
  $('btnFloat').hidden = !on || !!bub; $('rFloating').hidden = !bub;
}
const BUB_CSS = `html,body{margin:0;height:100%;background:#1A1A1A;overflow:hidden;font:500 13px/1 Figtree,Helvetica,Arial,sans-serif;color:#FFFFEB;-webkit-font-smoothing:antialiased}
.b{position:absolute;inset:0;display:grid;grid-template-rows:1fr auto;gap:8px;padding:10px}
.f{position:relative;min-height:0;display:grid;place-items:center;container-type:size}
.f video{width:min(100cqw,100cqh);height:min(100cqw,100cqh);object-fit:cover;transform:scaleX(-1);border-radius:50%;box-shadow:0 6px 24px rgba(0,0,0,.45),0 0 0 2px rgba(255,255,235,.14);background:#000}
.f.rounded video{border-radius:18%}
.bar{display:flex;align-items:center;gap:8px;justify-content:center}
.dot{width:9px;height:9px;border-radius:50%;background:rgba(255,255,235,.4)}
.dot.on{background:#FF6C4C;box-shadow:0 0 0 4px rgba(255,108,76,.28);animation:p 1.2s infinite}
@keyframes p{50%{box-shadow:0 0 0 7px rgba(255,108,76,0)}}
.t{font-variant-numeric:tabular-nums;font-weight:700;min-width:34px}
button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:5px 12px;background:#FFFFEB;color:#1A1A1A;cursor:pointer}
button:hover{background:#F0D7FF}`;
async function openBubble() {
  if (bub || !camStream) return bub;
  const shape = P?.pip?.shape === 'rounded' ? 'rounded' : '';
  if (window.documentPictureInPicture) {
    const w = await documentPictureInPicture.requestWindow({ width: 220, height: 264 });
    const d = w.document; d.title = 'Wispr Video · camera';
    const st = d.createElement('style'); st.textContent = BUB_CSS; d.head.append(st);
    d.body.innerHTML = `<div class="b"><div class="f ${shape}"><video autoplay muted playsinline></video></div><div class="bar"><i class="dot"></i><span class="t">0:00</span><button>Stop</button></div></div>`;
    const v = d.querySelector('video'); v.srcObject = camStream; v.play().catch(() => {});
    d.querySelector('button').onclick = () => (rec0 ? stopRec() : closeBubble());
    bub = { kind: 'doc', w, dot: d.querySelector('.dot'), clock: d.querySelector('.t'), btn: d.querySelector('button') };
    w.addEventListener('pagehide', () => { if (bub?.w === w) { bub = null; floatBtn(); } });
  } else if (document.pictureInPictureEnabled) {
    const v = $('rCam'); await v.requestPictureInPicture();
    bub = { kind: 'video' };
    v.addEventListener('leavepictureinpicture', () => { if (bub?.kind === 'video') { bub = null; floatBtn(); } }, { once: true });
  } else throw new Error('this browser can’t float a window');
  bubState(); floatBtn(); return bub;
}
function closeBubble() {
  if (!bub) return; const b = bub; bub = null;
  try { if (b.kind === 'doc') b.w.close(); else if (document.pictureInPictureElement) document.exitPictureInPicture(); } catch {}
  floatBtn();
}
function bubState() {
  if (bub?.kind !== 'doc') return;
  bub.dot.classList.toggle('on', !!rec0); bub.clock.textContent = $('rClock').textContent; bub.btn.textContent = rec0 ? 'Stop' : 'Close';
}
$('btnFloat').onclick = () => openBubble().catch((e) => toast('Couldn’t float the camera: ' + e.message));

// what the share brought: screen audio on/off, and whether the floating camera will show up in the screen take
function shareNote(scr, wantAudio) {
  const has = scr.getAudioTracks().length > 0, surf = scr.getVideoTracks()[0]?.getSettings?.().displaySurface;
  const pill = $('rAudio'); pill.hidden = false;
  pill.className = 'apill ' + (has ? 'on' : wantAudio ? 'off' : '');
  pill.querySelector('span').textContent = has ? 'Screen audio on' : wantAudio
    ? (surf === 'window' ? 'Screen audio off: this Chrome can’t take a window’s sound. Share a tab or the whole screen for audio.' : 'Screen audio off: tick “Share audio” in Chrome’s picker next time.')
    : 'Screen audio off';
  const note = $('rFloatNote');
  if (bub) {
    note.hidden = false;
    note.textContent = surf === 'monitor' ? 'You’re sharing the whole screen, so the floating camera shows in the screen take too. Share a window or tab to keep it out, or drag it out of the way.'
      : 'The floating camera stays out of the screen take: you shared a ' + (surf === 'browser' ? 'tab' : surf === 'window' ? 'window' : 'window or tab') + '.';
  } else note.hidden = true;
  return has;
}
async function shareScreen(wantAudio, preferWindow) {
  const audio = wantAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false;
  const base = { video: { frameRate: 30, ...(preferWindow ? { displaySurface: 'window' } : {}) }, audio, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' };
  try { return await navigator.mediaDevices.getDisplayMedia({ ...base, systemAudio: wantAudio ? 'include' : 'exclude', windowAudio: wantAudio ? 'system' : 'exclude' }); }
  catch (e) { if (e.name !== 'TypeError') throw e; return navigator.mediaDevices.getDisplayMedia(base); }   // an older Chrome that doesn't know an option
}
let recWhat = 'both', recMeta = {};
async function startRec() {
  if (rec0) return;
  try {
    const sets = []; recWhat = what; recMeta = {};
    if (what !== 'screen') { await startPreview(); if (!camStream) throw new Error('no camera'); sets.push({ role: 'cam', stream: camStream }); }
    const float = what === 'both' && $('rFloat').checked;
    if (float && !bub) await openBubble().catch((e) => toast('Couldn’t float the camera: ' + e.message + '. Press Float camera once recording starts.', 6000));   // before the picker, while the click still counts
    if (what !== 'cam') {
      const wantAudio = $('rScrAudio').checked;
      const scr = await shareScreen(wantAudio, !!bub);
      streams.push(scr); scr.getVideoTracks()[0].addEventListener('ended', () => rec0 && stopRec());
      recMeta.screenAudio = shareNote(scr, wantAudio);
      sets.push({ role: 'screen', stream: new MediaStream([...scr.getVideoTracks(), ...scr.getAudioTracks()]) });
      if (what === 'screen' && $('rMic').checked) {   // screen-only take: the mic is its own source, not mixed into the screen
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
          streams.push(mic); sets.push({ role: 'mic', stream: mic, audioOnly: true }); recMeta.mic = true;
        } catch (e) { toast('Mic blocked, recording the screen without it: ' + e.message, 6000); }
      }
    } else $('rAudio').hidden = true;
    await countdown();
    recs = sets.map((s) => {
      const type = pickType(s.audioOnly), opt = type ? { mimeType: type } : {};
      if (!s.audioOnly) opt.videoBitsPerSecond = 6e6;
      const r = new MediaRecorder(s.stream, opt); r.chunks = []; r.role = s.role; r.ondataavailable = (e) => e.data.size && r.chunks.push(e.data); r.start(1000); return r;
    });
    rec0 = performance.now(); marks = []; heardAll = []; interim = []; show(0);
    $('recDot').classList.add('on'); $('btnRec').disabled = true; $('btnStop').disabled = false;
    if (what !== 'screen') listen(true);
    bubState(); tickRec();
  } catch (e) { toast('Could not start: ' + e.message); streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); streams = []; }
}
function tickRec() { if (!rec0) return; const s = Math.floor((performance.now() - rec0) / 1000); $('rClock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; bubState(); setTimeout(tickRec, 250); }
function countdown() { return new Promise((res) => { let n = 3; const c = $('count'); c.hidden = false; c.textContent = n; const it = setInterval(() => { n--; if (n) c.textContent = n; else { clearInterval(it); c.hidden = true; res(); } }, 800); }); }
async function stopRec() {
  if (!rec0) return;
  const dur = (performance.now() - rec0) / 1000; rec0 = 0; listen(false);
  $('recDot').classList.remove('on'); $('btnStop').disabled = true; $('btnRec').disabled = false;
  closeBubble(); $('rFloatNote').hidden = true;
  await Promise.all(recs.map((r) => new Promise((res) => { r.onstop = res; r.stop(); })));
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); streams = [];
  const take = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const camEnd = Math.max(0, ...trackOf('cam').clips.map(end));
  const at = what === 'screen' ? fr(T) : fr(camEnd);
  setMode('edit');
  toast(`Got it: ${Math.round(dur)}s. Adding it to the timeline…`, 4000);
  // screen audio sits under the voice (0.5) when there's a mic; on its own it plays at full. The mic of a
  // screen-only take lands as its own clip (b-roll track, audio only) at the same time, so the two can be mixed.
  const scrVol = recWhat === 'cam' ? 0 : recWhat === 'screen' && !recMeta.mic ? 1 : 0.5;
  for (const r of recs) {
    const blob = new Blob(r.chunks, { type: r.mimeType });
    const role = r.role === 'mic' ? 'media' : r.role, name = `${r.role}-${take}.webm`;
    const fix = r.role === 'mic' ? { volume: 1 } : r.role === 'screen' && recMeta.screenAudio ? { volume: scrVol } : null;
    await upload(blob, role, at, { take, name, ...(r.role === 'cam' ? { marks: JSON.stringify(marks) } : {}) }, fix);
  }
  recs = [];
}
$('btnRec').onclick = startRec;
$('btnStop').onclick = stopRec;
function recordKeys(e) {
  if (e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); show(cur + 1, true); }
  else if (e.key === 'ArrowLeft') show(cur - 1, true);
  else if (e.key.toLowerCase() === 'r') rec0 ? stopRec() : startRec();
}

setWhat('both');
boot().catch((e) => { document.body.innerHTML = `<p style="padding:40px;font:16px Figtree">Could not reach the Wispr Video server: ${e.message}</p>`; });
