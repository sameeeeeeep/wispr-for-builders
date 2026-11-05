// guru — Wispr Guru's one-shot "second cursor" for macOS.
//
// Points at a control on screen (found through the Accessibility tree, so it follows the window),
// shows a draggable step card beside it, waits for the person's reply (Wispr dictation, typing or
// keys), prints ONE JSON line on stdout and exits. Same shape as the Switchboard notch's sb-card.
//
//   guru '<json>'      modes: step · point · present · look        (see ../API.md)
//   guru --version
//
// Draws only its own windows. Accessibility (to find controls by label) and Screen Recording
// (for `look` screenshots) are optional; without them it falls back to coordinates.

import AppKit
import ApplicationServices
import SwiftUI

let API_VERSION = 1

// ── spec ──
struct Target: Decodable {
    var label: String?; var app: String?; var role: String?
    var x: Double?; var y: Double?; var w: Double?; var h: Double?
    var relativeTo: String?
}
struct Option: Decodable { var label: String; var detail: String?; var image: String? }
struct Spec: Decodable {
    var mode: String?
    var say: String?; var detail: String?; var task: String?
    var target: Target?
    var index: Int?; var total: Int?
    var size: String?; var at: String?
    var options: [Option]?
    var ttl: Double?; var timeout: Double?
    var app: String?; var find: String?
    var shot: Bool?
}

let slotsDir = (NSHomeDirectory() as NSString).appendingPathComponent(".wispr-guru/slots")
var mySlot: String?
func claimSlot() -> Int {
    try? FileManager.default.createDirectory(atPath: slotsDir, withIntermediateDirectories: true)
    for n in 0..<8 {
        let p = slotsDir + "/\(n)"
        if let s = try? String(contentsOfFile: p, encoding: .utf8), let pid = pid_t(s), kill(pid, 0) == 0 { continue }
        try? String(getpid()).write(toFile: p, atomically: true, encoding: .utf8)
        mySlot = p; return n
    }
    return 0
}
func claimFocus() {
    guard let panel, !panel.isKeyWindow else { return }
    NSApp.activate(ignoringOtherApps: true); panel.makeKeyAndOrderFront(nil)
}

