package com.bbglive.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackGroup;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * A shell around the deployed Bloomberg Live page.
 *
 * The page is loaded from the network rather than bundled into assets. That is
 * a deliberate trade: the app is useless without a connection anyway (it is a
 * live stream), and loading remotely means every later fix to index.html shows
 * up here without anyone rebuilding or reinstalling the APK.
 *
 * The picture, however, is no longer the page's job.
 *
 * Inside a WebView, hls.js has to fetch every segment in JavaScript, remux it
 * to fragmented MP4 in JavaScript, and feed the result through Media Source
 * Extensions. That path cannot decode HEVC at all, it refuses any origin that
 * does not send a CORS header, and the remuxing itself costs real work on every
 * segment. ExoPlayer has none of those three problems: it hands the bytes to
 * the hardware decoder, it performs no CORS check, and it speaks HLS natively.
 * It is what the set-top box applications that play this channel well are
 * using, and the difference is not subtle.
 *
 * So the layout is a sandwich. The player draws into a TextureView at the
 * bottom of the stack; the WebView sits on top of it, transparent, and keeps
 * everything else - the header, the clocks, the source and quality menus, the
 * telemetry rail, the remote navigation.
 *
 * A TextureView rather than a SurfaceView on purpose. A SurfaceView punches a
 * hole through the window and is composited below it, which would demand a
 * transparent window background and a transparent theme, and would still be at
 * the mercy of how a particular television's compositor orders the two. A
 * TextureView is an ordinary view in the hierarchy: put it at index 0 and the
 * WebView is simply drawn over it. It costs a little more GPU and it is worth
 * every bit of that here, because none of this can be tested from where it is
 * written.
 *
 * The page decides where the picture goes. It is the only side that knows where
 * the stage sits between the two bars, so it measures that rectangle and sends
 * it over; this class only fits the video's aspect ratio inside it. And if the
 * native player cannot open a feed at all, it says so and the page falls back
 * to hls.js rather than showing a black screen.
 */
@OptIn(markerClass = UnstableApi.class)
public class MainActivity extends Activity {

	private static final String HOME = "https://kobolibra.github.io/worldmonitor/";
	private static final String HOME_HOST = "kobolibra.github.io";
	private static final int BACKDROP = 0xFF06070A;

	/** Mirrors the hls.js settings in app.js, so both paths behave alike. */
	private static final long TARGET_OFFSET_MS = 18000L;
	private static final float MAX_LIVE_SPEED = 1.1f;

	private FrameLayout root;
	private WebView web;

	/** The view handed to us when the page enters HTML5 fullscreen. */
	private View customView;
	private WebChromeClient.CustomViewCallback customCallback;

	// ---- native playback ----
	private TextureView videoView;
	private ExoPlayer player;
	private final Handler ui = new Handler(Looper.getMainLooper());
	private Runnable statsTick;

	/** Stage rectangle in device pixels, as reported by the page. */
	private int stageX, stageY, stageW, stageH;
	private int videoW, videoH;
	private boolean muted;
	/** Two failures on one feed and we hand the picture back to hls.js. */
	private int failures;

