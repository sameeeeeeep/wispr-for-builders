// WisprTheme.swift — the one Wispr theme for every native Wispr helper (bridge card, Guru, ...).
// Values are Wispr Flow's own, read from the Flow desktop app's stylesheet (Nov 2026); the web
// twin is wispr.css next to this file. Build scripts concatenate this file ahead of each helper's
// main file, so it must stay free of top-level statements.
//
// Fonts: Figtree + EB Garamond (SIL OFL, the faces Flow ships). Call WisprTheme.registerFonts(in:)
// once at launch with the folder holding fonts/; if they are missing, the system font stands in.
// No Wispr logos: every logo slot is the product name set in Figtree (WisprLockup, WisprTile).

import AppKit
import SwiftUI
import CoreText

enum WisprTheme {
    // palette
    static let sand50   = Color(hex: 0xFCFCFB), sand200 = Color(hex: 0xF8F7F3), sand500 = Color(hex: 0xF5F4F0)
    static let sand600  = Color(hex: 0xEEEBE3), sand700 = Color(hex: 0xC5C0B3), sand950 = Color(hex: 0x4D4A42)
    static let vast50   = Color(hex: 0xE9E8E1), vast200 = Color(hex: 0xC8C8C2), vast300 = Color(hex: 0xB3B2AD)
    static let vast400  = Color(hex: 0x9D9C98), vast600 = Color(hex: 0x71716E), vast700 = Color(hex: 0x5B5B59)
    static let vast800  = Color(hex: 0x464544), vast875 = Color(hex: 0x343432), vast900 = Color(hex: 0x30302F)
    static let vast925  = Color(hex: 0x202020), vast950 = Color(hex: 0x1A1A1A)
    static let lumen    = Color(hex: 0xFFFFEB), fathom = Color(hex: 0x034F46), fathom50 = Color(hex: 0xE2F5F2)
    static let flare    = Color(hex: 0xFF6C4C), green600 = Color(hex: 0x059669), red600 = Color(hex: 0xDC2626)
    static let pro      = Color(hex: 0xECD8FD), proInk = Color(hex: 0x4B2A6B), new = Color(hex: 0xEFAC5B)
    static let keycapDrop = Color(hex: 0xD3CED6)
    // text field: 1px sand-600 at rest; focused = vast-400 edge plus a 3px muted-hover ring (Flow's focus-within)
    static let fieldFocus = vast400, fieldRing = Color(hex: 0xF1EBE1)
    // wisprflow.ai marketing palette
    static let dawn = Color(hex: 0xF0D7FF), glow = Color(hex: 0xFFA946), signal = Color(hex: 0xFFBCF2), lumenDark = Color(hex: 0xE4E4D0)

    // semantic (light, the app default)
    static let bg = sand500, surface = sand50, card = Color.white, border = sand600, hover = sand600
    static let fg = vast950, fg2 = vast700, fg3 = vast600
    static let primary = vast950, onPrimary = sand50, accent = fathom, onAccent = lumen

    // dark
    enum Dark {
        static let bg = vast925, surface = vast950, card = Color.black, border = vast900, hover = vast900
        static let fg = vast50, fg2 = vast300, fg3 = vast400, primary = sand50, onPrimary = vast950
    }

    // shape (app radii)
    static let rXS: CGFloat = 4, rSM: CGFloat = 6, rMD: CGFloat = 8, rLG: CGFloat = 12, rXL: CGFloat = 16, rXXL: CGFloat = 24
    static let dialogPadding: CGFloat = 24

    // type scale (app): 12 14 16 18 20 24 28 36 48
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        fontsReady ? .custom("Figtree", size: size).weight(weight) : .system(size: size, weight: weight)
    }
    static func serif(_ size: CGFloat, italic: Bool = false) -> Font {
        guard fontsReady else { return italic ? .system(size: size, design: .serif).italic() : .system(size: size, design: .serif) }
        return italic ? .custom("EB Garamond", size: size).italic() : .custom("EB Garamond", size: size)
    }
    static func mono(_ size: CGFloat) -> Font { .system(size: size, design: .monospaced) }
    static func nsSans(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        if fontsReady, let f = NSFont(name: "Figtree", size: size) {
            let d = f.fontDescriptor.addingAttributes([.traits: [NSFontDescriptor.TraitKey.weight: weight]])
            return NSFont(descriptor: d, size: size) ?? f
        }
        return .systemFont(ofSize: size, weight: weight)
    }

    // motion: the app's main curve cubic-bezier(0.05, 0.6, 0.4, 0.95), .15s
    static let ease = Animation.timingCurve(0.05, 0.6, 0.4, 0.95, duration: 0.15)
    static let easeOut = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.25)
    static let nudge = Animation.timingCurve(0.34, 1.4, 0.64, 1, duration: 0.35)

    // shadows (app shadow-xl / shadow-sm, approximated as one SwiftUI shadow each)
    static let shadowXL = (color: Color.black.opacity(0.10), radius: CGFloat(12), y: CGFloat(10))
    static let shadowSM = (color: Color.black.opacity(0.10), radius: CGFloat(1.5), y: CGFloat(1))

    // fonts
    private(set) static var fontsReady = false
    static func registerFonts(in dir: URL) {
        let fonts = dir.appendingPathComponent("fonts")
        let names = ["Figtree[wght].ttf", "EBGaramond[wght].ttf", "EBGaramond-Italic[wght].ttf"]
        var ok = 0
        for n in names {
            let u = fonts.appendingPathComponent(n)
            guard FileManager.default.fileExists(atPath: u.path) else { continue }
            var err: Unmanaged<CFError>?
            if CTFontManagerRegisterFontsForURL(u as CFURL, .process, &err) { ok += 1 }
            else if NSFont(name: n.hasPrefix("Fig") ? "Figtree" : "EB Garamond", size: 12) != nil { ok += 1 } // already registered
        }
        fontsReady = ok > 0 && NSFont(name: "Figtree", size: 12) != nil
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255, opacity: alpha)
    }
}

