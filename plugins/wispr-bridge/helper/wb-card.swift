// wb-card — one-shot native card for Wispr Bridge.
//
// Drawn with WisprTheme (../../wispr-theme/WisprTheme.swift): build.sh concatenates the theme ahead of
// this file, so build with ./build.sh rather than swiftc on this file alone.
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


// ── look: WisprTheme (concatenated ahead of this file by build.sh) ──
typealias W = WisprTheme
/// Room around each card so its shadow is not clipped by the borderless window.
let shadowPad: CGFloat = 18

struct Hint: View {
    let key: String; let what: String
    var body: some View {
        HStack(spacing: 5) {
            WisprKeycap(label: key, size: 11)
            Text(what).font(W.sans(12.5, .medium)).foregroundColor(W.fg2)
        }
    }
}

/// Flow's hold-to-talk line: "Hold [fn] and speak", keycap inline.
struct HoldToSpeak: View {
    var then: String = "and speak"
    var body: some View {
        HStack(spacing: 5) {
            Text("Hold").font(W.sans(12.5, .medium)).foregroundColor(W.fg2)
            WisprKeycap(label: "fn", size: 11)
            Text(then).font(W.sans(12.5, .medium)).foregroundColor(W.fg2)
        }
    }
}

struct Badge: View {
    let n: Int; let on: Bool
    var body: some View {
        Text("\(n)").font(W.sans(12, .semibold)).foregroundColor(on ? W.onPrimary : W.vast900)
            .frame(width: 22, height: 22)
            .background(RoundedRectangle(cornerRadius: W.rSM).fill(on ? W.primary : Color.white))
            .overlay(RoundedRectangle(cornerRadius: W.rSM).stroke(on ? Color.white : W.border, lineWidth: on ? 1.5 : 1))
    }
}

struct PresentView: View {
    @ObservedObject var m: Model
    @FocusState var focused: Bool
    var width: CGFloat { m.grid ? max(480, CGFloat(min(3, max(2, m.opts.count))) * 168 - 12 + 48) : 480 }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                WisprLockup(name: "Wispr Bridge", size: 13)
                Spacer()
                if m.multi {
                    Text("Pick any").font(W.sans(11, .medium)).foregroundColor(W.fg2)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: W.rSM).fill(W.sand600))
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(m.spec.title ?? "Pick one")
                    .font(W.sans(17, .semibold)).foregroundColor(W.fg)
                    .fixedSize(horizontal: false, vertical: true)
                if let s = m.spec.subtitle, !s.isEmpty {
                    Text(s).font(W.sans(13)).foregroundColor(W.fg2).fixedSize(horizontal: false, vertical: true)
                }
            }
            if m.grid { grid } else { list }
            TextField("", text: $m.typed,
                      prompt: Text(m.multi ? "Click to toggle, then press return" : "Add a note, or type a number")
                        .foregroundColor(W.fg3))
                .textFieldStyle(.plain).font(W.sans(13.5)).foregroundColor(W.fg)
                .padding(.horizontal, 12).frame(height: 36)
                .background(RoundedRectangle(cornerRadius: W.rMD).fill(Color.white))
                .overlay(RoundedRectangle(cornerRadius: W.rMD).stroke(focused ? W.fieldFocus : W.border, lineWidth: 1))
                .background(RoundedRectangle(cornerRadius: W.rMD + 3).stroke(focused ? W.fieldRing : Color.clear, lineWidth: 3).padding(-2.5))
                .animation(W.ease, value: focused)
                .focused($focused)
                .onSubmit { m.submit() }
                .onChange(of: m.typed) { _ in m.typedChanged() }
            HStack(spacing: 12) {
                // Digits are text in the focused field: "2 ↵" picks, "1 but shorter ↵" picks with a note.
                HoldToSpeak()
                if m.multi { Hint(key: "return", what: "when done") } else { Hint(key: m.opts.count <= 1 ? "return" : "1–\(m.opts.count)", what: "to pick") }
                Spacer()
                Button("Not now") { emit(["cancelled": true, "reason": "dismissed"]) }
                    .buttonStyle(WisprButtonStyle(kind: .outline, height: 30))
                if m.multi {
                    Button("Done") { m.finish(m.chosen.isEmpty ? [m.selected] : Array(m.chosen)) }
                        .buttonStyle(WisprButtonStyle(kind: .primary, height: 30))
                }
            }
        }
        .padding(24)
        .frame(width: width)
        .wisprSurface()
        .padding(shadowPad)
        .scaleEffect(m.shown ? 1 : 0.97, anchor: .top)
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
                            Rectangle().fill(W.sand500)
                                .overlay(Text("No preview").font(W.sans(11)).foregroundColor(W.fg3))
                        }
                    }
                    .frame(width: 156, height: 112).clipped()
                    .clipShape(RoundedRectangle(cornerRadius: W.rMD))
                    Badge(n: i + 1, on: isOn(i)).padding(7)
                }
                .frame(width: 156, height: 112)
                .overlay(RoundedRectangle(cornerRadius: W.rMD).stroke(W.border, lineWidth: 1))
                .overlay(RoundedRectangle(cornerRadius: W.rMD + 3)
                    .stroke(isOn(i) ? W.vast950 : Color.clear, lineWidth: 2).padding(-3.5))
                .animation(W.ease, value: isOn(i))
                Text(o.label).font(W.sans(13, .medium)).foregroundColor(W.fg).lineLimit(1)
                if let d = o.detail, !d.isEmpty {
                    Text(d).font(W.sans(11.5)).foregroundColor(W.fg2).lineLimit(1)
                }
            }
            .frame(width: 156, alignment: .leading)
            .scaleEffect(m.flash == i ? 0.97 : 1)
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
                        Badge(n: i + 1, on: isOn(i))
                        if let img = m.images[i] {
                            Image(nsImage: img).resizable().aspectRatio(contentMode: .fill)
                                .frame(width: 34, height: 34).clipShape(RoundedRectangle(cornerRadius: W.rSM))
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(o.label).font(W.sans(14, .medium)).foregroundColor(W.fg)
                            if let d = o.detail, !d.isEmpty {
                                Text(d).font(W.sans(12.5)).foregroundColor(W.fg2)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: W.rMD).fill(i == m.selected ? W.sand600 : Color.white))
                    .overlay(RoundedRectangle(cornerRadius: W.rMD).stroke(isOn(i) ? W.vast950 : W.border, lineWidth: isOn(i) ? 1.5 : 1))
                    .animation(W.ease, value: m.selected)
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
    @Published var tappable = false
    var onTap: (() -> Void)?
    var onClose: (() -> Void)?
    @Published var shown = true
    init(title: String?, text: String, busy: Bool) { self.title = title; self.text = text; self.busy = busy }
}

