// wb-card — one-shot native card for Wispr Bridge (made for Wispr; unofficial).
//
// Extended from the Switchboard notch's sb-card. One JSON argument, draws, waits, prints one JSON
// line on stdout, exits. No network, no microphone: voice arrives as text that Wispr types into the
// card's focused text box.
//
//   wb-card '<json>'
//   mode "present": { title, subtitle?, options:[{label, detail?, image?}], multi?, recommended?,
//                     at?: "notch"|"cursor"|"center", timeout? }
//       -> {"pick":n,"label":s} | {"picks":[..],"labels":[..]} | {"text":s} | {"cancelled":true}
//   mode "notify":   { text, title?, ttl? }             -> {"shown":true}
//   mode "progress": { id, file }   (watches file {text, done})  -> {"done":true}
//   mode "ask":      { placeholder?, title? }           -> {"text":s} | {"cancelled":true}

import AppKit
import SwiftUI

struct Opt: Decodable { let label: String; let detail: String?; let image: String? }
struct Spec: Decodable {
    let mode: String?
    let title: String?; let subtitle: String?; let options: [Opt]?
    let multi: Bool?; let recommended: Int?
    let at: String?; let timeout: Double?
    let text: String?; let ttl: Double?
    let id: String?; let file: String?
    let placeholder: String?
    let focus: Bool?
}

struct Palette {
    let bg, raised, border, text, muted, accent: Color
    static func hex(_ v: UInt32) -> Color {
        Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
    static let light = Palette(bg: hex(0xFAF9F5), raised: hex(0xF0EEE6), border: hex(0xE3E0D5),
                               text: hex(0x141413), muted: hex(0x6B6A65), accent: hex(0x6E56CF))
    static let dark = Palette(bg: hex(0x1F1F1E), raised: hex(0x2C2C2A), border: hex(0x3A3A37),
                              text: hex(0xFAF9F5), muted: hex(0xA3A29C), accent: hex(0x9E8CFC))
}

func emit(_ obj: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

// ── spoken / typed pick parsing ("two", "the second one", "number 3", "one and three") ──
let numberWords: [String: Int] = [
    "one": 1, "won": 1, "first": 1, "1st": 1,
    "two": 2, "to": 2, "too": 2, "second": 2, "2nd": 2,
    "three": 3, "third": 3, "3rd": 3, "tree": 3,
    "four": 4, "for": 4, "fourth": 4, "4th": 4,
    "five": 5, "fifth": 5, "six": 6, "sixth": 6, "seven": 7, "seventh": 7,
    "eight": 8, "eighth": 8, "nine": 9, "ninth": 9,
]
let fillers: Set<String> = ["the", "one", "option", "number", "no", "pick", "choose", "i", "want",
                            "lets", "let's", "go", "with", "please", "and", "a", "that", "it", "is",
                            "take", "use", "select", "ones", "both", "done", "ok", "okay"]

func words(_ s: String) -> [String] {
    s.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
}

/// Returns picked 1-based indices if the text is only a choice phrase, else nil.

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

func parsePicks(_ s: String, count: Int) -> [Int]? {
    let ws = words(s)
    if ws.isEmpty { return nil }
    var picks: [Int] = []
    var i = 0
    while i < ws.count {
        let w = ws[i]
        if let n = Int(w), n >= 1, n <= count { picks.append(n) }
        else if let n = numberWords[w], n <= count,
                // "one" is both a number and a filler ("the second one"): number only if nothing picked
                !(w == "one" && !picks.isEmpty), !((w == "to" || w == "for" || w == "too") && ws.count > 2) {
            picks.append(n)
        } else if !fillers.contains(w) { return nil }
        i += 1
    }
    var seen = Set<Int>(); picks = picks.filter { seen.insert($0).inserted }
    return picks.isEmpty ? nil : picks
}

/// Label match: every word of the typed text found in exactly one option's label.
func matchLabel(_ s: String, _ opts: [Opt]) -> Int? {
    let ws = words(s).filter { !fillers.contains($0) }
    if ws.isEmpty { return nil }
    let hits = opts.enumerated().filter { _, o in
        let l = words(o.label + " " + (o.detail ?? "")); return ws.allSatisfy { w in l.contains { $0.hasPrefix(w) } }
    }
    return hits.count == 1 ? hits[0].offset + 1 : nil
}

final class Model: ObservableObject {
    let spec: Spec
    let opts: [Opt]
    let images: [NSImage?]
    @Published var selected: Int
    @Published var chosen = Set<Int>()
    @Published var typed = ""
    @Published var shown = true
    @Published var flash: Int? = nil
    var multi: Bool { spec.multi == true }
    var grid: Bool { !opts.isEmpty && opts.allSatisfy { ($0.image ?? "").isEmpty == false } }
    init(_ spec: Spec) {
        self.spec = spec
        opts = Array((spec.options ?? []).prefix(9))
        images = opts.map { o in
            guard let p = o.image, !p.isEmpty else { return nil }
            return NSImage(contentsOfFile: (p as NSString).expandingTildeInPath)
        }
        let r = (spec.recommended ?? 1) - 1
        selected = max(0, min(r, max(0, (spec.options ?? []).count - 1)))
    }
    func finish(_ idx: [Int]) -> Never {
        if multi {
            let s = idx.sorted()
            emit(["picks": s.map { $0 + 1 }, "labels": s.map { opts[$0].label }])
        }
        emit(["pick": idx[0] + 1, "label": opts[idx[0]].label])
    }
    func tap(_ i: Int) {
        if multi { if chosen.contains(i) { chosen.remove(i) } else { chosen.insert(i) }; selected = i }
        else {
            selected = i; flash = i
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { self.finish([i]) }
        }
    }
    func submit() {
        if Date().timeIntervalSince(born) < 0.8 { typed = ""; return }
        let t = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty {
            if !multi, let (n, note) = leadingPick(t, count: opts.count) {
                emit(["pick": n, "label": opts[n - 1].label, "note": note])
            }
            if let ps = parsePicks(t, count: opts.count) {
                if multi { finish(ps.map { $0 - 1 }) } else { finish([ps[0] - 1]) }
            }
            if !multi, let m = matchLabel(t, opts) { finish([m - 1]) }
            if multi, words(t).allSatisfy({ ["done", "ok", "okay", "that's", "thats", "it"].contains($0) }), !chosen.isEmpty {
                finish(Array(chosen))
            }
            emit(["text": t])
        }
        if opts.isEmpty { emit(["cancelled": true, "reason": "empty"]) }
        if multi { finish(chosen.isEmpty ? [selected] : Array(chosen)) } else { finish([selected]) }
    }
    /// Wispr pastes the whole utterance at once: if it is exactly a choice ("two."), pick after a beat.
    var prevTyped = ""
    func typedChanged() {
        defer { prevTyped = typed }
        guard !multi else { return }
        let snapshot = typed
        // Only a whole word landing at once (Wispr dictation, paste) auto-picks; a digit typed by hand
        // waits for ↵ so "1 but make it shorter" can be finished.
        guard prevTyped.isEmpty, snapshot.count >= 2 else { return }
        guard let ps = parsePicks(snapshot, count: opts.count), ps.count == 1 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
            if self.typed == snapshot { self.tap(ps[0] - 1) }
        }
    }
}

struct Hint: View {
    let key: String; let what: String; let p: Palette
    var body: some View {
        HStack(spacing: 4) {
            Text(key).font(.system(size: 9.5, weight: .medium)).foregroundColor(p.muted)
                .padding(.horizontal, 4).padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: 4).stroke(p.border, lineWidth: 1))
            Text(what).font(.system(size: 10)).foregroundColor(p.muted)
        }
    }
}

