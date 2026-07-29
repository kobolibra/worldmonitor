import Cocoa

// Draws the launcher icon at every size macOS asks for, so the repository does
// not have to carry binary image assets that nobody can review in a diff.

let iconBackground = NSColor(srgbRed: 0x0A / 255.0, green: 0x0C / 255.0, blue: 0x0F / 255.0, alpha: 1)
let barPrimary = NSColor(srgbRed: 1.0, green: 0x6A / 255.0, blue: 0.0, alpha: 1)
let barSecondary = NSColor(srgbRed: 1.0, green: 0x9A / 255.0, blue: 0x4D / 255.0, alpha: 1)

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
	let plate = NSRect(
		x: inset, y: inset,
		width: CGFloat(pixels) - inset * 2,
		height: CGFloat(pixels) - inset * 2)
	iconBackground.setFill()
	NSBezierPath(roundedRect: plate, xRadius: 185 * u, yRadius: 185 * u).fill()

	func bar(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, color: NSColor) {
		let r: CGFloat = 58 * u
		let rect = NSRect(x: x * u, y: y * u, width: w * u, height: h * u)
		color.setFill()
		NSBezierPath(roundedRect: rect, xRadius: r, yRadius: r).fill()
	}

	// Two bars on a common baseline, echoing the page's own mark.
	bar(x: 328, y: 224, w: 144, h: 576, color: barPrimary)
	bar(x: 552, y: 224, w: 144, h: 384, color: barSecondary)

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
