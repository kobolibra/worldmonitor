/* Bloomberg Live native bridge. Kept deliberately self-contained: the page owns
   all chrome; the shell owns only decoded pictures and playback telemetry. */
(function(){
  "use strict";

  try{
    if(localStorage.getItem("bbg.source") === "tvplus") localStorage.setItem("bbg.source", "asia");
  }catch(e){}

  var post = null, shell = "";
  try{
    var mac = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bbgPlayer;
    if(mac){ post = function(o){ try{ mac.postMessage(JSON.stringify(o)); }catch(e){} }; shell = "mac"; }
  }catch(e){}
  if(!post){
    try{
      if(window.BbgPlayer && typeof window.BbgPlayer.post === "function"){
        post = function(o){ try{ window.BbgPlayer.post(JSON.stringify(o)); }catch(e){} };
        shell = "android";
      }
    }catch(e){}
  }
  window.__bbgShell = shell;
  if(!post) return;

  var api = null, live = false, dead = false, startedUrl = "";
  var tracks = [], lockedH = null, muted = false, paused = false;
  var edgeLatency = NaN, displayLatency = NaN, lastRect = "";
  var bar = null, btnPlay = null, btnMute = null, fillEl = null, knobEl = null;
  var badge = null, badgeTimer = null, badgeState = null;
  var clockEdgeMs = NaN, clockTimer = null, clockGeneration = 0;
  var EXTRA = [];
  var TARGET_LAT = 18, BEHIND_LAT = 28, BADGE_MS = 1800;

  var PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 4.8v14.4l11.2-7.2z"/></svg>';
  var PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 4.6h3.4v14.8H7zm6.6 0H17v14.8h-3.4z"/></svg>';
  var SOUND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9.2h3.4L12 5.2v13.6L7.4 14.8H4z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M15.4 9.3a3.8 3.8 0 010 5.4M18.1 6.8a7.4 7.4 0 010 10.4"/></svg>';
  var MUTED = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9.2h3.4L12 5.2v13.6L7.4 14.8H4z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M15.6 9.6l4.8 4.8m0-4.8l-4.8 4.8"/></svg>';
  var FULL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M4.5 9.2V4.5h4.7M19.5 9.2V4.5h-4.7M4.5 14.8v4.7h4.7M19.5 14.8v4.7h-4.7"/></svg>';

  var style = document.createElement("style");
  style.textContent =
    "html.native,html.native body{background:transparent!important}html.native .ambient{display:none!important}"+
    ".nbar{position:absolute;left:10px;right:10px;bottom:10px;z-index:6;height:40px;display:flex;align-items:center;gap:2px;padding:0 8px;border-radius:11px;border:1px solid rgba(255,255,255,.08);background:rgba(38,38,40,.62);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);box-shadow:0 3px 14px rgba(0,0,0,.34);opacity:0;pointer-events:none;transform:translateY(6px);transition:opacity .18s ease,transform .18s ease}"+
    ".screen:hover .nbar,.nbar:focus-within{opacity:1;pointer-events:auto;transform:none}"+
    "body.cinema .nbar{bottom:50px}body.cinema:not(.idle) .nbar{opacity:1;pointer-events:auto;transform:none}body.cinema.idle .nbar{opacity:0!important;pointer-events:none;transform:translateY(6px)}"+
    ".nbar button{appearance:none;-webkit-appearance:none;border:0;padding:0;background:transparent;color:#fff;width:28px;height:28px;flex:0 0 auto;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer}.nbar button:hover{background:rgba(255,255,255,.15)}.nbar button:active{background:rgba(255,255,255,.24)}.nbar svg{width:16px;height:16px;display:block}"+
    ".ntrack{flex:1 1 auto;min-width:40px;height:20px;display:flex;align-items:center;cursor:pointer;padding:0 8px}.nrail{position:relative;width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,.30)}.nfill{position:absolute;inset:0 auto 0 0;width:100%;border-radius:2px;background:#fff;transition:width .4s linear}.nknob{position:absolute;top:50%;left:100%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.55);transition:left .4s linear}"+
    ".nlive{flex:0 0 auto;display:flex;align-items:center;gap:5px;padding:0 8px 0 4px;font:inherit;font-size:11px;font-weight:500;letter-spacing:.06em;font-variant-numeric:tabular-nums;color:rgba(255,255,255,.86)}.nlive i{width:6px;height:6px;border-radius:50%;background:#27d17c}.nbar.behind .nfill,.nbar.behind .nknob,.nbar.behind .nlive i{background:#ff6a00}.nbar.behind .nlive{color:#ff9a4d}"+
    "body.tv .nbar{display:none!important}.nbadge{display:none;position:absolute;left:50%;top:50%;z-index:7;width:104px;height:104px;margin:-52px 0 0 -52px;border-radius:50%;align-items:center;justify-content:center;pointer-events:none;color:#fff;background:rgba(8,10,14,.58);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border:2px solid rgba(255,255,255,.86);box-shadow:0 10px 34px rgba(0,0,0,.5);opacity:0;transform:scale(.82);transition:opacity .2s ease,transform .2s ease}body.tv .nbadge{display:flex}.nbadge.on{opacity:1;transform:scale(1)}.nbadge svg{width:46px;height:46px}";
  document.head.appendChild(style);

  function rate(bps){
    if(!bps) return "";
    return bps >= 1000000 ? Math.round(bps/100000)/10+" Mbps" : Math.round(bps/1000)+" kbps";
  }
  function sendRect(){
    if(!live || !api) return;
    var r;
    try{ r = api.screen.getBoundingClientRect(); }catch(e){ return; }
    if(!r || !r.width || !r.height) return;
    var dpr = window.devicePixelRatio || 1;
    var key = [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height),dpr].join(",");
    if(key === lastRect) return;
    lastRect = key;
    post({a:"rect",x:r.left,y:r.top,w:r.width,h:r.height,dpr:dpr,vw:innerWidth,vh:innerHeight});
  }
  function placeBar(){
    if(!bar) return;
    var lift = 10;
    try{
      var rail = document.querySelector(".rail"), cs;
      if(rail && (cs=getComputedStyle(rail)).position === "fixed"){
        var h = rail.getBoundingClientRect().height;
        var emptyTop = parseFloat(cs.paddingTop) || 0;
        if(h > 0) lift = Math.max(10, Math.round(h-emptyTop+3));
      }
    }catch(e){}
    var v=lift+"px";
    if(bar.style.bottom!==v) bar.style.bottom=v;
  }
  addEventListener("resize",function(){ lastRect="";sendRect();placeBar(); });
  setInterval(function(){ sendRect();placeBar(); },400);

  function button(icon,label,fn){
    var b=document.createElement("button"); b.type="button"; b.tabIndex=-1; b.innerHTML=icon;
    b.title=label; b.setAttribute("aria-label",label);
    b.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();fn();}); return b;
  }
  function buildBar(){
    if(bar || !api || !api.screen) return;
    bar=document.createElement("div"); bar.className="nbar";
    btnPlay=button(PAUSE,"播放 / 暂停",function(){post({a:"toggle"});});
    var track=document.createElement("div"); track.className="ntrack"; track.title="点一下回到直播";
    var rail=document.createElement("div"); rail.className="nrail";
    fillEl=document.createElement("div"); fillEl.className="nfill";
    knobEl=document.createElement("div"); knobEl.className="nknob";
    rail.appendChild(fillEl); rail.appendChild(knobEl); track.appendChild(rail);
    track.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();post({a:"live"});});
    var tag=document.createElement("span"); tag.className="nlive"; tag.innerHTML="<i></i>LIVE";
    btnMute=button(SOUND,"静音 / 取消静音",function(){post({a:"mute",on:!muted});});
    var full=button(FULL,"全屏",function(){var f=document.getElementById("fsBtn");if(f)f.click();});
    bar.appendChild(btnPlay);bar.appendChild(track);bar.appendChild(tag);bar.appendChild(btnMute);bar.appendChild(full);
    api.screen.appendChild(bar);placeBar();syncControls();
  }
  function buildBadge(){
    if(badge || !api || !api.screen) return;
    badge=document.createElement("div");badge.className="nbadge";badge.setAttribute("aria-hidden","true");badge.innerHTML=PAUSE;
    api.screen.appendChild(badge);badgeState=false;
    api.screen.addEventListener("focus",flashBadge);
    api.screen.addEventListener("blur",function(){clearTimeout(badgeTimer);badge.classList.remove("on");});
  }
  function flashBadge(){
    if(!badge)return;badge.innerHTML=paused?PLAY:PAUSE;badgeState=paused;badge.classList.add("on");clearTimeout(badgeTimer);
    if(!paused)badgeTimer=setTimeout(function(){if(badge)badge.classList.remove("on");},BADGE_MS);
  }
  function syncControls(){
    if(btnPlay){btnPlay.innerHTML=paused?PLAY:PAUSE;btnPlay.title=paused?"播放":"暂停";}
    if(btnMute){btnMute.innerHTML=muted?MUTED:SOUND;btnMute.title=muted?"取消静音":"静音";}
    if(badge && badgeState!==paused){
      var focused=false;try{focused=document.activeElement===api.screen;}catch(e){}
      if(focused)flashBadge();else badgeState=paused;
    }
    if(!fillEl||!knobEl)return;
    var l=isFinite(displayLatency)?displayLatency:edgeLatency,frac=1;
    if(isFinite(l)&&l>TARGET_LAT)frac=1-Math.min((l-TARGET_LAT)/45,.26);
    var pct=Math.round(frac*1000)/10+"%";fillEl.style.width=pct;knobEl.style.left=pct;
    if(bar)bar.classList.toggle("behind",isFinite(l)&&l>BEHIND_LAT);
  }

  document.addEventListener("click",function(e){
    if(!live||!api||!api.screen||!api.screen.contains(e.target))return;
    try{if(e.target.closest("button,a,input,select,textarea,[role='button'],#state,.nbar"))return;}catch(x){}
    e.preventDefault();e.stopPropagation();
    if(muted){muted=false;post({a:"mute",on:false});syncControls();return;} post({a:"toggle"});
  },true);

  function markQuality(){
    var v=lockedH?String(lockedH):"auto";
    [].slice.call(api.qList.querySelectorAll(".q-item")).forEach(function(b){b.setAttribute("aria-selected",b.getAttribute("data-level")===v?"true":"false");});
    api.qMode.textContent=lockedH?lockedH+"p":"自动";api.qSrc.textContent=lockedH?"已锁定":"自适应";api.qFoot.hidden=true;
  }
  function choose(h,remember){lockedH=h>0?h:null;post({a:"level",h:h>0?h:-1});if(remember)api.savePref(h>0?String(h):"auto");markQuality();}
  function buildQuality(){
    if(!tracks.length){api.qBtn.disabled=true;return;}
    var html=api.itemHtml("auto","自动","","");
    tracks.forEach(function(t){html+=api.itemHtml(String(t.h),t.h+"p",t.h>=1080?"FHD":(t.h>=720?"HD":""),rate(t.bps));});
    api.qList.innerHTML=html;api.qBtn.disabled=false;
    [].slice.call(api.qList.querySelectorAll(".q-item")).forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();var v=b.getAttribute("data-level");choose(v==="auto"?-1:parseInt(v,10),true);api.closeQMenu();api.qBtn.focus();});});
    var want=api.pref(),h=want==="auto"?-1:parseInt(want,10),best=-1;
    if(h>0){tracks.forEach(function(t){if(t.h<=h&&t.h>best)best=t.h;});h=best;} choose(h>0?h:-1,false);
  }

  function absoluteUrl(path,base){try{return new URL(path,base).href;}catch(e){return "";}}
  function firstVariant(text,base){
    var lines=text.split(/\r?\n/),want=false;
    for(var i=0;i<lines.length;i++){
      var s=lines[i].trim();
      if(s.indexOf("#EXT-X-STREAM-INF:")===0){want=true;continue;}
      if(want&&s&&s[0]!=="#")return absoluteUrl(s,base);
    }
    return "";
  }
  function programEdge(text){
    var lines=text.split(/\r?\n/),cursor=NaN,duration=0,saw=false;
    for(var i=0;i<lines.length;i++){
      var s=lines[i].trim();
      if(s.indexOf("#EXT-X-PROGRAM-DATE-TIME:")===0){
        var d=Date.parse(s.slice(25));if(isFinite(d)){cursor=d;saw=true;} continue;
      }
      if(s.indexOf("#EXTINF:")===0){duration=parseFloat(s.slice(8))||0;continue;}
      if(s&&s[0]!=="#"){if(isFinite(cursor))cursor+=duration*1000;duration=0;}
    }
    return saw?cursor:NaN;
  }
  function fetchText(url){return fetch(url,{cache:"no-store",credentials:"omit"}).then(function(r){if(!r.ok)throw Error(String(r.status));return r.text().then(function(t){return {text:t,url:r.url||url};});});}
  function refreshClock(gen){
    if(!live||gen!==clockGeneration||!startedUrl)return;
    fetchText(startedUrl).then(function(master){
      var child=firstVariant(master.text,master.url);return child?fetchText(child):master;
    }).then(function(media){
      if(gen!==clockGeneration)return;var edge=programEdge(media.text);
      if(isFinite(edge))clockEdgeMs=edge;
    }).catch(function(){});
  }
  function startClock(){
    clockGeneration++;var gen=clockGeneration;clockEdgeMs=NaN;clearInterval(clockTimer);refreshClock(gen);
    clockTimer=setInterval(function(){refreshClock(gen);},5000);
  }
  function stopClock(){clockGeneration++;clearInterval(clockTimer);clockTimer=null;clockEdgeMs=NaN;}

  function onStats(d){
    muted=!!d.muted;paused=!!d.paused;api.screen.classList.toggle("mutedState",muted);
    api.statRate.textContent=d.bps?"码率 "+rate(d.bps):"码率 —";
    var buf=typeof d.buf==="number"&&isFinite(d.buf)?d.buf:NaN;
    api.statBuf.textContent=isFinite(buf)?"缓冲 "+buf.toFixed(1)+"s":"缓冲 —";api.statBuf.classList.toggle("thin",isFinite(buf)&&buf<4);
    edgeLatency=typeof d.lat==="number"&&isFinite(d.lat)?d.lat:NaN;
    displayLatency=NaN;
    if(isFinite(clockEdgeMs)&&isFinite(edgeLatency)){
      var v=(Date.now()-clockEdgeMs)/1000+edgeLatency;
      if(v>=0&&v<3600)displayLatency=v;
    }
    if(isFinite(displayLatency)){
      api.statLat.textContent="实延 ≈"+displayLatency.toFixed(1)+"s";
      api.statLat.title="节目时间戳测得的端到端延迟估计\n包括编码、封装、CDN 分发与本机播放缓冲\n精度受信号源时钟和分片边界影响";
    }else{
      api.statLat.textContent=isFinite(edgeLatency)?"边缘差 "+edgeLatency.toFixed(1)+"s":"延迟 —";
      api.statLat.title="该信号源暂未提供可用的节目时间戳；这里只显示画面落后播放列表边缘的时间，不能冒充真实端到端延迟";
    }
    var l=isFinite(displayLatency)?displayLatency:edgeLatency,behind=isFinite(l)&&l>BEHIND_LAT;
    api.liveBtn.classList.toggle("behind",behind);api.liveTxt.textContent=behind?"回到直播":"LIVE";
    api.qRes.textContent=d.h?(d.w||"?")+"×"+d.h:"—";syncControls();
  }

  window.__bbgNativeEvent=function(json){
    var d;try{d=typeof json==="string"?JSON.parse(json):json;}catch(e){return;}
    if(!d||!api||!live)return;
    if(d.t==="loading")api.showLoading(d.msg||"正在连接 Bloomberg 直播…");
    else if(d.t==="playing"){api.clearState();lastRect="";sendRect();placeBar();}
    else if(d.t==="tracks"){tracks=(d.list||[]).filter(function(t){return t&&t.h;}).sort(function(a,b){return b.h-a.h;});buildQuality();}
    else if(d.t==="stats")onStats(d);
    else if(d.t==="error")api.scheduleRetry("直播连接中断",d.msg||"");
    else if(d.t==="fallback"){
      dead=true;live=false;stopClock();document.documentElement.classList.remove("native");post({a:"stop"});
      [bar,badge].forEach(function(x){if(x&&x.parentNode)x.parentNode.removeChild(x);});bar=badge=null;btnPlay=btnMute=fillEl=knobEl=null;
      api.restart();
    }
  };

  window.__bbgNative={
    start:function(url,handle){
      if(dead)return false;api=handle;live=true;startedUrl=url;document.documentElement.classList.add("native");
      try{api.video.pause();api.video.removeAttribute("src");api.video.load();}catch(e){} api.video.style.display="none";
      tracks=[];lockedH=null;lastRect="";paused=false;edgeLatency=displayLatency=NaN;api.qBtn.disabled=true;api.qMode.textContent="自动";api.qRes.textContent="—";
      buildBar();buildBadge();startClock();post({a:"play",url:url,muted:!api.wantSound()});sendRect();return true;
    },
    active:function(){return live;},gaveUp:function(){return dead;},
    live:function(){if(!live)return false;post({a:"live"});return true;},
    togglePlay:function(){if(!live)return false;post({a:"toggle"});return true;},
    toggleMute:function(){if(!live)return false;post({a:"mute",on:!muted});return true;},
    setMuted:function(on){if(!live)return false;post({a:"mute",on:!!on});return true;},
    extraSources:EXTRA
  };
  try{Object.defineProperty(window.__bbgNative,"dead",{get:function(){return dead;}});}catch(e){window.__bbgNative.dead=false;}
})();