struct Badge: View {
    let n: Int; let on: Bool; let p: Palette
    var body: some View {
        Text("\(n)").font(.system(size: 11, weight: .bold)).foregroundColor(on ? .white : p.text)
            .frame(width: 22, height: 22)
            .background(RoundedRectangle(cornerRadius: 7).fill(on ? p.accent : p.bg.opacity(0.92)))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(on ? .clear : p.border, lineWidth: 1))
    }
}

struct PresentView: View {
    @ObservedObject var m: Model
    @Environment(\.colorScheme) var scheme
    @FocusState var focused: Bool
    var p: Palette { scheme == .dark ? .dark : .light }
    var width: CGFloat { m.grid ? CGFloat(min(3, max(2, m.opts.count))) * 168 - 12 + 36 : 440 }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Circle().fill(p.accent).frame(width: 7, height: 7)
                Text("made for Wispr").font(.system(size: 10.5, weight: .medium)).foregroundColor(p.muted)
                Spacer()
                if m.multi { Text("pick any").font(.system(size: 10.5)).foregroundColor(p.muted) }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(m.spec.title ?? "Pick one")
                    .font(.system(size: 16, weight: .semibold)).foregroundColor(p.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let s = m.spec.subtitle, !s.isEmpty {
                    Text(s).font(.system(size: 12)).foregroundColor(p.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            if m.grid { grid } else { list }
            TextField("", text: $m.typed,
                      prompt: Text(m.multi ? "Say \"one and three\", or click, then ↵" : "Say \"two\", or type anything")
                        .foregroundColor(p.muted.opacity(0.7)))
                .textFieldStyle(.plain).font(.system(size: 12.5)).foregroundColor(p.text)
                .padding(.horizontal, 11).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 10).fill(p.raised.opacity(0.6)))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(focused ? p.accent.opacity(0.6) : p.border, lineWidth: 1))
                .focused($focused)
                .onSubmit { m.submit() }
                .onChange(of: m.typed) { _ in m.typedChanged() }
            HStack(spacing: 10) {
                // Digits are text in the focused field: "2 ↵" picks, "1 but shorter ↵" picks with a note.
                Hint(key: m.multi ? "1 3 ↵" : "1–\(max(1, m.opts.count)) ↵", what: m.multi ? "pick" : "type to pick", p: p)
                Hint(key: "↑↓ ↵", what: "move", p: p)
                Hint(key: "esc", what: "dismiss", p: p)
                Spacer()
                Text("or say anything · drag to move").font(.system(size: 10)).foregroundColor(p.muted.opacity(0.7))
            }
        }
        .padding(18)
        .frame(width: width)
        .background(RoundedRectangle(cornerRadius: 18).fill(p.bg))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(p.border, lineWidth: 1))
        .scaleEffect(m.shown ? 1 : 0.94, anchor: .top)
        .opacity(m.shown ? 1 : 0)
        .onAppear { focused = true }
        .onHover { if $0 { claimFocus() } }
    }

    func isOn(_ i: Int) -> Bool { m.multi ? m.chosen.contains(i) : (i == m.selected) }

    var cols: Int { min(3, max(2, m.opts.count)) }
    // Explicit rows (not LazyVGrid) so the hosting view has a real fitting size.
    var grid: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(stride(from: 0, to: m.opts.count, by: cols)), id: \.self) { start in
                HStack(alignment: .top, spacing: 12) {
                    ForEach(start..<min(start + cols, m.opts.count), id: \.self) { i in tile(i) }
                }
            }
        }
    }

    func tile(_ i: Int) -> some View {
        let o = m.opts[i]
        return Button { m.tap(i) } label: {
            VStack(alignment: .leading, spacing: 6) {
                ZStack(alignment: .topLeading) {
                    Group {
                        if let img = m.images[i] {
                            Image(nsImage: img).resizable().aspectRatio(contentMode: .fill)
                        } else {
                            Rectangle().fill(p.raised)
                                .overlay(Text("no preview").font(.system(size: 10)).foregroundColor(p.muted))
                        }
                    }
                    .frame(width: 156, height: 112).clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 11))
                    Badge(n: i + 1, on: isOn(i), p: p).padding(7)
                }
                .frame(width: 156, height: 112)
                .overlay(RoundedRectangle(cornerRadius: 11)
                    .stroke(isOn(i) ? p.accent : p.border, lineWidth: isOn(i) ? 2.5 : 1))
                Text(o.label).font(.system(size: 12, weight: .medium)).foregroundColor(p.text).lineLimit(1)
                if let d = o.detail, !d.isEmpty {
                    Text(d).font(.system(size: 10.5)).foregroundColor(p.muted).lineLimit(1)
                }
            }
            .frame(width: 156, alignment: .leading)
            .scaleEffect(m.flash == i ? 0.96 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { if $0 { m.selected = i } }
    }

    var list: some View {
        VStack(spacing: 6) {
            ForEach(Array(m.opts.enumerated()), id: \.offset) { i, o in
                Button { m.tap(i) } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Badge(n: i + 1, on: isOn(i), p: p)
                        if let img = m.images[i] {
                            Image(nsImage: img).resizable().aspectRatio(contentMode: .fill)
                                .frame(width: 34, height: 34).clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(o.label).font(.system(size: 13, weight: .medium)).foregroundColor(p.text)
                            if let d = o.detail, !d.isEmpty {
                                Text(d).font(.system(size: 11.5)).foregroundColor(p.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 11).fill(i == m.selected ? p.raised : .clear))
                    .overlay(RoundedRectangle(cornerRadius: 11).stroke(isOn(i) ? p.accent.opacity(0.6) : p.border, lineWidth: 1))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { if $0 { m.selected = i } }
            }
        }
    }
}

