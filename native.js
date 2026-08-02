/* Bloomberg Live - native player bridge.

   Loaded before app.js, and inert unless the page is running inside one of our
   own shells. In a plain browser tab nothing below runs at all: there is no
   message channel to find, the function returns immediately, and app.js goes
   on using hls.js exactly as before.

   Why a native player exists at all. hls.js decodes through Media Source
   Extensions: every transport stream segment is fetched by JavaScript,
   remuxed to fragmented MP4 in JavaScript, and only then handed to the
   decoder. That pipeline is subject to the same origin policy, it cannot play
   HEVC in Chrome or in an Android WebView, and the remux itself costs real
   work on every segment - which is why the picture holds up worse here than in
   a set-top box application playing the identical feed.

   AVPlayer on macOS and ExoPlayer on Android have none of those problems. They
   hit the hardware decoder directly, they perform no CORS check, and they speak
   HLS natively. So inside the two shells the picture is handed to them, and the
   page keeps everything else: the header, the clocks, the source and quality
   menus, the telemetry rail, the remote navigation.

   The division of labour:

     page  -> shell   play / stop / level / mute / toggle / live / rect
     shell -> page    loading / playing / tracks / stats / error / fallback

   The picture is positioned by the page, not by the shell. The page is the
   only side that knows where the stage sits between the two bars, and getting
   this wrong is what previously left the image floating in a corner with black
   around it, so the stage rectangle is measured in CSS pixels and sent over
   whenever it changes.

   Every shell keeps a way out. If the native player cannot open the feed it
   sends "fallback", this layer switches itself off for the rest of the
   session, and app.js restarts the same source through hls.js - but only when
   that source is one hls.js could ever play. Falling back onto a feed the
   browser engine cannot decode is not a fallback, it is a retry loop. */
