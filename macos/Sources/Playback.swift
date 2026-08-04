import Foundation

/// What to do with the player on this tick.
enum PlaybackAction: Equatable {
	case none
	case holdForBuffer
	case resume
	case catchUp(rate: Double)
	case endCatchUp
	case dropPin
}

/// Everything the governor needs to know about the player, sampled once per tick.
struct PlaybackSample {
	var bufferedAhead: Double?
	var behindLive: Double?
	var bufferEmpty: Bool
	var likelyToKeepUp: Bool
	var rate: Double
	var started: Bool
	var viewerPaused: Bool
	var pinned: Bool
	var canDropPin: Bool
}

/// Playback values shared with the Android and web paths where applicable.
struct PlaybackTuning {
	var targetOffset = 18.0
	var rebufferCushion = 5.0
	var stallResumeCeiling = 12.0
	var pinnedDegradeAfter = 8.0
	var catchUpRate = 1.1
	var catchUpTrigger = 6.0
	var catchUpRelease = 1.5
	var catchUpMinimumBuffer = 6.0
	var catchUpAbortBuffer = 3.0
	var catchUpMaxDuration = 30.0
	var catchUpCooldown = 60.0
}

/// Pure playback policy: the caller samples AVPlayer, this decides, the caller applies.
final class PlaybackGovernor {
	var tuning: PlaybackTuning
	private(set) var holding = false
	private(set) var catchingUp = false
	private var holdingSince = 0.0
	private var catchUpSince = 0.0
	private var catchUpBlockedUntil = -Double.greatestFiniteMagnitude

	init(tuning: PlaybackTuning = PlaybackTuning()) { self.tuning = tuning }

	func reset() {
		holding = false
		catchingUp = false
		catchUpBlockedUntil = -Double.greatestFiniteMagnitude
	}

	func releaseHold() { holding = false }

	func decide(_ s: PlaybackSample, now: Double) -> PlaybackAction {
		// A viewer pause is absolute. Nothing below may restart it.
		if s.viewerPaused {
			holding = false
			return endCatchUpIfNeeded(now: now, force: true)
		}

		if holding {
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

		// AVPlayer can accept play() before a live item is ready and then reach
		// readyToPlay with rate still at zero. main.swift marks `started` only
		// after the item has a real video presentation size and is ready, so this
		// state is no longer preparation: it is a lost initial play request. A
		// Space press fixed it only because toggleByViewer issued play() again.
		// Resume here instead. This cannot undo a deliberate pause (handled
		// above), and it cannot fight a governor hold (handled above as well).
		if s.started, s.rate == 0 {
			if catchingUp {
				catchingUp = false
				catchUpBlockedUntil = now + tuning.catchUpCooldown
			}
			return .resume
		}

		if s.started, s.rate > 0, s.bufferEmpty, (s.bufferedAhead ?? 0) < 0.5 {
			holding = true
			holdingSince = now
			if catchingUp {
				catchingUp = false
				catchUpBlockedUntil = now + tuning.catchUpCooldown
			}
			return .holdForBuffer
		}

		return steerCatchUp(s, now: now)
	}

	private func steerCatchUp(_ s: PlaybackSample, now: Double) -> PlaybackAction {
		guard s.started, s.rate > 0,
			let behind = s.behindLive,
			let ahead = s.bufferedAhead
		else { return endCatchUpIfNeeded(now: now, force: false) }

		if catchingUp {
			let recovered = behind <= tuning.targetOffset + tuning.catchUpRelease
			let cushionGone = ahead < tuning.catchUpAbortBuffer
			let tooLong = now - catchUpSince > tuning.catchUpMaxDuration
			if recovered || cushionGone || tooLong {
				return endCatchUpIfNeeded(now: now, force: true)
			}
			return .none
		}

		if now < catchUpBlockedUntil { return .none }
		if behind > tuning.targetOffset + tuning.catchUpTrigger,
			ahead >= tuning.catchUpMinimumBuffer {
			catchingUp = true
			catchUpSince = now
			return .catchUp(rate: tuning.catchUpRate)
		}
		return .none
	}

	private func endCatchUpIfNeeded(now: Double, force: Bool) -> PlaybackAction {
		guard catchingUp, force else { return .none }
		catchingUp = false
		catchUpBlockedUntil = now + tuning.catchUpCooldown
		return .endCatchUp
	}
}
