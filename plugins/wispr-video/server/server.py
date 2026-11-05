"""Wispr Video editor server: serves the editor UI and the project API on 127.0.0.1:4380.
The UI and Claude (via mcp.py) both edit ~/WisprVideo/<id>/project.json; /api/events pushes every change live."""
import hmac, json, os, queue, re, secrets, shutil, subprocess, sys, threading, time, traceback, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine as E

PORT = int(os.environ.get('WISPR_VIDEO_PORT', 4380))
APP = E.PKG / 'app'
SAFE = re.compile(r'^[A-Za-z0-9._-]{1,80}$')
TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp4': 'video/mp4',
         '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.webm': 'video/webm'}
HOSTS = {f'127.0.0.1:{PORT}', f'localhost:{PORT}'}
ORIGINS = {f'http://{h}' for h in HOSTS}


def install_token():
    """Per-install secret. The editor page gets it as an HttpOnly cookie; every API, media and event call must carry it,
    so another site in the browser (or one using DNS rebinding) can't drive edits, renders or read project files."""
    d = Path.home() / '.wispr-video'; d.mkdir(mode=0o700, exist_ok=True)
    f = d / 'token'
    if not f.exists():
        f.write_text(secrets.token_urlsafe(32)); f.chmod(0o600)
    return f.read_text().strip()


TOKEN = install_token()
clients = []          # SSE queues
jobs = {}             # id -> {kind, state, progress, result, error}


def emit(ev):
    for q in list(clients): q.put(ev)


def job(kind, pid, fn):
    jid = f'{kind}-{int(time.time() * 1000) % 10 ** 8}'
    jobs[jid] = {'id': jid, 'kind': kind, 'project': pid, 'state': 'running', 'progress': 0, 'stage': kind}
    emit({'type': 'job', **jobs[jid]})

    def run():
        try:
            res = fn(lambda stage, f: (jobs[jid].update(stage=stage, progress=round(f, 3)), emit({'type': 'job', **jobs[jid]})))
            jobs[jid].update(state='done', progress=1, result=res)
        except Exception as e:
            traceback.print_exc(); jobs[jid].update(state='error', error=str(e)[:600])
        emit({'type': 'job', **jobs[jid]})
    threading.Thread(target=run, daemon=True).start()
    return jobs[jid]


def watch():
    """Tell the editor whenever any project.json changes, whoever changed it (UI, Claude, a script)."""
    seen = {}
    while True:
        try:
            for f in E.HOME.glob('*/project.json'):
                m = f.stat().st_mtime
                if seen.get(f) != m:
                    if f in seen:
                        try: rev = json.loads(f.read_text()).get('rev')
                        except Exception: rev = None
                        emit({'type': 'project', 'project': f.parent.name, 'rev': rev})
                    seen[f] = m
        except Exception: pass
        time.sleep(0.25)


CLAUDE_SYS = """You are the editor inside Wispr Video, a voice-first video editor. The user speaks an edit; you make it with the
wispr-video MCP tools. Always call video_get first (it has the transcript with timeline times, script line times, clip ids),
then video_edit with ops. Ripple cuts shift everything after them, so when making several cuts send them latest-first in one call.
Check visual changes with video_still. Reply to a creator, not an engineer: one short plain sentence saying what changed, like "Made the title bigger and moved it to the top." Never mention numbers, coordinates, clip ids, op names, markdown or stills. Never export unless asked."""


