package design.takeone.tidewater;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import android.webkit.WebChromeClient;
import android.webkit.ConsoleMessage;
import android.webkit.WebViewClient;
import android.util.Log;
import android.view.WindowInsets;

/** Offline demo app: only the bundled Tidewater board, no accounts or network. */
public final class TidewaterActivity extends Activity {
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().getDecorView().setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    WebView board = new WebView(this);
    board.getSettings().setJavaScriptEnabled(true);
    // Immersive sticky hides the bars a beat after first paint; until then the
    // content draws underneath the status bar and the header logo clips. Pad
    // the view by the system-window inset so first paint lays out inside the
    // safe area; the padding returns to 0 once the bars hide.
    board.setOnApplyWindowInsetsListener((v, insets) -> {
      v.setPadding(0, insets.getSystemWindowInsetTop(), 0, 0);
      return insets;
    });
    board.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onConsoleMessage(ConsoleMessage message) {
        Log.i("TidewaterDemo", message.message());
        return true;
      }
    });
    board.setWebViewClient(new WebViewClient() {
      @Override public void onPageFinished(WebView view, String url) {
        view.evaluateJavascript("document.addEventListener('click',e=>console.log('tap '+e.target.id+' '+e.clientX+','+e.clientY));", null);
        Log.i("TidewaterDemo", "board ready");
      }
    });
    board.getSettings().setAllowFileAccess(false);
    setContentView(board);
    board.loadUrl("file:///android_asset/scene.html");
  }
}