func emit(_ obj: [String: Any]) -> Never {
    if let mySlot { try? FileManager.default.removeItem(atPath: mySlot) }
    var o = obj
    if let r = Tracker.shared.lastRect { o["rect"] = ["x": r.minX, "y": r.minY, "w": r.width, "h": r.height] }
    if o["targetFound"] == nil, Tracker.shared.hasTarget { o["targetFound"] = Tracker.shared.lastRect != nil }
    let data = (try? JSONSerialization.data(withJSONObject: o)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

// ── palette: Sameep's Wispr palette (fathom green on lumen ivory, flare accent) ──
struct Palette {
    let bg, raised, border, text, muted, accent, cursor: Color
    static func hex(_ v: UInt32) -> Color {
        Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
    static let light = Palette(bg: hex(0xFFFFEB), raised: hex(0xF4F3DC), border: hex(0xE4E4D0),
                               text: hex(0x1A1A1A), muted: hex(0x5D5D52), accent: hex(0x034F46), cursor: hex(0xFF6C4C))
    static let dark = Palette(bg: hex(0x15201E), raised: hex(0x1E2B29), border: hex(0x2E3D3A),
                              text: hex(0xFFFFEB), muted: hex(0xA9AE9C), accent: hex(0xCFE8DC), cursor: hex(0xFF6C4C))
}

// ── type: Wispr Flow's own faces (Figtree UI, EB Garamond display, Google Sans Code keys), registered
// for this process from the installed Wispr Flow app; system fonts if it isn't installed ──
func registerWisprFonts() {
    let dir = "/Applications/Wispr Flow.app/Contents/Resources/assets/fonts"
    for f in ["Figtree/Figtree-VariableFont_wght.ttf", "EBGaramond/EBGaramond-VariableFont_wght.ttf",
              "Google_Sans_Code/GoogleSansCode-VariableFont_wght.ttf"] {
        let u = URL(fileURLWithPath: dir + "/" + f)
        if FileManager.default.fileExists(atPath: u.path) { CTFontManagerRegisterFontsForURL(u as CFURL, .process, nil) }
    }
}
func ui(_ size: CGFloat, _ w: Font.Weight = .regular) -> Font { Font.custom("Figtree", size: size).weight(w) }
func serif(_ size: CGFloat) -> Font { Font.custom("EB Garamond", size: size) }
func mono(_ size: CGFloat) -> Font { Font.custom("Google Sans Code", size: size).weight(.medium) }

let FLARE = NSColor(srgbRed: 1, green: 0x6C / 255, blue: 0x4C / 255, alpha: 1)

// ── coordinates: AX/CG use top-left origin on the primary screen; Cocoa uses bottom-left ──
var primaryH: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }
func toCocoa(_ r: CGRect) -> NSRect { NSRect(x: r.minX, y: primaryH - r.maxY, width: r.width, height: r.height) }

// ── accessibility search ──
func axAttr(_ e: AXUIElement, _ a: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
}
func axString(_ e: AXUIElement, _ a: String) -> String? {
    guard let v = axAttr(e, a) else { return nil }
    if let s = v as? String { return s }
    return nil
}
func axFrame(_ e: AXUIElement) -> CGRect? {
    guard let p = axAttr(e, kAXPositionAttribute), let s = axAttr(e, kAXSizeAttribute) else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &pt)
    AXValueGetValue(s as! AXValue, .cgSize, &sz)
    if sz.width < 2 || sz.height < 2 { return nil }
    return CGRect(origin: pt, size: sz)
}

struct AXMatch { let el: AXUIElement; let label: String; let role: String; let rect: CGRect; let score: Int }

func findApp(_ name: String?) -> NSRunningApplication? {
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    if let n = name?.lowercased(), !n.isEmpty {
        return apps.first { $0.localizedName?.lowercased() == n || $0.bundleIdentifier?.lowercased() == n }
            ?? apps.first { ($0.localizedName?.lowercased() ?? "").contains(n) }
    }
    // Frontmost app that isn't where Claude runs (terminal, Claude, editors).
    let skip = ["com.apple.terminal", "com.googlecode.iterm2", "com.anthropic.claudefordesktop", "dev.warp.warp-stable",
                "com.microsoft.vscode", "com.mitchellh.ghostty", "net.kovidgoyal.kitty"]
    if let f = NSWorkspace.shared.frontmostApplication, !skip.contains(f.bundleIdentifier?.lowercased() ?? "") { return f }
    // Otherwise the topmost on-screen window's owner that isn't skipped.
    let infos = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    for i in infos where (i[kCGWindowLayer as String] as? Int) == 0 {
        if let pid = i[kCGWindowOwnerPID as String] as? pid_t, let a = NSRunningApplication(processIdentifier: pid),
           a.activationPolicy == .regular, !skip.contains(a.bundleIdentifier?.lowercased() ?? "") { return a }
    }
    return nil
}

func roleMatches(_ role: String, _ want: String?) -> Bool {
    guard let w = want?.lowercased(), !w.isEmpty else { return true }
    let r = role.lowercased()
    let map = ["button": ["axbutton", "axpopupbutton", "axmenubutton"], "row": ["axrow", "axcell", "axoutlinerow", "axstatictext"],
               "menuitem": ["axmenuitem", "axmenubaritem"], "field": ["axtextfield", "axtextarea", "axsearchfield"],
               "checkbox": ["axcheckbox", "axswitch"], "tab": ["axradiobutton", "axtab"], "link": ["axlink"]]
    return (map[w] ?? ["ax" + w]).contains(r)
}

let AX_KEYS = [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXChildrenAttribute,
               kAXPositionAttribute, kAXSizeAttribute] as CFArray
let CLICKY: Set<String> = ["AXButton", "AXRow", "AXCell", "AXMenuItem", "AXMenuBarItem", "AXRadioButton", "AXCheckBox",
                           "AXPopUpButton", "AXLink", "AXMenuButton", "AXTab"]

// One batched AX round trip per node (AXUIElementCopyMultipleAttributeValues), front window first,
// then the menu bar; stops at `budget` seconds so a huge app can't stall the card.
var electronWoken = Set<pid_t>()
func searchAX(pid: pid_t, label: String, role roleWanted: String?, limit: Int = 10, budget: Double = 2.5) -> [AXMatch] {
    let want = label.lowercased().trimmingCharacters(in: .whitespaces)
    let root = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(root, 0.4)
    // Chromium/Electron apps only build their accessibility tree once asked to.
    if AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success, !electronWoken.contains(pid) {
        electronWoken.insert(pid); usleep(350_000)
    }
    var out: [AXMatch] = []
    var stack: [(AXUIElement, Int)] = []
    if let mb = axAttr(root, kAXMenuBarAttribute) { stack.append((mb as! AXUIElement, 0)) }
    if let wins = axAttr(root, kAXWindowsAttribute) as? [AXUIElement] { stack += wins.reversed().map { ($0, 0) } }
    let t0 = Date()
    var seen = 0
    defer { if ProcessInfo.processInfo.environment["GURU_DEBUG"] != nil { FileHandle.standardError.write(Data("ax: \(seen) nodes \(Date().timeIntervalSince(t0))s \(out.count) hits\n".utf8)) } }
    while let (e, d) = stack.popLast(), seen < 6000, Date().timeIntervalSince(t0) < budget {
        seen += 1
        var vals: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(e, AX_KEYS, AXCopyMultipleAttributeOptions(rawValue: 0), &vals) == .success,
              let v = vals as? [AnyObject], v.count == 7 else { continue }
        let role = v[0] as? String ?? ""
        let texts = [v[1] as? String, v[2] as? String, role == "AXStaticText" || role == "AXCell" ? v[3] as? String : nil].compactMap { $0 }
        var best = 0, bestText = ""
        for t in texts {
            let tl = t.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            if tl.isEmpty || tl.count > 120 { continue }
            var score = 0
            if tl == want { score = 100 } else if tl.hasPrefix(want) { score = 70 } else if want.count >= 3 && tl.contains(want) { score = 50 }
            if score > best { best = score; bestText = t }
        }
        if best > 0, roleMatches(role, roleWanted), CFGetTypeID(v[5]) == AXValueGetTypeID(), CFGetTypeID(v[6]) == AXValueGetTypeID() {
            var pt = CGPoint.zero, sz = CGSize.zero
            AXValueGetValue(v[5] as! AXValue, .cgPoint, &pt); AXValueGetValue(v[6] as! AXValue, .cgSize, &sz)
            if sz.width >= 2, sz.height >= 2 {
                if CLICKY.contains(role) { best += 10 }
                let rect = CGRect(origin: pt, size: sz)
                if out.contains(where: { $0.rect == rect && $0.label == bestText }) { continue }
                out.append(AXMatch(el: e, label: bestText, role: role, rect: rect, score: best - d / 4))
                if best >= 110 && out.count >= limit { break }
            }
        }
        // Closed menus are huge and invisible: only the menu bar's top items are worth matching.
        if role == "AXMenu" || role == "AXMenuBarItem" && d > 0 { continue }
        if d < 40, let kids = v[4] as? [AXUIElement] { stack += kids.reversed().map { ($0, d + 1) } }
    }
    return Array(out.sorted { $0.score > $1.score }.prefix(limit))
}

func frontWindowRect(pid: pid_t) -> CGRect? {
    let infos = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    for i in infos where (i[kCGWindowOwnerPID as String] as? pid_t) == pid && (i[kCGWindowLayer as String] as? Int) == 0 {
        if let b = i[kCGWindowBounds as String] as? [String: CGFloat] {
            let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
            if r.width > 80 && r.height > 60 { return r }
        }
    }
    return nil
}

// ── tracker: resolves the target and keeps it current while windows move ──
final class Tracker {
    static let shared = Tracker()
    var target: Target?
    var hasTarget: Bool { target != nil }
    var lastRect: CGRect?          // top-left global coords
    var el: AXUIElement?
    var pid: pid_t?
    var onChange: ((CGRect?) -> Void)?
    private var timer: Timer?

    func start(_ t: Target?) {
        target = t
        guard let t else { return }

        if let a = findApp(t.app) { pid = a.processIdentifier }
        resolve(full: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.resolve(full: false) }
        // A full re-search now and then catches views that re-render (sidebar selection, tab switches).
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.resolve(full: true) }
    }

    private var searching = false
    private let q = DispatchQueue(label: "guru.ax", qos: .userInitiated)

    func resolve(full: Bool) {
        guard let t = target else { return }
        if let label = t.label, !label.isEmpty, AXIsProcessTrusted(), let pid {
            if !full, let el {
                if let f = axFrame(el) { publish(f) } else { self.el = nil; resolve(full: true) }
                return
            }
            if !full || searching { return }
            searching = true
            q.async {
                let m = searchAX(pid: pid, label: label, role: t.role, limit: 1).first
                DispatchQueue.main.async {
                    self.searching = false
                    if let m { self.el = m.el; self.publish(m.rect) } else { self.el = nil; self.publish(self.coordRect()) }
                    self.resolvedOnce = true
                    self.onResolved?(self.lastRect)
                }
            }
            return
        }
        resolvedOnce = true
        publish(coordRect())
        onResolved?(lastRect)
    }
    var resolvedOnce = false
    var onResolved: ((CGRect?) -> Void)?

    func coordRect() -> CGRect? {
        guard let t = target, let x = t.x, let y = t.y else { return nil }
        var base = CGRect(x: x, y: y, width: t.w ?? 0, height: t.h ?? 0)
        if t.relativeTo == "window", let pid, let w = frontWindowRect(pid: pid) { base = base.offsetBy(dx: w.minX, dy: w.minY) }
        if base.width < 4 { base = base.insetBy(dx: -14, dy: 0) }
        if base.height < 4 { base = base.insetBy(dx: 0, dy: -14) }
        return base
    }

    func publish(_ r: CGRect?) {
        if r != lastRect { lastRect = r; onChange?(r) }
    }
}