(function(){
	"use strict";

	/* A source that this file used to add has been withdrawn (see EXTRA below).
	   Anyone who selected it still has that choice sitting in local storage, and
	   app.js reads it a moment from now, so retire the stored value here - before
	   app.js runs - instead of leaving it to resolve to a source that no longer
	   exists. Cheap, idempotent, and it runs on every path including the ones
	   that return early below. */
	try{
		if(localStorage.getItem("bbg.source") === "tvplus"){
			localStorage.setItem("bbg.source", "asia");
		}
	}catch(e){}

	/* ---------- Say what was found, and what happened ----------
	   This layer used to disappear without a word when it found no channel, and
	   that silence cost real time: a package that predates the player and a
	   current one produce exactly the same page - no message, no way to tell from
	   the outside which one is installed. A component that can switch itself off
	   has to leave a record of having done so.

	   Two lines are kept. The first names the shell that was found; the second
	   says what the native player then did. Between them, "never started",
	   "running" and "gave up and why" stop being indistinguishable.

	   They go in the source popover footer, because that is where somebody
	   wondering what the app is doing with the picture will already be. app.js
	   only ever rewrites the list inside that popover, never the footer, so these
	   survive the menu being rebuilt. */
	function footLine(cls, txt){
		try{
			var foot = document.querySelector("#sMenu .q-foot");
			if(!foot) return;
			var el = foot.querySelector("." + cls);
			if(!el){
				el = document.createElement("div");
				el.className = cls;
				el.style.marginTop = "7px";
				el.style.opacity = ".85";
				foot.appendChild(el);
			}
			el.textContent = txt;
		}catch(e){}
	}
	function envLine(txt){ footLine("q-env", txt); }
	function noteLine(txt){ footLine("q-note", txt); }

	/* ---------- Find a shell ---------- */
	var post = null;
	var shell = "";
	try{
		var mac = window.webkit && window.webkit.messageHandlers &&
			window.webkit.messageHandlers.bbgPlayer;
		if(mac){
			post = function(o){ try{ mac.postMessage(JSON.stringify(o)); }catch(e){} };
			shell = "mac";
		}
	}catch(e){}
	if(!post){
		try{
			var droid = window.BbgPlayer;
			if(droid && typeof droid.post === "function"){
				post = function(o){ try{ droid.post(JSON.stringify(o)); }catch(e){} };
				shell = "android";
			}
		}catch(e){}
	}

	/* Readable by anything else that needs to know, and by a person reading the
	   console. "" means a plain browser as far as this layer can tell. */
	window.__bbgShell = shell;

	if(!post){
		/* An Android WebView announces itself with a wv token. Carrying that token
		   while exposing no bridge is not an ordinary browser: it is our own shell
		   from a build that predates the player, which is worth naming outright
		   rather than describing as "no native support". */
		var inWebView = false;
		try{
			inWebView = /;\s*wv[);]/.test(navigator.userAgent || "") ||
				/\bwv\b/.test(navigator.userAgent || "");
		}catch(e){}
		envLine(inWebView
			? "\u8fd0\u884c\u73af\u5883\uff1aapp \u5185\u58f3\uff0c\u4f46\u672a\u627e\u5230\u539f\u751f\u64ad\u653e\u6865\u2014\u2014\u88c5\u7684\u4ecd\u662f\u65e7\u7248\u5b89\u88c5\u5305\uff0c\u753b\u9762\u8fd8\u5728\u8d70 hls.js\u3002"
			: "\u8fd0\u884c\u73af\u5883\uff1a\u666e\u901a\u6d4f\u89c8\u5668 \u00b7 hls.js \u89e3\u7801\u3002");
		return;
	}

	envLine(shell === "mac"
		? "\u8fd0\u884c\u73af\u5883\uff1aMac app \u00b7 \u539f\u751f\u89e3\u7801\u5df2\u5c31\u7eea\u3002"
		: "\u8fd0\u884c\u73af\u5883\uff1a\u5b89\u5353 app \u00b7 \u539f\u751f\u89e3\u7801\u5df2\u5c31\u7eea\u3002");

	var api = null;          /* handed over by app.js on the first start */
	var live = false;        /* the native player owns the picture right now */
	var dead = false;        /* a fallback happened; never try again this session */
	var tracks = [];         /* [{h,w,bps}] reported by the shell, tallest first */
	var lockedH = null;      /* the height the viewer asked for, null for auto */
	var muted = false;
	var paused = false;
	var lastRect = "";
	var startedUrl = "";     /* what the native player was last asked to open */

	/* ---------- Sources that only exist inside a shell ----------
	   Empty, deliberately, and kept as a mechanism rather than deleted.

	   The reason it exists: a hardware decoder can play things a browser engine
	   refuses - HEVC, and any edge that sends no Access-Control-Allow-Origin -
	   so a shell can legitimately offer a feed the web page cannot. The
	   television distribution of the channel,

	     https://bloomberg-bloombergtv-1-gb.samsung.wurl.com/manifest/playlist.m3u8

	   was offered here on exactly that reasoning. It does not work. hls.js could
	   not open it, which was expected and was the whole point; but AVPlayer and
	   ExoPlayer cannot open it either, from this network, which kills the
	   premise. Its manifest is reachable from a public prober, so the edge is
	   alive and simply will not serve this path - geography, or the exit address,
	   or both. Whatever the cause, an entry that cannot play on any of the three
	   engines is not a source, it is a dead end with a name, and it stayed in the
	   menu long enough to look like a defect in the app instead.

	   The native player was never the part that failed here and is not going
	   away: the reason for it was always system decoding of the official feeds,
	   which is where the picture and the smoothness actually improve.

	   If a shell-only feed is ever added again, the bar is a manifest that has
	   been observed to play on the target device - not one that merely resolves. */
	var EXTRA = [];
	function nativeOnly(url){
		for(var i = 0; i < EXTRA.length; i++){ if(EXTRA[i].url === url) return EXTRA[i]; }
		return null;
	}

	/* The page has to stop painting its own backdrop, or it would cover the
	   layer the picture is drawn on. The bars keep their own translucent
	   surfaces, so they still read against moving video.

	   The rest of this sheet is the hover control bar built below. */
	var css = document.createElement("style");
	css.textContent =
		"html.native,html.native body{background:transparent !important;}" +
		"html.native .ambient{display:none !important;}" +
		".nbar{position:absolute;left:50%;bottom:16px;z-index:6;display:flex;gap:6px;" +
		"padding:6px;border-radius:14px;border:1px solid rgba(255,255,255,.14);" +
		"background:rgba(8,10,14,.74);-webkit-backdrop-filter:blur(14px);" +
		"backdrop-filter:blur(14px);box-shadow:0 8px 26px rgba(0,0,0,.42);" +
		"opacity:0;pointer-events:none;" +
		"transform:translateX(-50%) translateY(8px);" +
		"transition:opacity .16s ease,transform .16s ease;}" +
		".screen:hover .nbar,.nbar:focus-within{opacity:1;pointer-events:auto;" +
		"transform:translateX(-50%) translateY(0);}" +
		".nbar button{appearance:none;-webkit-appearance:none;border:0;" +
		"background:transparent;color:#f4f6f8;font:inherit;font-size:12px;" +
		"letter-spacing:.02em;padding:7px 13px;border-radius:9px;cursor:pointer;}" +
		".nbar button:hover{background:rgba(255,255,255,.13);}" +
		".nbar button:active{background:rgba(255,255,255,.2);}" +
		/* A television has no pointer, the bar could never be revealed, and its
		   buttons would only add stops to the remote's path across the page. */
		"body.tv .nbar{display:none !important;}";
	document.head.appendChild(css);

	function rate(bps){
		if(!bps) return "";
		return bps >= 1000000 ? (Math.round(bps / 100000) / 10 + " Mbps")
		                      : (Math.round(bps / 1000) + " kbps");
	}

	/* ---------- Where the picture goes ----------
	   CSS pixels, measured from the stage element. The shell converts to its own
	   units: points on macOS, device pixels on Android via the ratio sent here. */
	function sendRect(){
		if(!live || !api) return;
		var r;
		try{ r = api.screen.getBoundingClientRect(); }catch(e){ return; }
		if(!r || !r.width || !r.height) return;
		var dpr = window.devicePixelRatio || 1;
		var key = [Math.round(r.left), Math.round(r.top), Math.round(r.width),
			Math.round(r.height), dpr].join(",");
		if(key === lastRect) return;
		lastRect = key;
		post({a:"rect", x:r.left, y:r.top, w:r.width, h:r.height, dpr:dpr,
			vw:window.innerWidth, vh:window.innerHeight});
	}
	window.addEventListener("resize", function(){ lastRect = ""; sendRect(); });
	/* Entering cinema mode, hiding the bars and a fullscreen transition all
	   change the stage without firing a resize, and none of them are worth
	   wiring individually. */
	setInterval(sendRect, 400);

	/* ---------- Controls on the picture ----------
	   Everything a person can do to the picture with a mouse was, until now,
	   supplied by WebKit: hover the video element and its own control bar rises
	   out of the bottom edge, with play, pause, volume and a fullscreen button.
	   Not one line of this page ever asked for that bar. It came with the
	   element.

	   Native playback empties and hides that element - deliberately, so that
	   app.js does not run a second telemetry loop and a second unmute path
	   against a decoder that is no longer playing anything - and WebKit's bar
	   goes with it. The keyboard survived, because those shortcuts are bound to
	   the document. The mouse did not, so the picture became something that can
	   only be operated by somebody who knows the shortcuts.

	   Hence two additions, both of them only in native mode:

	     - a click anywhere on the picture, handled below;
	     - this bar, which appears on hover exactly where WebKit's used to.

	   There is no scrubber on it. WebKit drew one because a video element always
	   has a timeline; a live channel has no position to seek to and nowhere to
	   seek from, which is what the LIVE button in the rail is for.

	   The buttons carry tabIndex -1 on purpose. The remote's path across this
	   page is a deliberate three-row arrangement, and silently adding two stops
	   to it would be a regression for the television in exchange for a bar the
	   television cannot even show. */
	var bar = null;
	var btnPlay = null;
	var btnMute = null;

	function barButton(label, onClick){
		var b = document.createElement("button");
		b.type = "button";
		b.tabIndex = -1;
		b.textContent = label;
		b.addEventListener("click", function(e){
			e.preventDefault();
			e.stopPropagation();
			onClick();
		});
		return b;
	}

	function buildBar(){
		if(bar || !api || !api.screen) return;
		bar = document.createElement("div");
		bar.className = "nbar";

		btnPlay = barButton("\u6682\u505c", function(){ post({a:"toggle"}); });
		btnMute = barButton("\u9759\u97f3", function(){ post({a:"mute", on: !muted}); });
		/* Deliberately the page's own fullscreen control rather than a second
		   implementation of it. That button already knows to ask the shell to
		   take the window fullscreen rather than expanding an element inside a
		   window that stays put, which was a long enough bug to earn the rule. */
		var btnFull = barButton("\u5168\u5c4f", function(){
			var f = document.getElementById("fsBtn");
			if(f) f.click();
		});

		bar.appendChild(btnPlay);
		bar.appendChild(btnMute);
		bar.appendChild(btnFull);
		api.screen.appendChild(bar);
		syncBar();
	}

	function syncBar(){
		if(btnPlay) btnPlay.textContent = paused ? "\u64ad\u653e" : "\u6682\u505c";
		if(btnMute){
			btnMute.textContent = muted
				? "\u53d6\u6d88\u9759\u97f3" : "\u9759\u97f3";
		}
	}

	/* A click on the picture itself.

	   Bound on the document in the capture phase so it runs before anything
	   app.js has on the stage. At the target node capture and bubble listeners
	   fire in registration order, so binding to the stage would put this second,
	   behind a handler already registered there - one that operates the hidden
	   video element and therefore does nothing at all. */
	document.addEventListener("click", function(e){
		if(!live || !api || !api.screen) return;
		var t = e.target;
		if(!t || !api.screen.contains(t)) return;
		/* The bar's own buttons, the retry button, and anything else genuinely
		   interactive drawn over the picture, keep their own click. */
		try{
			if(t.closest && t.closest("button,a,input,select,textarea,[role='button'],#state")) return;
		}catch(err){}
		e.preventDefault();
		e.stopPropagation();
		/* A silent picture: the first click is what everybody means by it. */
		if(muted){
			muted = false;
			post({a:"mute", on:false});
			api.screen.classList.remove("mutedState");
			syncBar();
			return;
		}
		post({a:"toggle"});
	}, true);

	/* ---------- Quality ----------
	   Built from the variants the native player actually reports, so the list is
	   the feed's real ladder rather than a guess. A pick is a cap, which is what
	   both players understand; auto hands the ladder back. */
	function markSelection(){
		var v = lockedH ? String(lockedH) : "auto";
		[].slice.call(api.qList.querySelectorAll(".q-item")).forEach(function(b){
			b.setAttribute("aria-selected", b.getAttribute("data-level") === v ? "true" : "false");
		});
		api.qMode.textContent = lockedH ? (lockedH + "p") : "\u81ea\u52a8";
		api.qSrc.textContent = lockedH ? "\u5df2\u9501\u5b9a" : "\u81ea\u9002\u5e94";
		api.qFoot.hidden = true;
	}
	function choose(h, remember){
		lockedH = (h > 0) ? h : null;
		post({a:"level", h: (h > 0) ? h : -1});
		if(remember) api.savePref((h > 0) ? String(h) : "auto");
		markSelection();
	}
	function buildQuality(){
		if(!api) return;
		if(!tracks.length){ api.qBtn.disabled = true; return; }
		var html = api.itemHtml("auto", "\u81ea\u52a8", "", "");
		tracks.forEach(function(t){
			html += api.itemHtml(String(t.h), t.h + "p",
				t.h >= 1080 ? "FHD" : (t.h >= 720 ? "HD" : ""), rate(t.bps));
		});
		api.qList.innerHTML = html;
		api.qBtn.disabled = false;
		[].slice.call(api.qList.querySelectorAll(".q-item")).forEach(function(btn){
			btn.addEventListener("click", function(e){
				e.stopPropagation();
				var v = btn.getAttribute("data-level");
				choose(v === "auto" ? -1 : parseInt(v, 10), true);
				api.closeQMenu();
				api.qBtn.focus();
			});
		});

		/* Resolve the remembered height against this feed's ladder: exact rung,
		   then the best rung below it, then auto. Never upwards. */
		var want = api.pref();
		var h = (want === "auto") ? -1 : parseInt(want, 10);
		if(h > 0){
			var best = -1, i;
			for(i = 0; i < tracks.length; i++){ if(tracks[i].h === h){ best = h; break; } }
			if(best < 0){
				for(i = 0; i < tracks.length; i++){
					if(tracks[i].h <= h && tracks[i].h > best) best = tracks[i].h;
				}
			}
			h = best;
		}
		choose(h > 0 ? h : -1, false);
	}

	/* ---------- Telemetry ----------
	   app.js stops its own loop while the video element is hidden, so the rail is
	   filled from here instead, with the same wording and the same thresholds. */
	function onStats(d){
		muted = !!d.muted;
		paused = !!d.paused;
		api.screen.classList.toggle("mutedState", muted);
		syncBar();

		api.statRate.textContent = d.bps
			? ("\u7801\u7387 " + (d.bps >= 1000000
				? (Math.round(d.bps / 100000) / 10 + " Mbps")
				: (Math.round(d.bps / 1000).toLocaleString() + " kbps")))
			: "\u7801\u7387 \u2014";

		var buf = (typeof d.buf === "number" && isFinite(d.buf)) ? d.buf : NaN;
		api.statBuf.textContent = isFinite(buf)
			? ("\u7f13\u51b2 " + buf.toFixed(1) + "s") : "\u7f13\u51b2 \u2014";
		api.statBuf.classList.toggle("thin", isFinite(buf) && buf < 4);

		var lat = (typeof d.lat === "number" && isFinite(d.lat)) ? d.lat : NaN;
		api.statLat.textContent = isFinite(lat)
			? ("\u5ef6\u8fdf " + lat.toFixed(1) + "s") : "\u5ef6\u8fdf \u2014";
		api.statLat.title = "\u5f53\u524d\u753b\u9762\u8ddd\u79bb\u76f4\u64ad\u8fb9\u7f18\u7684\u771f\u5b9e\u65f6\u95f4\u5dee\n\u539f\u751f\u89e3\u7801";

		var behind = isFinite(lat) && lat > 28;
		api.liveBtn.classList.toggle("behind", behind);
		api.liveTxt.textContent = behind ? "\u56de\u5230\u76f4\u64ad" : "LIVE";

		api.qRes.textContent = d.h ? ((d.w || "?") + "\u00d7" + d.h) : "\u2014";
		var row = api.qList.querySelector('.q-item[aria-selected="true"]');
		if(row && row.getAttribute("data-level") === "auto"){
			var cell = row.querySelector(".q-rate");
			if(cell) cell.textContent = d.h ? ("\u5f53\u524d " + d.h + "p") : "";
		}
	}

	/* ---------- Shell to page ---------- */
	window.__bbgNativeEvent = function(json){
		var d;
		try{ d = (typeof json === "string") ? JSON.parse(json) : json; }catch(e){ return; }
		if(!d || !api || !live) return;
		if(d.t === "loading"){
			api.showLoading(d.msg || "\u6b63\u5728\u8fde\u63a5 Bloomberg \u76f4\u64ad\u2026");
		} else if(d.t === "playing"){
			api.clearState();
			lastRect = "";
			sendRect();
			noteLine("\u539f\u751f\u64ad\u653e\uff1a\u6b63\u5728\u8fd0\u884c \u00b7 \u7cfb\u7edf\u89e3\u7801\u5668\u3002");
		} else if(d.t === "tracks"){
			tracks = (d.list || []).filter(function(t){ return t && t.h; })
				.sort(function(a, b){ return b.h - a.h; });
			buildQuality();
		} else if(d.t === "stats"){
			onStats(d);
		} else if(d.t === "error"){
			noteLine("\u539f\u751f\u64ad\u653e\uff1a\u62a5\u9519\u2014\u2014" + (d.msg || "\u672a\u8bf4\u660e\u539f\u56e0"));
			api.scheduleRetry("\u76f4\u64ad\u8fde\u63a5\u4e2d\u65ad", d.msg || "");
		} else if(d.t === "fallback"){
			/* The native player could not open this feed. Switch this layer off for
			   the session and hand the picture back - but only to an engine that
			   could actually play what is selected. */
			dead = true;
			live = false;
			document.documentElement.classList.remove("native");
			post({a:"stop"});
			/* WebKit's own control bar comes back with the video element, so this
			   one has to go or the picture would carry two. */
			if(bar && bar.parentNode){
				bar.parentNode.removeChild(bar);
				bar = null;
				btnPlay = null;
				btnMute = null;
			}

			var only = nativeOnly(startedUrl);
			if(only){
				/* Handing such a URL to hls.js produces an endless sequence of network
				   errors and retries - the request never even reaches a decoder - and
				   the page would sit on "network interrupted, recovering" for as long
				   as it is left open, with nothing on screen to say the chosen source
				   can never work here. Say so once and stop instead. */
				noteLine("\u539f\u751f\u64ad\u653e\uff1a" + only.name +
					" \u6253\u4e0d\u5f00\uff0c\u5df2\u505c\u6b62\u3002");
				api.showLoading("\u65e0\u6cd5\u6253\u5f00 " + only.name, "");
				api.showError(only.name +
					" \u53ea\u80fd\u7531\u7cfb\u7edf\u89e3\u7801\u5668\u64ad\u653e\uff0c\u521a\u624d\u6ca1\u80fd\u6253\u5f00\u3002\u8bf7\u5728\u300c\u4fe1\u53f7\u6e90\u300d\u91cc\u6362\u4e00\u4e2a\uff0c\u6bd4\u5982 ASIA\u3002");
				return;
			}
			noteLine("\u539f\u751f\u64ad\u653e\uff1a\u6253\u4e0d\u5f00\uff0c\u5df2\u9000\u56de hls.js\u3002");
			api.restart();
		}
	};

	/* ---------- Page to shell ---------- */
	window.__bbgNative = {
		start: function(url, handle){
			if(dead) return false;
			api = handle;
			live = true;
			startedUrl = url;
			document.documentElement.classList.add("native");
			/* Hiding the element is also what stops app.js running its own
			   telemetry loop and its own unmute path against a dead video. */
			try{
				api.video.pause();
				api.video.removeAttribute("src");
				api.video.load();
			}catch(e){}
			api.video.style.display = "none";
			tracks = [];
			lockedH = null;
			lastRect = "";
			paused = false;
			api.qBtn.disabled = true;
			api.qMode.textContent = "\u81ea\u52a8";
			api.qRes.textContent = "\u2014";
			buildBar();
			post({a:"play", url:url, muted: !api.wantSound()});
			sendRect();
			return true;
		},
		active: function(){ return live; },
		/* app.js has to know whether this layer has given up, so that it waits for
		   hls.js instead of assuming a player is already there. */
		gaveUp: function(){ return dead; },
		live: function(){ if(!live) return false; post({a:"live"}); return true; },
		togglePlay: function(){ if(!live) return false; post({a:"toggle"}); return true; },
		toggleMute: function(){ if(!live) return false; post({a:"mute", on: !muted}); return true; },
		setMuted: function(on){ if(!live) return false; post({a:"mute", on: !!on}); return true; },
		extraSources: EXTRA
	};

	/* The same fact under the name app.js already reads.

	   Its loader gate asks (NAT && !NAT.dead) to decide whether a player is
	   already standing by and hls.js therefore need not be waited for. That
	   field was never exported, so it read undefined, the negation was always
	   true, and the gate answered yes even after this layer had switched itself
	   off - at which point playHls() skipped the wait, and a fallback that
	   happened before hls.js had landed arrived at a black screen.

	   A getter rather than a copied value, because a snapshot taken here would
	   read false for the rest of the session, which is the same bug wearing a
	   different spelling. */
	try{
		Object.defineProperty(window.__bbgNative, "dead", {
			get: function(){ return dead; },
			enumerable: false,
			configurable: true
		});
	}catch(e){
		/* Neither shell is old enough for this to fail, but a plain field that is
		   at least correct at start is better than an absent one. */
		window.__bbgNative.dead = false;
	}
})();
