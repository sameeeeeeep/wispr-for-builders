"""Wispr Video engine: the project (a JSON edit list), the edit ops, transcription and the ffmpeg export.
Shared by the HTTP server (the editor UI) and the MCP server (Claude). Projects live in ~/WisprVideo/<id>/."""
import copy, difflib, hashlib, json, math, os, re, shutil, subprocess, tempfile, threading, time, uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
FONTS = PKG / 'app' / 'fonts'
HOME = Path(os.environ.get('WISPR_VIDEO_HOME') or Path.home() / 'WisprVideo')
FPS = 30
SIZES = {'9:16': (1080, 1920), '4:5': (1080, 1350), '16:9': (1920, 1080), '1:1': (1080, 1080)}
LAYOUTS = ('auto', 'cam', 'screen', 'pip', 'split')
FILLERS = {'um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm'}
_lock = threading.RLock()


# ---------- projects ----------

PID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')


def pdir(pid):
    """A project's folder. The id is checked here, so no caller can reach outside ~/WisprVideo with it."""
    if not isinstance(pid, str) or not PID_RE.match(pid) or '..' in pid: raise ValueError(f'bad project id {pid!r}')
    return HOME / pid


def within(pid, path):
    """True if path resolves inside the project's folder."""
    base = pdir(pid).resolve()
    try: Path(path).resolve().relative_to(base); return True
    except ValueError: return False


def source_file(pid, s):
    """A source's media file, confined to the project folder (a crafted project can't point ffmpeg elsewhere)."""
    f = (pdir(pid) / str(s.get('file', ''))).resolve()
    if not within(pid, f): raise ValueError(f"source {s.get('id')} points outside the project")
    return f
def slug(s): return re.sub(r'[^a-z0-9]+', '-', (s or 'video').lower()).strip('-')[:40] or 'video'
def rid(prefix): return prefix + uuid.uuid4().hex[:6]


MOVIES = Path(os.environ.get('WISPR_VIDEO_MOVIES') or Path.home() / 'Movies' / 'Wispr Video')


def movies_dir(p):
    """Where a person finds their takes and exports: ~/Movies/Wispr Video/<project title>/."""
    name = re.sub(r'\s+', ' ', re.sub(r'[/:\\\x00-\x1f]+', ' ', str(p.get('title') or p.get('id') or 'Video'))).strip(' .')[:80] or 'Video'
    d = MOVIES / name; d.mkdir(parents=True, exist_ok=True)
    return d


def readable_copy(p, src, label, ext):
    """Copy a finished take or export to the Movies folder under a human name, e.g. 'Take 1 – 5 Nov 12.48 (camera).webm'."""
    d = movies_dir(p)
    stamp = time.strftime('%-d %b %H.%M')
    base = f'{label} – {stamp}'
    out = d / f'{base}{ext}'; n = 2
    while out.exists(): out = d / f'{base} ({n}){ext}'; n += 1
    shutil.copy2(src, out)
    return out


def revealable(pid, path):
    """Files Finder may be asked to show: inside the project, or inside its Movies folder."""
    if within(pid, path): return True
    try: Path(path).resolve().relative_to(MOVIES.resolve()); return True
    except ValueError: return False


INBOX_ROLES = ('cam', 'screen', 'media')


def ingest_inbox(pid, progress=None):
    """Attach takes waiting in the project's inbox (an upload whose import was interrupted, say by a restart).
    Each upload has a sidecar <file>.json with its role and timing; only files inside this project's inbox are read."""
    inbox = (pdir(pid) / 'inbox').resolve(); done = []
    with _ingest_locks.setdefault(pid, threading.Lock()):   # camera + screen arrive together: one ingest at a time
        done = _ingest(pid, inbox, progress)
    return done


_ingest_locks = {}


def _ingest(pid, inbox, progress):
    done = []
    for meta in sorted(inbox.glob('*.json')):
        f = meta.with_suffix('')
        if not f.exists() or not within(pid, f) or f.parent != inbox: meta.unlink(missing_ok=True); continue
        m = json.loads(meta.read_text())
        role = m.get('role') if m.get('role') in INBOX_ROLES else 'media'
        at = m.get('at'); at = None if at is None else _num(at, 0, 1e6, 'at')
        if progress: progress('importing ' + role, 0.2)
        sid = import_media(pid, f, role, at=at, take=m.get('take'), marks=m.get('marks'), recorded_at=m.get('t'), name=m.get('name'))
        if role == 'cam':
            if progress: progress('transcribing', 0.6)
            transcribe(pid, sid)
        f.unlink(missing_ok=True); meta.unlink(missing_ok=True); done.append(sid)
    return done


def default_project(title, aspect):
    return {
        'id': '', 'title': title, 'rev': 0, 'aspect': aspect, 'fps': FPS, 'created': time.time(),
        'script': '', 'sources': {},
        'tracks': [
            {'id': 'layout', 'kind': 'layout', 'label': 'Layout', 'clips': []},
            {'id': 'overlay', 'kind': 'overlay', 'label': 'B-roll', 'clips': []},
            {'id': 'screen', 'kind': 'screen', 'label': 'Screen', 'clips': []},
            {'id': 'cam', 'kind': 'cam', 'label': 'Camera', 'clips': []},
        ],
        'layout': 'auto',
        'pip': {'corner': 'br', 'size': 0.34, 'shape': 'circle'},
        'captions': {'on': True, 'size': 0.045, 'y': 0.70, 'words': 4, 'weight': 800, 'upper': False,
                     'color': '#FFFFEB', 'active': '#F0D7FF', 'keyword': '#FFA946', 'serifKeywords': True,
                     'box': '', 'keywords': []},
        'bg': '#1A1A1A',
        'exports': [],
    }


def new_project(title='Untitled video', aspect='9:16'):
    HOME.mkdir(parents=True, exist_ok=True)
    pid = f"{time.strftime('%m%d')}-{slug(title)}"
    n = 2
    while pdir(pid).exists(): pid = f"{time.strftime('%m%d')}-{slug(title)}-{n}"; n += 1
    (pdir(pid) / 'media').mkdir(parents=True)
    p = default_project(title, aspect if aspect in SIZES else '9:16'); p['id'] = pid
    save(pid, p, 'new project', snapshot=False)
    set_current(pid)
    return p


def list_projects():
    out = []
    if HOME.exists():
        for d in sorted(HOME.iterdir(), key=lambda d: -d.stat().st_mtime):
            f = d / 'project.json'
            if f.exists():
                try: p = json.loads(f.read_text())
                except Exception: continue
                out.append({'id': p['id'], 'title': p['title'], 'aspect': p['aspect'], 'duration': round(duration(p), 2),
                            'updated': f.stat().st_mtime})
    return out


def current():
    f = HOME / '.current'
    pid = f.read_text().strip() if f.exists() else ''
    if pid and (pdir(pid) / 'project.json').exists(): return pid
    ps = list_projects()
    return ps[0]['id'] if ps else ''


def set_current(pid):
    HOME.mkdir(parents=True, exist_ok=True); (HOME / '.current').write_text(pid)


def load(pid=None):
    pid = pid or current()
    if not pid: raise ValueError('no project yet: create one with video_new or in the editor')
    return sanitize(json.loads((pdir(pid) / 'project.json').read_text()), pid)


def save(pid, p, note='', snapshot=True):
    with _lock:
        f = pdir(pid) / 'project.json'
        hist = pdir(pid) / 'history'
        if snapshot and f.exists():
            hist.mkdir(exist_ok=True)
            old = json.loads(f.read_text())
            (hist / f"{old['rev']:05d}.json").write_text(json.dumps(old))
            for x in sorted(hist.glob('*.json'))[:-80]: x.unlink()
            for x in hist.glob('redo-*.json'): x.unlink()
        p['rev'] = p.get('rev', 0) + 1
        p['note'] = note
        p['updated'] = time.time()
        tmp = f.with_suffix('.tmp'); tmp.write_text(json.dumps(p, indent=1)); tmp.replace(f)
        return p


def undo(pid=None, redo=False):
    pid = pid or current()
    with _lock:
        hist = pdir(pid) / 'history'; hist.mkdir(exist_ok=True)
        f = pdir(pid) / 'project.json'
        cur = json.loads(f.read_text())
        if redo:
            r = sorted(hist.glob('redo-*.json'))
            if not r: return cur
            nxt = json.loads(r[-1].read_text()); r[-1].unlink()
            (hist / f"{cur['rev']:05d}.json").write_text(json.dumps(cur))
        else:
            h = sorted(hist.glob('[0-9]*.json'))
            if not h: return cur
            nxt = json.loads(h[-1].read_text()); h[-1].unlink()
            (hist / f"redo-{cur['rev']:05d}.json").write_text(json.dumps(cur))
        nxt['rev'] = cur['rev'] + 1; nxt['note'] = 'redo' if redo else 'undo'; nxt['updated'] = time.time()
        f.write_text(json.dumps(nxt, indent=1))
        return nxt