// ── overlay: the second cursor + a pulsing ring, one transparent window per screen ──
final class OverlayView: NSView {
    var ring: NSRect?        // in this view's coords
    var cursorAt: NSPoint?   // animated tip position
    var name = "Guru"
    var phase: CGFloat = 0
    override var isFlipped: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        guard let ring else { return }
        let ctx = NSGraphicsContext.current!.cgContext
        // soft spotlight halo
        let pulse = 0.5 + 0.5 * sin(phase)
        let halo = ring.insetBy(dx: -6 - 4 * pulse, dy: -6 - 4 * pulse)
        let hp = NSBezierPath(roundedRect: halo, xRadius: 10, yRadius: 10)
        FLARE.withAlphaComponent(0.10 + 0.06 * pulse).setFill(); hp.fill()
        FLARE.withAlphaComponent(0.95).setStroke(); hp.lineWidth = 2.5; hp.stroke()
        // the second cursor: a pointer glyph with a name tag (multiplayer-cursor style)
        guard let tip = cursorAt else { return }
        ctx.saveGState()
        ctx.translateBy(x: tip.x, y: tip.y)
        let p = NSBezierPath()
        p.move(to: .zero); p.line(to: NSPoint(x: 0, y: -22)); p.line(to: NSPoint(x: 6, y: -16.5))
        p.line(to: NSPoint(x: 10.5, y: -26)); p.line(to: NSPoint(x: 14, y: -24.5)); p.line(to: NSPoint(x: 9.5, y: -15))
        p.line(to: NSPoint(x: 17, y: -15)); p.close()
        let sh = NSShadow(); sh.shadowBlurRadius = 4; sh.shadowOffset = NSSize(width: 0, height: -1)
        sh.shadowColor = NSColor.black.withAlphaComponent(0.35); sh.set()
        FLARE.setFill(); p.fill()
        NSColor.white.setStroke(); p.lineWidth = 1.5; p.stroke()
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11.5, weight: .semibold), .foregroundColor: NSColor.white]
        let s = NSAttributedString(string: name, attributes: attrs)
        let sz = s.size()
        let pill = NSRect(x: 16, y: -42, width: sz.width + 16, height: sz.height + 7)
        FLARE.setFill(); NSBezierPath(roundedRect: pill, xRadius: pill.height / 2, yRadius: pill.height / 2).fill()
        s.draw(at: NSPoint(x: pill.minX + 8, y: pill.minY + 3.5))
        ctx.restoreGState()
    }
}

