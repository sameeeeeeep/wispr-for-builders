// keytest — real-key paste test for the card helpers. Sends a real ⌘V (and ↵) to one process,
// optionally after a click at x,y (top-left screen points). Used by tests/paste.sh.
//   keytest <pid> [x y]
import AppKit
let a = CommandLine.arguments
guard a.count > 1, let pid = pid_t(a[1]) else { print("usage: keytest <pid> [x y]"); exit(2) }
let src = CGEventSource(stateID: .hidSystemState)
func key(_ code: CGKeyCode, cmd: Bool = false) {
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)!
        if cmd { e.flags = .maskCommand }
        e.postToPid(pid); usleep(30_000)
    }
}
if a.count > 3, let x = Double(a[2]), let y = Double(a[3]) {
    for t in [CGEventType.leftMouseDown, .leftMouseUp] {
        CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)!.postToPid(pid)
        usleep(60_000)
    }
    usleep(300_000)
}
key(9, cmd: true)     // ⌘V
usleep(400_000)
key(36)               // ↵
