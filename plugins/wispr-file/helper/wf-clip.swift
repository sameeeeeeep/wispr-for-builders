// wf-clip — tiny local helper for Wispr File. No network, no microphone.
//   wf-clip copy <file>...            put the files on the clipboard as files (plus image data for images)
//   wf-clip icon <file> <out.png>...  write each file's Finder icon as a 256px PNG
//   wf-clip paste                     press Cmd-V in the frontmost app (needs Accessibility for this binary)
import AppKit

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { FileHandle.standardError.write("usage: wf-clip copy|icon|paste\n".data(using: .utf8)!); exit(2) }
let rest = Array(args.dropFirst())

switch cmd {
case "copy":
    let pb = NSPasteboard.general
    pb.clearContents()
    let utis: [String: NSPasteboard.PasteboardType] = ["png": .png, "jpg": NSPasteboard.PasteboardType("public.jpeg"),
        "jpeg": NSPasteboard.PasteboardType("public.jpeg"), "gif": NSPasteboard.PasteboardType("com.compuserve.gif"),
        "tif": .tiff, "tiff": .tiff, "heic": NSPasteboard.PasteboardType("public.heic")]
    var items: [NSPasteboardItem] = []
    for p in rest {
        let url = URL(fileURLWithPath: p)
        let it = NSPasteboardItem()
        it.setString(url.absoluteString, forType: .fileURL)
        if let t = utis[url.pathExtension.lowercased()], let d = try? Data(contentsOf: url), d.count < 40_000_000 { it.setData(d, forType: t) }
        items.append(it)
    }
    print(pb.writeObjects(items) ? "ok" : "fail")
case "icon":
    var i = 0
    while i + 1 < rest.count {
        let img = NSWorkspace.shared.icon(forFile: rest[i])
        img.size = NSSize(width: 256, height: 256)
        if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: rest[i + 1]))
        }
        i += 2
    }
    print("ok")
case "paste":
    guard AXIsProcessTrusted() else { print("no-accessibility"); exit(4) }
    let src = CGEventSource(stateID: .combinedSessionState)
    let down = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: true)
    let up = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: false)
    down?.flags = .maskCommand; up?.flags = .maskCommand
    down?.post(tap: .cghidEventTap); up?.post(tap: .cghidEventTap)
    print("ok")
default:
    exit(2)
}
