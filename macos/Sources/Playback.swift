import Foundation

/// What to do with the player on this tick.
enum PlaybackAction: Equatable {
	/// Nothing to change.
	case none
	/// Stop playing and wait for the buffer to refill. The picture is frozen
	/// either way during a starve; pausing deliberately is what stops the
	/// player from resuming on the first sample that arrives and starving
	/// again a second later.
	case holdForBuffer
	/// The cushion is back. Resume at normal rate.
	case resume
	/// Run slightly fast to recover the live offset.
	case catchUp(rate: Double)
	/// Stop running fast.
	case endCatchUp
	/// The pinned rung cannot be sustained. Drop the pin and reopen the
	/// master, keeping the requested height as a ceiling.
	case dropPin
}

/// Everything the governor needs to know about the player, sampled once per
/// tick by the caller.
struct PlaybackSample {
	/// Seconds buffered ahead of the playhead, or nil if not yet known.
	var bufferedAhead: Double?
	/// Distance from the live edge in seconds, or nil if not yet known.
	var behindLive: Double?
	/// AVPlayerItem.isPlaybackBufferEmpty.
	var bufferEmpty: Bool
	/// AVPlayerItem.isPlaybackLikelyToKeepUp.
	var likelyToKeepUp: Bool
	/// The player's requested rate. Zero means paused.
	var rate: Double
	/// Whether a frame has ever been presented for this item.
	var started: Bool
	/// Whether the viewer, rather than this governor, paused playback.
	var viewerPaused: Bool
	/// Whether a single rung is currently pinned.
	var pinned: Bool
	/// Whether reopening the master is possible at all.
	var canDropPin: Bool
	/// True end-to-end latency from AVPlayerItem.currentDate(), or nil
	/// when the feed does not publish the tag or the clock is not usable.
	/// Always larger than or equal to behindLive; the difference is the
	/// CDN and packaging delay that the edge distance cannot see.
	var trueLatency: Double?
}

/// The tuning. Every value here has a counterpart in the Android build.
struct PlaybackTuning {
	/// Where the stream is meant to sit relative to the live edge. Matches
	/// TARGET_OFFSET_MS on Android and liveSyncDuration in the web player.
	var targetOffset = 18.0
	/// Seconds that must be buffered before playback resumes after a starve.
	/// Mirrors bufferForPlaybackAfterRebufferMs.
	var rebufferCushion = 5.0
	/// Waiting for that cushion cannot be unbounded: a feed that only ever
	/// trickles would never reach it, and a trickle played badly still beats a
	/// still frame.
	var stallResumeCeiling = 12.0
	/// A pinned rung that has starved this long is the suspect, not the path.
	var pinnedDegradeAfter = 8.0
	/// Matches MAX_LIVE_SPEED on Android.
	var catchUpRate = 1.1
	/// How far past the target offset to tolerate before helping.
	var catchUpTrigger = 6.0
	/// Stop helping once the offset is back within this of the target.
	var catchUpRelease = 1.5
	/// Never speed up without this much buffered: spending a cushion that is
	/// not there is how the ladder collapses.
	var catchUpMinimumBuffer = 6.0
	/// Abandon catch-up if the buffer falls this low while running fast.
	var catchUpAbortBuffer = 3.0
	/// A cap on one stretch of catch-up, so a feed whose live edge runs away
	/// from us is not watched at 1.1 forever.
	var catchUpMaxDuration = 30.0
	/// And a rest afterwards, for the same reason.
	var catchUpCooldown = 60.0
}

/// Decides, once a second, whether to hold through a starve, whether to run
/// slightly fast to recover the live offset, and whether a pinned rung has
/// stopped being worth its pin.
///
/// Holds no AppKit or AVFoundation types on purpose: the caller samples the
/// player, this decides, the caller applies. That keeps the reasoning in one
/// place and testable without a window, a network or a feed.
final class PlaybackGovernor {

	var tuning: PlaybackTuning

	/// True while playback is being held for the buffer to refill.
	private(set) var holding = false
	/// True while running at the catch-up rate.
	private(set) var catchingUp = false

