// Renders the menu-bar "cot." pill as template PNGs (black + alpha; macOS tints
// them to match the menu bar). Run from desktop/:
//   swift scripts/make-tray-icons.swift src-tauri/icons/tray
//
//   cot-on.png   filled pill, "cot." knocked out: the collector is serving
//   cot-off.png  outlined pill: stopped, starting or failed
//   cot-on-light.png, cot-off-light.png  the same in white, for Linux panels,
//                which show icons as drawn and are mostly dark
import AppKit

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let scale: CGFloat = 2            // rendered @2x; the tray shows it 18pt tall
let size = CGSize(width: 30, height: 18)

func render(filled: Bool, color: NSColor = .black, to name: String) {
    let px = CGSize(width: size.width * scale, height: size.height * scale)
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: Int(px.width), pixelsHigh: Int(px.height),
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = ctx
    let cg = ctx.cgContext
    cg.scaleBy(x: scale, y: scale)

    let inset: CGFloat = filled ? 1 : 1.5
    let pill = NSRect(x: inset, y: inset + 0.5, width: size.width - inset * 2, height: size.height - inset * 2 - 1)
    let path = NSBezierPath(roundedRect: pill, xRadius: pill.height / 2, yRadius: pill.height / 2)
    color.set()
    if filled { path.fill() } else { path.lineWidth = 1.4; path.stroke() }

    let base = NSFont(name: "Georgia-BoldItalic", size: 10.5) ?? .boldSystemFont(ofSize: 10.5)
    let attrs: [NSAttributedString.Key: Any] = [.font: base, .foregroundColor: color]
    let text = NSAttributedString(string: "cot.", attributes: attrs)
    let bounds = text.size()
    let origin = NSPoint(x: (size.width - bounds.width) / 2, y: (size.height - bounds.height) / 2 + 0.5)
    if filled { cg.setBlendMode(.clear) }
    text.draw(at: origin)

    NSGraphicsContext.restoreGraphicsState()
    let data = rep.representation(using: .png, properties: [:])!
    try! data.write(to: URL(fileURLWithPath: outDir).appendingPathComponent(name))
}

render(filled: true, to: "cot-on.png")
render(filled: false, to: "cot-off.png")
render(filled: true, color: .white, to: "cot-on-light.png")
render(filled: false, color: .white, to: "cot-off-light.png")
print("wrote \(outDir)/cot-on.png, cot-off.png, cot-on-light.png, cot-off-light.png")
