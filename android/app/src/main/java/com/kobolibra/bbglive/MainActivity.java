package com.kobolibra.bbglive;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * A shell around the deployed Bloomberg Live page.
 *
 * The page is loaded from the network rather than bundled into assets. That is
 * a deliberate trade: the app is useless without a connection anyway (it is a
 * live stream), and loading remotely means every later fix to index.html shows
 * up here without anyone rebuilding or reinstalling the APK.
 */
public class MainActivity extends Activity {

	private static final String HOME = "https://kobolibra.github.io/worldmonitor/";
	private static final String HOME_HOST = "kobolibra.github.io";
	private static final int BACKDROP = 0xFF06070A;

	private FrameLayout root;
	private WebView web;

	/** The view handed to us when the page enters HTML5 fullscreen. */
	private View customView;
	private WebChromeClient.CustomViewCallback customCallback;

	@SuppressLint("SetJavaScriptEnabled")
	@Override
	protected void onCreate(Bundle saved) {
		super.onCreate(saved);

		// A news channel that blanks out after 30 seconds is not a news channel.
		getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

		root = new FrameLayout(this);
		root.setBackgroundColor(BACKDROP);

		web = new WebView(this);
		web.setBackgroundColor(BACKDROP);
		root.addView(web, new FrameLayout.LayoutParams(
				ViewGroup.LayoutParams.MATCH_PARENT,
				ViewGroup.LayoutParams.MATCH_PARENT));
		setContentView(root);

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
			web.loadUrl(HOME);
		}
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
		applyImmersive();
	}

	private void exitFullscreen() {
		if (customView == null) return;
		root.removeView(customView);
		customView = null;
		web.setVisibility(View.VISIBLE);
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
		if (hasFocus) applyImmersive();
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
	protected void onDestroy() {
		if (web != null) {
			root.removeView(web);
			web.destroy();
			web = null;
		}
		super.onDestroy();
	}
}
