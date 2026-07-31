/* Bloomberg Live - native player bridge.

   Loaded before app.js, and inert unless the page is running inside one of our
   own shells. In a plain browser tab nothing below runs at all: there is no
   message channel to find, the function returns immediately, and app.js goes
   on using hls.js exactly as before.

   Why a native player exists at all. hls.js decodes through Media Source
   Extensions: every transport stream segment is fetched by JavaScript,
   remuxed to fragmented MP4 in JavaScript, and only then handed to the
   decoder. That pipeline cannot play HEVC in Chrome or in an Android WebView,
   it is subject to the same origin policy so a CDN that sends no
   Access-Control-Allow-Origin is simply unreachable, and the remux itself
   costs real work on every segment - which is why the picture holds up worse
   here than in a set-top box application playing the identical feed.

   AVPlayer on macOS and ExoPlayer on Android have none of those three
   problems. They hit the hardware decoder directly, they perform no CORS
   check, and they speak HLS natively. So inside the two shells the picture is
   handed to them, and the page keeps everything else: the header, the clocks,
   the source and quality menus, the telemetry rail, the remote navigation.

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
   session, and app.js restarts the same source through hls.js. A native path
   that fails must degrade to the old one, never to a black screen. */
(function(){
	"use strict";

	/* ---------- Find a shell ---------- */
	var post = null;
	try{
		var mac = window.webkit && window.webkit.messageHandlers &&
			window.webkit.messageHandlers.bbgPlayer;
		if(mac) post = function(o){ try{ mac.postMessage(JSON.stringify(o)); }catch(e){} };
	}catch(e){}
	if(!post){
		try{
			var droid = window.BbgPlayer;
			if(droid && typeof droid.post === "function"){
				post = function(o){ try{ droid.post(JSON.stringify(o)); }catch(e){} };
			}
		}catch(e){}
	}
	if(!post) return;

	var api = null;          /* handed over by app.js on the first start */
	var live = false;        /* the native player owns the picture right now */
	var dead = false;        /* a fallback happened; never try again this session */
	var tracks = [];         /* [{h,w,bps}] reported by the shell, tallest first */
	var lockedH = null;      /* the height the viewer asked for, null for auto */
	var muted = false;
	var lastRect = "";

	/* The page has to stop painting its own backdrop, or it would cover the
	   layer the picture is drawn on. The bars keep their own translucent
	   surfaces, so they still read against moving video. */
	var css = document.createElement("style");
	css.textContent =
		"html.native,html.native body{background:transparent !important;}" +
		"html.native .ambient{display:none !important;}";
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
		api.screen.classList.toggle("mutedState", muted);

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
		} else if(d.t === "tracks"){
			tracks = (d.list || []).filter(function(t){ return t && t.h; })
				.sort(function(a, b){ return b.h - a.h; });
			buildQuality();
		} else if(d.t === "stats"){
			onStats(d);
		} else if(d.t === "error"){
			api.scheduleRetry("\u76f4\u64ad\u8fde\u63a5\u4e2d\u65ad", d.msg || "");
		} else if(d.t === "fallback"){
			/* The native player could not open this feed. Hand the picture back to
			   hls.js rather than leaving the viewer with nothing. */
			dead = true;
			live = false;
			document.documentElement.classList.remove("native");
			post({a:"stop"});
			api.restart();
		}
	};

	/* ---------- Page to shell ---------- */
	window.__bbgNative = {
		start: function(url, handle){
			if(dead) return false;
			api = handle;
			live = true;
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
			api.qBtn.disabled = true;
			api.qMode.textContent = "\u81ea\u52a8";
			api.qRes.textContent = "\u2014";
			post({a:"play", url:url, muted: !api.wantSound()});
			sendRect();
			return true;
		},
		active: function(){ return live; },
		live: function(){ if(!live) return false; post({a:"live"}); return true; },
		togglePlay: function(){ if(!live) return false; post({a:"toggle"}); return true; },
		toggleMute: function(){ if(!live) return false; post({a:"mute", on: !muted}); return true; },
		setMuted: function(on){ if(!live) return false; post({a:"mute", on: !!on}); return true; },

		/* The television distribution of the channel. It is deliberately offered
		   only here: its top rungs are HEVC and its edge sends no CORS header, so
		   in a browser tab it is unplayable, while a hardware decoder that does no
		   CORS check handles it without noticing. This is the feed a set-top box
		   plays, and the reason one looks better than a web page. */
		extraSources: [
			{id:"tvplus", name:"TV+", note:"\u7535\u89c6\u7248 \u00b7 \u539f\u751f\u89e3\u7801",
				url:"https://bloomberg-bloombergtv-1-gb.samsung.wurl.com/manifest/playlist.m3u8"}
		]
	};
})();
