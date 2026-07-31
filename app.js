/* Bloomberg Live - player, controls, clocks.
   Split out of index.html so the two can be edited independently. */
(function(){
  "use strict";

  /* Parallel Bloomberg feeds. The L-bar graphics package is baked into the
     encoded picture, not an overlay, and nothing in the manifest declares it,
     so it has to be a choice. ASIA leads because its origin is nearest. */
  var SOURCES = [
    {id:"asia",    name:"ASIA",   note:"\u4e9a\u6d32 \u00b7 \u56de\u6e90\u6700\u8fd1", url:"https://www.bloomberg.com/media-manifest/streams/asia.m3u8"},
    {id:"phoenix", name:"US ALT", note:"\u7f8e\u4e1c \u00b7 \u5e26\u884c\u60c5\u6761", url:"https://www.bloomberg.com/media-manifest/streams/phoenix-us.m3u8"},
    {id:"us",      name:"US",     note:"\u7f8e\u56fd \u00b7 \u6570\u5b57\u7248",   url:"https://www.bloomberg.com/media-manifest/streams/us.m3u8"},
    {id:"eu",      name:"EUROPE", note:"\u6b27\u6d32\u9891\u9053",       url:"https://www.bloomberg.com/media-manifest/streams/eu.m3u8"},
    {id:"aus",     name:"AU",     note:"\u6fb3\u6d32\u9891\u9053",       url:"https://www.bloomberg.com/media-manifest/streams/aus.m3u8"}
  ];
  function sourceById(id){
    for(var si = 0; si < SOURCES.length; si++) if(SOURCES[si].id === id) return SOURCES[si];
    return SOURCES[0];
  }

  /* One time reset: the pinned era wrote an explicit 1080p into storage, which
     would be read back and re-applied as a hard lock on every load. */
  try{
    if(localStorage.getItem("bbg.pref") !== "2"){
      localStorage.removeItem("bbg.quality");
      localStorage.setItem("bbg.pref", "2");
    }
  }catch(e){}

  var currentSource = SOURCES[0];
  try{
    var savedSource = localStorage.getItem("bbg.source");
    if(savedSource) currentSource = sourceById(savedSource);
  }catch(e){}
  function streamUrl(){ return currentSource.url; }

  /* Auto by default, and auto means auto. An explicit pick is a real lock.
     Stored as a picture height, never a level index: indices belong to one
     manifest and would point at an unrelated rung on another feed. */
  var prefQuality = "auto";
  try{
    var savedQuality = localStorage.getItem("bbg.quality");
    if(savedQuality) prefQuality = savedQuality;
  }catch(e){}
  function savePref(v){
    prefQuality = v;
    try{ localStorage.setItem("bbg.quality", v); }catch(e){}
  }

  /* Sound on by default.

     The muted start was inherited from ordinary web practice, where autoplay
     with sound is refused until the page has seen a gesture, and the escape
     hatch was a click on the picture. On a television that escape hatch does
     not exist: a remote sends arrow keys, the focus ring covers the rail only,
     and the picture is not a focusable thing, so the one control that could
     restore sound was the one control a remote can never reach.

     It was also unnecessary in the two places it hurt most. The Android shell
     sets setMediaPlaybackRequiresUserGesture(false) and the macOS shell sets
     mediaTypesRequiringUserActionForPlayback to none, so both allow unmuted
     autoplay outright. Only a plain browser tab can still refuse, and that
     refusal is detectable at play time - so ask for sound first and degrade
     only if actually turned down. */
  var wantSound = true;
  try{
    if(localStorage.getItem("bbg.sound") === "0") wantSound = false;
  }catch(e){}
  /* True only when the browser, not the viewer, imposed the silence. */
  var forcedMute = false;
  function saveSound(on){
    wantSound = !!on;
    try{ localStorage.setItem("bbg.sound", on ? "1" : "0"); }catch(e){}
  }

  function $(id){ return document.getElementById(id); }

  var video    = $("video");
  var screenEl = $("screen");
  var stateEl  = $("state");
  var stateTxt = $("stateText");
  var stateSub = $("stateSub");
  var retryBtn = $("retryNow");
  var hintEl   = $("hint");
  var liveBtn  = $("liveBtn");
  var liveTxt  = $("liveTxt");
  var statRate = $("statRate");
  var statBuf  = $("statBuf");
  var statLat  = $("statLat");

  var sBtn = $("sBtn"), sName = $("sName"), sMenu = $("sMenu"), sList = $("sList");
  var qBtn = $("qBtn"), qMode = $("qMode"), qRes = $("qRes");
  var qMenu = $("qMenu"), qList = $("qList"), qFoot = $("qFoot"), qSrc = $("qSrc");

  /* Fullscreen is the only playback control that needs a button of its own.
     Play, pause and mute already exist as dedicated keys on every remote and
     keyboard, so putting them on the rail would only add clutter. */
  var fsBtn = $("fsBtn"), fsTxt = $("fsTxt");

  /* The layer that holds the header, the picture and the rail. This is what
     fullscreen expands. */
  var appEl = document.querySelector(".app");

  var hls = null;
  var retryTimer = null, countdownTimer = null;
  var retryCount = 0, netRecovery = 0, mediaRecovery = 0;
  var measuredBps = 0;
  var fragSecs = 0;
  var heightIndex = {};

  /* The rung asked for, as a height: hls.js renumbers hls.levels when it drops
     a failing one, so a captured index would later mean something else. */
  var lockedHeight = null;
  var relockTries = 0, relockTimer = null;
  var RELOCK_DELAYS = [4000, 10000, 20000];

  var LOCK_OK    = "\u5df2\u9501\u5b9a\u8be5\u6863\u4f4d\uff0c\u4e0d\u4f1a\u518d\u81ea\u52a8\u53d8\u52a8\u3002\u5982\u679c\u5361\u987f\uff0c\u6539\u56de\u300c\u81ea\u52a8\u300d\u8ba9\u64ad\u653e\u5668\u81ea\u5df1\u6839\u636e\u5b9e\u9645\u5e26\u5bbd\u9009\u62e9\u3002";
  var LOCK_RETRY = "\u8be5\u6863\u4f4d\u521a\u624d\u52a0\u8f7d\u5931\u8d25\uff0c\u64ad\u653e\u5668\u4e34\u65f6\u9000\u5230\u4e86\u4f4e\u6863\u4fdd\u4f4f\u753b\u9762\u3002\u6b63\u5728\u5207\u56de\u2014\u2014\u5982\u679c\u53cd\u590d\u53d1\u751f\uff0c\u8bf4\u660e\u5f53\u524d\u7ebf\u8def\u5582\u4e0d\u52a8\u8fd9\u4e00\u6863\u3002";
  var LOCK_LOST  = "\u8be5\u6863\u4f4d\u5728\u5f53\u524d\u7ebf\u8def\u4e0a\u6301\u7eed\u52a0\u8f7d\u5931\u8d25\uff0c\u5df2\u505c\u6b62\u91cd\u8bd5\u3002\u6362\u4e00\u4e2a\u66f4\u8fd1\u7684\u4fe1\u53f7\u6e90\uff0c\u6216\u6539\u56de\u300c\u81ea\u52a8\u300d\u3002";

  function noop(){}
  function setTitle(p){ document.title = p ? (p + " \u00b7 Bloomberg Live") : "Bloomberg Live"; }
  function nativeOk(){ return !!video.canPlayType("application/vnd.apple.mpegurl"); }

  function showLoading(text, sub){
    stateEl.hidden = false; stateEl.classList.remove("error");
    stateTxt.textContent = text; stateSub.textContent = sub || "";
    setTitle(retryCount ? "\u91cd\u8fde\u4e2d" : "");
  }
  function showError(sub){
    stateEl.hidden = false; stateEl.classList.add("error");
    stateSub.textContent = sub || ""; setTitle("\u91cd\u8fde\u4e2d");
  }
  function clearState(){
    stateEl.hidden = true; stateEl.classList.remove("error");
    stateTxt.textContent = ""; stateSub.textContent = ""; setTitle("");
  }
  function showHint(){ hintEl.classList.remove("show"); void hintEl.offsetWidth; hintEl.classList.add("show"); }
  function destroyHls(){ if(hls){ try{ hls.destroy(); }catch(e){} hls = null; } }

  function backoffMs(n){
    var steps = [3000, 5000, 8000, 13000, 21000, 30000];
    return steps[Math.min(n - 1, steps.length - 1)];
  }
  function scheduleRetry(reason, sub){
    retryCount++;
    var wait = backoffMs(retryCount), due = Date.now() + wait;
    var label = reason || "\u76f4\u64ad\u8fde\u63a5\u4e2d\u65ad";
    showError(sub);
    clearInterval(countdownTimer);
    function tick(){
      var left = Math.max(0, Math.ceil((due - Date.now()) / 1000));
      stateTxt.textContent = label + " \u00b7 " + left + " \u79d2\u540e\u91cd\u8bd5\uff08\u7b2c " + retryCount + " \u6b21\uff09";
    }
    tick();
    countdownTimer = setInterval(tick, 250);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(playHls, wait);
  }
  retryBtn.addEventListener("click", function(){
    clearTimeout(retryTimer); clearInterval(countdownTimer); playHls();
  });

  /* ---------- Popovers ---------- */
  function closeMenu(btn, pop){ pop.hidden = true; btn.setAttribute("aria-expanded", "false"); }
  function closeAllMenus(){ closeMenu(qBtn, qMenu); closeMenu(sBtn, sMenu); }
  function openMenu(btn, pop, list){
    if(btn.disabled) return;
    closeAllMenus();
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    var sel = list.querySelector('.q-item[aria-selected="true"]') || list.querySelector(".q-item");
    if(sel) sel.focus();
  }
  function wireMenu(btn, pop, list){
    btn.addEventListener("click", function(e){
      e.stopPropagation();
      if(pop.hidden) openMenu(btn, pop, list); else closeMenu(btn, pop);
    });
    pop.addEventListener("click", function(e){ e.stopPropagation(); });
    pop.addEventListener("keydown", function(e){
      var items = [].slice.call(list.querySelectorAll(".q-item"));
      if(!items.length) return;
      var i = items.indexOf(document.activeElement), k = e.key;
      if(k === "ArrowDown" || k === "ArrowUp"){
        e.preventDefault();
        var n = (i < 0) ? 0 : (i + (k === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[n].focus();
      } else if(k === "Home"){ e.preventDefault(); items[0].focus(); }
      else if(k === "End"){ e.preventDefault(); items[items.length - 1].focus(); }
      else if(k === "Escape" || k === "Tab"){ e.preventDefault(); closeMenu(btn, pop); btn.focus(); }
    });
  }
  wireMenu(sBtn, sMenu, sList);
  wireMenu(qBtn, qMenu, qList);
  document.addEventListener("click", closeAllMenus);
  function closeQMenu(){ closeMenu(qBtn, qMenu); }

  /* ---------- Cinema mode, fullscreen, idle chrome, remote ----------
     These are two different things and conflating them was the original bug.
     Cinema mode floats the header and the rail over the picture and then fades
     them. Fullscreen makes the window itself fill the display. The button has
     to do both, in that order.

     Faults found here, in the order they were introduced:

     1. The request expanded the picture element alone. The header and the rail
        live outside it, so during fullscreen the source and quality menus were
        not merely hidden but absent.
     2. The request was wrapped in a try block. requestFullscreen reports a
        refusal by rejecting its promise, which no try block can see, so a
        refusal looked exactly like success.
     3. Inside a native shell the page is the wrong place to ask. A WKWebView
        cannot resize its own window, and the Android shell already occupies the
        whole display.
     4. The root element is not a valid thing to expand in practice. WebKit does
        not stretch <html> to the fullscreen surface: it keeps the old box and
        pins it to one corner, which is why the page ended up small in the lower
        left with black above and to the right. An ordinary element is stretched
        by the user agent, so the request now goes to the layer that holds the
        header, the picture and the rail.
     5. Hiding the chrome was blocked by focus. Clicking the button leaves it
        focused, and the idle timer deliberately refuses to hide a focused
        control, so on a desktop the two bars would never fade - the exact
        complaint that fullscreen "only hides the bars" was in fact fullscreen
        not hiding them at all. Entering now drops focus and fades at once.

     A remote is also not a keyboard: fullscreen used to exist only as an F key
     binding, which on a television means not at all. */
  var body = document.body;
  var IDLE_MS = 4200;
  var ENTER_MS = 700;
  var idleTimer = null;

  /* The host app appends ?tv=1 when Android reports a television UI mode; the
     user agent test is only a fallback for a plain browser on a TV stick. */
  var isTv = /(^|[?&])tv=1(&|$)/.test(location.search) ||
    /Android TV|Google TV|GoogleTV|SMART-TV|SmartTV|BRAVIA|AFT[A-Z]|CrKey|Web0S|Tizen/i.test(navigator.userAgent || "");

  /* Android WebView announces itself with a wv token; a browser on Android does
     not carry it. Our Android shell is always immersive fullscreen already. */
  var inWebViewShell = /;\s*wv[);]/.test(navigator.userAgent || "") ||
    /\bwv\b/.test(navigator.userAgent || "");

  function inCinema(){ return body.classList.contains("cinema"); }
  function sleep(){
    if(!inCinema()) return;
    if(!qMenu.hidden || !sMenu.hidden) return;
    var a = document.activeElement;
    var onControl = !!(a && a.classList && (a.classList.contains("q-btn") || a.classList.contains("live")));
    if(onControl){
      /* With a remote, focus lives on a control permanently, so refusing to
         hide while anything is focused would mean never hiding. */
      if(!isTv) return;
      try{ a.blur(); }catch(e){}
    }
    body.classList.add("idle");
  }
  function wake(){
    body.classList.remove("idle");
    clearTimeout(idleTimer);
    if(inCinema()) idleTimer = setTimeout(sleep, IDLE_MS);
  }

  /* The desktop shell exposes a channel for this, because a WKWebView cannot
     resize the window it lives in. Returning true means the shell has taken
     the request and the page must not also ask the browser. */
  function hostFs(){
    try{
      var h = window.webkit && window.webkit.messageHandlers &&
        window.webkit.messageHandlers.bbgFullscreen;
      if(h){ h.postMessage("toggle"); return true; }
    }catch(e){}
    return false;
  }
  function fsElement(){
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  function requestFs(){
    /* Never the root element: see fault 4 above. */
    var el = appEl || document.body;
    var fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if(!fn) return;
    try{
      var p = fn.call(el);
      /* A refusal arrives as a rejected promise, never as a throw. Cinema mode
         stays on either way, so this only has to be swallowed deliberately
         rather than reported. */
      if(p && typeof p["catch"] === "function") p["catch"](noop);
    }catch(e){}
  }
  function exitFs(){
    try{
      var fn = document.exitFullscreen || document.webkitExitFullscreen;
      if(fsElement() && fn) fn.call(document);
    }catch(e){}
  }
  function setCinema(on){
    body.classList.toggle("cinema", !!on);
    fsTxt.textContent = on ? "\u9000\u51fa\u5168\u5c4f" : "\u5168\u5c4f";
    wake();
    /* Get out of the way immediately rather than after the usual idle delay,
       and let go of the button that was just clicked so that hiding is not
       refused. Any movement, tap or key brings both bars straight back. */
    if(on){
      if(!isTv){
        var a = document.activeElement;
        if(a && a !== body && a.blur){ try{ a.blur(); }catch(e){} }
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(sleep, ENTER_MS);
    }
  }
  function toggleFullscreen(){
    var on = !inCinema();
    setCinema(on);
    if(hostFs()) return;
    if(inWebViewShell || isTv) return;
    if(on) requestFs(); else exitFs();
  }

  /* Leaving fullscreen by any route the page did not initiate - Escape, the
     green button, the View menu - has to put the bars back. */
  ["fullscreenchange", "webkitfullscreenchange"].forEach(function(evt){
    document.addEventListener(evt, function(){
      if(isTv) return;
      if(!fsElement()) setCinema(false);
    });
  });

  /* Called by the desktop shell when its window enters or leaves fullscreen,
     so the green button and the menu item agree with the rail button. */
  window.__bbgSetCinema = function(on){
    if(isTv) return;
    if(!!on === inCinema()) return;
    setCinema(!!on);
  };

  screenEl.addEventListener("dblclick", toggleFullscreen);
  fsBtn.addEventListener("click", function(e){
    e.stopPropagation();
    closeAllMenus();
    toggleFullscreen();
  });

  /* Left to right along the rail. A WebView will not reliably do spatial
     navigation by itself, so the walk is explicit. */
  var CTRLS = [sBtn, qBtn, fsBtn];
  function liveCtrls(){
    return CTRLS.filter(function(b){ return b && !b.disabled && b.offsetParent !== null; });
  }
  function moveFocus(step){
    var list = liveCtrls();
    if(!list.length) return;
    var i = list.indexOf(document.activeElement);
    if(i < 0){ list[step > 0 ? 0 : list.length - 1].focus(); return; }
    list[(i + step + list.length) % list.length].focus();
  }
  function focusRail(){
    var list = liveCtrls();
    if(list.length) list[0].focus();
  }

  ["mousemove", "mousedown", "touchstart", "wheel"].forEach(function(evt){
    document.addEventListener(evt, wake, {passive:true});
  });

  if(isTv){
    body.classList.add("tv");
    /* System video controls cannot be driven by a remote and swallow the D-pad
       while on screen. The rail replaces them. */
    try{ video.removeAttribute("controls"); video.tabIndex = -1; }catch(e){}
    setCinema(true);
  }

  /* ---------- Source selector ---------- */
  function buildSourceMenu(){
    var html = "";
    SOURCES.forEach(function(s){
      html += '<button class="q-item" type="button" role="option" aria-selected="' +
        (s.id === currentSource.id ? "true" : "false") + '" tabindex="-1" data-src="' + s.id + '">' +
        '<span class="q-bar" aria-hidden="true"></span>' +
        '<span class="q-lbl">' + s.name + '</span>' +
        '<span class="q-rate">' + s.note + '</span></button>';
    });
    sList.innerHTML = html;
    [].slice.call(sList.querySelectorAll(".q-item")).forEach(function(btn){
      btn.addEventListener("click", function(e){
        e.stopPropagation();
        closeMenu(sBtn, sMenu);
        sBtn.focus();
        selectSource(btn.getAttribute("data-src"));
      });
    });
    sName.textContent = currentSource.name;
  }
  function selectSource(id){
    var s = sourceById(id);
    if(s.id === currentSource.id) return;
    currentSource = s;
    try{ localStorage.setItem("bbg.source", s.id); }catch(e){}
    [].slice.call(sList.querySelectorAll(".q-item")).forEach(function(b){
      b.setAttribute("aria-selected", b.getAttribute("data-src") === s.id ? "true" : "false");
    });
    sName.textContent = s.name;
    /* A deliberate restart, not a failure: clear the backoff ladder, and drop
       the native src too or Safari keeps decoding the old feed underneath. */
    retryCount = 0; netRecovery = 0; mediaRecovery = 0;
    clearTimeout(retryTimer); clearInterval(countdownTimer);
    destroyHls();
    try{ video.pause(); video.removeAttribute("src"); video.load(); }catch(e){}
    playHls();
  }
  buildSourceMenu();

  /* ---------- Quality, built from real manifest levels ---------- */
  function levelLabel(l){ return l.height ? (l.height + "p") : (Math.round((l.bitrate || 0) / 1000) + "k"); }
  function levelBadge(l){ return l.height >= 1080 ? "FHD" : (l.height >= 720 ? "HD" : ""); }
  function rateLabel(bps){
    if(!bps) return "";
    return bps >= 1000000 ? (Math.round(bps / 100000) / 10 + " Mbps") : (Math.round(bps / 1000) + " kbps");
  }
  function itemHtml(level, label, badge, rate){
    return '<button class="q-item" type="button" role="option" aria-selected="false" tabindex="-1" data-level="' + level + '">' +
      '<span class="q-bar" aria-hidden="true"></span>' +
      '<span class="q-lbl">' + label + '</span>' +
      (badge ? '<span class="q-badge' + (badge === "FHD" ? " is-fhd" : "") + '">' + badge + '</span>' : '') +
      '<span class="q-rate">' + (rate || "") + '</span></button>';
  }
  function clearRelock(){
    clearTimeout(relockTimer);
    relockTimer = null;
    relockTries = 0;
    qBtn.classList.remove("fallen");
  }
  function resetQuality(){
    closeQMenu();
    qList.innerHTML = "";
    heightIndex = {};
    lockedHeight = null;
    clearRelock();
    qBtn.disabled = true;
    qMode.textContent = (prefQuality === "auto") ? "\u81ea\u52a8" : (prefQuality + "p");
    qRes.textContent = "\u2014";
    qSrc.textContent = "\u81ea\u9002\u5e94";
    qFoot.hidden = true;
  }
  /* skipApply is for when the ladder changed underneath us: redraw the list,
     but do not re-resolve the preference, or a rung the player has just given
     up on would be requested all over again. */
  function buildQualityMenu(skipApply){
    if(!hls || !hls.levels || !hls.levels.length){ resetQuality(); return; }
    var idxs = hls.levels.map(function(l, i){ return i; }).sort(function(a, b){
      var la = hls.levels[a], lb = hls.levels[b];
      return (lb.height || 0) - (la.height || 0) || (lb.bitrate || 0) - (la.bitrate || 0);
    });
    var seen = {}, html = itemHtml("auto", "\u81ea\u52a8", "", "");
    heightIndex = {};
    idxs.forEach(function(i){
      var l = hls.levels[i], h = l.height || 0;
      if(seen[h]) return;
      seen[h] = 1;
      heightIndex[h] = i;
      html += itemHtml(String(i), levelLabel(l), levelBadge(l), rateLabel(l.bitrate));
    });
    qList.innerHTML = html;
    qBtn.disabled = false;
    [].slice.call(qList.querySelectorAll(".q-item")).forEach(function(btn){
      btn.addEventListener("click", function(e){
        e.stopPropagation();
        var v = btn.getAttribute("data-level");
        clearRelock();
        if(v === "auto"){
          lockedHeight = null;
          applyLevel(-1);
          savePref("auto");
        } else {
          var idx = parseInt(v, 10), lv = hls.levels[idx];
          lockedHeight = (lv && lv.height) || null;
          applyLevel(idx);
          savePref(lv && lv.height ? String(lv.height) : "auto");
        }
        measuredBps = 0;
        setActiveQuality(v);
        closeQMenu();
        qBtn.focus();
      });
    });
    if(skipApply){
      var keep = (lockedHeight != null) ? indexForHeight(lockedHeight) : -1;
      setActiveQuality(keep >= 0 ? String(keep) : (lockedHeight != null ? "" : "auto"));
      enforceLock();
    } else {
      applyPreferredLevel();
    }
  }

  /* A pick is a lock; -1 hands control back to the ladder. soft=true switches
     at the next fragment boundary instead of discarding the buffer. */
  function applyLevel(idx, soft){
    if(!hls) return;
    try{
      if(soft && idx >= 0) hls.nextLevel = idx;
      else hls.currentLevel = idx;
      if(idx >= 0) hls.startLevel = idx;
    }catch(e){}
  }
  function indexForHeight(h){
    if(!hls || !hls.levels) return -1;
    for(var i = 0; i < hls.levels.length; i++){
      if((hls.levels[i].height || 0) === h) return i;
    }
    return -1;
  }
  function activeHeight(){
    var l = (hls && hls.levels && hls.currentLevel >= 0) ? hls.levels[hls.currentLevel] : null;
    return l ? (l.height || 0) : 0;
  }

  /* hls.js keeps its own escape hatch from a manual lock: a level whose
     fragments keep failing is penalised and abandoned, which silently
     overrides a stated choice and lands on the bottom rung. So the choice is
     re-asserted, at most three times with widening gaps, and only ever back to
     the rung that was asked for. It never lowers anything by itself. */
  function enforceLock(){
    if(lockedHeight == null || !hls) return;
    var now = activeHeight();
    if(now === lockedHeight){
      clearRelock();
      qMode.textContent = lockedHeight + "p";
      qFoot.textContent = LOCK_OK;
      qFoot.hidden = false;
      return;
    }
    /* The label must never claim a rung we are not on. */
    qBtn.classList.add("fallen");
    qMode.textContent = lockedHeight + "p \u2192 " + (now ? (now + "p") : "\u2014");
    qFoot.hidden = false;
    if(indexForHeight(lockedHeight) < 0 || relockTries >= RELOCK_DELAYS.length){
      qFoot.textContent = LOCK_LOST;
      return;
    }
    qFoot.textContent = LOCK_RETRY;
    clearTimeout(relockTimer);
    relockTimer = setTimeout(function(){
      relockTimer = null;
      if(lockedHeight == null || !hls) return;
      var j = indexForHeight(lockedHeight);
      if(j >= 0) applyLevel(j, true);
    }, RELOCK_DELAYS[relockTries++]);
  }

  /* Resolve a remembered height against the ladder this feed offers: exact
     match, then the best rung at or below it, then auto. */
  function applyPreferredLevel(){
    clearRelock();
    if(prefQuality === "auto"){
      lockedHeight = null; applyLevel(-1); setActiveQuality("auto"); return;
    }
    var want = parseInt(prefQuality, 10);
    var heights = Object.keys(heightIndex).map(Number).sort(function(a, b){ return b - a; });
    if(!heights.length || !isFinite(want)){
      lockedHeight = null; applyLevel(-1); setActiveQuality("auto"); return;
    }
    var pick = -1, i;
    for(i = 0; i < heights.length; i++){ if(heights[i] === want){ pick = heights[i]; break; } }
    if(pick < 0){ for(i = 0; i < heights.length; i++){ if(heights[i] <= want){ pick = heights[i]; break; } } }
    if(pick < 0){ lockedHeight = null; applyLevel(-1); setActiveQuality("auto"); return; }
    lockedHeight = pick;
    applyLevel(heightIndex[pick]);
    measuredBps = 0;
    setActiveQuality(String(heightIndex[pick]));
  }
  function setActiveQuality(v){
    [].slice.call(qList.querySelectorAll(".q-item")).forEach(function(b){
      b.setAttribute("aria-selected", b.getAttribute("data-level") === v ? "true" : "false");
    });
    if(v === "auto"){
      qBtn.classList.remove("fallen");
      qMode.textContent = "\u81ea\u52a8";
      qSrc.textContent = "\u81ea\u9002\u5e94";
      qFoot.hidden = true;
    } else {
      var l = hls && hls.levels[parseInt(v, 10)];
      qMode.textContent = l ? levelLabel(l) : ((lockedHeight != null) ? (lockedHeight + "p") : "\u81ea\u52a8");
      qSrc.textContent = "\u5df2\u9501\u5b9a";
      qFoot.textContent = LOCK_OK;
      qFoot.hidden = false;
    }
    updateActiveRate();
  }
  /* On the auto row, report the rung the ladder has actually settled on. */
  function updateActiveRate(){
    var lv = (hls && hls.levels && hls.currentLevel >= 0) ? hls.levels[hls.currentLevel] : null;
    qRes.textContent = lv ? ((lv.width || "?") + "\u00d7" + (lv.height || "?")) : "\u2014";
    var row = qList.querySelector('.q-item[aria-selected="true"]');
    if(!row || row.getAttribute("data-level") !== "auto") return;
    var cell = row.querySelector(".q-rate");
    if(cell) cell.textContent = lv ? ("\u5f53\u524d " + levelLabel(lv)) : "";
  }

  /* ---------- Live edge ----------
     hls.latency is the real distance from the live edge; liveSyncPosition is
     only our own target, so measuring against it reports drift, not latency. */
  function targetLatency(){
    var t = hls && hls.targetLatency;
    return (typeof t === "number" && t > 0) ? t : 20;
  }
  function latency(){
    if(hls && typeof hls.latency === "number" && hls.latency > 0) return hls.latency;
    var b = video.buffered;
    if(b && b.length) return Math.max(0, b.end(b.length - 1) - video.currentTime);
    return NaN;
  }
  /* Seconds of playable video ahead of the playhead. This is what predicts a
     stall; latency does not. */
  function bufferAhead(){
    var b = video.buffered, t = video.currentTime;
    if(!b) return NaN;
    for(var i = 0; i < b.length; i++){
      if(t >= b.start(i) - 0.2 && t <= b.end(i)) return Math.max(0, b.end(i) - t);
    }
    return 0;
  }
  function liveEdge(){
    if(hls && isFinite(hls.liveSyncPosition)) return hls.liveSyncPosition;
    var b = video.buffered;
    return (b && b.length) ? b.end(b.length - 1) : NaN;
  }
  function jumpToLive(){
    var e = liveEdge();
    if(!isFinite(e)) return;
    try{ video.currentTime = e; }catch(err){}
    video.play().catch(noop);
  }
  liveBtn.addEventListener("click", function(){ if(liveBtn.classList.contains("behind")) jumpToLive(); });

  /* ---------- Starting playback with sound ----------
     Ask for what the viewer actually wants, then deal with a refusal, rather
     than pre-emptively surrendering to a policy that does not apply here.
     A blocked autoplay is reported by rejecting the promise play() returns; it
     is never thrown, so a try block around it sees nothing. Only in that
     rejection do we mute, and only then is the tap-to-unmute hint shown - on a
     television it would be advice that cannot be followed. */
  function attemptPlay(){
    video.muted = !wantSound;
    screenEl.classList.toggle("mutedState", video.muted);
    var p;
    try{ p = video.play(); }catch(e){ p = null; }
    if(!p || typeof p["catch"] !== "function") return;
    p["catch"](function(){
      if(!wantSound){
        /* Muted and still refused: nothing left to concede. */
        var m = video.play();
        if(m && typeof m["catch"] === "function") m["catch"](noop);
        return;
      }
      forcedMute = true;
      video.muted = true;
      screenEl.classList.add("mutedState");
      var q = video.play();
      if(q && typeof q["catch"] === "function") q["catch"](noop);
      showHint();
    });
  }

  /* ---------- Playback ---------- */
  function playHls(){
    clearTimeout(retryTimer); clearInterval(countdownTimer);
    if(window.Hls) return startPlayback();
    showLoading(retryCount === 0 ? "\u6b63\u5728\u52a0\u8f7d\u64ad\u653e\u7ec4\u4ef6\u2026" : "\u6b63\u5728\u91cd\u65b0\u52a0\u8f7d\u64ad\u653e\u7ec4\u4ef6\u2026");
    var wait = window.__hlsReady || function(cb){ cb(false); };
    wait(function(ok){
      if(!ok && !window.Hls && !nativeOk()){
        scheduleRetry("\u64ad\u653e\u7ec4\u4ef6\u52a0\u8f7d\u5931\u8d25", "\u4e09\u4e2a\u955c\u50cf\u6e90\u90fd\u6ca1\u80fd\u52a0\u8f7d hls.js\u3002\u901a\u5e38\u662f\u7f51\u7edc\u53d7\u9650\u6216\u88ab\u5e7f\u544a\u62e6\u622a\u63d2\u4ef6\u963b\u65ad\u3002");
        return;
      }
      startPlayback();
    });
  }

  function startPlayback(){
    video.style.display = "block";
    showLoading(retryCount === 0 ? "\u6b63\u5728\u8fde\u63a5 Bloomberg \u5b98\u65b9\u76f4\u64ad\u2026" : "\u6b63\u5728\u91cd\u65b0\u8fde\u63a5\u2026");
    destroyHls();
    resetQuality();
    measuredBps = 0;
    fragSecs = 0;
    /* Every restart is a fresh chance at sound: a refusal earlier in the
       session does not mean the page is still ungestured now. */
    forcedMute = false;
    video.muted = !wantSound;
    try{ video.playbackRate = 1; }catch(e){}
    screenEl.classList.toggle("mutedState", video.muted);

    if(window.Hls && window.Hls.isSupported()){
      hls = new window.Hls({
        enableWorker: true,

        /* Media behind the playhead shares the SourceBuffer quota with media
           ahead of it, and that quota is much smaller inside a WebView. */
        backBufferLength: 15,

        /* Live sync in seconds, not fragments. A fragment count means nothing
           without knowing the segment length, and this playlist's length is
           not knowable here: six fragments of ten seconds is a sixty second
           target, so a session fifty seconds behind looked comfortably early
           and neither the catch up nor the corrective seek ever fired.
           Measured before this change: buffer 30s, latency 51.5s. These two
           supersede the *DurationCount options entirely. */
        lowLatencyMode: false,
        liveSyncDuration: 18,
        liveMaxLatencyDuration: 30,

        /* About six seconds recovered per minute. Exactly 1 removes the
           mechanism; 1.3 eats the cushion faster than the network refills it. */
        maxLiveSyncPlaybackRate: 1.1,
        liveDurationInfinity: true,

        maxBufferLength: 40,
        maxMaxBufferLength: 60,
        maxBufferHole: 0.5,
        nudgeMaxRetry: 10,

        /* ABR biased towards holding a picture rather than maximising one:
           start low, demand real headroom before climbing. An explicit pick
           still overrides all of it. */
        abrEwmaDefaultEstimate: 600000,
        abrBandWidthFactor: 0.8,
        abrBandWidthUpFactor: 0.5,
        startFragPrefetch: true,

        /* Retry a slow segment rather than tearing the session down. */
        manifestLoadingTimeOut: 8000,
        manifestLoadingMaxRetry: 3,
        manifestLoadingRetryDelay: 500,
        levelLoadingTimeOut: 10000,
        levelLoadingMaxRetry: 6,
        fragLoadingTimeOut: 20000,
        fragLoadingMaxRetry: 8,
        fragLoadingRetryDelay: 500
      });
      hls.loadSource(streamUrl());
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, function(){
        retryCount = 0; netRecovery = 0; mediaRecovery = 0;
        clearState();
        buildQualityMenu();
        attemptPlay();
      });
      hls.on(window.Hls.Events.LEVEL_SWITCHED, function(){
        measuredBps = 0;
        updateActiveRate();
        enforceLock();
      });
      if(window.Hls.Events.LEVELS_UPDATED){
        hls.on(window.Hls.Events.LEVELS_UPDATED, function(){ buildQualityMenu(true); });
      }
      hls.on(window.Hls.Events.FRAG_BUFFERED, function(_e, d){
        netRecovery = 0; mediaRecovery = 0;
        /* Real encoded bitrate: bytes delivered over media time covered. */
        try{
          var st = d && d.stats, dur = d && d.frag && d.frag.duration;
          var bytes = st ? (st.total || st.loaded) : 0;
          if(dur > 0) fragSecs = dur;
          if(bytes > 0 && dur > 0){
            var bps = bytes * 8 / dur;
            measuredBps = measuredBps ? (measuredBps * 0.7 + bps * 0.3) : bps;
          }
        }catch(e){}
      });
      hls.on(window.Hls.Events.ERROR, onHlsError);
    } else if(nativeOk()){
      /* Fallback only: the system decoder exposes no level list. */
      qMode.textContent = "\u7cfb\u7edf\u89e3\u7801";
      var mySrc = streamUrl();
      video.src = mySrc;
      video.addEventListener("loadedmetadata", function(){
        if(video.src !== mySrc) return;
        retryCount = 0; clearState(); attemptPlay();
      }, {once:true});
      video.addEventListener("error", function(){
        if(video.src !== mySrc) return;
        scheduleRetry("\u76f4\u64ad\u8fde\u63a5\u4e2d\u65ad");
      }, {once:true});
    } else {
      showError("\u8be5\u6d4f\u89c8\u5668\u65e2\u4e0d\u652f\u6301 MSE\uff0c\u4e5f\u4e0d\u652f\u6301\u539f\u751f HLS \u64ad\u653e\u3002");
      stateTxt.textContent = "\u5f53\u524d\u6d4f\u89c8\u5668\u65e0\u6cd5\u64ad\u653e\u6b64\u76f4\u64ad\u6d41";
    }
  }

  /* A fatal error is not always terminal: reattach the loader or flush the
     buffer in place, twice each, before tearing everything down. */
  function onHlsError(_evt, data){
    if(!data || !data.fatal) return;
    var T = window.Hls.ErrorTypes;
    if(data.type === T.NETWORK_ERROR && netRecovery < 2){
      netRecovery++;
      showLoading("\u7f51\u7edc\u4e2d\u65ad\uff0c\u6b63\u5728\u6062\u590d\u2026");
      try{ hls.startLoad(); return; }catch(e){}
    }
    if(data.type === T.MEDIA_ERROR && mediaRecovery < 2){
      mediaRecovery++;
      showLoading("\u89e3\u7801\u5f02\u5e38\uff0c\u6b63\u5728\u81ea\u6108\u2026");
      try{ hls.recoverMediaError(); return; }catch(e){}
    }
    destroyHls();
    scheduleRetry("\u76f4\u64ad\u8fde\u63a5\u4e2d\u65ad");
  }

  /* ---------- Audio ---------- */
  try{
    var savedVol = parseFloat(localStorage.getItem("bbg.volume"));
    if(isFinite(savedVol)) video.volume = Math.min(1, Math.max(0, savedVol));
  }catch(e){}
  video.addEventListener("volumechange", function(){
    screenEl.classList.toggle("mutedState", video.muted);
    try{ if(!video.muted) localStorage.setItem("bbg.volume", String(video.volume)); }catch(e){}
  });
  function unmute(){
    if(video.style.display === "none") return;
    forcedMute = false;
    saveSound(true);
    if(!video.muted) return;
    video.muted = false;
    video.play().catch(noop);
    hintEl.classList.remove("show");
  }
  screenEl.addEventListener("click", unmute);

  /* ---------- Keyboard and remote ----------
     A remote arrives here as arrow keys plus Enter, so the arrows have to do
     something useful at the document level: wake the chrome, then walk the
     rail. Enter activates a focused button by itself. Play, pause and mute stay
     as keys only, including the dedicated media keys a remote sends. */
  document.addEventListener("keydown", function(e){
    if(e.metaKey || e.ctrlKey || e.altKey) return;
    var k = (e.key || "").toLowerCase();
    wake();

    /* If the browser imposed silence, any key is the gesture that lifts it -
       including on a remote, where the picture cannot be reached at all. A
       deliberate mute is left alone: forcedMute is only ever set by a refused
       play, never by the viewer pressing M. */
    if(forcedMute && video.muted && k !== "m") unmute();

    /* An open menu owns the keyboard; it has its own handler. */
    if(!qMenu.hidden || !sMenu.hidden){
      if(k === "escape") closeAllMenus();
      return;
    }

    var tag = (document.activeElement && document.activeElement.tagName) || "";
    var onButton = (tag === "BUTTON" || tag === "A" || tag === "INPUT");

    if(k === "arrowleft" || k === "arrowright"){
      e.preventDefault(); moveFocus(k === "arrowright" ? 1 : -1); return;
    }
    if(k === "arrowdown"){ e.preventDefault(); focusRail(); return; }
    if(k === "arrowup"){
      e.preventDefault();
      if(document.activeElement === liveBtn) focusRail(); else liveBtn.focus();
      return;
    }
    if(k === "enter"){
      if(onButton) return;
      e.preventDefault(); focusRail(); return;
    }
    if(k === "escape"){
      if(inCinema() && !isTv){ setCinema(false); exitFs(); }
      return;
    }
    if(k === " " || k === "spacebar" || k === "k" || k === "mediaplaypause" ||
       k === "mediaplay" || k === "mediapause"){
      if(onButton && k.indexOf("media") !== 0) return;
      e.preventDefault();
      if(video.paused) video.play().catch(noop); else video.pause();
      return;
    }
    /* Remembered, so the choice survives a reload and a source change. */
    if(k === "m" || k === "audiovolumemute"){
      if(video.muted) unmute();
      else { video.muted = true; forcedMute = false; saveSound(false); }
      return;
    }
    if(k === "f"){ toggleFullscreen(); return; }
    if(k === "l"){ jumpToLive(); return; }
    if(k === "s"){ e.preventDefault(); openMenu(sBtn, sMenu, sList); return; }
  });

  /* ---------- Telemetry ----------
     A latency figure is meaningless without the target it is judged against,
     which is exactly how a sixty second target went unnoticed. The tooltip
     carries the target, the measured segment length and the playback rate. */
  setInterval(function(){
    if(video.style.display === "none") return;

    var lv = (hls && hls.levels && hls.currentLevel >= 0) ? hls.levels[hls.currentLevel] : null;
    var bps = measuredBps || (lv ? lv.bitrate : 0);
    statRate.textContent = bps
      ? ("\u7801\u7387 " + (bps >= 1000000 ? (Math.round(bps / 100000) / 10 + " Mbps")
                                          : (Math.round(bps / 1000).toLocaleString() + " kbps")))
      : "\u7801\u7387 \u2014";

    var buf = bufferAhead();
    statBuf.textContent = isFinite(buf) ? ("\u7f13\u51b2 " + buf.toFixed(1) + "s") : "\u7f13\u51b2 \u2014";
    statBuf.classList.toggle("thin", isFinite(buf) && buf < 4);

    var l = latency(), t = targetLatency();
    statLat.textContent = isFinite(l) ? ("\u5ef6\u8fdf " + l.toFixed(1) + "s") : "\u5ef6\u8fdf \u2014";
    statLat.classList.toggle("catching", video.playbackRate > 1.01);
    var tip = "\u5f53\u524d\u753b\u9762\u8ddd\u79bb\u76f4\u64ad\u8fb9\u7f18\u7684\u771f\u5b9e\u65f6\u95f4\u5dee\n\u76ee\u6807 " + t.toFixed(1) + "s";
    if(fragSecs) tip += "\n\u5206\u7247\u65f6\u957f " + fragSecs.toFixed(1) + "s";
    tip += "\n\u500d\u901f " + video.playbackRate.toFixed(2) + "\u00d7";
    statLat.title = tip;

    var behind = isFinite(l) && l > t + 8;
    liveBtn.classList.toggle("behind", behind);
    liveTxt.textContent = behind ? "\u56de\u5230\u76f4\u64ad" : "LIVE";

    updateActiveRate();
  }, 1000);

  /* Coming back to a backgrounded tab, the picture can be far behind. */
  document.addEventListener("visibilitychange", function(){
    if(document.hidden) return;
    var l = latency();
    if(isFinite(l) && l > targetLatency() + 10) jumpToLive();
  });

  /* ---------- Clocks and market sessions ----------
     Minutes from local midnight in each market's own zone. Holiday calendars
     are not modelled, so a public holiday still reads as an open session. */
  var MARKETS = [
    {code:"NYSE",  zone:"America/New_York", zones:["America/New_York","America/Toronto","America/Detroit","America/Chicago","America/Denver","America/Phoenix","America/Los_Angeles"], pre:[240,570], open:[[570,960]], post:[960,1200]},
    {code:"LSE",   zone:"Europe/London", zones:["Europe/London","Europe/Dublin","Europe/Lisbon"], pre:[420,480], open:[[480,990]], post:[990,1035]},
    {code:"XETRA", zone:"Europe/Berlin", zones:["Europe/Berlin","Europe/Paris","Europe/Madrid","Europe/Rome","Europe/Amsterdam","Europe/Zurich","Europe/Brussels","Europe/Vienna","Europe/Stockholm","Europe/Oslo","Europe/Copenhagen","Europe/Warsaw","Europe/Prague"], pre:[480,540], open:[[540,1050]], post:[1050,1110]},
    {code:"SSE",   zone:"Asia/Shanghai", zones:["Asia/Shanghai","Asia/Chungking","Asia/Chongqing","Asia/Harbin","Asia/Urumqi"], pre:[555,570], open:[[570,690],[780,900]], post:[900,930]},
    {code:"HKEX",  zone:"Asia/Hong_Kong", zones:["Asia/Hong_Kong","Asia/Macau"], pre:[540,570], open:[[570,720],[780,960]], post:[960,975]},
    {code:"TWSE",  zone:"Asia/Taipei", zones:["Asia/Taipei"], pre:[510,540], open:[[540,810]], post:null},
    {code:"TSE",   zone:"Asia/Tokyo", zones:["Asia/Tokyo"], pre:[480,540], open:[[540,690],[750,930]], post:null},
    {code:"KRX",   zone:"Asia/Seoul", zones:["Asia/Seoul","Asia/Pyongyang"], pre:[480,540], open:[[540,930]], post:[930,1080]},
    {code:"SGX",   zone:"Asia/Singapore", zones:["Asia/Singapore","Asia/Kuala_Lumpur","Asia/Jakarta","Asia/Manila","Asia/Bangkok","Asia/Ho_Chi_Minh"], pre:[480,540], open:[[540,1020]], post:null},
    {code:"NSE",   zone:"Asia/Kolkata", zones:["Asia/Kolkata","Asia/Calcutta","Asia/Colombo","Asia/Karachi","Asia/Dhaka"], pre:[540,555], open:[[555,930]], post:null},
    {code:"DFM",   zone:"Asia/Dubai", zones:["Asia/Dubai","Asia/Riyadh","Asia/Qatar","Asia/Kuwait","Asia/Tehran","Asia/Jerusalem","Europe/Istanbul","Europe/Moscow"], pre:[570,600], open:[[600,870]], post:null},
    {code:"ASX",   zone:"Australia/Sydney", zones:["Australia/Sydney","Australia/Melbourne","Australia/Brisbane","Australia/Perth","Pacific/Auckland"], pre:[420,600], open:[[600,960]], post:[960,1020]}
  ];

  var partsFmts = {};
  function fmtFor(zone){
    if(!partsFmts[zone]){
      partsFmts[zone] = new Intl.DateTimeFormat("en-GB", {
        timeZone: zone, hour12: false, weekday: "short",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
    }
    return partsFmts[zone];
  }
  function zoneNow(zone){
    try{
      var o = {};
      fmtFor(zone).formatToParts(new Date()).forEach(function(p){ o[p.type] = p.value; });
      var h = parseInt(o.hour, 10) % 24, m = parseInt(o.minute, 10);
      var hh = (h < 10 ? "0" + h : String(h));
      return {text: hh + ":" + o.minute + ":" + o.second, mins: h * 60 + m, day: o.weekday};
    }catch(e){
      return {text: "--:--:--", mins: -1, day: ""};
    }
  }
  function within(range, m){ return !!range && m >= range[0] && m < range[1]; }
  function marketFor(zone){
    for(var i = 0; i < MARKETS.length; i++){
      if(MARKETS[i].zones.indexOf(zone) >= 0) return MARKETS[i];
    }
    return null;
  }
  function sessionOf(zone){
    var mk = marketFor(zone);
    if(!mk) return {t:"\u2014", c:"off"};
    var n = zoneNow(mk.zone);
    if(n.mins < 0) return {t:"\u2014", c:"off"};
    if(n.day === "Sat" || n.day === "Sun") return {t:"\u5468\u672b\u4f11\u5e02", c:"off"};
    for(var i = 0; i < mk.open.length; i++){
      if(within(mk.open[i], n.mins)) return {t:"\u5f00\u76d8", c:"on"};
    }
    if(mk.open.length > 1 && n.mins >= mk.open[0][1] && n.mins < mk.open[1][0]){
      return {t:"\u5348\u95f4\u4f11\u5e02", c:"off"};
    }
    if(within(mk.pre, n.mins))  return {t:"\u76d8\u524d", c:"pre"};
    if(within(mk.post, n.mins)) return {t:"\u76d8\u540e", c:"pre"};
    return {t:"\u6536\u76d8", c:"off"};
  }

  var localZone = "UTC";
  try{ localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }catch(e){}
  $("localTz").textContent = (localZone.split("/").pop() || "LOCAL").replace(/_/g, " ").toUpperCase();

  var COLUMNS = [
    {box:"clockLondon", time:"londonTime", ses:"londonSession", zone:"Europe/London"},
    {box:"clockNy",     time:"nyTime",     ses:"session",       zone:"America/New_York"},
    {box:"clockHk",     time:"hkTime",     ses:"hkSession",     zone:"Asia/Hong_Kong"},
    {box:"clockSeoul",  time:"seoulTime",  ses:"seoulSession",  zone:"Asia/Seoul"},
    {box:"clockLocal",  time:"localTime",  ses:"localSession",  zone:localZone}
  ];
  COLUMNS.forEach(function(c){
    c.boxEl = $(c.box); c.timeEl = $(c.time); c.sesEl = $(c.ses);
  });

  /* A local column that repeats a fixed one is noise. */
  (function(){
    var dup = false;
    for(var i = 0; i < 4; i++){ if(COLUMNS[i].zone === localZone) dup = true; }
    if(dup) COLUMNS[4].boxEl.hidden = true;
  })();

  /* Ordered by real UTC offset rather than markup order, so the row reads west
     to east. Decorate, sort, undecorate with an index tiebreaker, because sort
     stability is not guaranteed everywhere and two columns can share an
     offset exactly. */
  (function(){
    function offsetMinutes(zone){
      try{
        var p = new Intl.DateTimeFormat("en-US", {timeZone: zone, timeZoneName: "longOffset"})
          .formatToParts(new Date())
          .filter(function(x){ return x.type === "timeZoneName"; })[0];
        var m = p && /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(p.value);
        if(m) return (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10));
      }catch(e){}
      return 0;
    }
    var decorated = COLUMNS.map(function(c, i){ return {c:c, i:i, off:offsetMinutes(c.zone)}; });
    decorated.sort(function(a, b){ return (a.off - b.off) || (a.i - b.i); });
    decorated.forEach(function(d, order){ d.c.boxEl.style.order = String(order); });
  })();

  function tickClocks(){
    COLUMNS.forEach(function(c){
      if(c.boxEl.hidden) return;
      c.timeEl.textContent = zoneNow(c.zone).text;
      var s = sessionOf(c.zone);
      c.sesEl.textContent = s.t;
      c.sesEl.className = "session " + s.c;
    });
  }
  tickClocks();
  setInterval(tickClocks, 1000);

  playHls();
})();