# ---------- timeline helpers ----------

def track(p, tid):
    for t in p['tracks']:
        if t['id'] == tid: return t
    raise ValueError(f'no track {tid!r}; tracks: ' + ', '.join(t['id'] for t in p['tracks']))


def clip_len(c): return c['dur'] if 'dur' in c else c['out'] - c['in']
def clip_end(c): return c['at'] + clip_len(c)


def duration(p):
    return max([clip_end(c) for t in p['tracks'] if t['kind'] != 'layout' for c in t['clips']] or [0])


def find_clip(p, cid):
    for t in p['tracks']:
        for c in t['clips']:
            if c['id'] == cid: return t, c
    raise ValueError(f'no clip {cid!r}')


def active(t, at):
    for c in t['clips']:
        if c['at'] <= at < clip_end(c) - 1e-6: return c
    return None


def fr(x): return round(round(_num(x, -1e6, 1e6, 'time') * FPS) / FPS, 4)   # snap to a frame (numbers only)


def sort_tracks(p):
    for t in p['tracks']: t['clips'].sort(key=lambda c: c['at'])


def timeline_words(p):
    """Every spoken word on the timeline: [{w, s, e, src, i, clip}] in output seconds."""
    out = []
    cam = [t for t in p['tracks'] if t['kind'] == 'cam']
    speech = cam if any(t['clips'] for t in cam) else [t for t in p['tracks'] if t['kind'] == 'screen']
    clips = [c for t in speech for c in t['clips']]
    by_src = {}
    for c in clips: by_src.setdefault(c['src'], []).append(c)
    for sid, cs in by_src.items():
        for i, w in enumerate(p['sources'].get(sid, {}).get('words') or []):
            # a word belongs to the clip it overlaps most (whisper's word starts drift into the pauses we cut)
            best, ov = None, 0.0
            for c in cs:
                o = min(w['e'], c['out']) - max(w['s'], c['in'])
                if o > ov: best, ov = c, o
            if not best or ov < min(0.04, (w['e'] - w['s']) * 0.3): continue
            c = best
            s = c['at'] + max(w['s'], c['in']) - c['in']; e = c['at'] + min(w['e'], c['out']) - c['in']
            out.append({'w': w['w'], 's': round(s, 3), 'e': round(max(e, s + 0.05), 3), 'src': sid, 'i': i, 'clip': c['id']})
    out.sort(key=lambda w: w['s'])
    return out


def norm(w): return re.sub(r'[^a-z0-9]', '', w.lower().replace('’', "'").replace("'", ''))


def find_text(p, text):
    """Timeline ranges where `text` is spoken (fuzzy, word-level)."""
    want = [norm(x) for x in text.split() if norm(x)]
    words = timeline_words(p); got = [norm(w['w']) for w in words]
    hits = []
    if not want: return hits
    for i in range(len(got) - len(want) + 1):
        seg = got[i:i + len(want)]
        score = sum(1 for a, b in zip(seg, want) if a == b or (len(a) > 3 and len(b) > 3 and (a.startswith(b) or b.startswith(a)))) / len(want)
        if score >= 0.7: hits.append({'start': words[i]['s'], 'end': words[i + len(want) - 1]['e'], 'score': round(score, 2),
                                      'text': ' '.join(w['w'] for w in words[i:i + len(want)])})
    hits.sort(key=lambda h: -h['score'])
    return hits[:8]


def script_lines(p):
    return [l.strip() for l in re.split(r'\n\s*\n|\n(?=\S)', p.get('script') or '') if l.strip() and not l.strip().startswith('#')]


def line_times(p):
    """Each teleprompter line's timeline range, from the take's marks or by matching the transcript."""
    out = []
    for i, line in enumerate(script_lines(p)):
        ws = line.split()
        a = find_text(p, ' '.join(ws[:6])); b = find_text(p, ' '.join(ws[-5:]))
        if a:
            end = next((h['end'] for h in b if h['end'] >= a[0]['start']), a[0]['end'])
            out.append({'line': i + 1, 'text': line, 'start': a[0]['start'], 'end': end})
        else: out.append({'line': i + 1, 'text': line, 'start': None, 'end': None})
    return out


# ---------- ops ----------

def _set_path(obj, path, value):
    keys = path.split('.')
    for k in keys[:-1]: obj = obj.setdefault(k, {}) if isinstance(obj, dict) else obj[int(k)]
    obj[keys[-1]] = value


def _ripple(p, a, b, tracks=None):
    """Remove timeline range [a, b) from tracks and pull everything after it left."""
    d = b - a
    if d <= 0: return
    for t in p['tracks']:
        if tracks and t['id'] not in tracks: continue
        new = []
        for c in t['clips']:
            s, e = c['at'], clip_end(c)
            if e <= a: new.append(c); continue
            if s >= b: c['at'] = fr(s - d); new.append(c); continue
            dur_mode = 'dur' in c
            if s < a:   # keep the part before a
                left = copy.deepcopy(c)
                if dur_mode: left['dur'] = fr(a - s)
                else: left['out'] = round(left['in'] + (a - s), 3)
                new.append(left)
            if e > b:   # keep the part after b, moved to a
                right = copy.deepcopy(c); right['id'] = rid('c')
                if dur_mode: right['dur'] = fr(e - b)
                else: right['in'] = round(c['in'] + (b - s), 3)
                right['at'] = fr(a)
                new.append(right)
        t['clips'] = [c for c in new if clip_len(c) > 0.02]
    sort_tracks(p)


def _split(p, at, tracks=None):
    for t in p['tracks']:
        if tracks and t['id'] not in tracks: continue
        for c in list(t['clips']):
            if c['at'] + 0.02 < at < clip_end(c) - 0.02:
                right = copy.deepcopy(c); right['id'] = rid('c'); right['at'] = fr(at)
                if 'dur' in c: right['dur'] = fr(clip_end(c) - at); c['dur'] = fr(at - c['at'])
                else: right['in'] = round(c['in'] + at - c['at'], 3); c['out'] = right['in']
                t['clips'].append(right)
    sort_tracks(p)


def detect_silences(media):
    """Quiet stretches in a file's audio: [[start, end]] in source seconds (threshold follows the take's loudness)."""
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(media), '-af', 'volumedetect', '-vn', '-f', 'null', '-'], capture_output=True, text=True)
    m = re.search(r'mean_volume: (-?[\d.]+) dB', r.stderr)
    noise = min(-28.0, max(-50.0, (float(m.group(1)) if m else -30) - 9))
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(media), '-af', f'silencedetect=noise={noise}dB:d=0.25', '-vn', '-f', 'null', '-'],
                       capture_output=True, text=True)
    out, st = [], None
    for line in r.stderr.splitlines():
        if 'silence_start' in line: st = float(line.split('silence_start:')[1].split()[0])
        elif 'silence_end' in line and st is not None:
            out.append([round(max(0, st), 3), round(float(line.split('silence_end:')[1].split()[0]), 3)]); st = None
    if st is not None: out.append([round(st, 3), round(ffprobe(media)['duration'], 3)])
    return out


def silence_ranges(p, min_gap=0.45, keep=0.12, fillers=True):
    """Timeline ranges that are dead air (from the camera audio) or filler words (from the transcript)."""
    rs = []
    for t in p['tracks']:
        if t['kind'] != 'cam': continue
        for c in t['clips']:
            src = p['sources'].get(c['src'], {})
            for a, b in src.get('silences') or []:
                a, b = max(a, c['in']), min(b, c['out'])
                if b - a < min_gap: continue
                lead = a <= c['in'] + 0.01; tail = b >= c['out'] - 0.01
                ta = c['at'] + (a - c['in']) + (0 if lead else keep)
                tb = c['at'] + (b - c['in']) - (0 if tail else keep)
                rs.append((ta, tb))
    if fillers:
        rs += [(w['s'] - 0.03, w['e'] + 0.03) for w in timeline_words(p) if norm(w['w']) in FILLERS]
    rs = sorted((fr(a), fr(b)) for a, b in rs if b - a > 0.08)
    merged = []
    for a, b in rs:
        if merged and a <= merged[-1][1] + 0.02: merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
        else: merged.append((a, b))
    return merged


