"""Security tests for the Wispr Video engine and server: edits can't escape the project, and nothing a project
says can reach an ffmpeg filter graph except checked numbers and colours. Run: python3 -m unittest discover tests"""
import json, os, shutil, sys, tempfile, threading, time, unittest, urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

HOME = Path(tempfile.mkdtemp(prefix='wv-sec-'))
os.environ['WISPR_VIDEO_HOME'] = str(HOME)
os.environ['WISPR_VIDEO_PORT'] = '4399'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import engine as E   # noqa: E402


def project_with_media():
    p = E.new_project('Sec test', '16:9'); pid = p['id']
    (E.pdir(pid) / 'media' / 'a.mp4').write_bytes(b'x')
    with E._lock:
        p = E.load(pid)
        p['sources']['scr1'] = {'id': 'scr1', 'kind': 'screen', 'file': 'media/a.mp4', 'name': 'a.mp4', 'duration': 10, 'w': 1920, 'h': 1080, 'hasAudio': False}
        E.track(p, 'screen')['clips'].append({'id': 'c1', 'src': 'scr1', 'at': 0, 'in': 0, 'out': 5, 'volume': 0})
        E.save(pid, p, 'fixture')
    return pid


class SetOp(unittest.TestCase):
    def setUp(self): self.pid = project_with_media()

    def test_set_cannot_touch_structure(self):
        for path in ('id', 'sources', 'tracks', 'exports', 'rev', 'sources.scr1.file', 'tracks.0.clips'):
            with self.assertRaises(ValueError, msg=path):
                E.apply_ops(self.pid, [{'op': 'set', 'path': path, 'value': '../../etc'}])

    def test_set_allowed_paths_still_work(self):
        p, _ = E.apply_ops(self.pid, [{'op': 'set', 'path': 'pip.size', 'value': 0.3}, {'op': 'set', 'path': 'title', 'value': 'Hi'}])
        self.assertEqual(p['pip']['size'], 0.3); self.assertEqual(p['title'], 'Hi')

    def test_saved_under_caller_id(self):
        f = E.pdir(self.pid) / 'project.json'
        raw = json.loads(f.read_text()); raw['id'] = '../evil'; f.write_text(json.dumps(raw))
        p, _ = E.apply_ops(self.pid, [{'op': 'set', 'path': 'title', 'value': 'x'}])
        self.assertEqual(p['id'], self.pid)
        self.assertFalse((HOME.parent / 'evil').exists())

    def test_bad_project_ids_rejected(self):
        for pid in ('../x', '..', '/etc', 'a/b', ''):
            with self.assertRaises(ValueError, msg=pid): E.pdir(pid)


class Paths(unittest.TestCase):
    def setUp(self): self.pid = project_with_media()

    def test_source_outside_project_rejected(self):
        f = E.pdir(self.pid) / 'project.json'
        raw = json.loads(f.read_text()); raw['sources']['scr1']['file'] = '../../../../etc/passwd'; f.write_text(json.dumps(raw))
        with self.assertRaises(ValueError): E.load(self.pid)

    def test_within(self):
        self.assertTrue(E.within(self.pid, E.pdir(self.pid) / 'exports' / 'a.mp4'))
        self.assertFalse(E.within(self.pid, '/etc/passwd'))
        self.assertFalse(E.within(self.pid, E.pdir(self.pid) / '..' / 'other' / 'x'))


class FilterInjection(unittest.TestCase):
    def setUp(self): self.pid = project_with_media()

    def test_bg_colour(self):
        for bad in ('#1A1A1A:s=1x1,drawtext=text=x', 'red', '#12345', "#1A1A1A'"):
            with self.assertRaises(ValueError, msg=bad): E.apply_ops(self.pid, [{'op': 'set', 'path': 'bg', 'value': bad}])
        p, _ = E.apply_ops(self.pid, [{'op': 'set', 'path': 'bg', 'value': '#FFFFEB'}]); self.assertEqual(p['bg'], '#FFFFEB')

    def test_caption_and_text_colours(self):
        with self.assertRaises(ValueError): E.apply_ops(self.pid, [{'op': 'captions', 'color': 'white;rm -rf'}])
        with self.assertRaises(ValueError): E.apply_ops(self.pid, [{'op': 'text', 'text': 'x', 'start': 0, 'end': 1, 'bg': '#000,boxblur'}])

    def test_crop_drawtext_rejected(self):
        with self.assertRaises(ValueError):
            E.apply_ops(self.pid, [{'op': 'update_clip', 'id': 'c1', 'crop': {'x': 0, 'y': 0, 'w': '1:ih,drawtext=text=pwned', 'h': 1}}])

    def test_numbers_rejected_or_clamped(self):
        for field, bad in (('volume', '1,afilter'), ('push', 'nan'), ('radius', [1]), ('at', 'inf')):
            with self.assertRaises(ValueError, msg=field): E.apply_ops(self.pid, [{'op': 'update_clip', 'id': 'c1', field: bad}])
        p, _ = E.apply_ops(self.pid, [{'op': 'update_clip', 'id': 'c1', 'push': 9, 'crop': {'x': 0.8, 'y': 0, 'w': 0.9, 'h': 1}}])
        c = E.find_clip(p, 'c1')[1]
        self.assertEqual(c['push'], 1.0)
        self.assertLessEqual(c['crop']['x'] + c['crop']['w'], 1.0)

    def test_frame_values(self):
        with self.assertRaises(ValueError): E.apply_ops(self.pid, [{'op': 'set', 'path': 'frame', 'value': {'margin': '0.1,drawbox'}}])
        p, _ = E.apply_ops(self.pid, [{'op': 'set', 'path': 'frame', 'value': {'margin': 5, 'radius': 0.02}}])
        self.assertEqual(p['frame']['margin'], 0.3)

    def test_tampered_file_cant_inject_at_render(self):
        f = E.pdir(self.pid) / 'project.json'
        raw = json.loads(f.read_text()); raw['bg'] = '#000:s=1x1[x];movie=/etc/passwd'; f.write_text(json.dumps(raw))
        with self.assertRaises(ValueError): E.load(self.pid)


class Reveal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import server as S
        cls.S = S
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 4399), S.H)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.pid = project_with_media()
        (E.pdir(cls.pid) / 'exports').mkdir(exist_ok=True)

    @classmethod
    def tearDownClass(cls): cls.httpd.shutdown()

    def post(self, path, body, host='127.0.0.1:4399'):
        req = urllib.request.Request('http://127.0.0.1:4399' + path, data=json.dumps(body).encode(), method='POST',
                                     headers={'Content-Type': 'application/json', 'Host': host, 'X-Wispr-Video-Token': self.S.TOKEN})
        try:
            with urllib.request.urlopen(req) as r: return r.status
        except urllib.error.HTTPError as e: return e.code

    def test_reveal_outside_project_is_refused(self):
        self.assertEqual(self.post(f'/api/project/{self.pid}/reveal', {'file': '/etc/passwd'}), 403)
        self.assertEqual(self.post(f'/api/project/{self.pid}/reveal', {'file': str(E.pdir(self.pid) / '..' / '..' / 'x')}), 403)

    def test_forged_host_refused(self):
        self.assertEqual(self.post(f'/api/project/{self.pid}/ops', {'ops': []}, host='evil.example:4399'), 403)


if __name__ == '__main__':
    try: unittest.main()
    finally: shutil.rmtree(HOME, ignore_errors=True)
