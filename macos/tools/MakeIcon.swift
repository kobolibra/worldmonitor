//
// Draws the app icon: a black plate with a white capital B.
//
// Earlier revisions built that B out of rounded rectangles by hand. That was
// the wrong approach in principle, not just in execution — a letter is a
// letterform, and approximating one with primitives produces something that
// reads as a shape resembling a B rather than as the letter itself. The bowls
// come out too circular, the joins land in the wrong place, and the stem
// weight never quite agrees with the horizontals.
//
// Bloomberg's mark is set in a neo-grotesque of the Helvetica family, and
// Helvetica ships with every copy of macOS. So the letter is not drawn here at
// all: the system is asked for the outline of that exact glyph and the outline
// it returns is what gets filled. The result is the real letterform, at any
// size, with no approximation anywhere in the path.
//
// Usage: makeicon <output.iconset directory>
//
import Cocoa
import CoreText

let plateColor = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
let markColor  = NSColor.white

// Cap height as a fraction of the plate. The mark is optically centred on its
// cap height rather than on the font's line box, because a line box carries
// ascender and descender room that this glyph does not use — centring on it
// would sit the B visibly high.
let capFraction: CGFloat = 56.0 / 108.0

/// Helvetica first. The fallbacks are the same family, so the letterform
/// survives even on a system with an unusual font set.
func markFont() -> NSFont {
	for name in ["Helvetica-Bold", "HelveticaNeue-Bold", "Arial-BoldMT", "ArialMT"] {
		if let f = NSFont(name: name, size: 1000) { return f }
	}
	return NSFont.boldSystemFont(ofSize: 1000)
}

/// The outline of the letter, straight from the font.
func markPath() -> CGPath? {
	let font = markFont() as CTFont
	var chars: [UniChar] = Array("B".utf16)
	var glyphs = [CGGlyph](repeating: 0, count: chars.count)
	guard CTFontGetGlyphsForCharacters(font, &chars, &glyphs, chars.count) else { return nil }
	return CTFontCreatePathForGlyph(font, glyphs[0], nil)
}

let glyph = markPath()
if glyph == nil {
	FileHandle.standardError.write("MakeIcon: could not obtain a glyph outline\n".data(using: .utf8)!)
	exit(1)
}

func renderPNG(pixels: Int) -> Data? {
	guard let rep = NSBitmapImageRep(
		bitmapDataPlanes: nil,
		pixelsWide: pixels,
		pixelsHigh: pixels,
		bitsPerSample: 8,
		samplesPerPixel: 4,
		hasAlpha: true,
		isPlanar: false,
		colorSpaceName: .deviceRGB,
		bytesPerRow: 0,
		bitsPerPixel: 0
	) else { return nil }

	guard let nsCtx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
	NSGraphicsContext.saveGraphicsState()
	NSGraphicsContext.current = nsCtx
	let ctx = nsCtx.cgContext

	ctx.setShouldAntialias(true)
	ctx.interpolationQuality = .high

	// The plate. Apple's own icons leave a margin inside the canvas and use a
	// generous corner radius; these numbers are expressed against a 1024 grid
	// so every variant is the same drawing at a different resolution.
	let u = CGFloat(pixels) / 1024.0
	let inset = 100.0 * u
	let plateRect = CGRect(
		x: inset,
		y: inset,
		width: CGFloat(pixels) - inset * 2,
		height: CGFloat(pixels) - inset * 2
	)
	ctx.setFillColor(plateColor.cgColor)
	ctx.addPath(CGPath(
		roundedRect: plateRect,
		cornerWidth: 185.0 * u,
		cornerHeight: 185.0 * u,
		transform: nil
	))
	ctx.fillPath()

	// The letter, scaled by its own ink bounds so it lands exactly on the
	// intended cap height no matter which fallback font supplied it.
	if let g = glyph {
		let box = g.boundingBoxOfPath
		if box.height > 0 && box.width > 0 {
			let target = plateRect.width * capFraction
			let k = target / box.height
			let drawnWidth = box.width * k
			let x = plateRect.midX - drawnWidth / 2 - box.minX * k
			let y = plateRect.midY - target / 2 - box.minY * k
			var t = CGAffineTransform(translationX: x, y: y).scaledBy(x: k, y: k)
			if let scaled = g.copy(using: &t) {
				ctx.setFillColor(markColor.cgColor)
				ctx.addPath(scaled)
				// Non-zero winding, which is what leaves the two counters open.
				ctx.fillPath()
			}
		}
	}

	NSGraphicsContext.restoreGraphicsState()
	return rep.representation(using: .png, properties: [:])
}

let args = CommandLine.arguments
guard args.count > 1 else {
	FileHandle.standardError.write("usage: makeicon <output.iconset>\n".data(using: .utf8)!)
	exit(2)
}
let outDir = URL(fileURLWithPath: args[1], isDirectory: true)
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

// The exact set iconutil expects.
let variants: [(String, Int)] = [
	("icon_16x16", 16),      ("icon_16x16@2x", 32),
	("icon_32x32", 32),      ("icon_32x32@2x", 64),
	("icon_128x128", 128),   ("icon_128x128@2x", 256),
	("icon_256x256", 256),   ("icon_256x256@2x", 512),
	("icon_512x512", 512),   ("icon_512x512@2x", 1024)
]

for (name, px) in variants {
	guard let data = renderPNG(pixels: px) else {
		FileHandle.standardError.write("MakeIcon: failed at \(name)\n".data(using: .utf8)!)
		exit(1)
	}
	let url = outDir.appendingPathComponent(name + ".png")
	do {
		try data.write(to: url)
	} catch {
		FileHandle.standardError.write("MakeIcon: cannot write \(url.path)\n".data(using: .utf8)!)
		exit(1)
	}
}

print("MakeIcon: wrote \(variants.count) variants to \(outDir.path) using \(markFont().fontName)")
