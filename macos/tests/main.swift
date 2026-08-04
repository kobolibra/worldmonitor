import Foundation

var failures = 0
func check(_ label: String, _ actual: PlaybackAction, _ expected: PlaybackAction) {
	if actual == expected { print("ok    \(label)") }
	else { print("FAIL  \(label): expected \(expected), got \(actual)"); failures += 1 }
}
func check(_ label: String, _ actual: CushionDecision, _ expected: CushionDecision) {
	if actual == expected { print("ok    \(label)") }
	else { print("FAIL  \(label): expected \(expected), got \(actual)"); failures += 1 }
}
func check(_ label: String, _ actual: StationDecision, _ expected: StationDecision) {
	if actual == expected { print("ok    \(label)") }
	else { print("FAIL  \(label): expected \(expected), got \(actual)"); failures += 1 }
}
func check(_ label: String, _ passed: Bool) {
	if passed { print("ok    \(label)") }
	else { print("FAIL  \(label)"); failures += 1 }
}
func sample(ahead: Double? = 10, behind: Double? = 18, empty: Bool = false,
	keepUp: Bool = true, rate: Double = 1, started: Bool = true,
	viewerPaused: Bool = false, pinned: Bool = false, canDropPin: Bool = true,
	bitrate: Double? = nil) -> PlaybackSample {
	PlaybackSample(bufferedAhead: ahead, behindLive: behind, bufferEmpty: empty,
		likelyToKeepUp: keepUp, rate: rate, started: started,
		viewerPaused: viewerPaused, pinned: pinned, canDropPin: canDropPin,
		bitrate: bitrate)
}

let tuning = PlaybackTuning()
print("target \(tuning.targetOffset)s, resume cushion \(tuning.rebufferCushion)s, catch-up \(tuning.catchUpRate)x")
print("cushion \(tuning.targetOffset - tuning.cushionHeadroom)s after \(tuning.cushionSettleDelay)s, floor \(tuning.cushionBitrateFloor)")
print("station: under \(tuning.stationFloor)s behind for \(tuning.stationEvidence)s, cooldown \(tuning.stationCooldown)s\n")

do { let g=PlaybackGovernor(); check("a healthy tick changes nothing",g.decide(sample(),now:0),.none) }

do {
	let g=PlaybackGovernor()
	check("an empty buffer holds",g.decide(sample(ahead:0,empty:true,keepUp:false),now:100),.holdForBuffer)
	check("3s buffered is not enough",g.decide(sample(ahead:3,keepUp:false),now:101),.none)
	check("the full cushion resumes",g.decide(sample(ahead:5,keepUp:false),now:102),.resume)
	check("and the hold is over",!g.holding)
}

do {
	let g=PlaybackGovernor(); _=g.decide(sample(ahead:0,empty:true,keepUp:false),now:200)
	check("still holding at 11s",g.decide(sample(ahead:1,keepUp:false),now:211),.none)
	check("the ceiling gives up and plays",g.decide(sample(ahead:1,keepUp:false),now:213),.resume)
}

do {
	let g=PlaybackGovernor()
	check("a viewer's pause is left alone",g.decide(sample(ahead:0,empty:true,keepUp:false,rate:0,viewerPaused:true),now:300),.none)
	check("and is never held",!g.holding)
}

// Regression: this is the exact state behind “switch to Native, then press
// Space once”. The item has a presentation size and main.swift has marked it
// started, but AVPlayer's early play() request left rate at zero.
do {
	let g=PlaybackGovernor()
	check("a lost native autoplay request resumes",g.decide(sample(rate:0,started:true),now:350),.resume)
	check("the resume does not create a hold",!g.holding)
}

do {
	let g=PlaybackGovernor()
	check("a starve before the first frame is not a starve",g.decide(sample(ahead:0,empty:true,keepUp:false,started:false),now:400),.none)
}

do {
	let g=PlaybackGovernor()
	check("30s behind starts the catch-up",g.decide(sample(behind:30),now:500),.catchUp(rate:1.1))
	check("the rate is not re-asserted",g.decide(sample(behind:25),now:501),.none)
	check("back on target ends it",g.decide(sample(behind:19),now:505),.endCatchUp)
	check("a cooldown follows",g.decide(sample(behind:30),now:506),.none)
	check("then it may help again",g.decide(sample(behind:30),now:570),.catchUp(rate:1.1))
}

