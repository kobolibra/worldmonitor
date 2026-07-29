import Cocoa

// Draws the launcher icon at every size macOS asks for, so the repository does
// not have to carry binary image assets that nobody can review in a diff.
//
// The mark is a capital B built from two D shaped bowls sharing a stem, with
// the counters punched back out in the plate colour. The geometry is written in
// the same 108 unit grid the Android adaptive icon uses, so the two platforms
// ship the identical shape.

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

	// A flat left edge with a semicircular right edge, in design coordinates.
	func bowl(left: CGFloat, top: CGFloat, flatRight: CGFloat, bottom: CGFloat) -> NSBezierPath {
		let path = NSBezierPath()
		let radius = (bottom - top) / 2 * s
		let centre = NSPoint(x: gx(flatRight), y: gy((top + bottom) / 2))
		path.move(to: NSPoint(x: gx(left), y: gy(bottom)))
		path.line(to: NSPoint(x: gx(flatRight), y: gy(bottom)))
		path.appendArc(withCenter: centre, radius: radius, startAngle: -90, endAngle: 90)
		path.line(to: NSPoint(x: gx(left), y: gy(top)))
		path.close()
		return path
	}

	markColor.setFill()
	bowl(left: 35.5, top: 26, flatRight: 54.5, bottom: 52).fill()
	bowl(left: 35.5, top: 52, flatRight: 57.5, bottom: 82).fill()

	iconBackground.setFill()
	bowl(left: 45.5, top: 34, flatRight: 54.5, bottom: 44).fill()
	bowl(left: 45.5, top: 60, flatRight: 57.5, bottom: 74).fill()

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