final class Overlay {
    var windows: [(NSWindow, OverlayView)] = []
    var targetTip: NSPoint?      // global cocoa
    var currentTip: NSPoint?
    var ringGlobal: NSRect?
    init(tag: String, screens: [NSScreen] = NSScreen.screens) {
        for s in screens {
            let w = NSWindow(contentRect: s.frame, styleMask: .borderless, backing: .buffered, defer: false)
            w.isOpaque = false; w.backgroundColor = .clear; w.ignoresMouseEvents = true; w.hasShadow = false
            w.level = NSWindow.Level(rawValue: NSWindow.Level.popUpMenu.rawValue + 1)
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            let v = OverlayView(frame: NSRect(origin: .zero, size: s.frame.size)); v.name = tag
            w.contentView = v; w.orderFrontRegardless()
            windows.append((w, v))
        }
        Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.tick() }
    }
    func set(_ topLeftRect: CGRect?, from: NSPoint?) {
        guard let r = topLeftRect else { ringGlobal = nil; targetTip = nil; redraw(); return }
        let c = toCocoa(r)
        ringGlobal = c
        // Tip touches the ring's lower-right edge, the glyph hangs off to the bottom-right.
        targetTip = NSPoint(x: c.maxX - min(10, c.width / 3), y: c.minY + min(8, c.height / 3))
        if currentTip == nil { currentTip = from ?? NSPoint(x: targetTip!.x + 160, y: targetTip!.y - 120) }
    }
    func tick() {
        if let t = targetTip, var c = currentTip {
            c.x += (t.x - c.x) * 0.16; c.y += (t.y - c.y) * 0.16
            currentTip = c
        }
        for (_, v) in windows { v.phase += 0.09 }
        redraw()
    }
    func redraw() {
        for (w, v) in windows {
            let f = w.frame
            v.ring = ringGlobal.flatMap { $0.intersects(f.insetBy(dx: -40, dy: -40)) ? $0.offsetBy(dx: -f.minX, dy: -f.minY) : nil }
            v.cursorAt = (v.ring != nil) ? currentTip.map { NSPoint(x: $0.x - f.minX, y: $0.y - f.minY) } : nil
            v.needsDisplay = true
        }
    }
    func wiggle() { if let t = targetTip { currentTip = NSPoint(x: t.x + 70, y: t.y - 50) } }
}

// ── reply parsing ──
func normalise(_ raw: String) -> [String: Any] {
    let t = raw.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        .trimmingCharacters(in: CharacterSet(charactersIn: ".!?,"))
    if t.isEmpty { return ["reply": "next"] }
    let next = ["done", "next", "ok", "okay", "got it", "yep", "yes", "did it", "continue", "go on", "finished", "next step", "done next", "ok next", "okay next", "it's done", "that's done", "all right", "alright", "sure", "cool"]
    if next.contains(t) || t.hasPrefix("done") || t.hasPrefix("next") { return ["reply": "next"] }
    if ["back", "go back", "previous", "undo", "last step"].contains(t) || t.hasPrefix("go back") { return ["reply": "back"] }
    if t.contains("where") || t.contains("can't find") || t.contains("cant find") || t.contains("don't see") || t.contains("dont see") || t.contains("can't see") || t.contains("not there") || t.contains("lost") { return ["reply": "where"] }
    if ["stop", "cancel", "quit", "exit", "never mind", "nevermind", "stop guiding"].contains(t) { return ["reply": "stop"] }
    return ["reply": "text", "text": raw.trimmingCharacters(in: .whitespacesAndNewlines)]
}
// "1 but make it shorter" / "two, and bolder": a leading pick followed by more words is a pick plus a note.
func leadingPick(_ s: String, count: Int) -> (Int, String)? {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    let map = ["one": 1, "first": 1, "two": 2, "second": 2, "three": 3, "third": 3, "four": 4, "fourth": 4,
               "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9]
    var head = "", rest = Substring(t)
    if let d = t.first, d.isNumber { head = String(d); rest = t.dropFirst() }
    else if let w = t.split(whereSeparator: { !$0.isLetter }).first, map[w.lowercased()] != nil { head = String(w); rest = t.dropFirst(w.count) }
    let n = Int(head) ?? map[head.lowercased()] ?? 0
    let note = rest.trimmingCharacters(in: CharacterSet(charactersIn: " ,.:;-—").union(.whitespaces))
    guard n >= 1, n <= count, !note.isEmpty, rest.first.map({ !$0.isNumber && !$0.isLetter }) ?? false else { return nil }
    return (n, note)
}

func parsePick(_ raw: String, count: Int) -> Int? {
    let t = raw.lowercased()
    if let n = Int(t.filter(\.isNumber)), n >= 1, n <= count { return n }
    let words = ["one": 1, "first": 1, "two": 2, "second": 2, "three": 3, "third": 3, "four": 4, "fourth": 4, "five": 5, "fifth": 5,
                 "six": 6, "sixth": 6, "seven": 7, "seventh": 7, "eight": 8, "eighth": 8, "nine": 9, "ninth": 9, "last": count]
    for (w, n) in words where t.split(whereSeparator: { !$0.isLetter }).contains(Substring(w)) && n <= count { return n }
    return nil
}

// ── state (remembered card position) ──
let stateDir = (NSHomeDirectory() as NSString).appendingPathComponent(".wispr-guru")
let statePath = (stateDir as NSString).appendingPathComponent("state.json")
func loadState() -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: statePath)))) as? [String: Any] ?? [:]
}
func saveState(_ s: [String: Any]) {
    try? FileManager.default.createDirectory(atPath: stateDir, withIntermediateDirectories: true)
    if let d = try? JSONSerialization.data(withJSONObject: s) { try? d.write(to: URL(fileURLWithPath: statePath)) }
}