do { let g=PlaybackGovernor(); check("a thin buffer never speeds up",g.decide(sample(ahead:4,behind:40),now:600),.none); check("nothing was started",!g.catchingUp) }

do { let g=PlaybackGovernor(); _=g.decide(sample(behind:30),now:700); check("a collapsing cushion abandons it",g.decide(sample(ahead:2,behind:30),now:702),.endCatchUp) }

do { let g=PlaybackGovernor(); _=g.decide(sample(behind:60),now:800); check("still helping at 25s",g.decide(sample(behind:55),now:825),.none); check("the cap ends one stretch",g.decide(sample(behind:55),now:831),.endCatchUp) }

do {
	let g=PlaybackGovernor(); _=g.decide(sample(behind:30),now:900)
	check("a starve interrupts the catch-up",g.decide(sample(ahead:0,behind:30,empty:true,keepUp:false),now:901),.holdForBuffer)
	check("the catch-up is off",!g.catchingUp)
	check("the cushion returns",g.decide(sample(ahead:8,behind:30),now:902),.resume)
	check("but not straight back to 1.1x",g.decide(sample(behind:30),now:903),.none)
	check("only after the cooldown",g.decide(sample(behind:30),now:965),.catchUp(rate:1.1))
}

do {
	let g=PlaybackGovernor()
	check("a pinned rung starves like any other",g.decide(sample(ahead:0,empty:true,keepUp:false,pinned:true),now:1100),.holdForBuffer)
	check("a short starve is not the pin's fault",g.decide(sample(ahead:0,keepUp:false,pinned:true),now:1105),.none)
	check("a long one is",g.decide(sample(ahead:0,keepUp:false,pinned:true),now:1109),.dropPin)
	check("and the hold ends with it",!g.holding)
}

do { let g=PlaybackGovernor(); _=g.decide(sample(ahead:0,empty:true,keepUp:false,pinned:true),now:1200); check("a recovering pin is kept",g.decide(sample(ahead:6,keepUp:false,pinned:true),now:1203),.resume) }

do {
	let g=PlaybackGovernor(); _=g.decide(sample(ahead:0,empty:true,keepUp:false,pinned:true,canDropPin:false),now:1300)
	check("nowhere to fall back to, so it waits",g.decide(sample(ahead:0,keepUp:false,pinned:true,canDropPin:false),now:1309),.none)
	check("and then plays anyway",g.decide(sample(ahead:0,keepUp:false,pinned:true,canDropPin:false),now:1313),.resume)
}

do { let g=PlaybackGovernor(); _=g.decide(sample(behind:30),now:1400); _=g.decide(sample(behind:19),now:1401); g.reset(); check("reset clears the cooldown",g.decide(sample(behind:30),now:1402),.catchUp(rate:1.1)) }

do {
	var shallow=PlaybackTuning(); shallow.targetOffset=6; let g=PlaybackGovernor(tuning:shallow)
	check("12s behind a 6s target is not yet a problem",g.decide(sample(behind:11),now:1500),.none)
	check("20s behind it is",g.decide(sample(behind:20),now:1501),.catchUp(rate:1.1))
	check("and 7s ends it",g.decide(sample(behind:7),now:1502),.endCatchUp)
}

do { let g=PlaybackGovernor(); check("an unknown offset does nothing",g.decide(sample(ahead:nil,behind:nil),now:1600),.none) }

// ---- the cushion ----

do {
	let g=PlaybackGovernor()
	check("no claim before the ladder has settled",g.cushion(sample(),offset:18,now:2000),.unchanged)
	check("nor a moment too early",g.cushion(sample(),offset:18,now:2003),.unchanged)
	check("then the window less the headroom",g.cushion(sample(),offset:18,now:2004),.claim(seconds:12))
	check("and it is not restated every tick",g.cushion(sample(bitrate:3_000_000),offset:18,now:2005),.unchanged)
	check("the claim is remembered",g.cushionClaim == 12)
}

// The build 12 disaster, prevented at the source: a feed publishing a window
// too shallow to stand 18s back gets a small offset from applyLiveOffset, and
// must never be asked to prefetch more than that window can hold.
do {
	let g=PlaybackGovernor()
	_=g.cushion(sample(),offset:12,now:2100)
	check("a 12s offset leaves too little to claim",g.cushion(sample(),offset:12,now:2110),.unchanged)
	check("so nothing is claimed at all",g.cushionClaim == nil)
}

