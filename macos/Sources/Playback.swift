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

/// What to ask of the forward buffer on this tick.
///
/// Kept apart from PlaybackAction deliberately. Those are mutually exclusive
/// moves - the player is either holding or catching up, never both - whereas
/// how much to prefetch is a standing request that coexists with all of them.
enum CushionDecision: Equatable {
	case unchanged
	case claim(seconds: Double)
	case withdraw
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
	/// The rung actually being delivered, in bits per second, when known. Only
	/// the cushion policy reads it: it is the one signal that says whether a
	/// standing buffer request has cost us the ladder.
	var bitrate: Double? = nil
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

	// MARK: The cushion
	//
	// How much playable video to keep ahead of the playhead. Android asks for
	// 20s through DefaultLoadControl and the web path for up to 40s through
	// maxBufferLength; this path asked for nothing and was measured holding 2s,
	// which is the whole reason a jitter spike a television rides through is a
	// visible stall on the desktop.
	//
	// Asking for it here has failed once, and the arithmetic of that failure is
	// the reason these numbers are shaped the way they are. Build 12 requested
	// 24s of forward buffer while the playhead stands 18s behind the live edge.
	// There are never 24 seconds of media between a playhead and an edge only 18
	// seconds away, so the request could not be satisfied at any bitrate - and a
	// buffer requirement that cannot be satisfied is most cheaply approached by
	// the bottom rung, forever. The feed sat at 400 kbps.
	//
	// A claim strictly inside the window does not have that property: it can
	// actually be met, and once met the adaptive logic is free again. So the
	// claim is the offset less some headroom, never a constant, and it is only
	// made once the ladder has had a moment to settle - a requirement stated
	// while the throughput estimate is still forming is the other half of what
	// went wrong.
	//
	// And because that is a theory about a framework rather than a measurement
	// of one, it carries its own escape hatch: a delivered bitrate under the
	// floor for long enough withdraws the claim for the rest of the session. If
	// the reasoning above is wrong, the app returns to trickling 2s ahead rather
	// than pinning itself to the bottom rung.

	/// Left unclaimed between the cushion and the live edge, because the segment
	/// at the edge is still being published.
	var cushionHeadroom = 6.0
	/// A claim smaller than this buys too little to be worth stating.
	var cushionMinimum = 8.0
	/// How long the ladder gets to settle before any claim is made.
	var cushionSettleDelay = 4.0
	/// Below this, the ladder is suspected of having collapsed.
	var cushionBitrateFloor = 800_000.0
	/// For how long, before the claim is blamed and withdrawn.
	var cushionCollapseAfter = 6.0
}

/// Pure playback policy: the caller samples AVPlayer, this decides, the caller applies.
final class PlaybackGovernor {
	var tuning: PlaybackTuning
	private(set) var holding = false
	private(set) var catchingUp = false
	private var holdingSince = 0.0
	private var catchUpSince = 0.0
	private var catchUpBlockedUntil = -Double.greatestFiniteMagnitude

	/// The forward buffer currently being asked for, if any.
	private(set) var cushionClaim: Double?
	/// Set once the claim has been blamed for a collapsed ladder. Never unset
	/// for the life of this item: one withdrawal is a diagnosis, a second claim
	/// after it would be an oscillation.
	private(set) var cushionAbandoned = false
	private var startedSince: Double?
	private var lowBitrateSince: Double?

	init(tuning: PlaybackTuning = PlaybackTuning()) { self.tuning = tuning }

	func reset() {
		holding = false
		catchingUp = false
		catchUpBlockedUntil = -Double.greatestFiniteMagnitude
		cushionClaim = nil
		cushionAbandoned = false
		startedSince = nil
		lowBitrateSince = nil
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

	/// How much to prefetch, given how far behind the edge we are standing.
	///
	/// `offset` is the offset actually in force on this item, not the target: a
	/// feed whose window is too shallow to carry one gets no claim at all, which
	/// is exactly the case where a claim would be unsatisfiable and would cost
	/// the ladder.
	func cushion(_ s: PlaybackSample, offset: Double, now: Double) -> CushionDecision {
		if cushionAbandoned { return .unchanged }
		// Nothing to prefetch into before the first frame, and a paused viewer is
		// not waiting on the network.
		guard s.started, !s.viewerPaused else { return .unchanged }
		if startedSince == nil { startedSince = now }

		if cushionClaim == nil {
			guard let since = startedSince,
				now - since >= tuning.cushionSettleDelay
			else { return .unchanged }
			let room = offset - tuning.cushionHeadroom
			guard offset > 0, room >= tuning.cushionMinimum else { return .unchanged }
			cushionClaim = room
			return .claim(seconds: room)
		}

		// The claim is standing. The only question left is whether it cost us the
		// ladder, and an unknown bitrate is not evidence that it did.
		guard let bps = s.bitrate else { return .unchanged }
		if bps >= tuning.cushionBitrateFloor {
			lowBitrateSince = nil
			return .unchanged
		}
		if lowBitrateSince == nil { lowBitrateSince = now }
		guard let low = lowBitrateSince,
			now - low > tuning.cushionCollapseAfter
		else { return .unchanged }
		cushionClaim = nil
		cushionAbandoned = true
		lowBitrateSince = nil
		return .withdraw
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