// ── card ──
final class Model: ObservableObject {
    let spec: Spec
    @Published var typed = ""
    @Published var shown = false
    @Published var found: Bool? = nil
    @Published var listening = false
    @Published var mini: Bool
    var onWhere: (() -> Void)?
    init(_ s: Spec) { spec = s; mini = s.size == "mini" }
    var isPresent: Bool { spec.mode == "present" }
    var isReply: Bool { spec.mode == "reply" }
    func send(_ raw: String) {
        if isReply {
            let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { return }
            emit(["reply": "text", "text": t])
        }
        if isPresent, let (n, note) = leadingPick(raw, count: spec.options?.count ?? 0) {
            emit(["pick": n, "label": spec.options?[n - 1].label ?? "", "note": note])
        }
        if isPresent, let n = parsePick(raw, count: spec.options?.count ?? 0) { pick(n) }
        let r = normalise(raw)
        if r["reply"] as? String == "where", found == true { onWhere?() }
        emit(r)
    }
    func pick(_ n: Int) { emit(["pick": n, "label": spec.options?[n - 1].label ?? ""]) }
}

struct CardView: View {
    @ObservedObject var m: Model
    @Environment(\.colorScheme) var scheme
    @FocusState var focused: Bool
    var p: Palette { scheme == .dark ? .dark : .light }

    var header: some View {
        HStack(spacing: 7) {
            Circle().fill(p.cursor).frame(width: 7, height: 7)
                .opacity(m.listening ? 0.4 : 1).animation(.easeInOut(duration: 0.6).repeatForever(), value: m.listening)
            Text("Guru").font(ui(11.5, .semibold)).foregroundColor(p.accent)
            if let t = m.spec.task { Text("· " + t).font(ui(11.5)).foregroundColor(p.muted).lineLimit(1) }
            Spacer(minLength: 6)
            if let i = m.spec.index, let n = m.spec.total {
                Text("\(i) of \(n)").font(ui(10.5, .medium)).foregroundColor(p.muted)
                    .padding(.horizontal, 7).padding(.vertical, 2).background(Capsule().fill(p.raised))
            }
            Button { m.mini.toggle(); relayout() } label: {
                Image(systemName: m.mini ? "arrow.up.left.and.arrow.down.right" : "arrow.down.right.and.arrow.up.left")
                    .font(ui(9.5, .semibold)).foregroundColor(p.muted)
            }.buttonStyle(.plain).help(m.mini ? "Bigger card" : "Smaller card")
        }
    }

