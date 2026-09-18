package xyz.empowertours.cota;

import android.os.Bundle;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;

/**
 * Cota's WebView, with WebAuthn switched on.
 *
 * <p>An Android WebView does not do WebAuthn by default, and every single thing
 * this app can do is behind a passkey: the ceremony is not just the login, it
 * derives the player's wallet (see lib/auth/derive.ts). Without the call below
 * the app installs, opens, renders the real site, and then cannot sign in —
 * which reads as a broken app rather than a missing setting.
 *
 * <p>Guarded on {@code isFeatureSupported} rather than assumed: the capability
 * lives in the system WebView, which updates independently of the OS, so a
 * device can be new and still lack it. Where it is missing we leave the setting
 * alone — the page then gets the ordinary "no passkey available" path, which
 * `SignInPanel` already explains, instead of a ceremony that cannot complete.
 *
 * <p>Note for anyone adding to the auth lane: the WebKit library does NOT
 * support {@code mediation: "conditional"}. Nothing in lib/auth/passkey.ts asks
 * for it today. If that changes, it has to change here too.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            WebSettingsCompat.setWebAuthenticationSupport(
                this.bridge.getWebView().getSettings(),
                WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP
            );
        }
    }
}
