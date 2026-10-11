import AppKit

// Generate packaging artwork at build time; the source logo stays unchanged.
let output = URL(fileURLWithPath: CommandLine.arguments[1])
let logo = NSImage(contentsOfFile: CommandLine.arguments[2])!
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func render(width: Int, height: Int, scale: Int, to file: URL, draw: () -> Void) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width * scale, pixelsHigh: height * scale,
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    bitmap.size = NSSize(width: width, height: height)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    // The bitmap's logical size already gives AppKit the Retina scale.
    draw()
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: file)
}

let iconset = output.appendingPathComponent("Goodfinds.iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let suffix = scale == 1 ? "" : "@2x"
        try render(width: size, height: size, scale: scale, to: iconset.appendingPathComponent("icon_\(size)x\(size)\(suffix).png")) {
            let edge = CGFloat(size)
            let inset = edge * 0.1
            let rect = NSRect(x: inset, y: inset, width: edge - 2 * inset, height: edge - 2 * inset)
            let shape = NSBezierPath(roundedRect: rect, xRadius: edge * 0.17, yRadius: edge * 0.17)
            shape.addClip()
            NSColor.black.setFill()
            rect.fill()
            logo.draw(in: rect)
        }
    }
}