def apply_ops(pid, ops, note=''):
    """Apply a list of edit ops (see OPS_DOC) and save. Returns (project, log)."""
    with _lock:
        pid = pid or current()
        p = load(pid); log = []
        for op in ops:
            log.append(_op(p, dict(op)))
        sort_tracks(p)
        sanitize(p, pid)   # every value that can reach ffmpeg is a checked number or colour before it's saved
        p = save(pid, p, note or '; '.join(log)[:200])
        return p, log


TEXT_STYLE = ('size', 'y', 'color', 'accent', 'bg', 'fill', 'weight', 'maxWidth', 'font', 'shadow')
SET_PATHS = {'title', 'aspect', 'layout', 'bg', 'script', 'pip', 'pip.corner', 'pip.size', 'pip.shape',
             'frame', 'frame.margin', 'frame.radius', 'frame.shadow'}
CAPTION_KEYS = {'on', 'size', 'y', 'words', 'weight', 'upper', 'color', 'active', 'keyword', 'serifKeywords', 'box', 'keywords'}
COLOR_RE = re.compile(r'^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$')


def _num(v, lo, hi, name):
    """A finite number clamped to [lo, hi]; anything else (strings, filter fragments, NaN) is rejected."""
    if isinstance(v, bool) or not isinstance(v, (int, float, str)): raise ValueError(f'{name} must be a number')
    try: f = float(v)
    except (TypeError, ValueError): raise ValueError(f'{name} must be a number, got {v!r}')
    if not math.isfinite(f): raise ValueError(f'{name} must be finite')
    return min(max(f, lo), hi)


def _color(v, name, empty=False):
    if empty and v in ('', None): return ''
    if not isinstance(v, str) or not COLOR_RE.match(v): raise ValueError(f'{name} must be a colour like #1A1A1A, got {v!r}')
    return v


def _box(b, name, need_size=True):
    if not isinstance(b, dict): raise ValueError(f'{name} must be an object with x, y, w, h')
    out = {k: _num(b.get(k, 0 if k in 'xy' else 1), 0, 1, f'{name}.{k}') for k in 'xywh'}
    if need_size and (out['w'] <= 0 or out['h'] <= 0): raise ValueError(f'{name} needs a width and height above 0')
    out['w'] = min(out['w'], 1 - out['x']); out['h'] = min(out['h'], 1 - out['y'])
    return out


def _style(st, name):
    if not isinstance(st, dict): raise ValueError(f'{name} must be an object')
    out = {}
    for k, v in st.items():
        if k not in TEXT_STYLE: continue
        if k in ('color', 'accent'): out[k] = _color(v, f'{name}.{k}')
        elif k in ('bg', 'fill'): out[k] = _color(v, f'{name}.{k}', empty=True)
        elif k == 'font': out[k] = 'serif' if v == 'serif' else 'sans'
        elif k == 'shadow': out[k] = bool(v)
        elif k == 'weight': out[k] = _num(v, 100, 900, f'{name}.weight')
        elif k == 'size': out[k] = _num(v, 0.005, 0.4, f'{name}.size')
        else: out[k] = _num(v, 0, 1, f'{name}.{k}')
    return out


def sanitize(p, pid):
    """Check and normalise a whole project in place. The id always comes from the caller, sources stay inside the
    project folder, and every number or colour that reaches an ffmpeg filter string is validated here."""
    pdir(pid)
    p['id'] = pid
    if p.get('aspect') not in SIZES: p['aspect'] = '9:16'
    if p.get('layout', 'auto') not in LAYOUTS: raise ValueError(f"layout must be one of {LAYOUTS}")
    p['bg'] = _color(p.get('bg', '#1A1A1A'), 'bg')
    p['title'] = str(p.get('title', ''))[:200]; p['script'] = str(p.get('script') or '')
    pip = p.setdefault('pip', {})
    if not isinstance(pip, dict): raise ValueError('pip must be an object')
    pip['corner'] = pip.get('corner', 'br') if pip.get('corner', 'br') in ('tl', 'tr', 'bl', 'br') else 'br'
    pip['shape'] = 'rounded' if pip.get('shape') == 'rounded' else 'circle'
    pip['size'] = _num(pip.get('size', 0.34), 0.1, 0.8, 'pip.size')
    if p.get('frame') is not None:
        f = p['frame']
        if not isinstance(f, dict): raise ValueError('frame must be an object')
        p['frame'] = {'margin': _num(f.get('margin', 0.05), 0, 0.3, 'frame.margin'),
                      'radius': _num(f.get('radius', 0.025), 0, 0.2, 'frame.radius'), 'shadow': bool(f.get('shadow', True))}
    cs = p.setdefault('captions', {})
    for k in list(cs):
        if k not in CAPTION_KEYS: cs.pop(k)
    for k, lo, hi in (('size', 0.01, 0.2), ('y', 0, 1), ('weight', 100, 900)):
        if k in cs: cs[k] = _num(cs[k], lo, hi, f'captions.{k}')
    if 'words' in cs: cs['words'] = int(_num(cs['words'], 1, 12, 'captions.words'))
    for k in ('color', 'active', 'keyword'):
        if k in cs: cs[k] = _color(cs[k], f'captions.{k}')
    if 'box' in cs: cs['box'] = _color(cs['box'], 'captions.box', empty=True)
    for k in ('on', 'upper', 'serifKeywords'):
        if k in cs: cs[k] = bool(cs[k])
    cs['keywords'] = [str(x)[:60] for x in (cs.get('keywords') or [])][:50]
    for sid, s in (p.get('sources') or {}).items():
        if not isinstance(s, dict) or not PID_RE.match(str(sid)): raise ValueError(f'bad source {sid!r}')
        source_file(pid, s)
        s['duration'] = _num(s.get('duration', 0), 0, 1e6, f'{sid}.duration')
        for k in ('w', 'h'): s[k] = int(_num(s.get(k) or 0, 0, 20000, f'{sid}.{k}'))
    for t in p.get('tracks') or []:
        if t.get('kind') not in ('layout', 'overlay', 'screen', 'cam'): raise ValueError(f"bad track kind {t.get('kind')!r}")
        if not PID_RE.match(str(t.get('id', ''))): raise ValueError(f"bad track id {t.get('id')!r}")
        for c in t.get('clips') or []:
            c['at'] = _num(c.get('at', 0), 0, 1e6, 'at')
            if 'dur' in c: c['dur'] = _num(c['dur'], 0, 1e6, 'dur')
            if t['kind'] == 'layout':
                if c.get('mode') not in LAYOUTS: raise ValueError(f"layout mode must be one of {LAYOUTS}")
                continue
            if c.get('kind') == 'text':
                c['text'] = str(c.get('text', ''))[:500]; c['style'] = _style(c.get('style') or {}, 'style')
                c['anim'] = 'fade' if c.get('anim') == 'fade' else ''
                continue
            if c.get('src') not in (p.get('sources') or {}): raise ValueError(f"clip {c.get('id')} uses an unknown source")
            c['in'] = _num(c.get('in', 0), 0, 1e6, 'in'); c['out'] = _num(c.get('out', 0), c['in'], 1e6, 'out')
            if 'volume' in c: c['volume'] = _num(c['volume'], 0, 4, 'volume')
            if 'radius' in c: c['radius'] = _num(c['radius'], 0, 0.5, 'radius')
            if 'push' in c: c['push'] = _num(c['push'], 0, 1, 'push')
            if c.get('box') is not None: c['box'] = _box(c['box'], 'box')
            if c.get('crop') is not None: c['crop'] = _box(c['crop'], 'crop')
            if 'fit' in c: c['fit'] = 'contain' if c['fit'] == 'contain' else 'cover'
            if 'anim' in c: c['anim'] = 'fade' if c['anim'] == 'fade' else ''
    return p


