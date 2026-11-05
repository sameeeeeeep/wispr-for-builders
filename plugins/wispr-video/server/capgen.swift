// capgen: renders caption states to transparent PNGs with CoreText (this ffmpeg build has no libass/drawtext).
// usage: capgen spec.json   spec = {width, height, fontsDir, style:{...}, frames:[{file, runs:[{t, c, serif}]}]}
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

struct Run: Decodable { let t: String; let c: String; let serif: Bool?; let sp: Bool? }
struct Frame: Decodable { let file: String; let runs: [Run] }
struct Style: Decodable {
  let size: Double; let y: Double; let weight: Double; let maxWidth: Double
  let box: String?; let shadow: Bool?; let font: String?; let serifFont: String?; let fill: String?; let serifUpright: Bool?
}
struct Spec: Decodable { let width: Int; let height: Int; let fontsDir: String?; let style: Style; let frames: [Frame] }

func color(_ hex: String) -> CGColor {
  var s = hex.trimmingCharacters(in: .whitespaces); if s.hasPrefix("#") { s.removeFirst() }
  if s.count == 6 { s += "FF" }
  let v = UInt64(s, radix: 16) ?? 0xFFFFFFFF
  return CGColor(srgbRed: CGFloat((v >> 24) & 255) / 255, green: CGFloat((v >> 16) & 255) / 255,
                 blue: CGFloat((v >> 8) & 255) / 255, alpha: CGFloat(v & 255) / 255)
}

func font(_ name: String, _ size: CGFloat, weight: Double, italic: Bool) -> CTFont {
  // the italic is its own font file ("EB Garamond Italic"); asking for an italic trait alone silently stays upright
  var base = CTFontCreateWithName((italic ? name + " Italic" : name) as CFString, size, nil)
  if italic && !(CTFontCopyFamilyName(base) as String).hasPrefix(name.components(separatedBy: " ").first ?? name) { base = CTFontCreateWithName(name as CFString, size, nil) }
  let wght = NSNumber(value: 0x77676874)   // 'wght' axis of the variable fonts
  var attrs: [CFString: Any] = [kCTFontVariationAttribute: [wght: weight]]
  if italic { attrs[kCTFontTraitsAttribute] = [kCTFontSymbolicTrait: CTFontSymbolicTraits.traitItalic.rawValue] }
  let d = CTFontDescriptorCreateWithAttributes(attrs as CFDictionary)
  return CTFontCreateCopyWithAttributes(base, size, nil, d)
}

let args = CommandLine.arguments
guard args.count > 1, let data = FileManager.default.contents(atPath: args[1]),
      let spec = try? JSONDecoder().decode(Spec.self, from: data) else { fputs("bad spec\n", stderr); exit(2) }
if let dir = spec.fontsDir, let items = try? FileManager.default.contentsOfDirectory(atPath: dir) {
  for f in items where f.hasSuffix(".ttf") || f.hasSuffix(".otf") {
    CTFontManagerRegisterFontsForURL(URL(fileURLWithPath: dir).appendingPathComponent(f) as CFURL, .process, nil)
  }
}
let W = spec.width, H = spec.height, st = spec.style
let px = CGFloat(st.size) * CGFloat(H)
let sans = font(st.font ?? "Figtree", px, weight: st.weight, italic: false)
let serif = font(st.serifFont ?? "EB Garamond", px * 1.12, weight: 600, italic: !(st.serifUpright ?? false))
let space = CGColorSpace(name: CGColorSpace.sRGB)!

for fr in spec.frames {
  guard let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
  if let f = st.fill, !f.isEmpty { ctx.setFillColor(color(f)); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H)) }
  if !fr.runs.isEmpty {
    let s = NSMutableAttributedString()
    for (i, r) in fr.runs.enumerated() {
      let a: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): (r.serif ?? false) ? serif : sans,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): color(r.c)]
      s.append(NSAttributedString(string: (i > 0 && (r.sp ?? true) ? " " : "") + r.t, attributes: a))
    }
    var align = CTTextAlignment.center
    var spacing = CGFloat(-px * 0.06)
    let ps = withUnsafeMutablePointer(to: &align) { ap in withUnsafeMutablePointer(to: &spacing) { sp in
      CTParagraphStyleCreate([CTParagraphStyleSetting(spec: .alignment, valueSize: MemoryLayout<CTTextAlignment>.size, value: ap),
                              CTParagraphStyleSetting(spec: .lineSpacingAdjustment, valueSize: MemoryLayout<CGFloat>.size, value: sp)], 2) } }
    s.addAttribute(NSAttributedString.Key(kCTParagraphStyleAttributeName as String), value: ps, range: NSRange(location: 0, length: s.length))
    let fs = CTFramesetterCreateWithAttributedString(s)
    let maxW = CGFloat(st.maxWidth) * CGFloat(W)
    let sz = CTFramesetterSuggestFrameSizeWithConstraints(fs, CFRange(), nil, CGSize(width: maxW, height: CGFloat(H)), nil)
    let cy = CGFloat(H) * (1 - CGFloat(st.y))   // y is from the top; CG is bottom-up
    let rect = CGRect(x: (CGFloat(W) - maxW) / 2, y: cy - sz.height / 2, width: maxW, height: ceil(sz.height) + 2)
    let frame = CTFramesetterCreateFrame(fs, CFRange(), CGPath(rect: rect, transform: nil), nil)
    if let box = st.box, !box.isEmpty {
      let lines = CTFrameGetLines(frame) as! [CTLine]
      var origins = [CGPoint](repeating: .zero, count: lines.count)
      CTFrameGetLineOrigins(frame, CFRange(), &origins)
      ctx.setFillColor(color(box))
      for (i, l) in lines.enumerated() {
        var asc: CGFloat = 0, desc: CGFloat = 0, lead: CGFloat = 0
        let w = CGFloat(CTLineGetTypographicBounds(l, &asc, &desc, &lead))
        let pad = px * 0.42
        let r = CGRect(x: rect.minX + origins[i].x - pad, y: rect.minY + origins[i].y - desc - pad * 0.5,
                       width: w + pad * 2, height: asc + desc + pad * 1.0)
        ctx.addPath(CGPath(roundedRect: r, cornerWidth: px * 0.32, cornerHeight: px * 0.32, transform: nil)); ctx.fillPath()
      }
    } else if st.shadow ?? true {
      ctx.setShadow(offset: CGSize(width: 0, height: -px * 0.04), blur: px * 0.35, color: CGColor(gray: 0, alpha: 0.55))
    }
    CTFrameDraw(frame, ctx)
  }
  guard let img = ctx.makeImage(),
        let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: fr.file) as CFURL, UTType.png.identifier as CFString, 1, nil) else { continue }
  CGImageDestinationAddImage(dst, img, nil); CGImageDestinationFinalize(dst)
}
