import Foundation

var failures = 0
func check(_ label: String, _ actual: PlaybackAction, _ expected: PlaybackAction) {
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
	trueLatency: Double? = nil) -> PlaybackSample {
	PlaybackSample(bufferedAhead: ahead, behindLive: behind, bufferEmpty: empty,
		likelyToKeepUp: keepUp, rate: rate, started: started,
		viewerPaused: viewerPaused, pinned: pinned, canDropPin: canDropPin,
		trueLatency: trueLatency)
}

let tuning = PlaybackTuning()
print("target \(tuning.targetOffset)s, rebuffer cushion \(tuning.rebufferCushion)s, catch-up \(tuning.catchUpRate)x")
print("catch-up trigger +\(tuning.catchUpTrigger)s, release within \(tuning.catchUpRelease)s, min buffer \(tuning.catchUpMinimumBuffer)s\n")

// ---- baseline ----

do { let g=PlaybackGovernor(); check("a healthy tick changes nothing",g.decide(sample(),now:0),.none) }

// ---- hold-for-buffer ----

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

// Regression: this is the exact state behind "switch to Native, then press
// Space once". The item has a presentation size and main.swift has marked it
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

// ---- catch-up ----

do {
	let g=PlaybackGovernor()
	check("30s behind starts the catch-up",g.decide(sample(behind:30),now:500),.catchUp(rate:1.1))
	check("the rate is not re-asserted",g.decide(sample(behind:25),now:501),.none)
	check("back on target ends it",g.decide(sample(behind:19),now:505),.endCatchUp)
	check("a cooldown follows",g.decide(sample(behind:30),now:506),.none)
	check("then it may help again",g.decide(sample(behind:30),now:570),.catchUp(rate:1.1))
}

do { let g=PlaybackGovernor(); check("a thin buffer never speeds up",g.decide(sample(ahead:4,behind:40),now:600),.none); check("nothing was started",!g.catchingUp) }

do { let g=PlaybackGovernor(); _=g.decide(sample(behind:30),now:700); check("a collapsing buffer abandons it",g.decide(sample(ahead:2,behind:30),now:702),.endCatchUp) }

do { let g=PlaybackGovernor(); _=g.decide(sample(behind:60),now:800); check("still helping at 25s",g.decide(sample(behind:55),now:825),.none); check("the cap ends one stretch",g.decide(sample(behind:55),now:831),.endCatchUp) }

do {
	let g=PlaybackGovernor(); _=g.decide(sample(behind:30),now:900)
	check("a starve interrupts the catch-up",g.decide(sample(ahead:0,behind:30,empty:true,keepUp:false),now:901),.holdForBuffer)
	check("the catch-up is off",!g.catchingUp)
	check("the buffer returns",g.decide(sample(ahead:8,behind:30),now:902),.resume)
	check("but not straight back to 1.1x",g.decide(sample(behind:30),now:903),.none)
	check("only after the cooldown",g.decide(sample(behind:30),now:965),.catchUp(rate:1.1))
}

// ---- drop-pin ----

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

// ---- reset ----

do { let g=PlaybackGovernor(); _=g.decide(sample(behind:30),now:1400); _=g.decide(sample(behind:19),now:1401); g.reset(); check("reset clears the cooldown",g.decide(sample(behind:30),now:1402),.catchUp(rate:1.1)) }

// ---- shallow target ----

do {
	var shallow=PlaybackTuning(); shallow.targetOffset=6; let g=PlaybackGovernor(tuning:shallow)
	check("12s behind a 6s target is not yet a problem",g.decide(sample(behind:11),now:1500),.none)
	check("20s behind it is",g.decide(sample(behind:20),now:1501),.catchUp(rate:1.1))
	check("and 7s ends it",g.decide(sample(behind:7),now:1502),.endCatchUp)
}

// ---- edge cases ----

do { let g=PlaybackGovernor(); check("an unknown offset does nothing",g.decide(sample(ahead:nil,behind:nil),now:1600),.none) }

do {
	let g=PlaybackGovernor()
	check("a transient empty buffer with keepUp is not a starve",g.decide(sample(ahead:0,empty:true,keepUp:true),now:1700),.none)
	check("the player is not held",!g.holding)
}

// ---- releaseHold ----

do {
	let g=PlaybackGovernor()
	_=g.decide(sample(ahead:0,empty:true,keepUp:false),now:1800)
	check("a hold is in place",g.holding)
	g.releaseHold()
	check("releaseHold clears it",!g.holding)
}

// ---- nil bufferedAhead ----

do {
	let g=PlaybackGovernor()
	check("a nil bufferedAhead is not a starve",g.decide(sample(ahead:nil,empty:true,keepUp:false),now:1850),.none)
	check("the player is not held",!g.holding)
}

// ---- true-latency catch-up ----

do {
	let g=PlaybackGovernor()
	// Edge distance is on target (18s) but true latency is 30s — the
	// CDN is 12s behind the broadcast. The true latency, not the edge
	// distance, should trigger the catch-up.
	check("true latency triggers catch-up",g.decide(sample(behind:18,trueLatency:30),now:1900),.catchUp(rate:1.1))
}

do {
	let g=PlaybackGovernor()
	_=g.decide(sample(behind:18,trueLatency:30),now:2000)
	check("true latency recovery ends catch-up",g.decide(sample(behind:18,trueLatency:19),now:2005),.endCatchUp)
}

// Edge distance still works when there is no true-latency signal.
do {
	let g=PlaybackGovernor()
	check("edge distance catch-up still works",g.decide(sample(behind:30),now:2100),.catchUp(rate:1.1))
}

print("")
if failures == 0 { print("all checks passed"); exit(0) }
print("\(failures) check(s) failed"); exit(1)