def _op(p, o):
    k = o.pop('op', '')
    if k == 'set':
        path = str(o['path'])
        if path not in SET_PATHS and not (path.startswith('captions.') and path.split('.', 1)[1] in CAPTION_KEYS):
            raise ValueError(f'set can only change: {", ".join(sorted(SET_PATHS))}, captions.<key>')
        _set_path(p, path, o['value']); return f"set {path}"
    if k == 'captions':
        bad = [x for x in o if x not in CAPTION_KEYS]
        if bad: raise ValueError(f'unknown caption setting {bad}')
        p['captions'].update({x: v for x, v in o.items()}); return 'captions ' + ', '.join(o)
    if k == 'keywords':
        kw = [x for x in p['captions'].get('keywords', []) if x not in (o.get('remove') or [])]
        kw += [x for x in (o.get('add') or []) if x not in kw]
        p['captions']['keywords'] = kw; return f'keywords {kw}'
    if k == 'text':
        tid = o.get('track', 'overlay')
        at = fr(o.get('start', o.get('at', 0)))
        dur = fr((o['end'] - at) if 'end' in o else o.get('dur', 3))
        st = {x: o[x] for x in TEXT_STYLE if x in o}
        c = {'id': rid('t'), 'kind': 'text', 'text': o['text'], 'at': at, 'dur': dur, 'style': st, 'anim': o.get('anim', 'fade')}
        track(p, tid)['clips'].append(c); return f"text {c['id']} {at}-{at + dur}"
    if k == 'add_clip' or k == 'overlay':
        tid = o.pop('track', 'overlay')
        src = o['src']
        if src not in p['sources']: raise ValueError(f'no source {src!r}; sources: ' + ', '.join(p['sources']))
        s = p['sources'][src]
        at = fr(o.pop('start', o.pop('at', 0)))
        c = {'id': rid('c'), 'src': src, 'at': at}
        if s['kind'] == 'image':
            end = o.pop('end', None)
            c['in'] = 0; c['out'] = round((end - at) if end is not None else o.pop('dur', 3), 3)
        else:
            c['in'] = round(o.pop('in', 0), 3)
            end = o.pop('end', None)
            c['out'] = round(c['in'] + (end - at) if end is not None else o.pop('out', s['duration']), 3)
            c['out'] = min(c['out'], s['duration'])
        o.pop('dur', None)
        if track(p, tid)['kind'] == 'overlay':
            c.update({'box': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'fit': 'cover', 'radius': 0, 'anim': 'fade'})
        if track(p, tid)['kind'] in ('cam', 'screen'): c['volume'] = 1 if track(p, tid)['kind'] == 'cam' else 0
        for x, v in o.items():
            if x == 'box': c['box'] = {**c.get('box', {}), **v}
            else: c[x] = v
        track(p, tid)['clips'].append(c); return f"added {c['id']} on {tid} at {at}s"
    if k == 'update_clip' or k == 'move_clip' or k == 'trim_clip':
        t, c = find_clip(p, o.pop('id'))
        to = o.pop('track', None)
        if c.get('kind') == 'text':   # title look: merge, and accept size/y/color/... at the top level too
            st = dict(c.get('style') or {}); st.update(o.pop('style', None) or {})
            for x in TEXT_STYLE:
                if x in o: st[x] = o.pop(x)
            c['style'] = st
        for x, v in o.items():
            if x == 'box': c['box'] = {**c.get('box', {}), **v}
            elif x in ('at', 'dur'): c[x] = fr(v)
            else: c[x] = v
        if to and to != t['id']:
            t['clips'].remove(c); track(p, to)['clips'].append(c)
        return f"updated {c['id']}"
    if k == 'delete_clip':
        t, c = find_clip(p, o['id'])
        if o.get('ripple'): _ripple(p, c['at'], clip_end(c))
        else: t['clips'].remove(c)
        return f"deleted {o['id']}"
    if k == 'split':
        _split(p, o['at'], o.get('tracks')); return f"split at {o['at']}"
    if k == 'ripple_delete' or k == 'cut':
        _ripple(p, fr(o['start']), fr(o['end']), o.get('tracks')); return f"cut {o['start']}-{o['end']}"
    if k == 'cut_silences':
        rs = silence_ranges(p, o.get('min_gap', 0.45), o.get('keep', 0.12), o.get('fillers', True))
        saved = 0
        for a, b in reversed(rs): _ripple(p, a, b); saved += b - a
        return f'cut {len(rs)} pauses ({saved:.1f}s)'
    if k == 'layout':
        mode = o['mode']
        if mode not in LAYOUTS: raise ValueError(f'layout must be one of {LAYOUTS}')
        if 'start' not in o: p['layout'] = mode; track(p, 'layout')['clips'] = []; return f'layout {mode} everywhere'
        a, b = fr(o['start']), fr(o['end'])
        lt = track(p, 'layout')
        _split(p, a, ['layout']); _split(p, b, ['layout'])
        lt['clips'] = [c for c in lt['clips'] if not (c['at'] >= a - 0.01 and clip_end(c) <= b + 0.01)]
        lt['clips'].append({'id': rid('l'), 'at': a, 'dur': fr(b - a), 'mode': mode})
        return f'layout {mode} {a}-{b}'
    if k == 'add_track':
        tid = o.get('id') or rid('overlay')
        p['tracks'].insert(1, {'id': tid, 'kind': 'overlay', 'label': o.get('label', 'B-roll'), 'clips': []}); return f'track {tid}'
    if k == 'fix_word':
        w = p['sources'][o['src']]['words'][o['i']]; w['w'] = o['w']; return f"word {o['i']} → {o['w']}"
    if k == 'replace_word':
        n = 0
        for s in p['sources'].values():
            for w in s.get('words') or []:
                if norm(w['w']) == norm(o['find']):
                    w['w'] = re.sub(re.escape(re.sub(r'[^\w]', '', w['w'])), o['replace'], w['w']) if re.sub(r'[^\w]', '', w['w']) else o['replace']; n += 1
        return f"replaced {n}× {o['find']}"
    if k == 'script':
        p['script'] = o['text']; return 'script'
    raise ValueError(f'unknown op {k!r}')


OPS_DOC = """Ops (times are timeline seconds):
- {"op":"cut","start":s,"end":e}                ripple-delete a range on every track
- {"op":"cut_silences","min_gap":0.45,"keep":0.12,"fillers":true}   remove pauses + um/uh
- {"op":"split","at":t}                         split clips at t
- {"op":"layout","mode":"cam|screen|pip|split|auto","start":s,"end":e}   (omit start/end = whole video)
- {"op":"overlay","src":id,"start":s,"end":e,"box":{"x":0,"y":0,"w":1,"h":1},"fit":"cover|contain","radius":0.04,"track":"overlay"}
- {"op":"add_clip","track":"screen|cam|overlay","src":id,"at":t,"in":0,"out":d}
- {"op":"update_clip","id":cid, ...fields}      e.g. at, in, out, volume, box, fit, radius, crop, push; for a text clip also text, size, y, color, bg (merged into its style)
- {"op":"delete_clip","id":cid,"ripple":false}
- {"op":"captions", "on":true,"size":0.045,"y":0.70,"words":4,"weight":800,"upper":false,"color":"#FFFFEB","active":"#F0D7FF","keyword":"#FFA946","serifKeywords":true,"box":"#1A1A1ACC"|""}
- {"op":"text","text":"Don't type, *just speak.*","start":s,"end":e,"y":0.5,"size":0.06,"color":"#FFFFEB","accent":"#F0D7FF","bg":"#1A1A1ACC","fill":"#FFFFEB"}   title / caption card; *stars* = italic serif; fill = full-frame card
- {"op":"keywords","add":["wispr"],"remove":[]}
- {"op":"replace_word","find":"wisper","replace":"Wispr"}
- {"op":"set","path":"pip.size","value":0.3}     any field: aspect (9:16|4:5|16:9|1:1), pip.corner (tl|tr|bl|br), pip.shape (circle|rounded), bg, title
- {"op":"add_track","label":"B-roll 2"}"""


# ---------- media ----------

def ffprobe(f):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height',
                        '-of', 'json', str(f)], capture_output=True, text=True)
    j = json.loads(r.stdout or '{}')
    v = next((s for s in j.get('streams', []) if s.get('codec_type') == 'video'), {})
    return {'duration': float(j.get('format', {}).get('duration') or 0), 'w': v.get('width', 0), 'h': v.get('height', 0),
            'hasAudio': any(s.get('codec_type') == 'audio' for s in j.get('streams', []))}


def _proxy(src, out):
    """Constant-30fps H.264 copy for scrubbing and the export (hardware encoder first, max 1920 wide)."""
    vf = "fps=30,scale='min(1920,iw)':-2,format=yuv420p"
    # audio padded with silence back to 0, so a take whose mic started late stays in sync with its picture
    tail = ['-af', 'aresample=async=1:first_pts=0', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k', '-movflags', '+faststart', str(out)]
    for enc in (['-c:v', 'h264_videotoolbox', '-b:v', '10M', '-g', '15'], ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '15']):
        r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(src), '-vf', vf, *enc, *tail], capture_output=True, text=True)
        if r.returncode == 0: return
    raise RuntimeError('could not read ' + Path(src).name + ': ' + r.stderr[-400:])


IMAGE_EXT = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic'}


