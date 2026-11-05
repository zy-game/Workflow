package com.qingmei.mobile;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecureStorePlugin.class);
        registerPlugin(PetOverlayPlugin.class);
        super.onCreate(savedInstanceState);
        routeIntent(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        routeIntent(intent);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        toggleOverlay(hasFocus ? "hide" : "show");
    }

    private void toggleOverlay(String action) {
        if (!PetOverlayService.running) return;
        Intent intent = new Intent(this, PetOverlayService.class);
        intent.setAction(action);
        startService(intent);
    }

    private void routeIntent(Intent intent) {
        if (intent == null || !intent.getBooleanExtra("open_chat", false)) return;
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) return;
        webView.postDelayed(
            () -> webView.evaluateJavascript(
                "window.openChatFromOverlay && window.openChatFromOverlay()",
                null
            ),
            1200
        );
    }
}
