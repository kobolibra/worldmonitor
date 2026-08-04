/* Bloomberg Live - native player bridge.

   Loaded before app.js and inert outside our own shells: with no message
   channel to find this returns immediately and app.js goes on using hls.js.

   Why it exists: hls.js decodes through Media Source Extensions, so every
   segment is fetched and remuxed in JavaScript, subject to CORS, with no HEVC.
   AVPlayer and ExoPlayer hand the bytes straight to the hardware decoder. So
   inside a shell the picture belongs to them and the page keeps everything
   else - header, clocks, menus, telemetry rail, remote navigation.

     page  -> shell   play / stop / level / mute / toggle / live / rect
     shell -> page    loading / playing / tracks / stats / error / fallback

   The picture is positioned by the page, because only the page knows where the
   stage sits between the two bars. */
(function(){
  "use strict";
  try{ if(localStorage.getItem("bbg.source")==="tvplus") localStorage.setItem("bbg.source","asia"); }catch(e){}

  var post=null,shell="";
  try{
    var mac=window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.bbgPlayer;
    if(mac){post=function(o){try{mac.postMessage(JSON.stringify(o));}catch(e){}};shell="mac";}
  }catch(e){}
  if(!post){try{if(window.BbgPlayer&&typeof window.BbgPlayer.post==="function"){post=function(o){try{window.BbgPlayer.post(JSON.stringify(o));}catch(e){}};shell="android";}}catch(e){}}
  window.__bbgShell=shell;
  if(!post)return;

  var api=null,live=false,dead=false,tracks=[],lockedH=null,muted=false,paused=false;
  var latency=NaN,lastRect="",bar=null,btnPlay=null,btnMute=null,fillEl=null,knobEl=null;
  var badge=null,badgeTimer=null,badgeState=null;
  /* Kept as a mechanism rather than deleted: a shell can legitimately offer a
     feed a browser engine cannot decode. Empty because the one entry that was
     here could not be played on any of the three engines from this network. */
  var EXTRA=[];
  var TARGET_LAT=18,BEHIND_LAT=28,BADGE_MS=1800;

  var PLAY='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 4.8v14.4l11.2-7.2z"/></svg>';
  var PAUSE='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 4.6h3.4v14.8H7zm6.6 0H17v14.8h-3.4z"/></svg>';
  var SOUND='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9.2h3.4L12 5.2v13.6L7.4 14.8H4z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M15.4 9.3a3.8 3.8 0 010 5.4M18.1 6.8a7.4 7.4 0 010 10.4"/></svg>';
  var MUTED='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9.2h3.4L12 5.2v13.6L7.4 14.8H4z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M15.6 9.6l4.8 4.8m0-4.8l-4.8 4.8"/></svg>';
  var FULL='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M4.5 9.2V4.5h4.7M19.5 9.2V4.5h-4.7M4.5 14.8v4.7h4.7M19.5 14.8v4.7h-4.7"/></svg>';

  var style=document.createElement("style");
  style.textContent=
    "html.native,html.native body{background:transparent!important}html.native .ambient{display:none!important}"+
    /* WebKit's own inline control proportions: a rounded rectangle inset ten
       points, 40 points tall, 28 point buttons, 16 point glyphs, a four point
       track and a twelve point knob. */
    ".nbar{position:absolute;left:10px;right:10px;bottom:10px;z-index:6;height:40px;display:flex;align-items:center;gap:2px;padding:0 8px;border-radius:11px;border:1px solid rgba(255,255,255,.08);background:rgba(38,38,40,.62);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);box-shadow:0 3px 14px rgba(0,0,0,.34);opacity:0;pointer-events:none;transform:translateY(6px);transition:opacity .18s ease,transform .18s ease}"+
    ".screen:hover .nbar,.nbar:focus-within{opacity:1;pointer-events:auto;transform:none}"+
    /* Cinema mode floats the rail over the picture, so the stage reaches the
       window's bottom edge. placeBar() measures the rail's content height;
       this is only the fallback for the tick before that runs. And the same
       idle state that fades the header and rail has to fade this, because in
       fullscreen a motionless pointer keeps :hover true forever. */
    "body.cinema .nbar{bottom:50px}body.cinema:not(.idle) .nbar{opacity:1;pointer-events:auto;transform:none}body.cinema.idle .nbar{opacity:0!important;pointer-events:none;transform:translateY(6px)}"+
    ".nbar button{appearance:none;-webkit-appearance:none;border:0;padding:0;background:transparent;color:#fff;width:28px;height:28px;flex:0 0 auto;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer}.nbar button:hover{background:rgba(255,255,255,.15)}.nbar svg{width:16px;height:16px;display:block}"+
    ".ntrack{flex:1 1 auto;min-width:40px;height:20px;display:flex;align-items:center;cursor:pointer;padding:0 8px}.nrail{position:relative;width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,.30)}.nfill{position:absolute;inset:0 auto 0 0;width:100%;border-radius:2px;background:#fff;transition:width .4s linear}.nknob{position:absolute;top:50%;left:100%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.55);transition:left .4s linear}"+
    ".nlive{flex:0 0 auto;display:flex;align-items:center;gap:5px;padding:0 8px 0 4px;font-size:11px;font-weight:500;letter-spacing:.06em;color:rgba(255,255,255,.86)}.nlive i{width:6px;height:6px;border-radius:50%;background:#27d17c}.nbar.behind .nfill,.nbar.behind .nknob,.nbar.behind .nlive i{background:#ff6a00}.nbar.behind .nlive{color:#ff9a4d}"+
    /* A remote cannot hover, so the bar can never be revealed on a television
       and its buttons would only add stops to the D-pad's path. */
    "body.tv .nbar{display:none!important}"+
    /* Which is why the television gets the shape every set-top player uses
       instead: one large circle in the middle of the picture, readable from
       across a room. Only there - with a pointer the bar is better, and two
       indicators of the same fact is one too many. */
    ".nbadge{display:none;position:absolute;left:50%;top:50%;z-index:7;width:104px;height:104px;margin:-52px 0 0 -52px;border-radius:50%;align-items:center;justify-content:center;pointer-events:none;color:#fff;background:rgba(8,10,14,.58);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border:2px solid rgba(255,255,255,.86);box-shadow:0 10px 34px rgba(0,0,0,.5);opacity:0;transform:scale(.82);transition:opacity .2s ease,transform .2s cubic-bezier(.2,.8,.3,1)}"+
    "body.tv .nbadge{display:flex}.nbadge.on{opacity:1;transform:scale(1)}.nbadge svg{width:46px;height:46px;display:block}";
  document.head.appendChild(style);

  function rate(bps){if(!bps)return"";return bps>=1000000?Math.round(bps/100000)/10+" Mbps":Math.round(bps/1000)+" kbps";}

  /* CSS pixels, measured from the stage. The shell converts to its own units. */
  function sendRect(){
    if(!live||!api)return;var r;try{r=api.screen.getBoundingClientRect();}catch(e){return;}
    if(!r||!r.width||!r.height)return;var dpr=window.devicePixelRatio||1;
    var key=[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height),dpr].join(",");
    if(key===lastRect)return;lastRect=key;post({a:"rect",x:r.left,y:r.top,w:r.width,h:r.height,dpr:dpr,vw:innerWidth,vh:innerHeight});
  }

  /* Two layouts. Ordinarily the rail is a flex row under the stage and ten
     points above the stage is ten points above the rail. In cinema mode the
     rail is fixed over the picture, and its top 20 points are empty gradient -
     counting those is what lifted the bar too far. Measure the content height:
     total height minus the top padding, plus a three point gap. */
  function placeBar(){
    if(!bar)return;var lift=10;
    try{var rail=document.querySelector(".rail"),cs;if(rail&&(cs=getComputedStyle(rail)).position==="fixed"){var h=rail.getBoundingClientRect().height,emptyTop=parseFloat(cs.paddingTop)||0;if(h>0)lift=Math.max(10,Math.round(h-emptyTop+3));}}catch(e){}
    var v=lift+"px";if(bar.style.bottom!==v)bar.style.bottom=v;
  }
  addEventListener("resize",function(){lastRect="";sendRect();placeBar();});
  /* Cinema mode, hiding the bars and a fullscreen transition all change the
     stage without firing a resize, and they also change the rail this bar has
     to clear. */
  setInterval(function(){sendRect();placeBar();},400);

  function button(icon,label,fn){var b=document.createElement("button");b.type="button";b.tabIndex=-1;b.innerHTML=icon;b.title=label;b.setAttribute("aria-label",label);b.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();fn();});return b;}

  function sync(){
    if(btnPlay){btnPlay.innerHTML=paused?PLAY:PAUSE;btnPlay.title=paused?"\u64ad\u653e":"\u6682\u505c";}
    if(btnMute){btnMute.innerHTML=muted?MUTED:SOUND;btnMute.title=muted?"\u53d6\u6d88\u9759\u97f3":"\u9759\u97f3";}
    syncBadge();
    if(!fillEl||!knobEl)return;
    /* At or inside the target offset the knob sits flush right, which is what
       live looks like. Past it the knob retreats, but only across the last
       quarter: this is seconds behind an edge, not a position in a recording. */
    var frac=1;if(isFinite(latency)&&latency>TARGET_LAT)frac=1-Math.min((latency-TARGET_LAT)/45,.26);
    var pct=Math.round(frac*1000)/10+"%";fillEl.style.width=pct;knobEl.style.left=pct;
    if(bar)bar.classList.toggle("behind",isFinite(latency)&&latency>BEHIND_LAT);
  }

  function buildBar(){
    if(bar||!api||!api.screen)return;bar=document.createElement("div");bar.className="nbar";
    btnPlay=button(PAUSE,"\u64ad\u653e / \u6682\u505c",function(){post({a:"toggle"});});
    var track=document.createElement("div");track.className="ntrack";track.title="\u76f4\u64ad\u4e0d\u53ef\u62d6\u52a8\uff1b\u70b9\u4e00\u4e0b\u56de\u5230\u76f4\u64ad";
    var rail=document.createElement("div");rail.className="nrail";fillEl=document.createElement("div");fillEl.className="nfill";knobEl=document.createElement("div");knobEl.className="nknob";rail.appendChild(fillEl);rail.appendChild(knobEl);track.appendChild(rail);
    track.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();post({a:"live"});});
    var tag=document.createElement("span");tag.className="nlive";tag.innerHTML="<i></i>LIVE";
    btnMute=button(SOUND,"\u9759\u97f3 / \u53d6\u6d88\u9759\u97f3",function(){post({a:"mute",on:!muted});});
    /* Deliberately the page's own fullscreen control rather than a second
       implementation: that button already knows to ask the shell to take the
       window fullscreen instead of expanding an element inside a window that
       stays put. */
    var full=button(FULL,"\u5168\u5c4f",function(){var f=document.getElementById("fsBtn");if(f)f.click();});
    bar.appendChild(btnPlay);bar.appendChild(track);bar.appendChild(tag);bar.appendChild(btnMute);bar.appendChild(full);api.screen.appendChild(bar);placeBar();sync();
  }

  /* ---------- The television's badge ----------
     Shows when focus arrives on the picture, and whenever the play state
     changes. Goes on blur, and 1.8s after appearing while playing - a badge
     parked over a news channel is worse than no badge. It stays while paused,
     because that is the one state a viewer cannot infer from the picture.
     pointer-events:none throughout: Enter on the focused picture already
     toggles playback, and this must not become a second target. */
  function buildBadge(){
    if(badge||!api||!api.screen)return;
    badge=document.createElement("div");badge.className="nbadge";badge.setAttribute("aria-hidden","true");badge.innerHTML=PAUSE;badgeState=false;
    api.screen.appendChild(badge);
    api.screen.addEventListener("focus",function(){flashBadge();});
    api.screen.addEventListener("blur",function(){if(badgeTimer){clearTimeout(badgeTimer);badgeTimer=null;}if(badge)badge.classList.remove("on");});
    try{ if(document.activeElement===api.screen) flashBadge(); }catch(e){}
  }
  function flashBadge(){
    if(!badge)return;
    badge.innerHTML=paused?PLAY:PAUSE;badgeState=paused;badge.classList.add("on");
    if(badgeTimer){clearTimeout(badgeTimer);badgeTimer=null;}
    if(!paused)badgeTimer=setTimeout(function(){badgeTimer=null;if(badge)badge.classList.remove("on");},BADGE_MS);
  }
  function syncBadge(){
    if(!badge||paused===badgeState)return;
    var focused=false;try{focused=(document.activeElement===api.screen);}catch(e){}
    if(!focused){badgeState=paused;return;}
    flashBadge();
  }

  /* Bound on the document in the capture phase so it runs before app.js's own
     stage handler, which operates the hidden video element. */
  document.addEventListener("click",function(e){
    if(!live||!api||!api.screen||!api.screen.contains(e.target))return;
    try{if(e.target.closest("button,a,input,select,textarea,[role='button'],#state,.nbar"))return;}catch(x){}
    e.preventDefault();e.stopPropagation();
    if(muted){muted=false;post({a:"mute",on:false});api.screen.classList.remove("mutedState");sync();return;}
    post({a:"toggle"});
  },true);

  function markQuality(){var v=lockedH?String(lockedH):"auto";[].slice.call(api.qList.querySelectorAll(".q-item")).forEach(function(b){b.setAttribute("aria-selected",b.getAttribute("data-level")===v?"true":"false");});api.qMode.textContent=lockedH?lockedH+"p":"\u81ea\u52a8";api.qSrc.textContent=lockedH?"\u5df2\u9501\u5b9a":"\u81ea\u9002\u5e94";api.qFoot.hidden=true;}
  function choose(h,remember){lockedH=h>0?h:null;post({a:"level",h:h>0?h:-1});if(remember)api.savePref(h>0?String(h):"auto");markQuality();}
  /* Built from the rungs the shell actually reports, so the list is the feed's
     real ladder. A pick resolves downwards only: exact rung, then the best
     below it, then auto. */
  function buildQuality(){
    if(!tracks.length){api.qBtn.disabled=true;return;}var html=api.itemHtml("auto","\u81ea\u52a8","","");tracks.forEach(function(t){html+=api.itemHtml(String(t.h),t.h+"p",t.h>=1080?"FHD":(t.h>=720?"HD":""),rate(t.bps));});api.qList.innerHTML=html;api.qBtn.disabled=false;
    [].slice.call(api.qList.querySelectorAll(".q-item")).forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();var v=b.getAttribute("data-level");choose(v==="auto"?-1:parseInt(v,10),true);api.closeQMenu();api.qBtn.focus();});});
    var want=api.pref(),h=want==="auto"?-1:parseInt(want,10),best=-1;if(h>0){tracks.forEach(function(t){if(t.h<=h&&t.h>best)best=t.h;});h=best;}choose(h>0?h:-1,false);
  }

  /* app.js stops its own telemetry loop while the video element is hidden, so
     the rail is filled from here, with the same wording and thresholds. */
  function onStats(d){
    muted=!!d.muted;paused=!!d.paused;api.screen.classList.toggle("mutedState",muted);
    api.statRate.textContent=d.bps?"\u7801\u7387 "+rate(d.bps):"\u7801\u7387 \u2014";
    var buf=typeof d.buf==="number"&&isFinite(d.buf)?d.buf:NaN;api.statBuf.textContent=isFinite(buf)?"\u7f13\u51b2 "+buf.toFixed(1)+"s":"\u7f13\u51b2 \u2014";api.statBuf.classList.toggle("thin",isFinite(buf)&&buf<4);
    latency=typeof d.lat==="number"&&isFinite(d.lat)?d.lat:NaN;api.statLat.textContent=isFinite(latency)?"\u5ef6\u8fdf "+latency.toFixed(1)+"s":"\u5ef6\u8fdf \u2014";api.statLat.title="\u5f53\u524d\u753b\u9762\u8ddd\u79bb\u76f4\u64ad\u8fb9\u7f18\u7684\u65f6\u95f4\u5dee";
    var behind=isFinite(latency)&&latency>BEHIND_LAT;api.liveBtn.classList.toggle("behind",behind);api.liveTxt.textContent=behind?"\u56de\u5230\u76f4\u64ad":"LIVE";api.qRes.textContent=d.h?(d.w||"?")+"\u00d7"+d.h:"\u2014";sync();
  }

  window.__bbgNativeEvent=function(json){
    var d;try{d=typeof json==="string"?JSON.parse(json):json;}catch(e){return;}if(!d||!api||!live)return;
    if(d.t==="loading")api.showLoading(d.msg||"\u6b63\u5728\u8fde\u63a5 Bloomberg \u76f4\u64ad\u2026");
    else if(d.t==="playing"){api.clearState();lastRect="";sendRect();placeBar();}
    else if(d.t==="tracks"){tracks=(d.list||[]).filter(function(t){return t&&t.h;}).sort(function(a,b){return b.h-a.h;});buildQuality();}
    else if(d.t==="stats")onStats(d);
    else if(d.t==="error")api.scheduleRetry("\u76f4\u64ad\u8fde\u63a5\u4e2d\u65ad",d.msg||"");
    else if(d.t==="fallback"){
      /* The native player could not open this feed. Switch off for the session
         and hand the picture back. WebKit's own controls return with the video
         element, so both of ours have to go or the picture would carry two. */
      dead=true;live=false;document.documentElement.classList.remove("native");post({a:"stop"});
      if(badgeTimer){clearTimeout(badgeTimer);badgeTimer=null;}
      [bar,badge].forEach(function(x){if(x&&x.parentNode)x.parentNode.removeChild(x);});
      bar=badge=null;btnPlay=btnMute=fillEl=knobEl=null;badgeState=null;
      api.restart();
    }
  };

  window.__bbgNative={
    start:function(url,handle){
      if(dead)return false;api=handle;live=true;document.documentElement.classList.add("native");
      /* Hiding the element is also what stops app.js running a second telemetry
         loop and a second unmute path against a decoder that plays nothing. */
      try{api.video.pause();api.video.removeAttribute("src");api.video.load();}catch(e){}
      api.video.style.display="none";
      tracks=[];lockedH=null;lastRect="";paused=false;latency=NaN;
      api.qBtn.disabled=true;api.qMode.textContent="\u81ea\u52a8";api.qRes.textContent="\u2014";
      buildBar();buildBadge();post({a:"play",url:url,muted:!api.wantSound()});sendRect();return true;
    },
    active:function(){return live;},
    /* app.js has to know whether this layer gave up, so it waits for hls.js
       instead of assuming a player is already there. */
    gaveUp:function(){return dead;},
    live:function(){if(!live)return false;post({a:"live"});return true;},
    togglePlay:function(){if(!live)return false;post({a:"toggle"});return true;},
    toggleMute:function(){if(!live)return false;post({a:"mute",on:!muted});return true;},
    setMuted:function(on){if(!live)return false;post({a:"mute",on:!!on});return true;},
    extraSources:EXTRA
  };
  /* A getter, not a copied value: a snapshot taken here would read false for
     the rest of the session, which is the same bug in a different spelling. */
  try{Object.defineProperty(window.__bbgNative,"dead",{get:function(){return dead;},enumerable:false,configurable:true});}catch(e){window.__bbgNative.dead=false;}
})();