def import_media(pid, path, role='media', at=None, take=None, marks=None, recorded_at=None, keep_original=True, name=None):
    """Bring a file into the project as a source (proxied to CFR mp4) and put a clip for it on the timeline.
    role: cam (A-roll, transcribed) | screen | media (b-roll/overlay)."""
    path = Path(path)
    p = load(pid)
    sid = rid({'cam': 'cam', 'screen': 'scr'}.get(role, 'med'))
    media = pdir(pid) / 'media'; media.mkdir(exist_ok=True)
    ext = path.suffix.lower()
    if ext in IMAGE_EXT:
        out = media / f'{sid}.png'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-frames:v', '1', str(out)], check=True)
        info = ffprobe(out); info['duration'] = 0; kind = 'image'
    else:
        out = media / f'{sid}.mp4'
        _proxy(path, out)
        info = ffprobe(out); kind = role if role in ('cam', 'screen') else 'video'
        if not info['w']: kind = 'audio'
    if keep_original and path.parent != media:
        try: shutil.copy2(path, media / f'{sid}.orig{ext}')
        except Exception: pass
    silences = detect_silences(out) if kind in ('cam', 'video', 'audio') and info.get('hasAudio') else []
    with _lock:
        p = load(pid)
        p['sources'][sid] = {'id': sid, 'kind': kind, 'file': f'media/{out.name}', 'name': name or path.name, 'take': take,
                             'recordedAt': recorded_at, 'marks': marks or [], 'words': None, **info,
                             'silences': silences}
        tid = 'cam' if role == 'cam' else 'screen' if role == 'screen' else 'overlay'
        t = track(p, tid)
        if at is None: at = max([clip_end(c) for c in t['clips']] or [0]) if role != 'media' else 0
        c = {'id': rid('c'), 'src': sid, 'at': fr(float(at)), 'in': 0,
             'out': round(info['duration'] if kind != 'image' else 3, 3)}
        if tid == 'overlay': c.update({'box': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'fit': 'cover', 'radius': 0, 'anim': 'fade'})
        else: c['volume'] = 1 if role == 'cam' else 0
        if role != 'media' or kind != 'image' or at is not None:
            t['clips'].append(c)
        if role in ('cam', 'screen') and ext not in IMAGE_EXT:
            n = 1 + len({s.get('take') for s in p['sources'].values() if s['kind'] == role and s['id'] != sid})
            kept = readable_copy(p, path, f"Take {n}", f" ({'camera' if role == 'cam' else 'screen'}){ext}")
            p['sources'][sid]['saved'] = str(kept)
        sort_tracks(p)
        save(pid, p, f'imported {path.name} as {role}')
    return sid


# ---------- transcription ----------

def whisper_model():
    env = os.environ.get('WISPR_VIDEO_MODEL')
    cands = [Path(env)] if env else []
    cands += sorted((HOME / 'models').glob('ggml-*.bin'))
    cands += [Path.home() / 'Library/Application Support/Recordly/whisper/ggml-small.bin', Path.home() / '.relay/models/ggml-base.en.bin']
    for d in ('/opt/homebrew/share/whisper-cpp', '/usr/local/share/whisper-cpp'):
        cands += [x for x in sorted(Path(d).glob('ggml-*.bin')) if 'for-tests' not in x.name] if Path(d).exists() else []
    return next((c for c in cands if c.exists() and c.stat().st_size > 20e6), None)


def download_model(name='base.en'):
    (HOME / 'models').mkdir(parents=True, exist_ok=True)
    dst = HOME / 'models' / f'ggml-{name}.bin'
    subprocess.run(['curl', '-fL', '-o', str(dst), f'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin'], check=True)
    return dst


def transcribe(pid, sid=None):
    """Word-level transcript for a source (default: every untranscribed camera source)."""
    p = load(pid)
    sids = [sid] if sid else [k for k, s in p['sources'].items() if s['kind'] == 'cam' and not s.get('words')]
    done = {}
    for sid in sids:
        s = p['sources'][sid]
        if not s.get('hasAudio'): continue
        sil = s.get('silences')
        if sil is None: sil = detect_silences(source_file(pid, s))
        words = _whisper(source_file(pid, s), sil)
        words = _align_to_script(words, p.get('script', ''))
        with _lock:
            p = load(pid); p['sources'][sid]['words'] = words; p['sources'][sid]['silences'] = sil
            if p['captions'].get('keywords') == [] and p.get('script'):
                p['captions']['keywords'] = _guess_keywords(p['script'])
            save(pid, p, f'transcribed {sid} ({len(words)} words)')
        done[sid] = len(words)
    return done


def spread_words(segments, silences):
    """Word timings from phrase timings: each phrase's words are laid over its voiced audio (the phrase's span
    minus measured silences), by length. Much steadier than whisper.cpp's per-token stamps."""
    words = []
    for s0, e0, text in segments:
        toks = text.split()
        if not toks: continue
        voiced, t = [], s0
        for a, b in sorted(silences or []):
            if b <= s0 or a >= e0: continue
            if a > t: voiced.append((t, min(a, e0)))
            t = max(t, b)
        if t < e0: voiced.append((t, e0))
        voiced = [(a, b) for a, b in voiced if b - a > 0.05] or [(s0, e0)]
        total = sum(b - a for a, b in voiced)
        weights = [len(x) + 2 for x in toks]; W = sum(weights)

        def at(frac):   # position along the voiced stretches
            d = frac * total
            for a, b in voiced:
                if d <= b - a + 1e-9: return a + d
                d -= b - a
            return voiced[-1][1]
        acc = 0
        for tok, w in zip(toks, weights):
            ws, we = at(acc / W), at((acc + w) / W); acc += w
            words.append({'w': tok, 's': round(ws, 3), 'e': round(max(we, ws + 0.06), 3)})
    return words


def _whisper(media, silences=None):
    tmp = Path(tempfile.mkdtemp(prefix='wv-'))
    wav = tmp / 'a.wav'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(media), '-ar', '16000', '-ac', '1', str(wav)], check=True)
    model = whisper_model()
    if model and shutil.which('whisper-cli'):
        subprocess.run(['whisper-cli', '-m', str(model), '-f', str(wav), '-l', 'en', '-oj', '-of', str(tmp / 'o'), '-np'], check=True, capture_output=True)
        j = json.loads((tmp / 'o.json').read_text(errors='replace'))
        segs = [(x['offsets']['from'] / 1000, x['offsets']['to'] / 1000, x['text'].strip()) for x in j.get('transcription', [])]
        segs = [x for x in segs if x[2] and not x[2].startswith(('[', '('))]
        words = spread_words(segs, silences)
    elif shutil.which('whisper'):
        subprocess.run(['whisper', str(wav), '--model', 'base.en', '--word_timestamps', 'True', '--output_format', 'json',
                        '--output_dir', str(tmp), '--language', 'en'], check=True, capture_output=True)
        j = json.loads((tmp / 'a.json').read_text())
        words = [{'w': w['word'].strip(), 's': round(w['start'], 3), 'e': round(w['end'], 3)}
                 for seg in j['segments'] for w in seg.get('words', [])]
    else:
        raise RuntimeError('no speech model: install whisper-cpp (brew install whisper-cpp) and run video_setup to fetch a model')
    shutil.rmtree(tmp, ignore_errors=True)
    return [w for w in words if w['w']]


def _align_to_script(words, script):
    """Where the transcript matches the script, use the script's spelling and punctuation for the captions."""
    sw = (script or '').split()
    if not sw or not words: return words
    a = [norm(w['w']) for w in words]; b = [norm(x) for x in sw]
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal' or (tag == 'replace' and i2 - i1 == j2 - j1 and i2 - i1 <= 3):
            for k in range(i2 - i1):
                if tag == 'replace' and difflib.SequenceMatcher(None, a[i1 + k], b[j1 + k]).ratio() < 0.6: continue
                words[i1 + k]['w'] = sw[j1 + k].strip('*_>')
    return words


def _guess_keywords(script):
    caps = re.findall(r"\b([A-Z][a-zA-Z]{3,}|[A-Z]{2,}|\d[\w%]*)\b", script)
    common = {'This', 'That', 'There', 'They', 'What', 'When', 'Then', 'With', 'Your', 'Just', 'And', 'But', 'The', 'And'}
    seen = []
    for c in caps:
        if c not in common and c.lower() not in [s.lower() for s in seen]: seen.append(c)
    return seen[:12]


# ---------- captions ----------

def caption_chunks(p):
    """Caption pages: [{s, e, words:[{w,s,e,kw}]}] in timeline seconds."""
    cs = p['captions']; n = max(1, int(cs.get('words', 4)))
    kws = {norm(k) for k in cs.get('keywords', [])}
    words = [w for w in timeline_words(p) if norm(w['w']) not in FILLERS]
    chunks, cur = [], []
    for w in words:
        if cur and (len(cur) >= n or w['s'] - cur[-1]['e'] > 0.6 or re.search(r'[.?!]$', cur[-1]['w'])):
            chunks.append(cur); cur = []
        cur.append({**w, 'kw': norm(w['w']) in kws})
    if cur: chunks.append(cur)
    out = []
    for i, c in enumerate(chunks):
        nxt = chunks[i + 1][0]['s'] if i + 1 < len(chunks) else c[-1]['e'] + 0.4
        e = min(nxt, c[-1]['e'] + 0.4)
        out.append({'s': c[0]['s'], 'e': round(e, 3), 'words': c})
    return out