// ── notify / progress pill ──
final class PillModel: ObservableObject {
    @Published var title: String?
    @Published var text: String
    @Published var busy: Bool
    @Published var shown = true
    init(title: String?, text: String, busy: Bool) { self.title = title; self.text = text; self.busy = busy }
}

struct PillView: View {
    @ObservedObject var m: PillModel
    @Environment(\.colorScheme) var scheme
    var p: Palette { scheme == .dark ? .dark : .light }
    var body: some View {
        HStack(spacing: 10) {
            if m.busy { ProgressView().controlSize(.small).scaleEffect(0.8) }
            else { Circle().fill(p.accent).frame(width: 8, height: 8) }
            VStack(alignment: .leading, spacing: 1) {
                if let t = m.title, !t.isEmpty {
                    Text(t).font(.system(size: 10.5, weight: .medium)).foregroundColor(p.muted)
                }
                Text(m.text).font(.system(size: 13, weight: .medium)).foregroundColor(p.text)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(width: 340)
        .background(RoundedRectangle(cornerRadius: 14).fill(p.bg))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(p.border, lineWidth: 1))
        .opacity(m.shown ? 1 : 0)
        .offset(y: m.shown ? 0 : -8)
    }
}

// ── ask: floating field for Wispr to dictate into ──
final class AskModel: ObservableObject { @Published var text = ""; @Published var shown = true }
struct AskView: View {
    @ObservedObject var m: AskModel
    let title: String; let placeholder: String
    @Environment(\.colorScheme) var scheme
    @FocusState var focused: Bool
    var p: Palette { scheme == .dark ? .dark : .light }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle().fill(p.accent).frame(width: 7, height: 7)
                Text(title).font(.system(size: 10.5, weight: .medium)).foregroundColor(p.muted)
                Spacer()
                Hint(key: "↵", what: "go", p: p); Hint(key: "esc", what: "close", p: p)
            }
            TextField("", text: $m.text, prompt: Text(placeholder).foregroundColor(p.muted.opacity(0.7)), axis: .vertical)
                .textFieldStyle(.plain).font(.system(size: 17)).foregroundColor(p.text)
                .lineLimit(1...4)
                .focused($focused)
                .onSubmit {
                    let t = m.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if t.isEmpty { emit(["cancelled": true, "reason": "empty"]) } else { emit(["text": t]) }
                }
        }
        .padding(16).frame(width: 520)
        .background(RoundedRectangle(cornerRadius: 16).fill(p.bg))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(p.accent.opacity(0.5), lineWidth: 1.5))
        .scaleEffect(m.shown ? 1 : 0.96).opacity(m.shown ? 1 : 0)
        .onAppear { focused = true }
    }
}