    var field: some View {
        HStack(spacing: 8) {
            Image(systemName: "mic.fill").font(ui(11)).foregroundColor(focused ? p.cursor : p.muted)
            TextField("", text: $m.typed, prompt: Text(m.isReply ? "Click, hold Fn and reply" : m.isPresent ? "Say “two”, or type" : "Hold Fn and say “done”, or “where?”")
                .foregroundColor(p.muted.opacity(0.75)))
                .textFieldStyle(.plain).font(ui(13)).foregroundColor(p.text)
                .focused($focused).onSubmit { m.send(m.typed) }
        }
        .padding(.horizontal, 11).padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 11).fill(p.raised))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(focused ? p.accent.opacity(0.6) : p.border, lineWidth: 1))
    }

    func keycap(_ key: String, _ what: String) -> some View {
        HStack(spacing: 4) {
            Text(key).font(mono(9.5)).foregroundColor(p.text)
                .padding(.horizontal, 5).padding(.vertical, 1.5)
                .background(RoundedRectangle(cornerRadius: 4).fill(p.raised))
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(p.border, lineWidth: 1))
            Text(what).font(ui(10)).foregroundColor(p.muted)
        }
    }

    func chip(_ label: String, _ action: @escaping () -> Void, primary: Bool = false) -> some View {
        Button(action: action) {
            Text(label).font(ui(12.5, primary ? .semibold : .medium))
                .foregroundColor(primary ? p.bg : p.text)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(Capsule().fill(primary ? p.accent : p.raised))
                .overlay(Capsule().stroke(primary ? Color.clear : p.border, lineWidth: 1))
        }.buttonStyle(.plain)
    }

    var body: some View {
        Group {
            if m.mini { miniBody } else { fullBody }
        }
        .background(RoundedRectangle(cornerRadius: m.mini ? 22 : 18).fill(p.bg))
        .overlay(RoundedRectangle(cornerRadius: m.mini ? 22 : 18).stroke(p.border, lineWidth: 1))
        .scaleEffect(m.shown ? 1 : 0.94).opacity(m.shown ? 1 : 0)
        .onAppear { if !m.isReply { focused = true } }
        .onHover { inside in if inside && m.isReply { claimFocus(); focused = true } }
    }

    var miniBody: some View {
        HStack(spacing: 9) {
            Circle().fill(p.cursor).frame(width: 7, height: 7)
            Text(m.spec.say ?? "").font(ui(13, .medium)).foregroundColor(p.text).lineLimit(1)
            TextField("", text: $m.typed, prompt: Text("say “done”").foregroundColor(p.muted.opacity(0.7)))
                .textFieldStyle(.plain).font(ui(12.5)).frame(width: 96)
                .focused($focused).onSubmit { m.send(m.typed) }
            Button { m.mini = false; relayout() } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right").font(ui(9.5, .semibold)).foregroundColor(p.muted)
            }.buttonStyle(.plain)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .fixedSize()
    }

    var fullBody: some View {
        VStack(alignment: .leading, spacing: 11) {
            header
            Text(m.spec.say ?? "").font(serif(21)).foregroundColor(p.text)
                .fixedSize(horizontal: false, vertical: true)
            if let d = m.spec.detail, !d.isEmpty {
                Text(d).font(ui(12.5)).foregroundColor(p.muted).fixedSize(horizontal: false, vertical: true)
            }
            if m.found == false {
                Text("I can't spot it on screen right now. Say where you are, or “where?” and I'll look again.")
                    .font(ui(11.5)).foregroundColor(p.cursor).fixedSize(horizontal: false, vertical: true)
            }
            if m.isPresent, let opts = m.spec.options { optionsView(opts) }
            field
            if m.isReply {
                HStack(spacing: 6) {
                    chip("Dismiss", { emit(["reply": "stop"]) })
                    Spacer()
                    chip("Send to thread", { m.send(m.typed) }, primary: true)
                }
            } else if !m.isPresent {
                HStack(spacing: 6) {
                    chip("Back", { emit(["reply": "back"]) })
                    chip("Where?", { m.send("where") })
                    Spacer()
                    chip("Done", { emit(["reply": "next"]) }, primary: true)
                }
            }
            HStack(spacing: 10) {
                keycap(m.isPresent ? "1–\(m.spec.options?.count ?? 1)" : "↵", m.isPresent ? "choose" : m.isReply ? "send" : "done")
                keycap("esc", "stop")
                Spacer()
                Text("drag to move · made for Wispr").font(ui(10)).foregroundColor(p.muted.opacity(0.75))
            }
        }
        .padding(16).frame(width: 340)
    }

    @ViewBuilder func optionsView(_ opts: [Option]) -> some View {
        let tiles = opts.allSatisfy { $0.image != nil }
        if tiles {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                ForEach(Array(opts.enumerated()), id: \.offset) { i, o in
                    Button { m.pick(i + 1) } label: {
                        VStack(spacing: 4) {
                            ZStack(alignment: .topLeading) {
                                if let img = NSImage(contentsOfFile: o.image!) {
                                    Image(nsImage: img).resizable().aspectRatio(contentMode: .fill).frame(height: 70).clipped()
                                } else { Rectangle().fill(p.raised).frame(height: 70) }
                                Text("\(i + 1)").font(ui(10.5, .bold)).foregroundColor(p.bg)
                                    .frame(width: 18, height: 18).background(Circle().fill(p.accent)).padding(4)
                            }.clipShape(RoundedRectangle(cornerRadius: 8))
                            Text(o.label).font(ui(10.5)).foregroundColor(p.text).lineLimit(1)
                        }
                    }.buttonStyle(.plain)
                }
            }
        } else {
            VStack(spacing: 5) {
                ForEach(Array(opts.enumerated()), id: \.offset) { i, o in
                    Button { m.pick(i + 1) } label: {
                        HStack(alignment: .top, spacing: 9) {
                            Text("\(i + 1)").font(ui(11, .bold)).foregroundColor(p.bg)
                                .frame(width: 20, height: 20).background(RoundedRectangle(cornerRadius: 6).fill(p.accent))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(o.label).font(ui(13, .medium)).foregroundColor(p.text)
                                if let d = o.detail { Text(d).font(ui(11)).foregroundColor(p.muted).lineLimit(2) }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(8).background(RoundedRectangle(cornerRadius: 10).fill(p.raised)).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
            }
        }
    }
}

final class CardPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override func mouseDown(with event: NSEvent) { NSApp.activate(ignoringOtherApps: true); super.mouseDown(with: event) }
    override func performKeyEquivalent(with event: NSEvent) -> Bool { forwardEditKey(event) || super.performKeyEquivalent(with: event) }
}