def caption_states(p):
    """One state per word: [{s, e, runs:[{t,c,serif}]}]."""
    cs = p['captions']; states = []
    for ch in caption_chunks(p):
        for k, w in enumerate(ch['words']):
            s = ch['s'] if k == 0 else w['s']
            e = ch['words'][k + 1]['s'] if k + 1 < len(ch['words']) else ch['e']
            runs = []
            for j, x in enumerate(ch['words']):
                t = x['w'].upper() if cs.get('upper') else x['w']
                col = cs['active'] if j == k else cs['keyword'] if x['kw'] else cs['color']
                runs.append({'t': t, 'c': col, 'serif': bool(x['kw'] and cs.get('serifKeywords'))})
            states.append({'s': round(s, 3), 'e': round(e, 3), 'runs': runs})
    return states


def capgen_bin():
    src = HERE / 'capgen.swift'
    h = hashlib.sha1(src.read_bytes()).hexdigest()[:10]
    b = HOME / '.bin' / f'capgen-{h}'
    if not b.exists():
        b.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['swiftc', '-O', str(src), '-o', str(b)], check=True, capture_output=True)
    return b


def render_captions(p, W, H, work, states=None):
    """Caption PNGs + an ffconcat list that plays them over the timeline (or None if captions are off)."""
    cs = p['captions']
    states = caption_states(p) if states is None else states
    if not cs.get('on') or not states: return None
    frames = [{'file': str(work / 'cap-blank.png'), 'runs': []}]
    for i, s in enumerate(states): frames.append({'file': str(work / f'cap{i:05d}.png'), 'runs': s['runs']})
    spec = {'width': W, 'height': H, 'fontsDir': str(FONTS), 'frames': frames,
            'style': {'size': cs['size'], 'y': cs['y'], 'weight': cs.get('weight', 800), 'maxWidth': 0.84,
                      'box': cs.get('box') or '', 'shadow': True}}
    (work / 'caps.json').write_text(json.dumps(spec))
    subprocess.run([str(capgen_bin()), str(work / 'caps.json')], check=True)
    lines = ['ffconcat version 1.0']; t = 0
    for i, s in enumerate(states):
        if s['s'] > t + 0.01: lines += [f"file 'cap-blank.png'", f'duration {s["s"] - t:.3f}']
        lines += [f"file 'cap{i:05d}.png'", f'duration {max(0.04, s["e"] - max(t, s["s"])):.3f}']
        t = max(t, s['e'])
    lines += ["file 'cap-blank.png'", 'duration 1', "file 'cap-blank.png'"]
    (work / 'caps.txt').write_text('\n'.join(lines) + '\n')
    return work / 'caps.txt'


# ---------- render ----------

def _mask(work, w, h, r, circle=False):
    f = work / f'mask-{w}x{h}-{r}-{int(circle)}.png'
    if f.exists(): return f
    if circle: e = f"if(lte(hypot(X-{w}/2,Y-{h}/2),{min(w, h)}/2-1),255,0)"
    else: e = f"if(lte(hypot(max(abs(X-{w}/2)-({w}/2-{r}),0),max(abs(Y-{h}/2)-({h}/2-{r}),0)),{r}),255,0)"
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'color=black:s={w}x{h}', '-vf', f"format=gray,geq=lum='{e}'",
                    '-frames:v', '1', str(f)], check=True)
    return f


def _shadow(work, w, h, r, pad):
    """A soft drop shadow for a rounded frame: black with a blurred rounded-rect alpha, pad px bigger on each side."""
    f = work / f'shadow-{w}x{h}-{r}-{pad}.png'
    if f.exists(): return f
    W2, H2 = w + 2 * pad, h + 2 * pad
    e = f"if(lte(hypot(max(abs(X-{W2}/2)-({w}/2-{r}),0),max(abs(Y-{H2}/2)-({h}/2-{r}),0)),{r}),255,0)"
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'color=black:s={W2}x{H2}', '-f', 'lavfi', '-i', f'color=black:s={W2}x{H2}',
                    '-filter_complex', f"[1:v]format=gray,geq=lum='{e}',boxblur={max(2, pad // 2)}:2,lut=y=val*0.30[a];[0:v]format=rgba[c];[c][a]alphamerge",
                    '-frames:v', '1', str(f)], check=True)
    return f


def layout_at(p, t, has_cam, has_scr):
    c = active(track(p, 'layout'), t)
    mode = c['mode'] if c else p.get('layout', 'auto')
    if mode == 'auto': mode = 'pip' if has_scr and has_cam else 'screen' if has_scr else 'cam'
    if mode in ('pip', 'split') and not (has_cam and has_scr): mode = 'cam' if has_cam else 'screen'
    if mode == 'cam' and not has_cam and has_scr: mode = 'screen'
    if mode == 'screen' and not has_scr and has_cam: mode = 'cam'
    return mode


def geometry(p, mode, W, H, scr_wh=(16, 9)):
    """Boxes (x, y, w, h in px) for the screen and the camera in a layout. Used by the export and mirrored by the UI."""
    pip = p.get('pip', {}); portrait = H > W
    sw, sh = scr_wh
    if mode == 'cam': return {'cam': (0, 0, W, H, 'cover')}
    if mode == 'screen' or mode == 'pip':
        m = 0.04 * W
        bw = W - 2 * m; bh = bw * sh / sw
        if bh > H - 2 * m: bh = H - 2 * m; bw = bh * sw / sh
        y = (H - bh) / 2 - (0.12 * H if portrait and mode == 'pip' else 0)
        g = {'screen': ((W - bw) / 2, max(m, y), bw, bh, 'contain'), 'bg': True}
        if mode == 'pip':
            s = pip.get('size', 0.34) * min(W, H) * (1 if portrait else 0.9)
            mx = 0.05 * min(W, H)
            corner = pip.get('corner', 'br')
            x = mx if 'l' in corner else W - s - mx
            yy = mx + 0.06 * H if 't' in corner else H - s - mx - (0.05 * H if portrait else 0)
            g['cam'] = (x, yy, s, s, 'cover')
        return g
    if mode == 'split':
        if portrait or W == H: return {'screen': (0, 0, W, H / 2, 'cover'), 'cam': (0, H / 2, W, H / 2, 'cover')}
        return {'screen': (0, 0, W / 2, H, 'cover'), 'cam': (W / 2, 0, W / 2, H, 'cover')}
    return {}


def _ev(x): return int(round(x / 2) * 2)


def segments(p):
    total = duration(p)
    pts = {0.0, fr(total)}
    for t in p['tracks']:
        for c in t['clips']:
            pts.add(fr(c['at'])); pts.add(fr(clip_end(c)))
    pts = sorted(x for x in pts if 0 <= x <= total)
    return [(a, b) for a, b in zip(pts, pts[1:]) if b - a >= 1 / FPS - 1e-6]


def text_runs(text, color, accent):
    """'Don't type, *just speak.*' → runs; *starred* words use the italic serif. A word gets a space before it
    unless it touches the previous run ("sameep*.ai*" stays one word)."""
    runs, prev_space = [], True
    for i, part in enumerate(re.split(r'\*([^*]+)\*', text)):
        for k, w in enumerate(part.split()):
            sp = (prev_space or part[:1].isspace()) if k == 0 else True
            runs.append({'t': w, 'c': accent if i % 2 else color, 'serif': bool(i % 2), 'sp': bool(sp or not runs)})
        if part: prev_space = part[-1:].isspace()
    return runs


def _light(hexc):
    h = hexc.lstrip('#')[:6]
    try: r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError: return True
    return 0.299 * r + 0.587 * g + 0.114 * b > 140


def text_png(c, W, H, work):
    st = c.get('style') or {}
    key = hashlib.sha1(json.dumps([c['text'], st, W, H]).encode()).hexdigest()[:12]
    f = work / f'text-{key}.png'
    if f.exists(): return f
    fill = st.get('fill', '')
    color = st.get('color', '#1A1A1A' if fill else '#FFFFEB')
    spec = {'width': W, 'height': H, 'fontsDir': str(FONTS), 'frames': [{'file': str(f), 'runs': text_runs(c['text'], color, st.get('accent', color))}],
            'style': {'size': st.get('size', 0.06) * min(H, W) / H, 'y': st.get('y', 0.5), 'weight': st.get('weight', 700), 'maxWidth': st.get('maxWidth', 0.84),
                      'font': 'EB Garamond' if st.get('font') == 'serif' else 'Figtree',
                      'box': st.get('bg', ''), 'shadow': st.get('shadow', not fill and not st.get('bg') and _light(color)), 'fill': fill}}
    (work / f'text-{key}.json').write_text(json.dumps(spec))
    subprocess.run([str(capgen_bin()), str(work / f'text-{key}.json')], check=True)
    return f


