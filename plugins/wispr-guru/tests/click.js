// Used by click-through.sh: one real click on TextEdit's Bold button, if TextEdit is the window under it.
ObjC.import('CoreGraphics'); ObjC.import('AppKit')
function run(argv) {
  var guru = Number(argv[0])
  // the Bold button, as Guru found it
  var se = Application('System Events'), te = se.processes.byName('TextEdit')
  var cb = te.windows[0].entireContents().filter(function (e) { try { return e.role() === 'AXCheckBox' && /bold/i.test(e.description() + e.title()) } catch (x) { return false } })[0]
  if (!cb) return 'no-bold'
  var p = cb.position(), s = cb.size(), x = p[0] + s[0] / 2, y = p[1] + s[1] / 2
  // the window under the point, ignoring Guru's own (click-through) overlay and card
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || []
  var top = list.filter(function (w) {
    var b = w.kCGWindowBounds; return w.kCGWindowOwnerPID !== guru && x >= b.X && x < b.X + b.Width && y >= b.Y && y < b.Y + b.Height && w.kCGWindowLayer < 25
  })[0]
  if (!top || top.kCGWindowOwnerName !== 'TextEdit') return 'not-textedit:' + (top ? top.kCGWindowOwnerName : 'none')
  var back = $.CGEventGetLocation($.CGEventCreate(null))
  var down = $.CGEventCreateMouseEvent(null, 1, $.CGPointMake(x, y), 0), up = $.CGEventCreateMouseEvent(null, 2, $.CGPointMake(x, y), 0)
  $.CGEventPost(0, down); delay(0.08); $.CGEventPost(0, up); delay(0.1)
  $.CGWarpMouseCursorPosition(back)
  return 'clicked ' + Math.round(x) + ',' + Math.round(y)
}