	private var holdingSince = 0.0
	private var catchUpSince = 0.0
	private var catchUpBlockedUntil = -Double.greatestFiniteMagnitude

	init(tuning: PlaybackTuning = PlaybackTuning()) {
		self.tuning = tuning
	}

	/// A new item. Nothing about the previous one still applies.
	func reset() {
		holding = false
		catchingUp = false
		catchUpBlockedUntil = -Double.greatestFiniteMagnitude
	}

	/// The viewer took control. Their intent outranks anything decided here.
	func releaseHold() {
		holding = false
	}

	/// One tick. `now` is a monotonic-enough seconds value supplied by the
	/// caller, so the decisions stay a pure function of their inputs.
	func decide(_ s: PlaybackSample, now: Double) -> PlaybackAction {
		if s.viewerPaused {
			holding = false
			return endCatchUpIfNeeded(now: now, force: true)
		}

		if holding {
			// A pin that starves is the pin's fault first. Giving up the whole
			// native path over a quality preference is far too large a
			// response, and holding a still frame indefinitely is no better.
			if s.pinned, s.canDropPin, now - holdingSince > tuning.pinnedDegradeAfter {
				holding = false
				return .dropPin
			}
			let refilled = (s.bufferedAhead ?? 0) >= tuning.rebufferCushion || s.likelyToKeepUp
			if refilled || now - holdingSince > tuning.stallResumeCeiling {
				holding = false
				return .resume
			}
			return .none
		}

		// Only a genuine starve counts: the buffer is empty, the player does
		// not think it can keep up, and the measured buffer is known to be
		// thin. A nil bufferedAhead means loadedTimeRanges is empty — a
		// transient state during playlist updates that is not a starve.
		if s.started, s.rate > 0, s.bufferEmpty, !s.likelyToKeepUp, let ahead = s.bufferedAhead, ahead < 0.5 {
			holding = true
			holdingSince = now
			if catchingUp {
				catchingUp = false
				catchUpBlockedUntil = now + tuning.catchUpCooldown
			}
			return .holdForBuffer
		}

		// The item has presented a frame but the player's rate is zero, and
		// the viewer did not ask for that. The initial play() request was lost
		// — AVPlayer does this occasionally — and the fix is to ask again.
		if s.started, s.rate == 0 {
			return .resume
		}

		return steerCatchUp(s, now: now)
	}

	// MARK: - Catch-up

	private func steerCatchUp(_ s: PlaybackSample, now: Double) -> PlaybackAction {
		guard s.started, s.rate > 0,
			let ahead = s.bufferedAhead
		else {
			return endCatchUpIfNeeded(now: now, force: false)
		}

		// The true latency is the distance to the actual broadcast and
		// includes the CDN delay. The edge distance is the distance to the
		// end of the seekable range, which the framework keeps at the
		// target offset. When the true latency is available it is the more
		// meaningful number to steer on.
		let latency = s.trueLatency ?? s.behindLive
		guard let latency = latency else {
			return endCatchUpIfNeeded(now: now, force: false)
		}

		if catchingUp {
			let recovered = latency <= tuning.targetOffset + tuning.catchUpRelease
			let cushionGone = ahead < tuning.catchUpAbortBuffer
			let tooLong = now - catchUpSince > tuning.catchUpMaxDuration
			if recovered || cushionGone || tooLong {
				return endCatchUpIfNeeded(now: now, force: true)
			}
			// Already at rate. Re-asserting it every second would fight the
			// framework's own recovery for no gain.
			return .none
		}

		if now < catchUpBlockedUntil { return .none }
		if latency > tuning.targetOffset + tuning.catchUpTrigger,
			ahead >= tuning.catchUpMinimumBuffer
		{
			catchingUp = true
			catchUpSince = now
			return .catchUp(rate: tuning.catchUpRate)
		}
		return .none
	}

	private func endCatchUpIfNeeded(now: Double, force: Bool) -> PlaybackAction {
		guard catchingUp else { return .none }
		if !force { return .none }
		catchingUp = false
		catchUpBlockedUntil = now + tuning.catchUpCooldown
		return .endCatchUp
	}
}