// Accessory apps have no menu bar, so ⌘V/⌘C/⌘X/⌘A/⌘Z had no Edit menu to route through and never
// reached the text field. Wispr Flow inserts dictation by pasting, so it broke the same way. A hidden
// Edit menu gives those keys their standard nil-targeted actions; the panel also forwards them itself.
func installEditMenu() {
    let main = NSMenu(), holder = NSMenuItem(), edit = NSMenu(title: "Edit")
    main.addItem(holder); holder.submenu = edit
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z").keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    NSApplication.shared.mainMenu = main
}
func forwardEditKey(_ event: NSEvent) -> Bool {
    let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    guard mods == .command || mods == [.command, .shift], let c = event.charactersIgnoringModifiers?.lowercased() else { return false }
    let action: Selector? = switch c {
    case "v": #selector(NSText.paste(_:))
    case "c": #selector(NSText.copy(_:))
    case "x": #selector(NSText.cut(_:))
    case "a": #selector(NSText.selectAll(_:))
    case "z": mods.contains(.shift) ? Selector(("redo:")) : Selector(("undo:"))
    default: nil
    }
    guard let action else { return false }
    return NSApplication.shared.sendAction(action, to: nil, from: nil)
}


var panel: CardPanel!
var host: NSHostingView<CardView>!
var userMoved = false
var placing = false
var gSpecAt: String? = nil

func relayout() {
    DispatchQueue.main.async {
        host.layoutSubtreeIfNeeded()
        let s = host.fittingSize
        var f = panel.frame
        f.origin.y += f.height - s.height   // grow/shrink from the top edge
        f.size = s
        placing = true; panel.setFrame(f, display: true, animate: false); placing = false
    }
}

// Dock the card beside the target (right of it, else left, else below), on the target's screen.
func dock(_ topLeft: CGRect?) {
    guard !userMoved, let panel else { return }
    let size = panel.frame.size
    let gap: CGFloat = 46
    var origin: NSPoint
    if let r = topLeft {
        let c = toCocoa(r)
        let screen = NSScreen.screens.first { $0.frame.intersects(c) } ?? NSScreen.main!
        let v = screen.visibleFrame
        if c.maxX + gap + size.width <= v.maxX - 8 { origin = NSPoint(x: c.maxX + gap, y: c.midY - size.height / 2 - 24) }
        else if c.minX - gap - size.width >= v.minX + 8 { origin = NSPoint(x: c.minX - gap - size.width, y: c.midY - size.height / 2) }
        else { origin = NSPoint(x: c.midX - size.width / 2, y: c.minY - gap - size.height) }
        origin.x = min(max(origin.x, v.minX + 8), v.maxX - size.width - 8)
        origin.y = min(max(origin.y, v.minY + 8), v.maxY - size.height - 8)
        // Never cover the target: if clamping pushed it over, put it above instead.
        if NSRect(origin: origin, size: size).intersects(c.insetBy(dx: -6, dy: -6)) {
            origin.y = min(c.maxY + gap, v.maxY - size.height - 8)
        }
    } else {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main!
        let v = screen.visibleFrame
        origin = gSpecAt == "notch" ? NSPoint(x: v.midX - size.width / 2, y: v.maxY - size.height - 8)
            : NSPoint(x: min(mouse.x + 18, v.maxX - size.width - 8), y: max(mouse.y - size.height - 18, v.minY + 8))
    }
    placing = true
    NSAnimationContext.runAnimationGroup { ctx in ctx.duration = 0.22; panel.animator().setFrameOrigin(origin) }
    placing = false
}

// ── main ──
let args = CommandLine.arguments
if args.count > 1, args[1] == "--version" { print("guru api \(API_VERSION)"); exit(0) }
guard args.count > 1, let spec = try? JSONDecoder().decode(Spec.self, from: Data(args[1].utf8)) else {
    FileHandle.standardError.write(Data("usage: guru '<json>'  (see API.md)\n".utf8)); exit(2)
}
let mode = spec.mode ?? "step"
gSpecAt = spec.at

