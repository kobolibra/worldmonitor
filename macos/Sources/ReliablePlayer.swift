import AVFoundation
import Foundation

/// AVPlayer accepts `play()` before an HLS item is ready, but that request is
/// not a durable autoplay contract: an item replacement or a live playlist
/// settling can leave the player ready with a zero rate. The app used to ask
/// exactly once and therefore occasionally opened on a still first frame.
///
/// This module-local name intentionally shadows AVFoundation.AVPlayer in
/// main.swift. It changes startup only: once the playhead has advanced, the
/// observer and timer are discarded, so viewer pauses and the playback
/// governor keep their existing meaning.
final class AVPlayer: AVFoundation.AVPlayer {
	private var startupStatus: NSKeyValueObservation?
	private var startupTimer: Timer?
	private var startupOrigin: CMTime?
	private var startupAttempts = 0

	override init(playerItem item: AVPlayerItem?) {
		super.init(playerItem: item)
		armStartup(for: item)
	}

	deinit {
		startupStatus?.invalidate()
		startupTimer?.invalidate()
	}

	private func armStartup(for item: AVPlayerItem?) {
		guard let item = item else { return }
		startupOrigin = item.currentTime()
		startupStatus = item.observe(\.status, options: [.initial, .new]) { [weak self, weak item] _, _ in
			DispatchQueue.main.async {
				guard let self = self, let item = item,
					self.currentItem === item, item.status == .readyToPlay
				else { return }
				self.ensureInitialPlayback()
			}
		}
		let timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
			self?.ensureInitialPlayback()
		}
		RunLoop.main.add(timer, forMode: .common)
		startupTimer = timer
	}

	private func ensureInitialPlayback() {
		guard let item = currentItem else { return }
		if item.status == .failed {
			finishStartupWatch()
			return
		}

		let now = item.currentTime()
		if let origin = startupOrigin {
			let moved = CMTimeGetSeconds(CMTimeSubtract(now, origin))
			if moved.isFinite, moved > 0.25 {
				finishStartupWatch()
				return
			}
		}

		guard item.status == .readyToPlay else { return }
		startupAttempts += 1
		if rate == 0 { playImmediately(atRate: 1.0) }
		// Eight seconds is longer than the existing six-second live-edge rescue.
		// Beyond this point the normal startup deadline owns the failure; an
		// endless autoplay timer would only fight a later deliberate pause.
		if startupAttempts >= 16 { finishStartupWatch() }
	}

	private func finishStartupWatch() {
		startupStatus?.invalidate()
		startupStatus = nil
		startupTimer?.invalidate()
		startupTimer = nil
	}
}
