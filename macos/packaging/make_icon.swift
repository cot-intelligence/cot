// Generates AppIcon.icns from the cot mark — ink squircle, vermilion italic
// serif wordmark, matching public/apple-touch-icon.svg and the design language.
//
//   swift macos/packaging/make_icon.swift <output-dir>
//
// Each size is drawn at its native pixel dimensions rather than downscaled from
// one master, so the 16pt icon keeps its edges.

import AppKit
import Foundation

let ink = NSColor(srgbRed: 0x11 / 255, green: 0x11 / 255, blue: 0x11 / 255, alpha: 1)
let vermilion = NSColor(srgbRed: 1.0, green: 0x45 / 255, blue: 0, alpha: 1)

/// macOS app icons sit in a squircle inset from the canvas, so the shape lines
/// up with every other icon in the Dock.
let contentInset = 0.104
let cornerRatio = 0.2237

func drawIcon(pixels: Int) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false,
        colorSpaceName: .calibratedRGB,
        bytesPerRow: 0, bitsPerPixel: 0
    )!
    rep.size = NSSize(width: pixels, height: pixels)

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    let side = Double(pixels)
    let inset = side * contentInset
    let box = NSRect(x: inset, y: inset, width: side - inset * 2, height: side - inset * 2)
    let radius = box.width * cornerRatio

    let squircle = NSBezierPath(roundedRect: box, xRadius: radius, yRadius: radius)
    ink.setFill()
    squircle.fill()

    // A hairline lip so the mark still reads on a dark desktop background.
    vermilion.withAlphaComponent(0.28).setStroke()
    squircle.lineWidth = max(1, side * 0.006)
    squircle.stroke()

    // Sized to fill the squircle — the mark has to survive a 16pt titlebar and
    // a 16pt Finder row, not just the Dock.
    let fontSize = box.width * 0.58
    let font = NSFont(name: "Georgia-Italic", size: fontSize)
        ?? NSFont(name: "Times-Italic", size: fontSize)!
    let mark = NSAttributedString(
        string: "cot.",
        attributes: [
            .font: font,
            .foregroundColor: vermilion,
            .kern: -fontSize * 0.02,
        ]
    )

    // Optically centre on the x-height rather than the full line box, which the
    // descender-free "cot." otherwise pushes high.
    let measured = mark.size()
    let origin = NSPoint(
        x: box.midX - measured.width / 2,
        y: box.midY - measured.height / 2 + box.height * 0.05
    )
    mark.draw(at: origin)

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let outputDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let iconset = URL(fileURLWithPath: outputDir).appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

// (point size, scale) — the set `iconutil` expects.
let variants: [(Int, Int)] = [
    (16, 1), (16, 2), (32, 1), (32, 2), (128, 1),
    (128, 2), (256, 1), (256, 2), (512, 1), (512, 2),
]

for (points, scale) in variants {
    let rep = drawIcon(pixels: points * scale)
    guard let png = rep.representation(using: .png, properties: [:]) else {
        FileHandle.standardError.write("failed to encode \(points)@\(scale)x\n".data(using: .utf8)!)
        exit(1)
    }
    let suffix = scale == 1 ? "" : "@\(scale)x"
    let name = "icon_\(points)x\(points)\(suffix).png"
    try png.write(to: iconset.appendingPathComponent(name))
}

print(iconset.path)
