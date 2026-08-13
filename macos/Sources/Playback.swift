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
	/// The playhead has settled onto the live edge and stayed there long
	/// enough that it is not noise. Re-declare the configured offset and
	/// seek back behind the edge. Android never loses this because
	/// setTargetOffsetMs lives on the MediaItem for its whole life; here the
	/// same property is a one-shot that a background pause or a shallow
	/// startup window can silently undo, and a playhead on the edge has
	/// nothing ahead of it to prefetch - the throughput estimate collapses
	/// and the bitrate ladder follows it down.
	case reassertOffset
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
}

/// The tuning. Every value here has a counterpart in the Android build.
struct PlaybackTuning {
	/// Where the stream is meant to sit relative to the live edge.
	///
	/// Deliberately tighter than TARGET_OFFSET_MS on Android and
	/// liveSyncDuration in the web player, both of which are still 18s. With
	/// station keeping holding the ladder at the top rung there is headroom
	/// here that those two were not measured with, and latency is the thing
	/// that headroom is worth spending on.
	///
	/// The floor on this value is not comfort, it is `stationFloor` below:
	/// a target inside that band is a target on the live edge, with nothing
	/// published ahead of the playhead to prefetch, and the throughput
	/// estimate collapses. 12 keeps a wide margin over it.
	var targetOffset = 12.0
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
	/// Behind-live distances at or under this are the live edge in practice,
	/// not real progress toward it.
	var stationFloor = 4.0
	/// How long the playhead has to sit on the edge before it counts as
	/// settled rather than a one-tick measurement blip.
	var stationEvidence = 8.0
	/// Reasserting the offset costs a seek and a refill, so it has to stay
	/// rare. Matches the spacing used while this was last measured working.
	var stationCooldown = 90.0
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
	private var stationOffSince: Double?
	private var stationBlockedUntil = -Double.greatestFiniteMagnitude

	init(tuning: PlaybackTuning = PlaybackTuning()) {
		self.tuning = tuning
	}

	/// A new item. Nothing about the previous one still applies.
	func reset() {
		holding = false
		catchingUp = false
		catchUpBlockedUntil = -Double.greatestFiniteMagnitude
		stationOffSince = nil
		stationBlockedUntil = -Double.greatestFiniteMagnitude
	}

	/// The viewer took control. Their intent outranks anything decided here.
	func releaseHold() {
		holding = false
	}

	/// Called when the app returns from the background. A pause there
	/// freezes the playhead and the caller seeks it back near the live edge
	/// on resume; station keeping must not fight that seek while the buffer
	/// re-forms around it. Without this it can reassert on the very tick the
	/// resume seek is settling and drag the playhead straight back behind the
	/// edge it was just placed at - two repositions fighting each other is
	/// exactly what one earlier round of this feature read as a stutter and a
	/// repeat of the last few seconds.
	func suppressStationKeeping(for seconds: Double, now: Double) {
		stationBlockedUntil = max(stationBlockedUntil, now + seconds)
		stationOffSince = nil
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

		// Only a genuine starve counts. An item that has not produced a frame
		// yet is the startup deadline's business, and a paused player has no
		// forward buffer requirement to fail.
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

	// MARK: - Catch-up

	private func steerCatchUp(_ s: PlaybackSample, now: Double) -> PlaybackAction {
		guard s.started, s.rate > 0,
			let behind = s.behindLive,
			let ahead = s.bufferedAhead
		else {
			return endCatchUpIfNeeded(now: now, force: false)
		}

		if catchingUp {
			let recovered = behind <= tuning.targetOffset + tuning.catchUpRelease
			let cushionGone = ahead < tuning.catchUpAbortBuffer
			let tooLong = now - catchUpSince > tuning.catchUpMaxDuration
			if recovered || cushionGone || tooLong {
				return endCatchUpIfNeeded(now: now, force: true)
			}
			// Already at rate. Re-asserting it every second would fight the
			// framework's own recovery for no gain.
			return .none
		}

		if now < catchUpBlockedUntil { return steerStation(behind: behind, now: now) }
		if behind > tuning.targetOffset + tuning.catchUpTrigger,
			ahead >= tuning.catchUpMinimumBuffer
		{
			catchingUp = true
			catchUpSince = now
			return .catchUp(rate: tuning.catchUpRate)
		}
		return steerStation(behind: behind, now: now)
	}

	/// The complement of catch-up: not "too far behind" but "not behind
	/// enough". A playhead sitting on the live edge has nothing published
	/// past it to prefetch, so the throughput estimate collapses and the
	/// ladder follows it to the bottom rung - measured, previously, as
	/// exactly this: a healthy-looking buffer, a near-zero distance to live,
	/// and 400-600 kbps. Distinct from catch-up because the fix is not a
	/// faster rate, which cannot outrun a feed that has already caught the
	/// playhead - it is a seek back behind the edge.
	private func steerStation(behind: Double, now: Double) -> PlaybackAction {
		guard now >= stationBlockedUntil else { return .none }
		guard behind <= tuning.stationFloor else {
			stationOffSince = nil
			return .none
		}
		let since = stationOffSince ?? now
		stationOffSince = since
		guard now - since >= tuning.stationEvidence else { return .none }
		stationOffSince = nil
		stationBlockedUntil = now + tuning.stationCooldown
		return .reassertOffset
	}

	private func endCatchUpIfNeeded(now: Double, force: Bool) -> PlaybackAction {
		guard catchingUp else { return .none }
		if !force { return .none }
		catchingUp = false
		catchUpBlockedUntil = now + tuning.catchUpCooldown
		return .endCatchUp
	}
}
