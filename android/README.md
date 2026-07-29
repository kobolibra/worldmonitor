# Bloomberg Live - Android shell

A thin, dependency-free native wrapper around
<https://kobolibra.github.io/worldmonitor/>.

## What it is

One `Activity`, one `WebView`, no libraries. The APK is a few hundred kilobytes
and has no transitive dependencies to audit.

The page is **loaded from the network**, not bundled into `assets/`. The app is
useless without a connection anyway - it is a live stream - and loading remotely
means every later fix to `index.html` on the `gh-pages` branch reaches the phone
with no rebuild and no reinstall.

## The parts that a naive wrapper gets wrong

| Concern | Handling |
| --- | --- |
| Autoplay | `setMediaPlaybackRequiresUserGesture(false)`. Otherwise nothing plays until you tap. |
| Saved preferences | `setDomStorageEnabled(true)`. The page stores source, quality and volume in `localStorage`. |
| Fullscreen button | `WebChromeClient.onShowCustomView` / `onHideCustomView`. WebView hands the host a view and expects the host to display it; omitting this is why the fullscreen button appears dead in most wrappers. |
| Rotation | A wide `configChanges` list, so the Activity is not recreated and the stream is not torn down and re-buffered. |
| Screen timeout | `FLAG_KEEP_SCREEN_ON`. |
| Launch flash | `windowBackground` set to the page's own `--bg`. |
| Back button | Exits fullscreen first, then navigates back, then leaves. |

## Building

CI does it. See `.github/workflows/android.yml`, which runs only on pushes to
the `android` branch under `android/**`, then attaches the APK to a GitHub
Release.

Locally, with the Android SDK and JDK 17 present:

```sh
cd android && gradle assembleDebug
```

## Signing

The published build is debug-signed, which is fine for sideloading onto your own
devices. It is **not** suitable for the Play Store, and a debug-signed build
cannot be upgraded in place by a release-signed one later - you would have to
uninstall first.