do {
	let g=PlaybackGovernor()
	_=g.cushion(sample(),offset:0,now:2200)
	check("an unmeasured window is never claimed against",g.cushion(sample(),offset:0,now:2210),.unchanged)
}

do {
	let g=PlaybackGovernor()
	check("nothing is claimed before the first frame",g.cushion(sample(started:false),offset:18,now:2300),.unchanged)
	check("nor while the viewer has paused",g.cushion(sample(viewerPaused:true),offset:18,now:2320),.unchanged)
}

do {
	let g=PlaybackGovernor()
	_=g.cushion(sample(),offset:18,now:2400)
	_=g.cushion(sample(),offset:18,now:2410)
	check("the claim stands",g.cushionClaim == 12)
	check("a brief dip is not a collapse",g.cushion(sample(bitrate:400_000),offset:18,now:2411),.unchanged)
	check("a recovery clears the suspicion",g.cushion(sample(bitrate:3_000_000),offset:18,now:2413),.unchanged)
	check("so a later dip starts over",g.cushion(sample(bitrate:400_000),offset:18,now:2414),.unchanged)
	check("and is still not a collapse",g.cushion(sample(bitrate:400_000),offset:18,now:2419),.unchanged)
	check("the claim survived",g.cushionClaim == 12)
}

do {
	let g=PlaybackGovernor()
	_=g.cushion(sample(),offset:18,now:2500)
	_=g.cushion(sample(),offset:18,now:2510)
	_=g.cushion(sample(bitrate:400_000),offset:18,now:2511)
	check("a sustained collapse withdraws the claim",g.cushion(sample(bitrate:400_000),offset:18,now:2518),.withdraw)
	check("and it is given up for good",g.cushionAbandoned)
	check("a healthy rung does not win it back",g.cushion(sample(bitrate:3_000_000),offset:18,now:2600),.unchanged)
	check("nothing is claimed again",g.cushionClaim == nil)
}

do {
	let g=PlaybackGovernor()
	_=g.cushion(sample(),offset:18,now:2700)
	_=g.cushion(sample(),offset:18,now:2710)
	check("an unknown bitrate is not evidence",g.cushion(sample(bitrate:nil),offset:18,now:2711),.unchanged)
	check("and the claim is kept",g.cushionClaim == 12)
}

do {
	let g=PlaybackGovernor()
	_=g.cushion(sample(),offset:18,now:2800)
	_=g.cushion(sample(),offset:18,now:2810)
	g.reset()
	check("a new item starts with no claim",g.cushionClaim == nil)
	check("and has to settle again",g.cushion(sample(),offset:18,now:2811),.unchanged)
	check("then claims afresh",g.cushion(sample(),offset:18,now:2816),.claim(seconds:12))
}

// ---- station keeping ----

do {
	let g=PlaybackGovernor()
	check("standing 18s back is exactly right",g.station(sample(behind:18),window:30,applied:18,now:3000),.unchanged)
	check("and 8s back is still not the edge",g.station(sample(behind:8),window:30,applied:18,now:3001),.unchanged)
}

// The build 31 report, verbatim: 600 kbps, 6.9s buffered, 0.0s behind live.
// Nothing was in force because the window was not measurable when the first
// frame arrived, and before station keeping that was permanent for the whole
// session - which is why the ladder was on the floor.
do {
	let g=PlaybackGovernor()
	let s=sample(ahead:6.9,behind:0,bitrate:600_000)
	check("riding the edge is noticed but not acted on at once",g.station(s,window:30,applied:0,now:3100),.unchanged)
	check("nor a moment too early",g.station(s,window:30,applied:0,now:3107),.unchanged)
	check("then the offset is put back",g.station(s,window:30,applied:0,now:3108),.place(offset:18))
	check("and remembered",g.stationOffset == 18)
}

// An offset is in force and the playhead is on the edge regardless, so writing
// it again is not enough - it has to be seeked back.
do {
	let g=PlaybackGovernor()
	let s=sample(behind:0.5)
	check("an ignored offset waits for evidence too",g.station(s,window:30,applied:18,now:3200),.unchanged)
	check("and then the playhead is moved",g.station(s,window:30,applied:18,now:3208),.restore(offset:18))
}

