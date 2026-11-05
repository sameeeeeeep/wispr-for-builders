"""Wispr Video MCP server (stdio): lets Claude read and edit the open video project. Edits land in project.json,
so the editor window updates live. Zero dependencies: newline-delimited JSON-RPC 2.0."""
import base64, json, os, socket, subprocess, sys, time, traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine as E

PORT = int(os.environ.get('WISPR_VIDEO_PORT', 4380))
P = {'type': 'string', 'description': 'project id (default: the one open in the editor)'}

TOOLS = [
    {'name': 'video_open', 'description': 'Open the Wispr Video editor in the browser (starts it if needed). Creates a project if there is none. mode "record" opens straight on the teleprompter with the script loaded.',
     'inputSchema': {'type': 'object', 'properties': {'project': P, 'title': {'type': 'string', 'description': 'title for a new project'},
                                                       'mode': {'type': 'string', 'enum': ['edit', 'record']}}}},
    {'name': 'video_projects', 'description': 'List video projects and which one is open.', 'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'video_new', 'description': 'Create a new video project and make it current.',
     'inputSchema': {'type': 'object', 'properties': {'title': {'type': 'string'}, 'aspect': {'type': 'string', 'enum': list(E.SIZES)},
                                                       'script': {'type': 'string', 'description': 'teleprompter script, one paragraph per line'}}}},
    {'name': 'video_get', 'description': 'Read the project: sources, tracks and clip ids, caption settings, each script line\'s timeline time, '
                                         'and the word-level transcript with timeline times. Call this before editing.',
     'inputSchema': {'type': 'object', 'properties': {'project': P, 'words': {'type': 'boolean', 'description': 'include the transcript (default true)'}}}},
    {'name': 'video_edit', 'description': 'Apply edit ops to the timeline; the editor updates live. ' + E.OPS_DOC,
     'inputSchema': {'type': 'object', 'required': ['ops'], 'properties': {'project': P, 'ops': {'type': 'array', 'items': {'type': 'object'}},
                                                                           'note': {'type': 'string', 'description': 'what this edit does, shown in the editor'}}}},
    {'name': 'video_find', 'description': 'Find where a phrase is spoken: timeline start/end of the best matches.',
     'inputSchema': {'type': 'object', 'required': ['text'], 'properties': {'project': P, 'text': {'type': 'string'}}}},
    {'name': 'video_still', 'description': 'Render the frame at timeline time t (with captions) and return it as an image, to check an edit.',
     'inputSchema': {'type': 'object', 'required': ['t'], 'properties': {'project': P, 't': {'type': 'number'}, 'aspect': {'type': 'string', 'enum': list(E.SIZES)}}}},
    {'name': 'video_import', 'description': 'Add a file from disk: role cam (A-roll, gets transcribed), screen (screen recording), or media (b-roll image/video for overlays; at = timeline seconds to place it).',
     'inputSchema': {'type': 'object', 'required': ['path'], 'properties': {'project': P, 'path': {'type': 'string'}, 'role': {'type': 'string', 'enum': ['cam', 'screen', 'media']}, 'at': {'type': 'number'}}}},
    {'name': 'video_transcribe', 'description': 'Transcribe camera sources on-device (whisper.cpp) with word timings.',
     'inputSchema': {'type': 'object', 'properties': {'project': P, 'src': {'type': 'string'}}}},
    {'name': 'video_undo', 'description': 'Undo (or redo) the last edit.', 'inputSchema': {'type': 'object', 'properties': {'project': P, 'redo': {'type': 'boolean'}}}},
    {'name': 'video_export', 'description': 'Render the video to mp4 with ffmpeg (captions burned in). Returns the file path. Takes ~1–3 s per second of video.',
     'inputSchema': {'type': 'object', 'properties': {'project': P, 'aspect': {'type': 'string', 'enum': list(E.SIZES)}}}},
    {'name': 'video_setup', 'description': 'Check ffmpeg, whisper.cpp and the speech model; download=true fetches ggml-base.en (142 MB) if no model is found.',
     'inputSchema': {'type': 'object', 'properties': {'download': {'type': 'boolean'}}}},
]


def server_up():
    try: socket.create_connection(('127.0.0.1', PORT), timeout=0.3).close(); return True
    except OSError: return False


