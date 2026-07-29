import Cocoa
import WebKit

// The page is loaded from the network rather than bundled. The app is useless
// without a connection anyway, and this way every later fix to index.html
// reaches the desktop with no rebuild and no reinstall.
let homeURL = URL(string: "https://kobolibra.github.io/worldmonitor/")!
let homeHost = "kobolibra.github.io"

let backdrop = NSColor(srgbRed: 0x06 / 255.0, green: 0x07 / 255.0, blue: 0x0A / 255.0, alpha: 1)

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {

	private var window: NSWindow!
	private var web: WKWebView!

	// Held for the lifetime of the app. Releasing this token re-enables idle
	// display sleep, so it must not be a local.
	private var awakeToken: NSObjectProtocol?

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

		// Element fullscreen is off by default in WKWebView on macOS. Without
		// it the page's fullscreen button silently does nothing.
		if #available(macOS 12.3, *) {
			cfg.preferences.isElementFullscreenEnabled = true
		} else {
			cfg.preferences.setValue(true, forKey: "fullScreenEnabled")
		}

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

		if #available(macOS 12.0, *) {
			web.underPageBackgroundColor = backdrop
		}
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
		window.contentView = web
		window.collectionBehavior.insert(.fullScreenPrimary)

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