// The build 33 regression, and the reason this file's 88 passing checks did not
// catch it: the assertion here used to demand a .place, on the reasoning that a
// rescued item must not be left on the edge. That reasoning was wrong. A
// negative `applied` is not an offset that went missing, it is rescueStartup
// reporting that this feed produced no first frame with one in force - so
// hauling it back to 18s failed the item, the page reconnected, startup rescued
// it again, and the viewer got a permanent “interrupted, reconnecting” cycle.
// A low rung is watchable. That was not.
do {
	let g=PlaybackGovernor()
	let s=sample(behind:0)
	_=g.station(s,window:30,applied:-1,now:3300)
	check("a rescued feed is not hauled back",g.station(s,window:30,applied:-1,now:3310),.unchanged)
	check("and no offset is asserted behind its back",g.stationOffset == nil)
	check("even long after the evidence would have been enough",g.station(s,window:30,applied:-1,now:3380),.unchanged)
}

// A window that cannot hold the full target still gets what it can hold.
do {
	let g=PlaybackGovernor()
	_=g.station(sample(behind:0),window:20,applied:0,now:3400)
	check("a 20s window gives up 6s of headroom",g.station(sample(behind:0),window:20,applied:0,now:3408),.place(offset:14))
}

do {
	let g=PlaybackGovernor()
	_=g.station(sample(behind:0),window:8,applied:0,now:3500)
	check("an 8s window has nowhere to stand back in",g.station(sample(behind:0),window:8,applied:0,now:3520),.unchanged)
	check("so nothing is asserted",g.stationOffset == nil)
	check("an unmeasurable window is left alone",g.station(sample(behind:0),window:nil,applied:0,now:3521),.unchanged)
}

do {
	let g=PlaybackGovernor()
	_=g.station(sample(behind:0,started:false),window:30,applied:0,now:3600)
	check("before the first frame this is the startup path's job",g.station(sample(behind:0,started:false),window:30,applied:0,now:3620),.unchanged)
	_=g.station(sample(behind:0,viewerPaused:true),window:30,applied:0,now:3630)
	check("a paused viewer is never seeked",g.station(sample(behind:0,viewerPaused:true),window:30,applied:0,now:3650),.unchanged)
}

do {
	let g=PlaybackGovernor()
	_=g.station(sample(behind:nil),window:30,applied:18,now:3700)
	check("an unmeasurable distance is not evidence",g.station(sample(behind:nil),window:30,applied:18,now:3720),.unchanged)
}

// Evidence has to be continuous. A dip to the edge that recovers on its own is
// not worth a rebuffer.
do {
	let g=PlaybackGovernor()
	_=g.station(sample(behind:1),window:30,applied:18,now:3800)
	_=g.station(sample(behind:1),window:30,applied:18,now:3802)
	check("a recovery clears the evidence",g.station(sample(behind:17),window:30,applied:18,now:3803),.unchanged)
	_=g.station(sample(behind:1),window:30,applied:18,now:3804)
	check("so the clock starts over",g.station(sample(behind:1),window:30,applied:18,now:3806),.unchanged)
	check("and only then is it moved",g.station(sample(behind:1),window:30,applied:18,now:3812),.restore(offset:18))
}

// Every correction costs a refill, so they are rate limited - and standing
// evidence throughout the cooldown must not shorten it.
do {
	let g=PlaybackGovernor()
	let s=sample(behind:0)
	_=g.station(s,window:30,applied:18,now:3900)
	check("the first correction happens",g.station(s,window:30,applied:18,now:3908),.restore(offset:18))
	check("a second one is not attempted straight away",g.station(s,window:30,applied:18,now:3920),.unchanged)
	check("nor part way through the cooldown",g.station(s,window:30,applied:18,now:3950),.unchanged)
	check("nor a moment before it is up",g.station(s,window:30,applied:18,now:3997),.unchanged)
	check("but the feed is not abandoned either",g.station(s,window:30,applied:18,now:3998),.restore(offset:18))
}

do {
	let g=PlaybackGovernor()
	let s=sample(behind:0)
	_=g.station(s,window:30,applied:18,now:4000)
	_=g.station(s,window:30,applied:18,now:4008)
	g.reset()
	check("a new item forgets the correction",g.stationOffset == nil)
	_=g.station(s,window:30,applied:18,now:4009)
	check("and is not held back by the old cooldown",g.station(s,window:30,applied:18,now:4017),.restore(offset:18))
}

print("")
if failures == 0 { print("all checks passed"); exit(0) }
print("\(failures) check(s) failed"); exit(1)