def ensure_server():
    if server_up(): return
    log = open(E.HOME / 'server.log', 'a') if E.HOME.exists() else subprocess.DEVNULL
    subprocess.Popen([sys.executable, str(E.HERE / 'server.py')], stdout=log, stderr=log, start_new_session=True, env=os.environ.copy())
    for _ in range(40):
        if server_up(): return
        time.sleep(0.1)


def text(s): return {'content': [{'type': 'text', 'text': s}]}


def call(name, a):
    pid = a.get('project') or E.current()
    if name == 'video_open':
        E.HOME.mkdir(parents=True, exist_ok=True)
        if not pid: pid = E.new_project(a.get('title') or 'Untitled video')['id']
        E.set_current(pid); ensure_server()
        url = f'http://127.0.0.1:{PORT}/?p={pid}' + ('&mode=record' if a.get('mode') == 'record' else '')
        subprocess.run(['open', url])
        return text(f'Opened {url}')
    if name == 'video_projects':
        return text(json.dumps({'current': E.current(), 'projects': E.list_projects()}, indent=1))
    if name == 'video_new':
        p = E.new_project(a.get('title') or 'Untitled video', a.get('aspect', '9:16'))
        if a.get('script'): E.apply_ops(p['id'], [{'op': 'script', 'text': a['script']}])
        return text(f"created {p['id']} (now current)")
    if name == 'video_get':
        return text(E.summary(E.load(pid), a.get('words', True)))
    if name == 'video_edit':
        p, log = E.apply_ops(pid, a['ops'], a.get('note', ''))
        return text(f"rev {p['rev']} · {E.duration(p):.2f}s\n" + '\n'.join(log))
    if name == 'video_find':
        return text(json.dumps(E.find_text(E.load(pid), a['text']), indent=1) or 'no match')
    if name == 'video_still':
        f = E.still(pid, float(a['t']), a.get('aspect'))
        return {'content': [{'type': 'image', 'data': base64.b64encode(f.read_bytes()).decode(), 'mimeType': 'image/png'},
                            {'type': 'text', 'text': str(f)}]}
    if name == 'video_import':
        sid = E.import_media(pid, a['path'], a.get('role', 'media'), at=a.get('at'))
        if a.get('role') == 'cam': E.transcribe(pid, sid)
        return text(f'imported as source {sid}')
    if name == 'video_transcribe':
        return text(json.dumps(E.transcribe(pid, a.get('src'))))
    if name == 'video_undo':
        p = E.undo(pid, a.get('redo', False)); return text(f"rev {p['rev']} ({p.get('note')})")
    if name == 'video_export':
        out = E.render(pid, a.get('aspect')); return text(f'exported {out}')
    if name == 'video_setup':
        import shutil
        m = E.whisper_model()
        if not m and a.get('download'): m = E.download_model()
        return text(json.dumps({'ffmpeg': shutil.which('ffmpeg'), 'whisper-cli': shutil.which('whisper-cli'), 'swiftc': shutil.which('swiftc'),
                                'model': str(m or 'missing: call video_setup with download=true'), 'home': str(E.HOME)}, indent=1))
    raise ValueError(f'unknown tool {name}')


def main():
    for line in sys.stdin:
        try: msg = json.loads(line)
        except Exception: continue
        mid, method = msg.get('id'), msg.get('method')
        if mid is None: continue   # notifications
        try:
            if method == 'initialize':
                res = {'protocolVersion': msg.get('params', {}).get('protocolVersion', '2025-06-18'), 'capabilities': {'tools': {}},
                       'serverInfo': {'name': 'wispr-video', 'version': '0.1.0'},
                       'instructions': 'Wispr Video: a voice-first video editor. The user says an edit; call video_get, then video_edit. The editor window updates live.'}
            elif method == 'tools/list': res = {'tools': TOOLS}
            elif method == 'tools/call':
                prm = msg.get('params', {})
                try: res = call(prm.get('name'), prm.get('arguments') or {})
                except Exception as e: res = {**text(f'error: {e}'), 'isError': True}; traceback.print_exc(file=sys.stderr)
            elif method == 'ping': res = {}
            else:
                sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': 'method not found'}}) + '\n'); sys.stdout.flush(); continue
            sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': mid, 'result': res}) + '\n'); sys.stdout.flush()
        except Exception as e:
            sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32000, 'message': str(e)}}) + '\n'); sys.stdout.flush()


if __name__ == '__main__':
    main()