struct PillView: View {
    @ObservedObject var m: PillModel
    var body: some View {
        HStack(spacing: 10) {
            if m.busy { ProgressView().controlSize(.small).scaleEffect(0.8).tint(W.fg) }
            else { Circle().fill(W.flare).frame(width: 6, height: 6) }
            VStack(alignment: .leading, spacing: 2) {
                Text((m.title ?? "").isEmpty ? "Wispr Bridge" : m.title!).font(W.sans(12, .bold)).tracking(-0.2).foregroundColor(W.fg)
                Text(m.text).font(W.sans(13.5)).foregroundColor(W.fg2)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if m.onClose != nil {
                Button(action: { m.onClose?() }) {
                    Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundColor(W.fg3)
                        .frame(width: 22, height: 22).contentShape(Rectangle())
                }.buttonStyle(.plain).help("Dismiss")
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .frame(width: 340)
        .wisprSurface()
        .contentShape(Rectangle())
        .onTapGesture { m.onTap?() }
        .onHover { h in if m.tappable { (h ? NSCursor.pointingHand : NSCursor.arrow).set() } }
        .padding(shadowPad)
        .opacity(m.shown ? 1 : 0)
        .offset(y: m.shown ? 0 : -8)
    }
}

// ── ask: floating field for Wispr to dictate into ──
final class AskModel: ObservableObject { @Published var text = ""; @Published var shown = true }
struct AskView: View {
    @ObservedObject var m: AskModel
    let title: String; let placeholder: String
    @FocusState var focused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                WisprLockup(name: "Wispr Bridge", size: 13)
                if !title.isEmpty {
                    Text(title).font(W.sans(12.5)).foregroundColor(W.fg3).lineLimit(1)
                }
                Spacer()
            }
            TextField("", text: $m.text, prompt: Text(placeholder).foregroundColor(W.fg3), axis: .vertical)
                .textFieldStyle(.plain).font(W.sans(15)).foregroundColor(W.fg)
                .lineLimit(1...4)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: W.rMD).fill(Color.white))
                .overlay(RoundedRectangle(cornerRadius: W.rMD).stroke(focused ? W.fieldFocus : W.border, lineWidth: 1))
                .background(RoundedRectangle(cornerRadius: W.rMD + 3).stroke(focused ? W.fieldRing : Color.clear, lineWidth: 3).padding(-2.5))
                .focused($focused)
                .onSubmit {
                    let t = m.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if t.isEmpty { emit(["cancelled": true, "reason": "empty"]) } else { emit(["text": t]) }
                }
            HStack(spacing: 12) {
                HoldToSpeak()
                Hint(key: "return", what: "to send")
                Hint(key: "esc", what: "to close")
                Spacer()
            }
        }
        .padding(24).frame(width: 560)
        .wisprSurface()
        .padding(shadowPad)
        .scaleEffect(m.shown ? 1 : 0.97).opacity(m.shown ? 1 : 0)
        .onAppear { focused = true }
    }
}