// MARK: components

/// The app's keycap (Flow's keyBlock): white, 1px sand-600 edge, 2px #d3ced6 drop, 4px radius,
/// 22px tall with 8px side padding. Flow sets the label at 14; 12-13 suits a hint line.
struct WisprKeycap: View {
    let label: String
    var size: CGFloat = 12
    var body: some View {
        Text(label).font(WisprTheme.sans(size)).foregroundColor(WisprTheme.vast900)
            .padding(.horizontal, size >= 12 ? 8 : 7).frame(minHeight: max(20, size + 10))
            .background(RoundedRectangle(cornerRadius: WisprTheme.rXS).fill(Color.white))
            .overlay(RoundedRectangle(cornerRadius: WisprTheme.rXS).stroke(WisprTheme.border, lineWidth: 1))
            .background(RoundedRectangle(cornerRadius: WisprTheme.rXS).fill(WisprTheme.keycapDrop).offset(y: 2))
    }
}

/// App buttons: 8px radius, Figtree 14 medium.
struct WisprButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, outline, ghost, accent }
    var kind: Kind = .primary
    var height: CGFloat = 32
    func makeBody(configuration: Configuration) -> some View {
        let (bg, fg): (Color, Color) = {
            switch kind {
            case .primary: return (WisprTheme.primary, WisprTheme.onPrimary)
            case .secondary: return (WisprTheme.sand600, WisprTheme.vast950)
            case .outline: return (Color.white, WisprTheme.fg)
            case .ghost: return (Color.clear, WisprTheme.fg)
            case .accent: return (WisprTheme.accent, WisprTheme.onAccent)
            }
        }()
        return configuration.label.font(WisprTheme.sans(13, .medium)).foregroundColor(fg)
            .padding(.horizontal, 14).frame(height: height)
            .background(RoundedRectangle(cornerRadius: WisprTheme.rMD).fill(configuration.isPressed ? bg.opacity(0.85) : bg))
            .overlay(RoundedRectangle(cornerRadius: WisprTheme.rMD).stroke(kind == .outline ? WisprTheme.border : .clear, lineWidth: 1))
            .scaleEffect(configuration.isPressed ? 0.98 : 1).animation(WisprTheme.ease, value: configuration.isPressed)
    }
}

/// Card / dialog surface: sand-50, 1px sand-600 border, 12px radius, shadow-xl.
struct WisprSurface: ViewModifier {
    var radius: CGFloat = WisprTheme.rLG
    func body(content: Content) -> some View {
        // Shadow on the surface shape only: on the whole view SwiftUI would shadow every child too.
        content.background(RoundedRectangle(cornerRadius: radius).fill(WisprTheme.surface)
                .shadow(color: WisprTheme.shadowXL.color, radius: WisprTheme.shadowXL.radius, y: WisprTheme.shadowXL.y))
            .overlay(RoundedRectangle(cornerRadius: radius).stroke(WisprTheme.border, lineWidth: 1))
    }
}
extension View { func wisprSurface(radius: CGFloat = WisprTheme.rLG) -> some View { modifier(WisprSurface(radius: radius)) } }

/// Product lockup for native cards: the product name in Figtree 700, no logo.
struct WisprLockup: View {
    let name: String            // e.g. "Wispr Guru"
    var size: CGFloat = 14
    var body: some View {
        Text(name).font(WisprTheme.sans(size, .bold)).tracking(-0.3).foregroundColor(WisprTheme.fg)
    }
}

/// App-icon slot: black rounded tile with a short name in Figtree.
struct WisprTile: View {
    let label: String           // e.g. "Guru"
    var size: CGFloat = 28
    var body: some View {
        Text(label).font(WisprTheme.sans(size * 0.3, .bold)).foregroundColor(WisprTheme.sand50)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous).fill(WisprTheme.vast950))
    }
}
