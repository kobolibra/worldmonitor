import Cocoa

// Draws the launcher icon at every size macOS asks for, so the repository does
// not have to carry binary image assets that nobody can review in a diff.
//
// The mark is a capital B in the grotesque style the Bloomberg wordmark uses:
// narrow, with a flat vertical right side on each bowl, tight corner curves
// rather than semicircles, a smaller upper bowl, and squarish counters punched
// back out in the plate colour. The geometry is written in the same 108 unit
// grid the Android adaptive icon uses, so the two platforms ship the identical
// shape.

let iconBackground = NSColor(srgbRed: 0x0A / 255.0, green: 0x0C / 255.0, blue: 0x0F / 255.0, alpha: 1)
let markColor = NSColor.white

func renderPNG(pixels: Int) -> Data? {
	guard
		let rep = NSBitmapImageRep(
			bitmapDataPlanes: nil,
			pixelsWide: pixels,
			pixelsHigh: pixels,
			bitsPerSample: 8,
			samplesPerPixel: 4,
			hasAlpha: true,
			isPlanar: false,
			colorSpaceName: .deviceRGB,
			bytesPerRow: 0,
			bitsPerPixel: 0)
	else { return nil }

	rep.size = NSSize(width: pixels, height: pixels)

	NSGraphicsContext.saveGraphicsState()
	defer { NSGraphicsContext.restoreGraphicsState() }
	NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

	// Everything below is expressed in a 1024 unit design grid and scaled, so
	// the geometry stays identical at every export size.
	let u = CGFloat(pixels) / 1024.0

	// macOS icons sit inside the canvas rather than filling it.
	let inset: CGFloat = 100 * u
	let plateSide = CGFloat(pixels) - inset * 2
	let plate = NSRect(x: inset, y: inset, width: plateSide, height: plateSide)
	iconBackground.setFill()
	NSBezierPath(roundedRect: plate, xRadius: 185 * u, yRadius: 185 * u).fill()

	// Map the shared 108 unit grid onto the plate. The design grid runs top
	// down; AppKit runs bottom up, so y is flipped here and nowhere else.
	let s = plateSide / 108.0
	func gx(_ v: CGFloat) -> CGFloat { inset + v * s }
	func gy(_ v: CGFloat) -> CGFloat { inset + (108 - v) * s }

	// A rectangle in design coordinates whose two right corners are rounded.
	// A radius well below half the height is what keeps the letter grotesque
	// instead of geometric: the right side stays vertical between the curves.
	func rrect(x0: CGFloat, y0: CGFloat, x1: CGFloat, y1: CGFloat, r: CGFloat) -> NSBezierPath {
		let path = NSBezierPath()
		let radius = r * s
		let topRight = NSPoint(x: gx(x1 - r), y: gy(y0 + r))
		let bottomRight = NSPoint(x: gx(x1 - r), y: gy(y1 - r))
		path.move(to: NSPoint(x: gx(x0), y: gy(y0)))
		path.line(to: NSPoint(x: gx(x1 - r), y: gy(y0)))
		path.appendArc(
			withCenter: topRight, radius: radius,
			startAngle: 90, endAngle: 0, clockwise: true)
		path.line(to: NSPoint(x: gx(x1), y: gy(y1 - r)))
		path.appendArc(
			withCenter: bottomRight, radius: radius,
			startAngle: 0, endAngle: -90, clockwise: true)
		path.line(to: NSPoint(x: gx(x0), y: gy(y1)))
		path.close()
		return path
	}

	// Cap height 26 to 82, stem width 12, every horizontal stroke 9 thick.
	// The lower bowl reaches further right than the upper one, as it does in
	// the real letter.
	markColor.setFill()
	rrect(x0: 36, y0: 26, x1: 66, y1: 58, r: 12).fill()
	rrect(x0: 36, y0: 50, x1: 70, y1: 82, r: 13).fill()

	iconBackground.setFill()
	rrect(x0: 48, y0: 35, x1: 56.5, y1: 49, r: 5.5).fill()
	rrect(x0: 48, y0: 58, x1: 60, y1: 73, r: 6).fill()

	return rep.representation(using: .png, properties: [:])
}

let outputDir =
	CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset"

do {
	try FileManager.default.createDirectory(
		atPath: outputDir, withIntermediateDirectories: true)
} catch {
	FileHandle.standardError.write(
		Data("Could not create \(outputDir): \(error)\n".utf8))
	exit(1)
}

let variants: [(name: String, pixels: Int)] = [
	("icon_16x16.png", 16),
	("icon_16x16@2x.png", 32),
	("icon_32x32.png", 32),
	("icon_32x32@2x.png", 64),
	("icon_128x128.png", 128),
	("icon_128x128@2x.png", 256),
	("icon_256x256.png", 256),
	("icon_256x256@2x.png", 512),
	("icon_512x512.png", 512),
	("icon_512x512@2x.png", 1024),
]

for variant in variants {
	guard let data = renderPNG(pixels: variant.pixels) else {
		FileHandle.standardError.write(
			Data("Failed to render \(variant.name)\n".utf8))
		exit(1)
	}
	let url = URL(fileURLWithPath: outputDir).appendingPathComponent(variant.name)
	do {
		try data.write(to: url)
	} catch {
		FileHandle.standardError.write(
			Data("Failed to write \(variant.name): \(error)\n".utf8))
		exit(1)
	}
}

print("Wrote \(variants.count) icon variants to \(outputDir)")