def run_claude(pid, text, progress):
    mcp = {'mcpServers': {'wispr-video': {'command': sys.executable, 'args': [str(E.HERE / 'mcp.py')],
                                           'env': {'WISPR_VIDEO_HOME': str(E.HOME)}}}}
    cfg = E.HOME / '.mcp-claude.json'; cfg.write_text(json.dumps(mcp))
    claude = shutil.which('claude') or str(Path.home() / '.local/bin/claude')
    tools = ','.join(f'mcp__wispr-video__{t}' for t in ('video_get', 'video_edit', 'video_find', 'video_still', 'video_undo', 'video_transcribe', 'video_projects'))
    cmd = [claude, '-p', f'[project {pid}] {text}', '--mcp-config', str(cfg), '--strict-mcp-config', '--allowedTools', tools,
           '--append-system-prompt', CLAUDE_SYS, '--setting-sources', 'project', '--disable-slash-commands', '--output-format', 'stream-json', '--verbose', '--model', os.environ.get('WISPR_VIDEO_MODEL_CLAUDE', 'sonnet')]
    progress('thinking', 0.1)
    pr = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=str(E.pdir(pid)))
    final, steps = '', 0
    for line in pr.stdout:
        try: ev = json.loads(line)
        except Exception: continue
        if ev.get('type') == 'assistant':
            for b in ev.get('message', {}).get('content', []):
                if b.get('type') == 'tool_use':
                    steps += 1; progress(b['name'].replace('mcp__wispr-video__video_', ''), min(0.9, 0.15 + steps * 0.15))
        if ev.get('type') == 'result': final = ev.get('result') or ''
    pr.wait(timeout=600)
    if pr.returncode and not final: raise RuntimeError((pr.stderr.read() or 'claude failed')[-400:])
    return {'reply': final.strip()}


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a): pass

    def guard(self, write=False):
        """Host must be ours (stops DNS rebinding); writes and private reads need our Origin (or none) and the token."""
        if self.headers.get('Host', '') not in HOSTS:
            self.send(403, {'error': 'bad host'}); return False
        path = urllib.parse.urlparse(self.path).path
        public = path in ('/', '/index.html') or path.startswith('/app/')
        if public and not write: return True
        origin = self.headers.get('Origin')
        if origin is not None and origin not in ORIGINS:
            self.send(403, {'error': 'bad origin'}); return False
        cookie = dict(c.strip().split('=', 1) for c in (self.headers.get('Cookie') or '').split(';') if '=' in c)
        got = self.headers.get('X-Wispr-Video-Token') or cookie.get('wv_token', '')
        if not hmac.compare_digest(got, TOKEN):
            self.send(403, {'error': 'missing token: open the editor from http://127.0.0.1:%d/' % PORT}); return False
        return True

    def send(self, code, body=b'', ctype='application/json', extra=None):
        if isinstance(body, (dict, list)): body = json.dumps(body).encode()
        elif isinstance(body, str): body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n) if n else b''

    def jbody(self):
        b = self.body(); return json.loads(b) if b else {}

    def file(self, f, extra=None):
        f = Path(f)
        if not f.is_file(): return self.send(404, {'error': 'not found'})
        size = f.stat().st_size; ctype = TYPES.get(f.suffix.lower(), 'application/octet-stream')
        rng = self.headers.get('Range')
        if rng and (m := re.match(r'bytes=(\d*)-(\d*)', rng)):
            a = int(m.group(1) or 0); b = int(m.group(2)) if m.group(2) else size - 1
            b = min(b, size - 1)
            self.send_response(206)
            self.send_header('Content-Type', ctype); self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Range', f'bytes {a}-{b}/{size}'); self.send_header('Content-Length', str(b - a + 1))
            self.end_headers()
            with open(f, 'rb') as fh:
                fh.seek(a); left = b - a + 1
                while left > 0:
                    chunk = fh.read(min(left, 1 << 20))
                    if not chunk: break
                    try: self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError): return
                    left -= len(chunk)
            return
        self.send_response(200)
        self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(size)); self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers()
        with open(f, 'rb') as fh:
            try: shutil.copyfileobj(fh, self.wfile, 1 << 20)
            except (BrokenPipeError, ConnectionResetError): pass

    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = dict(urllib.parse.parse_qsl(u.query)); path = u.path
        if not self.guard(): return
        try:
            if path in ('/', '/index.html'):
                return self.file(APP / 'index.html', extra={'Set-Cookie': f'wv_token={TOKEN}; Path=/; HttpOnly; SameSite=Strict'})
            if path.startswith('/app/'):
                f = (APP / path[5:]).resolve()
                return self.file(f) if str(f).startswith(str(APP)) else self.send(403)
            if path.startswith('/media/'):
                _, _, pid, *rest = path.split('/')
                f = (E.pdir(pid) / '/'.join(rest)).resolve()
                return self.file(f) if SAFE.match(pid) and str(f).startswith(str(E.pdir(pid).resolve())) else self.send(403)
            if path == '/api/projects': return self.send(200, {'projects': E.list_projects(), 'current': E.current()})
            if path.startswith('/api/project/'):
                pid = path.split('/')[3]
                p = E.load(pid)
                return self.send(200, {'project': p, 'words': E.timeline_words(p), 'captions': E.caption_chunks(p),
                                       'lines': E.line_times(p), 'pauses': E.silence_ranges(p), 'duration': E.duration(p)})
            if path == '/api/jobs': return self.send(200, {'jobs': list(jobs.values())[-20:]})
            if path == '/api/events': return self.sse()
            if path == '/api/health': return self.send(200, {'ok': True, 'home': str(E.HOME), 'model': str(E.whisper_model() or '')})
            self.send(404, {'error': 'not found'})
        except Exception as e:
            traceback.print_exc(); self.send(500, {'error': str(e)})

    def sse(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream'); self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'keep-alive'); self.end_headers()
        q = queue.Queue(); clients.append(q)
        try:
            self.wfile.write(b'data: {"type":"hello"}\n\n'); self.wfile.flush()
            while True:
                try: ev = q.get(timeout=15); self.wfile.write(f'data: {json.dumps(ev)}\n\n'.encode())
                except queue.Empty: self.wfile.write(b': ping\n\n')
                self.wfile.flush()
        except Exception: pass
        finally: clients.remove(q)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path); q = dict(urllib.parse.parse_qsl(u.query)); parts = u.path.strip('/').split('/')
        if not self.guard(write=True): return
        try:
            if u.path == '/api/projects':
                b = self.jbody(); p = E.new_project(b.get('title') or 'Untitled video', b.get('aspect', '9:16'))
                return self.send(200, {'project': p})
            if u.path == '/api/current':
                E.set_current(self.jbody()['project']); return self.send(200, {'ok': True})
            if len(parts) >= 4 and parts[:2] == ['api', 'project']:
                pid, act = parts[2], parts[3]
                if not SAFE.match(pid): return self.send(400, {'error': 'bad project'})
                if act == 'ops':
                    b = self.jbody(); p, log = E.apply_ops(pid, b['ops'], b.get('note', ''))
                    return self.send(200, {'rev': p['rev'], 'log': log})
                if act in ('undo', 'redo'):
                    p = E.undo(pid, redo=act == 'redo'); return self.send(200, {'rev': p['rev']})
                if act == 'upload':
                    return self.upload(pid, q)
                if act == 'transcribe':
                    src = self.jbody().get('src')
                    return self.send(200, job('transcribe', pid, lambda pr: E.transcribe(pid, src)))
                if act == 'export':
                    b = self.jbody()
                    def ex(pr):
                        out = E.render(pid, b.get('aspect'), progress=pr)
                        return {'file': str(out), 'url': f'/media/{pid}/exports/{out.name}'}
                    return self.send(200, job('export', pid, ex))
                if act == 'claude':
                    text = self.jbody().get('text', '').strip()
                    if not text: return self.send(400, {'error': 'say something first'})
                    return self.send(200, job('claude', pid, lambda pr: run_claude(pid, text, pr)))
                if act == 'reveal':   # only files inside this project (its exports) can be shown in Finder
                    f = Path(str(self.jbody().get('file', ''))).resolve()
                    if not E.within(pid, f) or not f.is_file(): return self.send(403, {'error': 'can only reveal files in this project'})
                    subprocess.run(['open', '-R', str(f)]); return self.send(200, {'ok': True})
            self.send(404, {'error': 'not found'})
        except Exception as e:
            traceback.print_exc(); self.send(500, {'error': str(e)})

    def upload(self, pid, q):
        """Raw file body. ?role=cam|screen|media&name=…&at=…&take=…; camera takes are transcribed after import."""
        role = q.get('role', 'media'); name = Path(q.get('name') or 'upload.webm').name
        inbox = E.pdir(pid) / 'inbox'; inbox.mkdir(exist_ok=True)
        f = inbox / f"{int(time.time() * 1000)}-{re.sub(r'[^A-Za-z0-9._-]', '_', name)}"
        n = int(self.headers.get('Content-Length') or 0)
        with open(f, 'wb') as out:
            left = n
            while left > 0:
                chunk = self.rfile.read(min(left, 1 << 20))
                if not chunk: break
                out.write(chunk); left -= len(chunk)
        marks = json.loads(q['marks']) if q.get('marks') else None
        at = float(q['at']) if q.get('at') not in (None, '') else None

        def imp(pr):
            pr('importing ' + role, 0.1)
            sid = E.import_media(pid, f, role, at=at, take=q.get('take'), marks=marks, recorded_at=time.time(), name=name)
            if role == 'cam':
                pr('transcribing', 0.6); E.transcribe(pid, sid)
            f.unlink(missing_ok=True)
            return {'source': sid}
        self.send(200, job('import', pid, imp))


def main():
    E.HOME.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=watch, daemon=True).start()
    print(f'Wispr Video on http://127.0.0.1:{PORT}  (projects in {E.HOME})', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()


if __name__ == '__main__':
    main()