final class CardPanel: NSPanel {
    override var canBecomeKey: Bool { true }
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

var thePanel: NSPanel?
let born = Date()
/// focus:false cards stay out of the way; the pointer entering the card makes it key (keys + dictation).
func claimFocus() {
    guard let p = thePanel, !p.isKeyWindow else { return }
    NSApplication.shared.activate(ignoringOtherApps: true); p.makeKeyAndOrderFront(nil)
}

// ── main ──
var raw = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
if raw.hasPrefix("@") { raw = (try? String(contentsOfFile: String(raw.dropFirst()))) ?? "" }
guard let spec = try? JSONDecoder().decode(Spec.self, from: Data(raw.utf8)) else {
    FileHandle.standardError.write(Data("usage: wb-card '<json>'\n".utf8)); exit(2)
}
let mode = spec.mode ?? "present"

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
installEditMenu()
if let a = ProcessInfo.processInfo.environment["WB_CARD_APPEARANCE"] {
    app.appearance = NSAppearance(named: a == "dark" ? .darkAqua : .aqua)
}

func place(_ size: NSSize, _ at: String?) -> NSPoint {
    let mouse = NSEvent.mouseLocation
    let screen: NSScreen = at == "cursor"
        ? (NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main!)
        : (NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main!)
    let f = screen.visibleFrame
    var o: NSPoint
    switch at {
    case "cursor": o = NSPoint(x: mouse.x + 14, y: mouse.y - 18 - size.height)
    case "center": o = NSPoint(x: f.midX - size.width / 2, y: f.midY - size.height / 2 + f.height * 0.12)
    case "topright": o = NSPoint(x: f.maxX - size.width - 14, y: f.maxY - size.height - 10)
    default: o = NSPoint(x: f.midX - size.width / 2, y: f.maxY - size.height - 8)  // under the notch
    }
    o.x = min(max(o.x, f.minX + 8), f.maxX - size.width - 8)
    o.y = min(max(o.y, f.minY + 8), f.maxY - size.height - 8)
    return o
}

func makePanel<V: View>(_ view: V, at: String?, key: Bool) -> (NSPanel, NSHostingView<V>) {
    let host = NSHostingView(rootView: view)
    host.layoutSubtreeIfNeeded()
    let size = host.fittingSize
    let panel = CardPanel(contentRect: NSRect(origin: place(size, at), size: size),
                          styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.contentView = host
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.isMovableByWindowBackground = true     // draggable card
    if key { panel.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps: true) }
    else { panel.ignoresMouseEvents = false; panel.orderFrontRegardless() }
    return (panel, host)
}

var keep: [Any] = []

switch mode {
case "notify":
    let pm = PillModel(title: spec.title, text: spec.text ?? "", busy: false)
    let (panel, _) = makePanel(PillView(m: pm), at: spec.at ?? "topright", key: false)
    keep.append(panel)
    DispatchQueue.main.async { withAnimation(.easeOut(duration: 0.2)) { pm.shown = true } }
    DispatchQueue.main.asyncAfter(deadline: .now() + (spec.ttl ?? 3)) {
        withAnimation(.easeIn(duration: 0.18)) { pm.shown = false }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) { emit(["shown": true]) }
    }

case "progress":
    guard let file = spec.file else { FileHandle.standardError.write(Data("progress needs file\n".utf8)); exit(2) }
    struct P: Decodable { let text: String?; let title: String?; let done: Bool? }
    func read() -> P? { (try? Data(contentsOf: URL(fileURLWithPath: file))).flatMap { try? JSONDecoder().decode(P.self, from: $0) } }
    let first = read()
    let pm = PillModel(title: first?.title ?? spec.title, text: first?.text ?? spec.text ?? "Working…", busy: true)
    let (panel, host) = makePanel(PillView(m: pm), at: spec.at ?? "topright", key: false)
    keep.append(panel)
    DispatchQueue.main.async { withAnimation(.easeOut(duration: 0.2)) { pm.shown = true } }
    var last = Date()
    Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
        guard let p = read() else {
            if !FileManager.default.fileExists(atPath: file) { emit(["done": true, "reason": "removed"]) }
            return
        }
        if let t = p.text, t != pm.text { pm.text = t; last = Date()
            host.layoutSubtreeIfNeeded(); panel.setContentSize(host.fittingSize) }
        if p.done == true {
            pm.busy = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { emit(["done": true]) }
        }
        if Date().timeIntervalSince(last) > (spec.timeout ?? 1800) { emit(["done": true, "reason": "stale"]) }
    }

