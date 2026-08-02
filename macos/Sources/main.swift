import AVFoundation
import Cocoa
import WebKit

// The page is loaded from the network rather than bundled. The app is useless
// without a connection anyway, and this way every later fix to index.html
// reaches the desktop with no rebuild and no reinstall.
let homeURL = URL(string: "https://kobolibra.github.io/worldmonitor/")!
let homeHost = "kobolibra.github.io"

let backdrop = NSColor(srgbRed: 0x06 / 255.0, green: 0x07 / 255.0, blue: 0x0A / 255.0, alpha: 1)

/// Escape a string for embedding inside a JavaScript double-quoted literal.
private func jsQuote(_ s: String) -> String {
	var out = ""
	out.reserveCapacity(s.count + 16)
	for ch in s.unicodeScalars {
		switch ch {
		case "\\": out += "\\\\"
		case "\"": out += "\\\""
		case "\n": out += "\\n"
		case "\r": out += "\\r"
		case "\u{2028}": out += "\\u2028"
		case "\u{2029}": out += "\\u2029"
		default: out.unicodeScalars.append(ch)
		}
	}
	return "\"" + out + "\""
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
	WKScriptMessageHandler
{

	private var window: NSWindow!
	private var web: WKWebView!

	// Held for the lifetime of the app. Releasing this token re-enables idle
	// display sleep, so it must not be a local.
	private var awakeToken: NSObjectProtocol?

	// MARK: Native playback state
	//
	// WKWebView is WebKit, so hls.js works here - but it works the hard way.
	// Every segment is fetched in JavaScript, remuxed to fragmented MP4 in
	// JavaScript, and pushed through Media Source Extensions, which also means a
	// CORS check on the manifest and no HEVC at all. AVPlayer does none of that:
	// it hands the bytes straight to the hardware decoder, performs no CORS
	// check, and speaks HLS natively. It is the same pipeline QuickTime and
	// Safari's own video element use.
	//
	// So the picture is drawn by an AVPlayerLayer in a view underneath the web
	// view, and the web view is made transparent so the page's header, clocks,
	// menus and rail float over it. The page measures its own stage and sends
	// the rectangle across, because it is the only side that knows where the
	// picture belongs between the two bars.
	private var videoView: NSView!
	private var playerLayer: AVPlayerLayer?
	private var player: AVPlayer?
	private var item: AVPlayerItem?
	private var statsTimer: Timer?
	private var stageRect: CGRect = .zero
	private var muted = false
	private var everPlayed = false
	private var startedAt = Date()
	private var failures = 0
	private var sentTracks = false

	// MARK: The ladder
	//
	// The master playlist for the current feed, plus the individual media
	// playlist each rung is served from. Keeping the per-rung URLs is what makes
	// a picked quality mean anything here - see applyRequestedLevel.
	private var masterURL: URL?
	private var variantURLs: [Int: URL] = [:]
	/// What the page asked for: a height, or 0 for automatic.
	private var requestedHeight = 0
	/// Which rung's own playlist is currently open, or 0 for the master.
	private var pinnedHeight = 0

	// MARK: Buffering
	//
	// Left to AVFoundation, deliberately, and this is the second time that has
	// had to be learned.
	//
	// This app was measured smooth on exactly one configuration - several Mbps,
	// a few seconds buffered, under ten seconds behind live - and that
	// configuration set nothing here beyond the live offset below. Two later
	// attempts to improve on it both made it materially worse:
	//
	//   build 11  switched off automaticallyPreservesTimeOffsetFromLive, so the
	//             player rode the live edge. There is nothing past the edge to
	//             prefetch, so the throughput estimate collapsed and the ladder
	//             went with it: 400 kbps at 2.1s behind live.
	//
	//   build 12  restored the offset but also set
	//             preferredForwardBufferDuration to 24s. That reads like "be
	//             more resilient" and behaves like "prefer whichever rung fills
	//             fastest", because a standing forward-buffer requirement is a
	//             promise the adaptive logic has to keep and the bottom rung
	//             keeps it most cheaply: 24.3s buffered, still 400 kbps.
	//
	// The pattern in both is the same. Each knob was read as a statement about
	// safety and is really a statement about which rung to prefer. The framework
	// balances these against each other with far more information than this
	// process has - it can see segment timings, it cannot be told about them.
	//
	// So the only thing set is where to stand relative to the live edge, which
	// is a genuine editorial choice and not a performance hint.

	/// How far behind the live edge to sit. Matches liveSyncDuration in the web
	/// player's hls.js configuration, so both paths feel alike.
	private let targetOffset = 18.0
	/// A feed that has produced nothing at all by now is not going to.
	private let startupDeadline = 20.0

	func applicationDidFinishLaunching(_ note: Notification) {
		buildMenuBar()
		buildWebView()
		buildWindow()
		stayAwake()
		web.load(URLRequest(url: homeURL))
	}

	// MARK: - Web view

	private func buildWebView() {
		let cfg = WKWebViewConfiguration()

		// Without this the stream will not start until the user clicks, which
		// defeats the point of a dedicated app.
		cfg.mediaTypesRequiringUserActionForPlayback = []
		cfg.allowsAirPlayForMediaPlayback = true

		// Element fullscreen is off by default in WKWebView on macOS. This is
		// what the video's own control uses, so it stays enabled.
		if #available(macOS 12.3, *) {
			cfg.preferences.isElementFullscreenEnabled = true
		} else {
			cfg.preferences.setValue(true, forKey: "fullScreenEnabled")
		}

		// What a person means by fullscreen on a desktop is the window filling
		// the display, and a web view cannot resize the window it lives in.
		// Expanding an element inside the window is a different thing entirely:
		// the bars vanish and the window stays exactly where it was, which is
		// precisely the confusing half-result the page's own button produced.
		// So the page asks the shell over this channel, and the shell does what
		// the green button does.
		cfg.userContentController.add(self, name: "bbgFullscreen")
		// The second channel: everything to do with playback.
		cfg.userContentController.add(self, name: "bbgPlayer")

		// WebKit blocks the navigation on a Safe Browsing lookup before it will
		// paint. The destination here is a static file in our own repository,
		// so the check protects against nothing, while the lookup itself has to
		// reach a service that is slow or unreachable on the networks this app
		// runs on. Turning it off removes a round trip from every launch.
		cfg.preferences.isFraudulentWebsiteWarningEnabled = false

		// The default data store is persistent, which is what keeps the page's
		// stored source, quality and volume across launches - and what lets the
		// second launch reuse the cached copy of hls.js instead of refetching it.
		cfg.websiteDataStore = .default()

		web = WKWebView(frame: .zero, configuration: cfg)
		web.navigationDelegate = self
		web.uiDelegate = self
		web.allowsBackForwardNavigationGestures = false
		web.allowsMagnification = false

		// The web view has to be see-through, or it would paint over the picture
		// underneath it. The backdrop moves to the container view instead.
		//
		// The page itself is only transparent while a native player owns the
		// picture: without one it paints its own opaque background, so this is
		// safe either way.
		if #available(macOS 12.0, *) {
			web.underPageBackgroundColor = .clear
		}
		// The public property above sets the colour behind the page, but the view
		// still fills its own bounds opaquely first. This key is the long-standing
		// way to stop that, and there is no public equivalent.
		web.setValue(false, forKey: "drawsBackground")
	}

	// MARK: - Messages from the page

	func userContentController(
		_ controller: WKUserContentController, didReceive message: WKScriptMessage
	) {
		if message.name == "bbgFullscreen" {
			window.toggleFullScreen(nil)
			return
		}
		guard message.name == "bbgPlayer",
			let text = message.body as? String,
			let data = text.data(using: .utf8),
			let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
		else { return }
		handle(o)
	}

	private func handle(_ o: [String: Any]) {
		let a = (o["a"] as? String) ?? ""
		switch a {
		case "play":
			startNative(
				url: (o["url"] as? String) ?? "",
				startMuted: (o["muted"] as? Bool) ?? false)
		case "stop":
			releasePlayer()
		case "rect":
			let x = (o["x"] as? Double) ?? 0
			let y = (o["y"] as? Double) ?? 0
			let w = (o["w"] as? Double) ?? 0
			let h = (o["h"] as? Double) ?? 0
			// A web view measures from the top left and AppKit from the bottom
			// left. Getting this wrong does not look wrong - it looks like the
			// picture is merely in the wrong place - so it is done in one line,
			// here, and nowhere else. Points, not pixels: a WKWebView's CSS pixel
			// is one point, and AppKit handles the backing scale itself.
			let host = window?.contentView?.bounds.height ?? 0
			stageRect = CGRect(x: x, y: host - (y + h), width: w, height: h)
			applyRect()
		case "mute":
			setMuted((o["on"] as? Bool) ?? false)
		case "toggle":
			guard let p = player else { return }
			if p.rate == 0 { p.play() } else { p.pause() }
		case "live":
			jumpToLive()
		case "level":
			applyLevel((o["h"] as? Int) ?? Int((o["h"] as? Double) ?? -1))
		case "volume":
			if let v = o["v"] as? Double { player?.volume = Float(max(0, min(1, v))) }
		default:
			break
		}
	}

	// MARK: - Messages to the page

	private func send(_ payload: [String: Any]) {
		guard let web = web,
			let data = try? JSONSerialization.data(withJSONObject: payload),
			let text = String(data: data, encoding: .utf8)
		else { return }
		let js = "if(window.__bbgNativeEvent)window.__bbgNativeEvent(\(jsQuote(text)));"
		web.evaluateJavaScript(js, completionHandler: nil)
	}

	// MARK: - Native playback

	/// A new feed. Everything about the previous one - its ladder, its pinned
	/// rung - stops applying here.
	private func startNative(url: String, startMuted: Bool) {
		guard let u = URL(string: url) else {
			send(["t": "fallback"])
			return
		}
		masterURL = u
		variantURLs = [:]
		pinnedHeight = 0
		sentTracks = false
		// requestedHeight deliberately survives: a quality the viewer chose is a
		// standing preference, not something to forget because they changed feed.
		open(u, startMuted: startMuted)
		fetchVariants(u)
	}

	/// Point the player at one playlist - the master, or a single rung's own.
	private func open(_ u: URL, startMuted: Bool) {
		releasePlayer()

		muted = startMuted
		everPlayed = false
		startedAt = Date()

		let asset = AVURLAsset(url: u)
		let playerItem = AVPlayerItem(asset: asset)

		// Take up position behind the live edge and hold it.
		//
		// Holding it is not free - recovering lost time means playing slightly
		// faster or skipping, and both spend buffer - which is why build 11
		// switched it off. That was backwards. The alternative to occasionally
		// spending the cushion is not keeping it, it is never having one: without
		// this the player drifts up to the live edge and stays there, with
		// nothing ahead of it to hold and nothing to prefetch into.
		playerItem.automaticallyPreservesTimeOffsetFromLive = true
		playerItem.configuredTimeOffsetFromLive =
			CMTime(seconds: targetOffset, preferredTimescale: 600)

		// preferredForwardBufferDuration is deliberately not set here. See the
		// buffering note above: it does not mean "be safer", it means "prefer the
		// rung that fills fastest", and it pinned this feed to 400 kbps.

		// If a height was picked but this playlist is the master - because the
		// ladder has not been read yet - a ceiling is at least better than
		// nothing until applyRequestedLevel can do the real thing.
		if requestedHeight > 0, pinnedHeight == 0 {
			playerItem.preferredMaximumResolution =
				CGSize(width: 0, height: CGFloat(requestedHeight))
		}

		let p = AVPlayer(playerItem: playerItem)
		p.isMuted = muted
		p.volume = 1

		// Start on the first frame available rather than holding out for a
		// cushion first.
		//
		// Build 11 set this to true, reasoning that a setting which never stops
		// applying is not a faster-startup setting but a permanent stall setting.
		// The reasoning is sound and the conclusion was still wrong: false is
		// what this app was measured smooth on, at several Mbps with a healthy
		// buffer. Whatever latitude the framework takes with it, on this path it
		// uses it well. A measurement outranks a theory about a measurement.
		p.automaticallyWaitsToMinimizeStalling = false

		let layer = AVPlayerLayer(player: p)
		// Never crop. The graphics package on this channel lives at the edges of
		// the frame: filling the box would cut off the ticker and the news band.
		layer.videoGravity = .resizeAspect
		layer.backgroundColor = NSColor.clear.cgColor
		videoView.layer?.sublayers?.forEach { $0.removeFromSuperlayer() }
		videoView.layer?.addSublayer(layer)

		player = p
		item = playerItem
		playerLayer = layer
		videoView.isHidden = false
		applyRect()

		send(["t": "loading", "msg": "\u{6b63}\u{5728}\u{8fde}\u{63a5} Bloomberg \u{76f4}\u{64ad}\u{2026}"])
		p.play()
		startStats()
	}

	private func releasePlayer() {
		stopStats()
		player?.pause()
		playerLayer?.removeFromSuperlayer()
		playerLayer = nil
		player = nil
		item = nil
		videoView?.isHidden = true
	}

	private func setMuted(_ on: Bool) {
		muted = on
		player?.isMuted = on
	}

	private func jumpToLive() {
		guard let it = item, let end = it.seekableTimeRanges.last?.timeRangeValue.end else { return }
		player?.seek(to: end, toleranceBefore: .zero, toleranceAfter: .positiveInfinity)
		player?.play()
	}

	// MARK: - Quality

	/// A picked height, or -1 for automatic.
	private func applyLevel(_ h: Int) {
		requestedHeight = h > 0 ? h : 0
		applyRequestedLevel()
	}

	/// Honour the current pick.
	///
	/// The obvious route is preferredMaximumResolution, and it is not enough.
	/// That property is a ceiling, AVFoundation publishes no floor to go with
	/// it, and so a 1080p pick forbids nothing at all below 1080p: the adaptive
	/// logic remains free to sit on the bottom rung and be entirely compliant.
	///
	/// So the pick is enforced one level down instead. A master playlist names a
	/// separate media playlist for every rung; opening the chosen rung's own
	/// playlist gives the player a ladder with a single step on it, and there is
	/// no lower rung in existence to fall to. Automatic reopens the master and
	/// adapts across all of them as before.
	///
	/// Android has always worked this way - it constrains setMinVideoSize and
	/// setMaxVideoSize to the same height, which leaves one eligible track - so
	/// this also brings the two ends into agreement.
	///
	/// The cost is honest and intended: a pinned rung the network cannot sustain
	/// will stall instead of quietly degrading, and changing rungs costs a short
	/// reconnect because it is a different URL. Automatic remains the setting
	/// that adapts.
	private func applyRequestedLevel() {
		guard let it = item else { return }

		if requestedHeight > 0 {
			if let variant = variantURLs[requestedHeight] {
				if pinnedHeight == requestedHeight { return }
				pinnedHeight = requestedHeight
				open(variant, startMuted: muted)
			} else {
				// The ladder has not arrived, or this feed has no such rung.
				// A ceiling is the only instrument available.
				it.preferredMaximumResolution =
					CGSize(width: 0, height: CGFloat(requestedHeight))
			}
			return
		}

		if pinnedHeight != 0, let master = masterURL {
			pinnedHeight = 0
			open(master, startMuted: muted)
			return
		}
		it.preferredMaximumResolution = .zero
		it.preferredPeakBitRate = 0
	}

	// MARK: - The variant ladder
	//
	// Read out of the master playlist directly, with URLSession and a few lines
	// of parsing.
	//
	// AVFoundation does expose the rungs as AVAsset.variants, but that property
	// only exists on macOS 13 while this app deploys back to 11.0, it means an
	// async property load - structured concurrency inside a plain two-target
	// swiftc invocation with no Xcode project behind it - and it does not hand
	// back the per-rung URL that the pinning above depends on. A master playlist
	// is a text file with one line of attributes and one line of address per
	// rung. Parsing it needs no availability check and gives us both.

	private func fetchVariants(_ url: URL) {
		var request = URLRequest(url: url)
		request.timeoutInterval = 10
		let task = URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
			guard let data = data,
				let text = String(data: data, encoding: .utf8)
			else { return }
			let parsed = AppDelegate.parseMaster(text)
			if parsed.isEmpty { return }

			var list: [[String: Any]] = []
			var map: [Int: URL] = [:]
			var seen = Set<Int>()
			for v in parsed {
				if v.h <= 0 || seen.contains(v.h) { continue }
				seen.insert(v.h)
				list.append(["h": v.h, "w": v.w, "bps": v.bps])
				if let resolved = URL(string: v.uri, relativeTo: url)?.absoluteURL {
					map[v.h] = resolved
				}
			}
			if list.isEmpty { return }

			DispatchQueue.main.async {
				guard let self = self, self.player != nil, !self.sentTracks else { return }
				self.sentTracks = true
				self.variantURLs = map
				self.send(["t": "tracks", "list": list])
				// A pick restored from storage arrives before the ladder does, and
				// until now could only be applied as a ceiling. It can be done
				// properly from here.
				self.applyRequestedLevel()
			}
		}
		task.resume()
	}

	/// Every rung: its resolution and bandwidth, and the address on the line
	/// after them.
	///
	/// A media playlist carries no EXT-X-STREAM-INF lines at all, in which case
	/// this returns nothing - which is correct, and is also what happens when a
	/// pinned rung's own playlist is fetched.
	private static func parseMaster(_ text: String) -> [(h: Int, w: Int, bps: Int, uri: String)] {
		var out: [(h: Int, w: Int, bps: Int, uri: String)] = []
		var pending: (h: Int, w: Int, bps: Int)?

		for rawLine in text.components(separatedBy: .newlines) {
			let line = rawLine.trimmingCharacters(in: .whitespaces)
			if line.isEmpty { continue }

			if line.hasPrefix("#EXT-X-STREAM-INF:") {
				let attrs = String(line.dropFirst("#EXT-X-STREAM-INF:".count))
				var width = 0
				var height = 0
				var bps = 0

				// Splitting on commas is wrong in general - CODECS="a,b" contains
				// one - but every attribute needed here is unquoted, so a
				// quoted-string flag is enough to keep the pieces aligned.
				var pieces: [String] = []
				var current = ""
				var inQuotes = false
				for ch in attrs {
					if ch == "\"" {
						inQuotes = !inQuotes
						continue
					}
					if ch == ",", !inQuotes {
						pieces.append(current)
						current = ""
						continue
					}
					current.append(ch)
				}
				pieces.append(current)

				for piece in pieces {
					guard let eq = piece.firstIndex(of: "=") else { continue }
					let key = piece[piece.startIndex..<eq]
						.trimmingCharacters(in: .whitespaces).uppercased()
					let value = piece[piece.index(after: eq)...]
						.trimmingCharacters(in: .whitespaces)

					if key == "RESOLUTION" {
						let parts = value.lowercased().components(separatedBy: "x")
						if parts.count == 2 {
							width = Int(parts[0]) ?? 0
							height = Int(parts[1]) ?? 0
						}
					} else if key == "BANDWIDTH" || (key == "AVERAGE-BANDWIDTH" && bps == 0) {
						bps = Int(value) ?? bps
					}
				}

				pending = (h: height, w: width, bps: bps)
				continue
			}

			// Any other tag line. Comments and tags cannot be a rung's address.
			if line.hasPrefix("#") { continue }

			// A plain line directly after the attributes is that rung's playlist.
			if let p = pending {
				out.append((h: p.h, w: p.w, bps: p.bps, uri: line))
				pending = nil
			}
		}
		return out
	}

	// MARK: - Telemetry
	//
	// Polled rather than observed. Every figure the rail shows has to be read on
	// a timer anyway, and the same tick is the cheapest place to notice that the
	// item has failed or that nothing ever started - two conditions that would
	// otherwise need their own observers to reach the same conclusion one second
	// later.

	private func startStats() {
		stopStats()
		let t = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
			self?.tick()
		}
		RunLoop.main.add(t, forMode: .common)
		statsTimer = t
	}

	private func stopStats() {
		statsTimer?.invalidate()
		statsTimer = nil
	}

	private func tick() {
		guard let p = player, let it = item else { return }

		if it.status == .failed {
			reportError(it.error?.localizedDescription ?? "")
			return
		}
		if !everPlayed, Date().timeIntervalSince(startedAt) > startupDeadline {
			reportError("\u{8d85}\u{65f6}")
			return
		}

		let size = it.presentationSize
		if !everPlayed, size.width > 0, it.status == .readyToPlay {
			everPlayed = true
			failures = 0
			send(["t": "playing"])
		}

		var payload: [String: Any] = ["t": "stats"]

		let now = it.currentTime()
		if let loaded = it.loadedTimeRanges.last?.timeRangeValue {
			let ahead = CMTimeGetSeconds(CMTimeSubtract(CMTimeRangeGetEnd(loaded), now))
			if ahead.isFinite { payload["buf"] = max(0, ahead) }
		}
		if let seekable = it.seekableTimeRanges.last?.timeRangeValue {
			let behind = CMTimeGetSeconds(CMTimeSubtract(CMTimeRangeGetEnd(seekable), now))
			if behind.isFinite { payload["lat"] = max(0, behind) }
		}
		if let event = it.accessLog()?.events.last {
			let bps = event.indicatedBitrate > 0 ? event.indicatedBitrate : event.observedBitrate
			if bps > 0 { payload["bps"] = Int(bps) }
		}
		if size.width > 0 {
			payload["w"] = Int(size.width)
			payload["h"] = Int(size.height)
		}
		payload["muted"] = p.isMuted
		payload["paused"] = (p.rate == 0)
		send(payload)
	}

	/// One failure is bad luck on a long path and the page will retry. Two in a
	/// row on the same feed means the native decoder cannot play it, so hand the
	/// picture back to hls.js instead of retrying forever.
	private func reportError(_ detail: String) {
		stopStats()
		failures += 1
		if failures >= 2 {
			releasePlayer()
			send(["t": "fallback"])
			return
		}
		send(["t": "error", "msg": detail])
	}

	// MARK: - Geometry

	private func applyRect() {
		guard let v = videoView, stageRect.width > 1, stageRect.height > 1 else { return }
		// Layer geometry animates by default, which during a live resize shows up
		// as the picture lagging behind the window edge.
		CATransaction.begin()
		CATransaction.setDisableActions(true)
		v.frame = stageRect
		playerLayer?.frame = v.bounds
		CATransaction.commit()
	}

	// The window can also be taken fullscreen by routes the page knows nothing
	// about: the green button, the View menu, a trackpad gesture. Telling the
	// page either way is what keeps the bars, the rail label and the window in
	// agreement no matter which one was used.
	@objc private func windowEnteredFullScreen() { tellPage(cinema: true) }
	@objc private func windowLeftFullScreen() { tellPage(cinema: false) }

	private func tellPage(cinema on: Bool) {
		let js = "window.__bbgSetCinema && window.__bbgSetCinema(\(on ? "true" : "false"))"
		web.evaluateJavaScript(js, completionHandler: nil)
	}

	// MARK: - Window

	private func buildWindow() {
		let style: NSWindow.StyleMask = [
			.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView,
		]

		window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: 1280, height: 760),
			styleMask: style,
			backing: .buffered,
			defer: false)

		window.title = "Bloomberg Live"
		window.titleVisibility = .hidden
		window.titlebarAppearsTransparent = true
		window.backgroundColor = backdrop
		window.appearance = NSAppearance(named: .darkAqua)
		window.minSize = NSSize(width: 640, height: 400)
		window.isMovableByWindowBackground = true
		window.collectionBehavior.insert(.fullScreenPrimary)

		// The web view goes inside a plain container and is pinned to all four
		// edges of it, rather than being handed to the window as its content view
		// directly.
		//
		// Handing a WKWebView over as the content view looks like it should be
		// enough, and in a plain resize it is. The fullscreen transition is not a
		// plain resize: the window is swapped onto a new, larger surface, and a
		// content view that carries neither an autoresizing mask nor any
		// constraint has nothing telling it to grow with it. It keeps the old
		// 1280x760 box. AppKit measures from the bottom left, so the old box stays
		// welded to the bottom left corner and the new space above and to the
		// right is left showing the window's own backdrop - the black band that
		// appeared over and to the right of the page. Four constraints remove the
		// ambiguity for every route into a resize: the green button, the View
		// menu, a trackpad gesture, the page's own button, or dragging an edge.
		let host = NSView(frame: NSRect(x: 0, y: 0, width: 1280, height: 760))
		host.autoresizesSubviews = true
		host.wantsLayer = true
		host.layer?.backgroundColor = backdrop.cgColor

		// The picture goes in first, so the web view is drawn over it. Its frame
		// is set from the rectangle the page reports and from nowhere else, which
		// is why it carries no constraints of its own.
		videoView = NSView(frame: .zero)
		videoView.wantsLayer = true
		videoView.layer?.backgroundColor = NSColor.clear.cgColor
		videoView.isHidden = true
		host.addSubview(videoView)

		web.translatesAutoresizingMaskIntoConstraints = false
		host.addSubview(web)
		NSLayoutConstraint.activate([
			web.leadingAnchor.constraint(equalTo: host.leadingAnchor),
			web.trailingAnchor.constraint(equalTo: host.trailingAnchor),
			web.topAnchor.constraint(equalTo: host.topAnchor),
			web.bottomAnchor.constraint(equalTo: host.bottomAnchor),
		])

		window.contentView = host

		let centre = NotificationCenter.default
		centre.addObserver(
			self, selector: #selector(windowEnteredFullScreen),
			name: NSWindow.didEnterFullScreenNotification, object: window)
		centre.addObserver(
			self, selector: #selector(windowLeftFullScreen),
			name: NSWindow.didExitFullScreenNotification, object: window)

		// Restore the previous size and position if there is one, and only fall
		// back to centring when there is not.
		let restored = window.setFrameUsingName("BloombergLiveMain")
		window.setFrameAutosaveName("BloombergLiveMain")
		if !restored { window.center() }

		window.makeKeyAndOrderFront(nil)
		NSApp.activate(ignoringOtherApps: true)
	}

	// MARK: - Power

	private func stayAwake() {
		// A news channel that blanks out mid sentence is not a news channel.
		awakeToken = ProcessInfo.processInfo.beginActivity(
			options: [.idleDisplaySleepDisabled, .userInitiated],
			reason: "Playing a live video stream")
	}

	// MARK: - Menu bar

	// Built by hand because the bundle carries no nib. Without a main menu the
	// standard shortcuts, including Command Q, simply do not exist.
	private func buildMenuBar() {
		let main = NSMenu()

		let appItem = NSMenuItem()
		main.addItem(appItem)
		let appMenu = NSMenu()
		appMenu.addItem(
			withTitle: "About Bloomberg Live",
			action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
			keyEquivalent: "")
		appMenu.addItem(.separator())
		appMenu.addItem(
			withTitle: "Hide Bloomberg Live",
			action: #selector(NSApplication.hide(_:)),
			keyEquivalent: "h")
		let hideOthers = appMenu.addItem(
			withTitle: "Hide Others",
			action: #selector(NSApplication.hideOtherApplications(_:)),
			keyEquivalent: "h")
		hideOthers.keyEquivalentModifierMask = [.command, .option]
		appMenu.addItem(.separator())
		appMenu.addItem(
			withTitle: "Quit Bloomberg Live",
			action: #selector(NSApplication.terminate(_:)),
			keyEquivalent: "q")
		appItem.submenu = appMenu

		let viewItem = NSMenuItem()
		main.addItem(viewItem)
		let viewMenu = NSMenu(title: "View")
		let reload = NSMenuItem(
			title: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
		reload.target = self
		viewMenu.addItem(reload)
		let hardReload = NSMenuItem(
			title: "Reload Ignoring Cache",
			action: #selector(hardReloadPage),
			keyEquivalent: "r")
		hardReload.keyEquivalentModifierMask = [.command, .shift]
		hardReload.target = self
		viewMenu.addItem(hardReload)
		viewMenu.addItem(.separator())
		let full = NSMenuItem(
			title: "Enter Full Screen",
			action: #selector(NSWindow.toggleFullScreen(_:)),
			keyEquivalent: "f")
		full.keyEquivalentModifierMask = [.command, .control]
		viewMenu.addItem(full)
		viewItem.submenu = viewMenu

		let windowItem = NSMenuItem()
		main.addItem(windowItem)
		let windowMenu = NSMenu(title: "Window")
		windowMenu.addItem(
			withTitle: "Minimize",
			action: #selector(NSWindow.performMiniaturize(_:)),
			keyEquivalent: "m")
		windowMenu.addItem(
			withTitle: "Close",
			action: #selector(NSWindow.performClose(_:)),
			keyEquivalent: "w")
		windowItem.submenu = windowMenu

		NSApp.mainMenu = main
		NSApp.windowsMenu = windowMenu
	}

	@objc private func reloadPage() {
		web.reload()
	}

	@objc private func hardReloadPage() {
		releasePlayer()
		web.reloadFromOrigin()
	}

	// MARK: - Navigation

	// Only fires for navigations, not for subresource loads, so the hls.js
	// fetch and the stream segments are unaffected by this check.
	func webView(
		_ webView: WKWebView,
		decidePolicyFor action: WKNavigationAction,
		decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
	) {
		guard let url = action.request.url else {
			decisionHandler(.allow)
			return
		}
		if url.host?.caseInsensitiveCompare(homeHost) == .orderedSame
			|| url.scheme == "about"
		{
			decisionHandler(.allow)
			return
		}
		NSWorkspace.shared.open(url)
		decisionHandler(.cancel)
	}

	// A reload leaves an orphaned player running behind a page that no longer
	// knows about it - audible, invisible, and impossible to stop.
	func webView(_ webView: WKWebView, didStartProvisionalNavigation nav: WKNavigation!) {
		releasePlayer()
	}

	// target="_blank" would otherwise be swallowed silently.
	func webView(
		_ webView: WKWebView,
		createWebViewWith configuration: WKWebViewConfiguration,
		for action: WKNavigationAction,
		windowFeatures: WKWindowFeatures
	) -> WKWebView? {
		if let url = action.request.url { NSWorkspace.shared.open(url) }
		return nil
	}

	// MARK: - Lifecycle

	func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool {
		return true
	}

	func applicationShouldHandleReopen(
		_ app: NSApplication, hasVisibleWindows flag: Bool
	) -> Bool {
		if !flag { window.makeKeyAndOrderFront(nil) }
		return true
	}
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