	@SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
	@Override
	protected void onCreate(Bundle saved) {
		super.onCreate(saved);

		// A news channel that blanks out after 30 seconds is not a news channel.
		getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

		root = new FrameLayout(this);
		// The backdrop is painted here now, because the two views above it are
		// both see-through: the TextureView only covers the stage rectangle, and
		// the WebView is transparent.
		root.setBackgroundColor(BACKDROP);

		videoView = new TextureView(this);
		videoView.setOpaque(true);
		videoView.setVisibility(View.GONE);
		// A remote must never land here: the picture is a focus target inside the
		// page, not in the view hierarchy.
		videoView.setFocusable(false);
		videoView.setFocusableInTouchMode(false);
		root.addView(videoView, new FrameLayout.LayoutParams(1, 1, Gravity.TOP | Gravity.START));

		web = new WebView(this);
		// Transparent whether or not the native player is running: the page paints
		// its own opaque background unless it has handed the picture over.
		web.setBackgroundColor(Color.TRANSPARENT);
		root.addView(web, new FrameLayout.LayoutParams(
				ViewGroup.LayoutParams.MATCH_PARENT,
				ViewGroup.LayoutParams.MATCH_PARENT));
		setContentView(root);

		// On a television the only input device is a remote, which arrives as
		// D-pad key events. Those events are delivered to whatever holds focus,
		// so if the WebView never takes focus the page never sees an arrow key
		// and none of its controls can be reached. This is the usual reason a
		// WebView app looks frozen to a remote while working fine under a touch
		// screen.
		web.setFocusable(true);
		web.setFocusableInTouchMode(true);
		web.requestFocus();

		WebSettings s = web.getSettings();
		s.setJavaScriptEnabled(true);
		// The page keeps the chosen source, quality and volume in localStorage.
		// Without this they reset on every launch.
		s.setDomStorageEnabled(true);
		// Without this the stream will not start until the user taps, which
		// defeats the point of a dedicated app.
		s.setMediaPlaybackRequiresUserGesture(false);
		s.setUseWideViewPort(true);
		s.setLoadWithOverviewMode(true);
		s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
		s.setJavaScriptCanOpenWindowsAutomatically(false);
		s.setSupportMultipleWindows(false);
		s.setAllowFileAccess(false);
		s.setAllowContentAccess(false);
		s.setBuiltInZoomControls(false);
		s.setDisplayZoomControls(false);
		s.setTextZoom(100);
		s.setCacheMode(WebSettings.LOAD_DEFAULT);

		// The manifest already disables Safe Browsing, but some vendor WebView
		// builds only honour it as a per instance setting, so both are set. The
		// check blocks the load on a reply from a Google service that is not
		// reachable here, and the page being loaded is a static file we publish
		// ourselves, so there is nothing for it to protect against.
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			s.setSafeBrowsingEnabled(false);
		}

		// The channel the page uses to ask for playback. Only our own page is
		// ever loaded here, and any navigation off this host is handed to the
		// system browser before it can reach a WebView that has this attached.
		web.addJavascriptInterface(new Bridge(), "BbgPlayer");