def _segment_cmd(p, a, b, W, H, out, work, still=False):
    """ffmpeg command that renders the timeline range [a, b) to `out` with everything but captions."""
    d = round(b - a, 4); mid = (a + b) / 2
    cam_t = next((t for t in p['tracks'] if t['kind'] == 'cam'), None)
    scr_t = next((t for t in p['tracks'] if t['kind'] == 'screen'), None)
    cam = active(cam_t, mid) if cam_t else None
    scr = active(scr_t, mid) if scr_t else None
    if cam and p['sources'][cam['src']]['kind'] not in ('cam', 'video', 'screen'): cam = None
    ovs = [(t, active(t, mid)) for t in reversed(p['tracks']) if t['kind'] == 'overlay']
    ovs = [c for t, c in ovs if c]
    mode = layout_at(p, mid, bool(cam), bool(scr))
    scr_src = p['sources'][scr['src']] if scr else {}
    g = geometry(p, mode, W, H, (scr_src.get('w') or 16, scr_src.get('h') or 9))
    args, fc, n = [], [], 0

    def inp(c, image=False):
        nonlocal n
        s = p['sources'][c['src']]; f = str(source_file(p['id'], s))
        if s['kind'] == 'image': args.extend(['-loop', '1', '-t', f'{d}', '-i', f])
        else: args.extend(['-ss', f"{c['in'] + (a - c['at']):.4f}", '-t', f'{d + 0.2:.4f}', '-i', f])   # margin: a one-frame window can miss every source frame
        n += 1; return n - 1

    fc.append(f"color=c={_color(p.get('bg', '#1A1A1A'), 'bg').replace('#', '0x')}:s={W}x{H}:r={FPS}:d={d}[base]")
    last = 'base'

    def place(idx, box, label, radius=0, circle=False, fade=False, fit=None, aspect=None, clip=None, shadow=False):
        nonlocal last, n
        x, y, w, h, f0 = box; fit = fit or f0
        cr = (clip or {}).get('crop')   # {x,y,w,h} of the source, 0-1: a punch-in on part of the frame
        if cr is not None: cr = _box(cr, 'crop')   # re-checked here too: only numbers ever reach the filter string
        pre = f"crop=iw*{cr['w']}:ih*{cr['h']}:iw*{cr['x']}:ih*{cr['y']}," if cr else ''
        if cr and aspect: aspect = (aspect[0] * cr['w'], aspect[1] * cr['h'])
        if fit == 'contain' and aspect:   # shrink the box to the media's own shape, so corners and masks hug it
            sw, sh = aspect
            if w / h > sw / sh: nw = h * sw / sh; x += (w - nw) / 2; w = nw
            else: nh = w * sh / sw; y += (h - nh) / 2; h = nh
            fit = 'cover'
        w, h = _ev(w), _ev(h)
        push = ''
        if clip and clip.get('push'):   # slow push-in across the whole clip, continuous over segment cuts
            L = max(0.1, float(clip_len(clip))); off = float(a) - float(clip['at']); clip = {**clip, 'push': _num(clip['push'], 0, 1, 'push')}
            push = f",zoompan=z='1+{clip['push']}*({off:.4f}+on/{FPS})/{L:.4f}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={w}x{h}:fps={FPS}"
        if fit == 'cover': fc.append(f"[{idx}:v]setpts=PTS-STARTPTS,{pre}fps={FPS},scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}{push},setsar=1,format=rgba[{label}0]")
        else: fc.append(f"[{idx}:v]setpts=PTS-STARTPTS,{pre}fps={FPS},scale={w}:{h}:force_original_aspect_ratio=decrease,setsar=1,format=rgba[{label}0]")
        cur = f'{label}0'
        if shadow:
            pad = max(8, int(0.025 * min(W, H)))
            sh = _shadow(work, w, h, int(radius * min(w, h)) or 1, pad)
            args.extend(['-loop', '1', '-t', f'{d}', '-i', str(sh)]); n += 1
            fc.append(f"[{last}][{n - 1}:v]overlay=x={int(x) - pad}:y={int(y) - pad + pad // 3}[{label}sh]"); last = f'{label}sh'
        if radius or circle:
            if fit != 'cover':   # mask must match the scaled size: pad to box first
                fc.append(f"[{cur}]pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black@0[{label}p]"); cur = f'{label}p'
            m = _mask(work, w, h, int(radius * min(w, h)) or 1, circle)
            args.extend(['-loop', '1', '-t', f'{d}', '-i', str(m)]); n += 1
            fc.append(f"[{n - 1}:v]format=gray[{label}m];[{cur}][{label}m]alphamerge[{label}a]"); cur = f'{label}a'
        if fade: fc.append(f"[{cur}]fade=in:st=0:d=0.18:alpha=1[{label}f]"); cur = f'{label}f'
        cx = f'{int(x)}+({w}-overlay_w)/2' if fit != 'cover' else f'{int(x)}'
        cy = f'{int(y)}+({h}-overlay_h)/2' if fit != 'cover' else f'{int(y)}'
        fc.append(f"[{last}][{cur}]overlay=x={cx}:y={cy}:eof_action=repeat[{label}o]"); last = f'{label}o'

    si = inp(scr) if scr and 'screen' in g else None
    ci = inp(cam) if cam and 'cam' in g else None
    fr_ = p.get('frame')
    if si is not None and g.get('bg') and fr_:   # Wispr-style: footage in a soft rounded frame on a flat plate, no blur
        m = fr_.get('margin', 0.05) * min(W, H)
        place(si, (m, m, W - 2 * m, H - 2 * m, 'contain'), 'scr', radius=fr_.get('radius', 0.025),
              aspect=(scr_src.get('w') or 16, scr_src.get('h') or 9), clip=scr, shadow=fr_.get('shadow', True))
    elif si is not None and g.get('bg'):
        fc.append(f"[{si}:v]setpts=PTS-STARTPTS,split=2[sbg][sfg]")
        fc.append(f"[sbg]fps={FPS},scale={W // 8}:{H // 8}:force_original_aspect_ratio=increase,crop={W // 8}:{H // 8},boxblur=6:2,eq=brightness=-0.12:saturation=0.8,scale={W}:{H},setsar=1[sbgb]")
        fc.append(f"[{last}][sbgb]overlay=0:0[bgo]"); last = 'bgo'
        x, y, w, h, _ = g['screen']; w, h = _ev(w), _ev(h)
        fc.append(f"[sfg]fps={FPS},scale={w}:{h},setsar=1,format=rgba[scr0]")
        m = _mask(work, w, h, int(0.025 * W))
        args.extend(['-loop', '1', '-t', f'{d}', '-i', str(m)]); n += 1
        fc.append(f"[{n - 1}:v]format=gray[scrm];[scr0][scrm]alphamerge[scra]")
        fc.append(f"[{last}][scra]overlay=x={int(x)}:y={int(y)}[so]"); last = 'so'
    elif si is not None:
        place(si, g['screen'], 'scr')
    if ci is not None:
        circle = mode == 'pip' and p.get('pip', {}).get('shape', 'circle') == 'circle'
        place(ci, g['cam'], 'cam', radius=0.12 if mode == 'pip' and not circle else 0, circle=circle)
    for k, c in enumerate(ovs):
        if c.get('kind') == 'text':
            png = text_png(c, W, H, work)
            args.extend(['-loop', '1', '-t', f'{d}', '-i', str(png)]); n += 1
            cur = f'{n - 1}:v'
            fc.append(f"[{cur}]format=rgba[tx{k}]"); cur = f'tx{k}'
            if c.get('anim') == 'fade' and not (c.get('style') or {}).get('fill') and abs(a - c['at']) < 0.01: fc.append(f"[{cur}]fade=in:st=0:d=0.2:alpha=1[tx{k}f]"); cur = f'tx{k}f'
            fc.append(f"[{last}][{cur}]overlay=0:0[txo{k}]"); last = f'txo{k}'
            continue
        if p['sources'][c['src']]['kind'] == 'audio': continue
        b0 = c.get('box') or {'x': 0, 'y': 0, 'w': 1, 'h': 1}
        idx = inp(c)
        place(idx, (b0['x'] * W, b0['y'] * H, b0['w'] * W, b0['h'] * H, c.get('fit', 'cover')), f'ov{k}',
              radius=c.get('radius', 0), fade=(c.get('anim') == 'fade' and abs(a - c['at']) < 0.01),
              aspect=(lambda s: (s['w'], s['h']) if s.get('w') and s.get('h') else None)(p['sources'][c['src']]),
              clip=c, shadow=bool(c.get('shadow')))
    fc.append(f"[{last}]format=yuv420p[vout]")
    if still:
        return ['ffmpeg', '-v', 'error', '-y', *args, '-filter_complex', ';'.join(fc), '-map', '[vout]', '-frames:v', '1', str(out)]
    # audio: the camera, plus any clip with volume > 0
    aud = []
    for c in [x for x in (cam, scr) if x] + ovs:
        if c.get('kind') == 'text': continue
        s = p['sources'][c['src']]
        if not s.get('hasAudio') or not c.get('volume', 0): continue
        idx = ci if c is cam else si if c is scr else None
        if idx is None: idx = inp(c)
        fa = ''
        if abs(a - c['at']) < 0.01: fa += ',afade=t=in:d=0.012'
        if abs(b - clip_end(c)) < 0.01: fa += f',afade=t=out:st={max(0, d - 0.015):.3f}:d=0.015'
        fc.append(f"[{idx}:a]asetpts=PTS-STARTPTS,aresample=48000,volume={c['volume']}{fa},apad,atrim=0:{d}[a{len(aud)}]"); aud.append(f'[a{len(aud)}]')
    if not aud: fc.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{d}[aout]")
    elif len(aud) == 1: fc.append(f"{aud[0]}anull[aout]")
    else: fc.append(f"{''.join(aud)}amix=inputs={len(aud)}:normalize=0[aout]")
    cmd = ['ffmpeg', '-v', 'error', '-y', *args, '-filter_complex', ';'.join(fc), '-map', '[vout]']
    if still: return cmd + ['-frames:v', '1', str(out)]
    return cmd + ['-map', '[aout]', '-t', f'{d}', '-r', str(FPS), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16',
                  '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', str(out)]