// look: no UI, just facts for Claude.
if mode == "look" {
    var out: [String: Any] = [:]
    var needs: [String] = []
    let app = findApp(spec.app ?? spec.target?.app)
    if let app { out["app"] = app.localizedName ?? "" }
    if let s = NSScreen.screens.first { out["screen"] = ["w": s.frame.width, "h": s.frame.height]; out["scale"] = s.backingScaleFactor }
    out["screens"] = NSScreen.screens.map { s in ["x": s.frame.minX, "y": primaryH - s.frame.maxY, "w": s.frame.width, "h": s.frame.height] }
    if let app, let w = frontWindowRect(pid: app.processIdentifier) { out["window"] = ["x": w.minX, "y": w.minY, "w": w.width, "h": w.height] }
    if spec.shot == false {
    } else if CGPreflightScreenCaptureAccess() {
        let path = NSTemporaryDirectory() + "guru-look-\(Int(Date().timeIntervalSince1970)).png"
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture"); p.arguments = ["-x", "-m", path]
        try? p.run(); p.waitUntilExit()
        if FileManager.default.fileExists(atPath: path) { out["screenshot"] = path }
    } else { needs.append("screen-recording") }
    if let f = spec.find ?? spec.target?.label, let app {
        if AXIsProcessTrusted() {

            out["matches"] = searchAX(pid: app.processIdentifier, label: f, role: spec.target?.role).map {
                ["label": $0.label, "role": $0.role, "rect": ["x": $0.rect.minX, "y": $0.rect.minY, "w": $0.rect.width, "h": $0.rect.height]]
            }
        } else { needs.append("accessibility") }
    }
    if !needs.isEmpty { out["needs"] = needs }
    let d = try! JSONSerialization.data(withJSONObject: out)
    FileHandle.standardOutput.write(d); FileHandle.standardOutput.write(Data("\n".utf8)); exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
installEditMenu()
registerWisprFonts()
if let a = ProcessInfo.processInfo.environment["GURU_APPEARANCE"] { app.appearance = NSAppearance(named: a == "dark" ? .darkAqua : .aqua) }

signal(SIGTERM) { _ in if let mySlot { unlink(mySlot) }; exit(0) }
let overlay = Overlay(tag: "Guru", screens: mode == "reply" ? [] : NSScreen.screens)
let model = Model(spec)
model.onWhere = { overlay.wiggle() }

let tracker = Tracker.shared
let startTip = NSEvent.mouseLocation
tracker.onChange = { r in
    overlay.set(r, from: startTip)
    if mode != "point" { model.found = tracker.hasTarget ? (r != nil) : nil; dock(r) }
}

if mode == "point" {
    tracker.start(spec.target)
    overlay.set(tracker.lastRect, from: startTip)
    DispatchQueue.main.asyncAfter(deadline: .now() + (spec.ttl ?? 4)) { emit(["shown": true]) }
    app.run()
}

host = NSHostingView(rootView: CardView(m: model))
host.layoutSubtreeIfNeeded()
panel = CardPanel(contentRect: NSRect(origin: .zero, size: host.fittingSize),
                  styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.contentView = host
panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = true
panel.level = NSWindow.Level(rawValue: NSWindow.Level.popUpMenu.rawValue + 2)
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
panel.isMovableByWindowBackground = true
panel.hidesOnDeactivate = false

// A remembered drag position wins (if it's still on a screen).
let st = loadState()
if mode != "reply", let x = st["x"] as? CGFloat, let y = st["y"] as? CGFloat,
   NSScreen.screens.contains(where: { $0.visibleFrame.contains(NSPoint(x: x + 20, y: y + 20)) }) {
    panel.setFrameOrigin(NSPoint(x: x, y: y)); userMoved = true
}
if mode != "reply" { tracker.start(spec.target) }
tracker.onResolved = { r in if mode != "point" { model.found = tracker.hasTarget ? (r != nil) : nil; dock(r) } }
if tracker.resolvedOnce { model.found = tracker.hasTarget ? (tracker.lastRect != nil) : nil }
overlay.set(tracker.lastRect, from: startTip)
if mode != "reply" { dock(tracker.lastRect) }
// If the remembered spot covers the target, dock anyway.
if userMoved, let r = tracker.lastRect, panel.frame.intersects(toCocoa(r)) { userMoved = false; dock(r) }

NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: panel, queue: .main) { _ in
    if placing { return }
    if NSEvent.pressedMouseButtons & 1 == 1 {   // a drag by the person
        userMoved = true
        saveState(["x": panel.frame.minX, "y": panel.frame.minY])
    }
}
NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in model.listening = true }
NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { _ in model.listening = false }

if mode == "reply" {
    // Stack: take the lowest free slot under the top-right corner; never take the keyboard on appear.
    let slot = claimSlot()
    let v = (NSScreen.screens.first { $0.safeAreaInsets.top > 0 } ?? NSScreen.main!).visibleFrame
    let sz = panel.frame.size
    placing = true
    panel.setFrameOrigin(NSPoint(x: v.maxX - sz.width - 14, y: v.maxY - 10 - CGFloat(slot + 1) * (sz.height + 10)))
    placing = false
    panel.orderFrontRegardless()
} else {
    panel.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
}
DispatchQueue.main.async { withAnimation(.spring(response: 0.32, dampingFraction: 0.82)) { model.shown = true } }

NSEvent.addLocalMonitorForEvents(matching: .keyDown) { ev in
    if ev.keyCode == 53 { emit(["reply": "stop"]) }
    if ev.keyCode == 123, ev.modifierFlags.contains(.command) { emit(["reply": "back"]) }
    if model.isPresent, model.typed.isEmpty, !(panel.firstResponder is NSTextView), let c = ev.charactersIgnoringModifiers, let n = Int(c), n >= 1, n <= (spec.options?.count ?? 0) { model.pick(n) }
    return ev
}
// A double-tap on the card's own field focuses it again after the person clicked away.
DispatchQueue.main.asyncAfter(deadline: .now() + (spec.timeout ?? 540)) { emit(["reply": "timeout"]) }
app.run()