		web.setWebViewClient(new WebViewClient() {
			@Override
			public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
				return route(r.getUrl());
			}

			@SuppressWarnings("deprecation")
			@Override
			public boolean shouldOverrideUrlLoading(WebView v, String url) {
				return route(Uri.parse(url));
			}

			/** Keep our own page inside the app; hand anything else to the browser. */
			private boolean route(Uri uri) {
				if (uri == null) return false;
				if (HOME_HOST.equalsIgnoreCase(uri.getHost())) return false;
				try {
					startActivity(new Intent(Intent.ACTION_VIEW, uri));
				} catch (Exception ignored) {
					// No browser installed. Swallowing beats crashing.
				}
				return true;
			}
		});

		web.setWebChromeClient(new WebChromeClient() {
			@Override
			public void onShowCustomView(View view, CustomViewCallback cb) {
				enterFullscreen(view, cb);
			}

			@Override
			public void onHideCustomView() {
				exitFullscreen();
			}
		});

		applyImmersive();

		if (saved != null) {
			web.restoreState(saved);
		} else {
			web.loadUrl(isTelevision() ? (HOME + "?tv=1") : HOME);
		}
	}

	// ------------------------------------------------------------------- bridge

	/**
	 * Everything arriving from the page. Every method hops to the main thread
	 * first: a JavascriptInterface call is delivered on a WebView worker thread,
	 * and both ExoPlayer and the view hierarchy insist on the main one.
	 */
	private class Bridge {
		@JavascriptInterface
		public void post(final String json) {
			if (json == null) return;
			ui.post(new Runnable() {
				@Override
				public void run() {
					handle(json);
				}
			});
		}
	}

	private void handle(String json) {
		JSONObject o;
		try {
			o = new JSONObject(json);
		} catch (Exception e) {
			return;
		}
		String a = o.optString("a", "");
		if ("play".equals(a)) {
			startNative(o.optString("url", ""), o.optBoolean("muted", false));
		} else if ("stop".equals(a)) {
			releasePlayer();
		} else if ("rect".equals(a)) {
			double dpr = o.optDouble("dpr", 1.0);
			if (dpr <= 0) dpr = 1.0;
			stageX = (int) Math.round(o.optDouble("x", 0) * dpr);
			stageY = (int) Math.round(o.optDouble("y", 0) * dpr);
			stageW = (int) Math.round(o.optDouble("w", 0) * dpr);
			stageH = (int) Math.round(o.optDouble("h", 0) * dpr);
			layoutVideo();
		} else if (player == null) {
			// Everything below needs a player.
			return;
		} else if ("mute".equals(a)) {
			setMuted(o.optBoolean("on", false));
		} else if ("toggle".equals(a)) {
			player.setPlayWhenReady(!player.getPlayWhenReady());
		} else if ("live".equals(a)) {
			// The default position of a live window is its live edge.
			player.seekToDefaultPosition();
			player.setPlayWhenReady(true);
		} else if ("level".equals(a)) {
			applyLevel(o.optInt("h", -1));
		} else if ("volume".equals(a)) {
			float v = (float) o.optDouble("v", 1.0);
			player.setVolume(Math.max(0f, Math.min(1f, v)));
		}
	}

	/** Back to the page. Quoted as a JSON string, so no escaping can go wrong. */
	private void send(JSONObject o) {
		if (web == null || o == null) return;
		final String js = "if(window.__bbgNativeEvent)window.__bbgNativeEvent("
				+ JSONObject.quote(o.toString()) + ");";
		try {
			web.evaluateJavascript(js, null);
		} catch (Exception ignored) {
		}
	}

	private void send(String type) {
		try {
			send(new JSONObject().put("t", type));
		} catch (Exception ignored) {
		}
	}

	// -------------------------------------------------------------- native player

	private void startNative(String url, boolean startMuted) {
		if (url == null || url.isEmpty()) {
			send("fallback");
			return;
		}
		releasePlayer();
		muted = startMuted;
		videoW = 0;
		videoH = 0;

		try {
			// Buffer sizes in the same spirit as the web player: enough cushion to
			// ride out a bad minute on a long path, without sitting so far back
			// that the channel stops being live.
			DefaultLoadControl load = new DefaultLoadControl.Builder()
					.setBufferDurationsMs(20000, 60000, 2000, 5000)
					.build();

			player = new ExoPlayer.Builder(this)
					.setLoadControl(load)
					.build();
			player.setVideoTextureView(videoView);
			player.setVolume(muted ? 0f : 1f);
			player.addListener(new PlayerEvents());

			MediaItem item = new MediaItem.Builder()
					.setUri(Uri.parse(url))
					.setLiveConfiguration(new MediaItem.LiveConfiguration.Builder()
							.setTargetOffsetMs(TARGET_OFFSET_MS)
							.setMaxPlaybackSpeed(MAX_LIVE_SPEED)
							.build())
					.build();
			player.setMediaItem(item);
			player.prepare();
			player.setPlayWhenReady(true);
		} catch (Throwable t) {
			// A missing decoder, a device without the library, anything at all:
			// the page must not be left with nothing.
			releasePlayer();
			send("fallback");
			return;
		}

		videoView.setVisibility(View.VISIBLE);
		layoutVideo();
		startStats();
	}

	private void releasePlayer() {
		stopStats();
		if (player != null) {
			try {
				player.release();
			} catch (Exception ignored) {
			}
			player = null;
		}
		if (videoView != null) videoView.setVisibility(View.GONE);
	}

	private void setMuted(boolean on) {
		muted = on;
		if (player != null) player.setVolume(on ? 0f : 1f);
	}

	/**
	 * A picked height is a real lock, not a ceiling that the adaptive logic may
	 * drift below whenever it feels like it - that behaviour was the single
	 * loudest complaint about the web player. Constraining minimum and maximum
	 * to the same height leaves exactly one rung eligible.
	 *
	 * ExoPlayer keeps one escape hatch of its own, and it is the right one: if
	 * no track satisfies the constraints at all, it plays something rather than
	 * nothing.
	 */
	private void applyLevel(int h) {
		if (player == null) return;
		try {
			TrackSelectionParameters.Builder b = player.getTrackSelectionParameters().buildUpon();
			if (h > 0) {
				b.setMaxVideoSize(Integer.MAX_VALUE, h);
				b.setMinVideoSize(0, h);
			} else {
				b.clearVideoSizeConstraints();
			}
			player.setTrackSelectionParameters(b.build());
		} catch (Exception ignored) {
		}
	}

	/** The variant ladder, so the page can offer the feed's real rungs. */
	private void sendTracks() {
		if (player == null) return;
		try {
			JSONArray list = new JSONArray();
			boolean[] seen = new boolean[8192];
			Tracks tracks = player.getCurrentTracks();
			for (Tracks.Group group : tracks.getGroups()) {
				if (group.getType() != C.TRACK_TYPE_VIDEO) continue;
				TrackGroup tg = group.getMediaTrackGroup();
				for (int i = 0; i < tg.length; i++) {
					Format f = tg.getFormat(i);
					int h = f.height;
					if (h <= 0 || h >= seen.length || seen[h]) continue;
					seen[h] = true;
					JSONObject t = new JSONObject();
					t.put("h", h);
					t.put("w", f.width > 0 ? f.width : 0);
					t.put("bps", f.bitrate > 0 ? f.bitrate : 0);
					list.put(t);
				}
			}
			if (list.length() == 0) return;
			send(new JSONObject().put("t", "tracks").put("list", list));
		} catch (Exception ignored) {
		}
	}

	private class PlayerEvents implements Player.Listener {
		@Override
		public void onPlaybackStateChanged(int state) {
			if (state == Player.STATE_BUFFERING) {
				try {
					send(new JSONObject().put("t", "loading")
							.put("msg", "\u6b63\u5728\u8fde\u63a5 Bloomberg \u76f4\u64ad\u2026"));
				} catch (Exception ignored) {
				}
			} else if (state == Player.STATE_READY) {
				failures = 0;
				send("playing");
				sendTracks();
			} else if (state == Player.STATE_ENDED) {
				// A live window should not end. If it does, treat it as a drop.
				reportError("\u4fe1\u53f7\u6e90\u5df2\u7ed3\u675f");
			}
		}

		@Override
		public void onTracksChanged(Tracks tracks) {
			sendTracks();
		}

		@Override
		public void onVideoSizeChanged(VideoSize size) {
			videoW = size.width;
			videoH = size.height;
			layoutVideo();
		}

		@Override
		public void onPlayerError(PlaybackException error) {
			reportError(error != null ? error.getErrorCodeName() : "");
		}
	}

	/**
	 * One failure is bad luck on a long path and the page will retry. Two in a
	 * row on the same feed means the native decoder cannot play it, so hand the
	 * picture back to hls.js instead of retrying forever.
	 */
	private void reportError(String detail) {
		failures++;
		if (failures >= 2) {
			releasePlayer();
			send("fallback");
			return;
		}
		try {
			send(new JSONObject().put("t", "error").put("msg", detail == null ? "" : detail));
		} catch (Exception ignored) {
		}
	}

	// ------------------------------------------------------------------ telemetry

	private void startStats() {
		stopStats();
		statsTick = new Runnable() {
			@Override
			public void run() {
				pushStats();
				ui.postDelayed(this, 1000);
			}
		};
		ui.postDelayed(statsTick, 1000);
	}

	private void stopStats() {
		if (statsTick != null) {
			ui.removeCallbacks(statsTick);
			statsTick = null;
		}
	}

	private void pushStats() {
		if (player == null) return;
		try {
			JSONObject o = new JSONObject();
			o.put("t", "stats");

			long ahead = player.getTotalBufferedDuration();
			o.put("buf", Math.max(0L, ahead) / 1000.0);

			// The real distance from the live edge, measured by the player against
			// the playlist rather than guessed from the buffer.
			long off = player.getCurrentLiveOffset();
			if (off != C.TIME_UNSET && off >= 0) o.put("lat", off / 1000.0);

			Format f = player.getVideoFormat();
			if (f != null) {
				if (f.bitrate > 0) o.put("bps", f.bitrate);
				if (f.width > 0) o.put("w", f.width);
				if (f.height > 0) o.put("h", f.height);
			}
			o.put("muted", muted);
			o.put("paused", !player.getPlayWhenReady());
			send(o);
		} catch (Exception ignored) {
		}
	}

	// -------------------------------------------------------------------- layout

	/**
	 * Fit the picture inside the rectangle the page reported, preserving the
	 * feed's aspect ratio.
	 *
	 * A TextureView stretches whatever it is given to its own bounds, so without
	 * this the image would be distorted rather than letterboxed. Scaling up to
	 * fill instead would crop, and on this channel the crop would take the
	 * ticker along the bottom and the news band down the side - the parts of the
	 * frame this feed is watched for.
	 */
	private void layoutVideo() {
		if (videoView == null) return;
		if (stageW <= 0 || stageH <= 0) return;

		int w = stageW;
		int h = stageH;
		if (videoW > 0 && videoH > 0) {
			double ar = (double) videoW / (double) videoH;
			if (stageW / (double) stageH > ar) {
				h = stageH;
				w = (int) Math.round(stageH * ar);
			} else {
				w = stageW;
				h = (int) Math.round(stageW / ar);
			}
		}
		if (w <= 0 || h <= 0) return;

		FrameLayout.LayoutParams lp =
				new FrameLayout.LayoutParams(w, h, Gravity.TOP | Gravity.START);
		lp.leftMargin = stageX + (stageW - w) / 2;
		lp.topMargin = stageY + (stageH - h) / 2;
		videoView.setLayoutParams(lp);
	}

	// ------------------------------------------------------------------ television

	/**
	 * Whether this device is a television.
	 *
	 * The page cannot work this out for itself with any confidence: a TV box
	 * reports a perfectly ordinary Android user agent, and screen size alone
	 * does not distinguish a television from a large tablet. The host does know,
	 * so it says so in the query string and the page switches to a layout meant
	 * to be driven by a remote from across a room.
	 */
	private boolean isTelevision() {
		try {
			UiModeManager ui = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
			if (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) {
				return true;
			}
		} catch (Exception ignored) {
			// Fall through to the feature check.
		}
		try {
			PackageManager pm = getPackageManager();
			if (pm != null) {
				return pm.hasSystemFeature("android.software.leanback")
						|| pm.hasSystemFeature("android.hardware.type.television");
			}
		} catch (Exception ignored) {
			// Treat an unanswerable question as "not a television".
		}
		return false;
	}

	// ---------------------------------------------------------------- fullscreen

	/**
	 * The page's fullscreen button calls requestFullscreen() on the video.
	 * WebView does not act on that by itself - it hands the host app a view and
	 * expects the app to display it. A wrapper that omits this is the usual
	 * reason the fullscreen button in a WebView app appears to do nothing.
	 */
	private void enterFullscreen(View view, WebChromeClient.CustomViewCallback cb) {
		if (customView != null) {
			cb.onCustomViewHidden();
			return;
		}
		customView = view;
		customCallback = cb;
		view.setBackgroundColor(0xFF000000);
		root.addView(view, new FrameLayout.LayoutParams(
				ViewGroup.LayoutParams.MATCH_PARENT,
				ViewGroup.LayoutParams.MATCH_PARENT));
		web.setVisibility(View.GONE);
		// The fullscreen view now owns the screen, so it has to own the remote too.
		view.setFocusable(true);
		view.setFocusableInTouchMode(true);
		view.requestFocus();
		applyImmersive();
	}

	private void exitFullscreen() {
		if (customView == null) return;
		root.removeView(customView);
		customView = null;
		web.setVisibility(View.VISIBLE);
		web.requestFocus();
		if (customCallback != null) {
			customCallback.onCustomViewHidden();
			customCallback = null;
		}
		applyImmersive();
	}

	// -------------------------------------------------------------------- chrome

	@SuppressWarnings("deprecation")
	private void applyImmersive() {
		getWindow().getDecorView().setSystemUiVisibility(
				View.SYSTEM_UI_FLAG_LAYOUT_STABLE
						| View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
						| View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
						| View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
						| View.SYSTEM_UI_FLAG_FULLSCREEN
						| View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
	}

	@Override
	public void onWindowFocusChanged(boolean hasFocus) {
		super.onWindowFocusChanged(hasFocus);
		if (hasFocus) {
			applyImmersive();
			// Coming back from a system dialog or a home button trip, focus can
			// land on the decor view and the remote goes dead again.
			if (customView == null && web != null) web.requestFocus();
		}
	}

	// ------------------------------------------------------------------ lifecycle

	@Override
	public void onBackPressed() {
		if (customView != null) {
			exitFullscreen();
			return;
		}
		if (web != null && web.canGoBack()) {
			web.goBack();
			return;
		}
		super.onBackPressed();
	}

	@Override
	protected void onSaveInstanceState(Bundle out) {
		super.onSaveInstanceState(out);
		if (web != null) web.saveState(out);
	}

	@Override
	protected void onStop() {
		super.onStop();
		// A hardware decoder held open in the background is both a battery drain
		// and, on devices with a single decoder instance, a reason the next app
		// to want video gets nothing. The page restarts playback on return.
		if (player != null) player.setPlayWhenReady(false);
	}

	@Override
	protected void onDestroy() {
		releasePlayer();
		if (web != null) {
			root.removeView(web);
			web.destroy();
			web = null;
		}
		super.onDestroy();
	}
}