case "ask":
    let am = AskModel()
    let (panel, _) = makePanel(AskView(m: am, title: spec.title ?? "Wispr Bridge · dictate a request",
                                       placeholder: spec.placeholder ?? "Hold your Wispr key and say what you want…"),
                               at: spec.at ?? "center", key: true)
    keep.append(panel)
    DispatchQueue.main.async { withAnimation(.spring(response: 0.28, dampingFraction: 0.85)) { am.shown = true } }
    NSEvent.addLocalMonitorForEvents(matching: .keyDown) { ev in
        if ev.keyCode == 53 { emit(["cancelled": true, "reason": "esc"]) }
        return ev
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + (spec.timeout ?? 300)) { emit(["cancelled": true, "reason": "timeout"]) }

default:
    let model = Model(spec)
    if model.opts.isEmpty { FileHandle.standardError.write(Data("present needs options\n".utf8)); exit(2) }
    let (panel, _) = makePanel(PresentView(m: model), at: spec.at, key: spec.focus ?? true)
    thePanel = panel
    keep.append(panel)
    DispatchQueue.main.async { withAnimation(.spring(response: 0.32, dampingFraction: 0.82)) { model.shown = true } }
    NSEvent.addLocalMonitorForEvents(matching: .keyDown) { ev in
        let n = model.opts.count
        let cols = model.grid ? min(3, max(2, n)) : 1
        switch ev.keyCode {
        case 53: emit(["cancelled": true, "reason": "esc"])
        case 125: model.selected = min(model.selected + cols, n - 1); return nil   // down
        case 126: model.selected = max(model.selected - cols, 0); return nil       // up
        case 124 where model.grid && model.typed.isEmpty: model.selected = min(model.selected + 1, n - 1); return nil
        case 123 where model.grid && model.typed.isEmpty: model.selected = max(model.selected - 1, 0); return nil
        default: break
        }
        // Digits pick only while nobody is typing in the field; there they are text ("1 but shorter").
        if model.typed.isEmpty, !(thePanel?.firstResponder is NSTextView), ev.modifierFlags.intersection([.command, .control, .option]).isEmpty,
           let c = ev.charactersIgnoringModifiers, let k = Int(c), k >= 1, k <= n {
            model.tap(k - 1); return nil
        }
        return ev
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + (spec.timeout ?? 540)) {
        emit(["cancelled": true, "timeout": true])
    }
}

app.run()
