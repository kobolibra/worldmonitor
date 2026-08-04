/* Emergency safe mode.

   The native bridge is intentionally disabled while the macOS runtime crash
   and the rewritten bridge are investigated.  Leaving this file valid and
   inert makes app.js take its long-standing hls.js path in ordinary browsers
   and in every app shell.  That path does not depend on this file and was the
   last known working cross-platform fallback.

   Do not expose a partial __bbgNative object here: app.js treats its presence
   as ownership of the picture and would skip the web decoder. */
(function(){
  "use strict";
  window.__bbgShell = "";
})();
