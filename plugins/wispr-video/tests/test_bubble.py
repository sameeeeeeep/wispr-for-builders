"""Camera bubble placement: free x/y, per-section overrides, and that only numbers reach the filter graph."""
import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'server'))
import engine as E


def proj(pip, layout_clips=()):
    return {'pip': E._pip(pip, 'pip'), 'tracks': [{'id': 'layout', 'kind': 'layout', 'clips': list(layout_clips)}]}


class Bubble(unittest.TestCase):
    def test_corner_default(self):
        x, y, w, h, _ = E.geometry(proj({'corner': 'tl', 'size': 0.3}), 'pip', 1080, 1350)['cam']
        self.assertLess(x, 100); self.assertLess(y, 200); self.assertEqual(w, h)

    def test_free_position_is_the_centre_and_stays_inside(self):
        p = proj({'size': 0.3, 'x': 0.5, 'y': 0.5})
        x, y, w, h, _ = E.geometry(p, 'pip', 1080, 1350, pip=E.pip_at(p, 0))['cam']
        self.assertAlmostEqual(x + w / 2, 540); self.assertAlmostEqual(y + h / 2, 675)
        p = proj({'size': 0.3, 'x': 1, 'y': 1})
        x, y, w, h, _ = E.geometry(p, 'pip', 1080, 1350, pip=E.pip_at(p, 0))['cam']
        self.assertAlmostEqual(x + w, 1080); self.assertAlmostEqual(y + h, 1350)

    def test_section_override(self):
        p = proj({'size': 0.3, 'x': 0.2, 'y': 0.2}, [
            {'id': 'l1', 'at': 0, 'dur': 2, 'mode': 'cam'},
            {'id': 'l2', 'at': 2, 'dur': 2, 'mode': 'pip', 'pip': {'x': 0.8, 'y': 0.7}},
            {'id': 'l3', 'at': 4, 'dur': 2, 'mode': 'pip', 'pip': {'corner': 'br'}}])
        self.assertEqual((E.pip_at(p, 3)['x'], E.pip_at(p, 3)['y']), (0.8, 0.7))
        self.assertNotIn('x', E.pip_at(p, 5)); self.assertEqual(E.pip_at(p, 5)['corner'], 'br')
        self.assertEqual(E.pip_at(p, 7)['x'], 0.2)

    def test_layout_op_takes_a_section_bubble(self):
        p = proj({}); p['tracks'][0]['clips'] = []
        E._op(p, {'op': 'layout', 'mode': 'pip', 'start': 1, 'end': 3, 'pip': {'x': 0.3, 'y': 0.4, 'size': 0.25}})
        c = p['tracks'][0]['clips'][0]
        self.assertEqual(c['pip'], {'x': 0.3, 'y': 0.4, 'size': 0.25})

    def test_only_numbers(self):
        with self.assertRaises(ValueError): E._pip({'x': '0.5:drawtext', 'y': 0.2}, 'pip')
        self.assertNotIn('x', E._pip({'x': 0.5}, 'pip'))   # a position needs both
        self.assertEqual(E._pip({'x': 3, 'y': -1}, 'pip')['x'], 1)


if __name__ == '__main__':
    unittest.main()
