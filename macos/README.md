# Bloomberg Live - macOS app

A native `WKWebView` window around
<https://kobolibra.github.io/worldmonitor/>.

## Why not Electron

Electron would ship an entire copy of Chromium to display a page that WebKit,
already present on every Mac, renders perfectly well. That is roughly 100 MB on
disk and several hundred MB of resident memory for a wrapper. This bundle is a
few hundred kilobytes, uses the system WebKit, and has no third party code in
it at all.

## Build

```sh
./macos/build.sh
```

Needs the Xcode command line tools and nothing else. Produces a universal
(arm64 + x86_64) binary, so one download works on both Apple Silicon and Intel
Macs.

CI runs the same script. There is no Xcode project, deliberately: the app is
one Swift file, one plist and a generated icon, and a `.pbxproj` would be more
lines of unreviewable generated XML than the app itself.

## The parts a naive wrapper gets wrong

| Concern | Handling |
| --- | --- |
| Autoplay | `mediaTypesRequiringUserActionForPlayback = []`. Otherwise the stream waits for a click. |
| Fullscreen button does nothing | Element fullscreen is **off by default** in WKWebView on macOS. Turned on via `isElementFullscreenEnabled`, with a KVC fallback below macOS 12.3. |
| Display sleeps mid stream | `beginActivity(.idleDisplaySleepDisabled)`, with the token retained for the app's lifetime. |
| Saved preferences | The default `WKWebsiteDataStore` is persistent, so the page's stored source, quality and volume survive relaunch. |
| No keyboard shortcuts | The bundle has no nib, so the main menu is built in code. Without it even Command Q does not exist. |
| White flash on launch | Dark window background plus `underPageBackgroundColor`. |
| Window forgets its size | `setFrameUsingName` then `setFrameAutosaveName`, centring only when there is nothing to restore. |

## Gatekeeper

The build is **ad hoc signed, not notarised**. Notarisation needs a paid Apple
Developer account, so the first launch will be refused with "cannot be opened
because Apple cannot check it for malicious software".

To get past it, either:

- **Right click the app, choose Open, then confirm.** Control click works too.
  A plain double click will not offer the option.
- Or clear the download quarantine flag:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Bloomberg Live.app"
  ```

This is only needed once per install.
