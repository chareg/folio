package app.folio.reader;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Parcelable;
import android.provider.OpenableColumns;
import android.view.View;
import android.view.Window;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Folio for Android is a thin native shell around the Folio reader page in assets/www.
 * The page is served from a private https origin so pdf.js, fonts and modules all load
 * normally, and documents are streamed straight from their content:// URI on request.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST + "/";
    private static final int REQ_OPEN = 41;
    private static final String[] MIME_TYPES = {
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-word.document.macroEnabled.12",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.template"
    };

    private WebView web;
    private boolean pageReady = false;
    private Intent pendingIntent = null;
    private final Map<String, Uri> docs = new HashMap<String, Uri>();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private SharedPreferences store;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        store = getSharedPreferences("folio", MODE_PRIVATE);
        int bg = store.getInt("chrome_bg", isSystemDark() ? 0xff15131b : 0xfffbfafc);
        applyChrome(bg, store.getBoolean("chrome_light", !isSystemDark()));

        web = new WebView(this);
        web.setBackgroundColor(bg);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        if (Build.VERSION.SDK_INT >= 33) {
            s.setAlgorithmicDarkeningAllowed(false);
        } else if (Build.VERSION.SDK_INT >= 29) {
            s.setForceDark(WebSettings.FORCE_DARK_OFF);
        }

        web.addJavascriptInterface(new Bridge(), "FolioAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                android.util.Log.d("Folio", m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });
        web.loadUrl(ORIGIN + "index.html");
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_VIEW.equals(action) && !Intent.ACTION_SEND.equals(action)) return;
        if (!pageReady) { pendingIntent = intent; return; }
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(action)) uri = intent.getData();
        else {
            Parcelable p = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (p instanceof Uri) uri = (Uri) p;
        }
        if (uri != null) deliver(uri, intent.getType(), tryPersist(uri, intent.getFlags()));
        intent.setAction(Intent.ACTION_MAIN); // don't reopen it after a rotation or restart
    }

    private boolean tryPersist(Uri uri, int flags) {
        if ((flags & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) == 0) return false;
        try {
            getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return true;
        } catch (SecurityException e) {
            return false;
        }
    }

    /** Hands a document to the page. The page then fetches its bytes from /__doc/<token>. */
    private void deliver(Uri uri, String typeHint, boolean persisted) {
        String token = UUID.randomUUID().toString();
        synchronized (docs) { docs.put(token, uri); }
        JSONObject o = new JSONObject();
        try {
            o.put("token", token);
            o.put("uri", uri.toString());
            o.put("name", displayName(uri));
            String mime = null;
            try { mime = getContentResolver().getType(uri); } catch (Exception ignored) { }
            o.put("mime", mime != null ? mime : (typeHint != null ? typeHint : ""));
            o.put("persisted", persisted);
        } catch (JSONException ignored) { }
        js("window.folioReceive && window.folioReceive(" + o.toString() + ")");
    }

    private String displayName(Uri uri) {
        String name = null;
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            Cursor c = null;
            try {
                c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {
            } finally {
                if (c != null) c.close();
            }
        }
        if (name == null) name = uri.getLastPathSegment();
        return name != null ? name : "Document";
    }

    private void js(final String code) {
        ui.post(new Runnable() {
            @Override public void run() { if (web != null) web.evaluateJavascript(code, null); }
        });
    }

    private boolean isSystemDark() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    @SuppressWarnings("deprecation")
    private void applyChrome(int color, boolean light) {
        Window w = getWindow();
        w.setStatusBarColor(color);
        w.setNavigationBarColor(color);
        w.getDecorView().setBackgroundColor(color);
        int flags = w.getDecorView().getSystemUiVisibility();
        flags = light ? (flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR)
                      : (flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        w.getDecorView().setSystemUiVisibility(flags);
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        js("window.folioSystemTheme && window.folioSystemTheme(" + isSystemDark() + ")");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_OPEN) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            js("window.folioPickCancelled && window.folioPickCancelled()");
            return;
        }
        Uri uri = data.getData();
        deliver(uri, data.getType(), tryPersist(uri, data.getFlags()));
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web == null || !pageReady) { super.onBackPressed(); return; }
        web.evaluateJavascript("(window.folioBack && window.folioBack()) ? 'handled' : 'no'", new ValueCallback<String>() {
            @Override public void onReceiveValue(String v) {
                if (v == null || !v.contains("handled")) moveTaskToBack(true);
            }
        });
    }

    @Override
    protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }

    /* ------------------------------------------------------------------ */

    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri url = req.getUrl();
            if (!HOST.equals(url.getHost())) return null;
            String path = url.getPath();
            if (path == null || path.equals("/")) path = "/index.html";
            Map<String, String> headers = new HashMap<String, String>();
            headers.put("Cache-Control", "no-store");
            try {
                if (path.startsWith("/__doc/")) {
                    Uri doc;
                    synchronized (docs) { doc = docs.get(path.substring(7)); }
                    if (doc == null) return notFound();
                    InputStream in = getContentResolver().openInputStream(doc);
                    if (in == null) return notFound();
                    return new WebResourceResponse("application/octet-stream", null, 200, "OK", headers, in);
                }
                if (path.contains("..")) return notFound();
                InputStream in = getAssets().open("www" + path);
                return new WebResourceResponse(mimeFor(path), mimeFor(path).startsWith("text/") ? "utf-8" : null, 200, "OK", headers, in);
            } catch (IOException | SecurityException e) {
                return notFound();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri url = req.getUrl();
            if (HOST.equals(url.getHost())) return false;
            openExternal(url.toString());
            return true;
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mimeFor(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".pfb")) return "application/x-font-type1";
        return "application/octet-stream";
    }

    private void openExternal(String url) {
        String u = url.toLowerCase();
        if (!(u.startsWith("http:") || u.startsWith("https:") || u.startsWith("mailto:") || u.startsWith("tel:"))) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException ignored) { }
    }

    /** Everything the page can ask of Android. Calls arrive on a binder thread. */
    private class Bridge {
        @JavascriptInterface
        public void ready() {
            ui.post(new Runnable() {
                @Override public void run() {
                    pageReady = true;
                    Intent p = pendingIntent;
                    pendingIntent = null;
                    if (p != null) handleIntent(p);
                }
            });
        }

        @JavascriptInterface
        public boolean isSystemDark() { return MainActivity.this.isSystemDark(); }

        @JavascriptInterface
        public void pickDocument() {
            ui.post(new Runnable() {
                @Override public void run() {
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    i.putExtra(Intent.EXTRA_MIME_TYPES, MIME_TYPES);
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    try {
                        startActivityForResult(i, REQ_OPEN);
                    } catch (ActivityNotFoundException e) {
                        js("window.folioPickCancelled && window.folioPickCancelled('nopicker')");
                    }
                }
            });
        }

        @JavascriptInterface
        public void openRecent(final String uriString) {
            final Uri uri = Uri.parse(uriString);
            boolean ok = false;
            try {
                InputStream in = getContentResolver().openInputStream(uri);
                if (in != null) { in.close(); ok = true; }
            } catch (Exception ignored) { }
            if (ok) deliver(uri, null, true);
            else js("window.folioOpenFailed && window.folioOpenFailed(" + JSONObject.quote(uriString) + ")");
        }

        @JavascriptInterface
        public void forget(String uriString) {
            try {
                getContentResolver().releasePersistableUriPermission(Uri.parse(uriString), Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public void releaseToken(String token) {
            synchronized (docs) { docs.remove(token); }
        }

        @JavascriptInterface
        public void setChrome(final String cssColor, final boolean light) {
            ui.post(new Runnable() {
                @Override public void run() {
                    int c;
                    try { c = Color.parseColor(cssColor.trim()); } catch (Exception e) { return; }
                    applyChrome(c, light);
                    if (web != null) web.setBackgroundColor(c);
                    store.edit().putInt("chrome_bg", c).putBoolean("chrome_light", light).apply();
                }
            });
        }

        @JavascriptInterface
        public void openExternal(final String url) {
            ui.post(new Runnable() { @Override public void run() { MainActivity.this.openExternal(url); } });
        }

        @JavascriptInterface
        public void share(final String uriString, final String mime, final String name) {
            ui.post(new Runnable() {
                @Override public void run() {
                    Intent i = new Intent(Intent.ACTION_SEND);
                    i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                    i.putExtra(Intent.EXTRA_STREAM, Uri.parse(uriString));
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try { startActivity(Intent.createChooser(i, name)); } catch (Exception ignored) { }
                }
            });
        }
    }
}