def render(pid=None, aspect=None, out=None, progress=None):
    """Export the timeline to mp4. Returns the output path."""
    p = load(pid); pid = p['id']
    aspect = aspect or p['aspect']; W, H = SIZES[aspect]
    segs = segments(p)
    if not segs: raise ValueError('the timeline is empty')
    work = Path(tempfile.mkdtemp(prefix='wv-render-'))
    prog = progress or (lambda *_: None)
    try:
        parts = []
        for i, (a, b) in enumerate(segs):
            f = work / f'seg{i:04d}.mov'
            cmd = _segment_cmd(p, a, b, W, H, f, work)
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode: raise RuntimeError(f'segment {a:.2f}-{b:.2f} failed: {r.stderr[-800:]}')
            parts.append(f); prog('render', (i + 1) / len(segs) * 0.8)
        (work / 'list.txt').write_text(''.join(f"file '{x.name}'\n" for x in parts))
        joined = work / 'joined.mov'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(work / 'list.txt'), '-c', 'copy', str(joined)], check=True)
        prog('captions', 0.85)
        caps = render_captions(p, W, H, work)
        rd = pdir(pid) / 'exports'; rd.mkdir(exist_ok=True)
        out = Path(out) if out else rd / f"{slug(p['title'])}-{aspect.replace(':', 'x')}-{time.strftime('%H%M%S')}.mp4"
        cmd = ['ffmpeg', '-v', 'error', '-y', '-i', str(joined)]
        if caps:
            cmd += ['-f', 'concat', '-safe', '0', '-i', str(caps), '-filter_complex', '[1:v]format=rgba[c];[0:v][c]overlay=0:0:eof_action=repeat,format=yuv420p[v]', '-map', '[v]', '-map', '0:a']
        tail = ['-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(out)]
        for enc in (['-c:v', 'h264_videotoolbox', '-b:v', '12M', '-profile:v', 'high'], ['-c:v', 'libx264', '-preset', 'medium', '-crf', '19']):
            r = subprocess.run(cmd + ['-t', f'{duration(p):.3f}', *enc, *tail], capture_output=True, text=True)
            if r.returncode == 0: break
        if r.returncode: raise RuntimeError('final pass failed: ' + r.stderr[-800:])
        prog('done', 1)
        with _lock:
            p = load(pid)
            kept = readable_copy(p, out, f"{p['title']} – {aspect.replace(':', '×')}", '.mp4')
            p['exports'].append({'file': str(out), 'saved': str(kept), 'aspect': aspect, 'at': time.time(), 'duration': round(duration(p), 2)})
            save(pid, p, f'exported {aspect}')
        return out
    finally:
        shutil.rmtree(work, ignore_errors=True)


def last_saved(pid, source=None):
    p = load(pid)
    if source: return p['sources'].get(source, {}).get('saved')
    return (p['exports'][-1].get('saved') if p['exports'] else None)


def still(pid=None, t=0.0, aspect=None, out=None):
    """A PNG of the composite at timeline time t (with captions) — lets Claude look at its edit."""
    p = load(pid); aspect = aspect or p['aspect']; W, H = SIZES[aspect]
    seg = next(((a, b) for a, b in segments(p) if a <= t < b), None)
    if not seg: raise ValueError(f't={t} is outside the timeline (0–{duration(p):.2f}s)')
    work = Path(tempfile.mkdtemp(prefix='wv-still-'))
    out = Path(out) if out else pdir(p['id']) / 'stills' / f'{t:.2f}.png'
    out.parent.mkdir(exist_ok=True)
    raw = work / 'raw.png'
    cmd = _segment_cmd(p, t, max(seg[1], t + 1 / FPS), W, H, raw, work, still=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode: raise RuntimeError(r.stderr[-600:])
    st = [s for s in caption_states(p) if s['s'] <= t < s['e']]
    caps = render_captions(p, W, H, work, states=st[:1]) if st else None
    if caps: subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(raw), '-i', str(work / 'cap00000.png'), '-filter_complex', 'overlay', str(out)], check=True)
    else: shutil.copy(raw, out)
    shutil.rmtree(work, ignore_errors=True)
    return out


def summary(p, words=True):
    """Compact text view of a project for Claude."""
    L = [f"project {p['id']} · \"{p['title']}\" · {p['aspect']} · {duration(p):.2f}s · rev {p['rev']} · layout default {p['layout']}"]
    L.append('sources:')
    for s in p['sources'].values():
        L.append(f"  {s['id']}: {s['kind']} {s.get('name','')} {s['duration']:.2f}s {s.get('w')}x{s.get('h')}" + (f" · {len(s['words'])} words" if s.get('words') else ' · not transcribed' if s['kind'] == 'cam' else ''))
    L.append('tracks (top draws over bottom):')
    for t in p['tracks']:
        L.append(f"  [{t['id']}] {t['label']}")
        for c in t['clips']:
            if t['kind'] == 'layout': L.append(f"    {c['id']} {c['at']:.2f}–{clip_end(c):.2f} {c['mode']}")
            elif c.get('kind') == 'text': L.append(f"    {c['id']} {c['at']:.2f}–{clip_end(c):.2f} text \"{c['text']}\" {c.get('style')}")
            else: L.append(f"    {c['id']} {c['at']:.2f}–{clip_end(c):.2f} src {c['src']} in {c['in']:.2f} out {c['out']:.2f}" + (f" box {c.get('box')}" if t['kind'] == 'overlay' else '') + (f" vol {c.get('volume')}" if 'volume' in c else ''))
    cs = p['captions']
    L.append(f"captions: {'on' if cs['on'] else 'off'} size {cs['size']} y {cs['y']} words {cs['words']} keywords {cs.get('keywords')}")
    lt = line_times(p)
    if lt:
        L.append('script lines (timeline):')
        for l in lt: L.append(f"  {l['line']}. " + (f"{l['start']:.2f}–{l['end']:.2f}" if l['start'] is not None else 'not found') + f"  {l['text'][:90]}")
    if words:
        ws = timeline_words(p)
        if ws:
            L.append('transcript (start time · word):')
            row = []
            for w in ws:
                row.append(f"{w['s']:.2f} {w['w']}")
                if len(row) == 8: L.append('  ' + ' | '.join(row)); row = []
            if row: L.append('  ' + ' | '.join(row))
            rs = silence_ranges(p)
            if rs: L.append(f"pauses cut_silences would remove: {len(rs)} ({sum(b - a for a, b in rs):.1f}s)")
    return '\n'.join(L)