/// The plugin folder that holds fonts/: $WISPR_PLUGIN_ROOT, else the folder above helper/ (this binary
/// lives at <plugin>/helper/wb-card, or <plugin>/vendor/wispr-bridge/helper/wb-card when vendored).
func pluginRoot() -> URL {
    let fm = FileManager.default
    var cands: [URL] = []
    for k in ["WISPR_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"] {
        if let v = ProcessInfo.processInfo.environment[k], !v.isEmpty { cands.append(URL(fileURLWithPath: v)) }
    }
    let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    cands.append(exe.deletingLastPathComponent().deletingLastPathComponent())
    cands.append(exe.deletingLastPathComponent())
    cands.append(URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".wispr-bridge"))
    return cands.first { fm.fileExists(atPath: $0.appendingPathComponent("fonts").path) }
        ?? exe.deletingLastPathComponent().deletingLastPathComponent()
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
// Timeouts count from launch, not from when AppKit is ready: on a busy Mac startup can take 10–20 s, and the
// caller's own deadline (timeout + a margin) must still find this card's answer.
let launched = DispatchTime.now()
var raw = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
if raw.hasPrefix("@") { raw = (try? String(contentsOfFile: String(raw.dropFirst()))) ?? "" }
guard let spec = try? JSONDecoder().decode(Spec.self, from: Data(raw.utf8)) else {
    FileHandle.standardError.write(Data("usage: wb-card '<json>'\n".utf8)); exit(2)
}
let mode = spec.mode ?? "present"

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
installEditMenu()
// Wispr's cards are light (the Flow app's default look), whatever the system appearance.
app.appearance = NSAppearance(named: .aqua)
WisprTheme.registerFonts(in: pluginRoot())

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
    panel.hasShadow = false                    // the card draws its own Wispr shadow
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
    // busy:false drops the spinner (nothing is loading); run:[absolute executable, args…] is started when the
    // pill is clicked, with no shell; closable:true adds a × that dismisses the pill.
    struct P: Decodable { let text: String?; let title: String?; let done: Bool?; let busy: Bool?; let run: [String]?; let closable: Bool? }
    func read() -> P? { (try? Data(contentsOf: URL(fileURLWithPath: file))).flatMap { try? JSONDecoder().decode(P.self, from: $0) } }
    let first = read()
    let pm = PillModel(title: first?.title ?? spec.title, text: first?.text ?? spec.text ?? "Working…", busy: first?.busy ?? true)
    var runArgv: [String]? = nil
    func applyActions(_ p: P?) {
        if let r = p?.run, let exe = r.first, exe.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: exe) { runArgv = r } else { runArgv = nil }
        pm.tappable = runArgv != nil
        pm.onTap = runArgv == nil ? nil : {
            guard let r = runArgv else { return }
            let t = Process(); t.executableURL = URL(fileURLWithPath: r[0]); t.arguments = Array(r.dropFirst())
            t.standardOutput = FileHandle.nullDevice; t.standardError = FileHandle.nullDevice
            try? t.run()
        }
        pm.onClose = (p?.closable ?? false) ? { () -> Void in emit(["done": true, "reason": "dismissed"]) } : nil
    }
    applyActions(first)
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
        if let b = p.busy, b != pm.busy { pm.busy = b }
        if (p.run ?? []) != (runArgv ?? []) || (p.closable ?? false) != (pm.onClose != nil) { applyActions(p) }
        if p.done == true {
            pm.busy = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { emit(["done": true]) }
        }
        if Date().timeIntervalSince(last) > (spec.timeout ?? 1800) { emit(["done": true, "reason": "stale"]) }
    }

case "ask":
    let am = AskModel()
    let (panel, _) = makePanel(AskView(m: am, title: spec.title ?? "",
                                       placeholder: spec.placeholder ?? "Say what you want Claude to do"),
                               at: spec.at ?? "center", key: true)
    keep.append(panel)
    DispatchQueue.main.async { withAnimation(WisprTheme.easeOut) { am.shown = true } }
    NSEvent.addLocalMonitorForEvents(matching: .keyDown) { ev in
        if ev.keyCode == 53 { emit(["cancelled": true, "reason": "esc"]) }
        return ev
    }
    DispatchQueue.main.asyncAfter(deadline: launched + (spec.timeout ?? 300)) { emit(["cancelled": true, "reason": "timeout"]) }

default:
    let model = Model(spec)
    if model.opts.isEmpty { FileHandle.standardError.write(Data("present needs options\n".utf8)); exit(2) }
    let (panel, _) = makePanel(PresentView(m: model), at: spec.at, key: spec.focus ?? true)
    thePanel = panel
    keep.append(panel)
    DispatchQueue.main.async { withAnimation(WisprTheme.easeOut) { model.shown = true } }
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
    DispatchQueue.main.asyncAfter(deadline: launched + (spec.timeout ?? 540)) {
        emit(["cancelled": true, "timeout": true, "reason": "timeout"])
    }
}

app.run()
