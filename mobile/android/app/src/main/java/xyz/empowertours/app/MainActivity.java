package xyz.empowertours.app;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;

/**
 * EmpowerTours' WebView, with WebAuthn switched on.
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
 * SignInPanel already explains, instead of a ceremony that cannot complete.
 *
 * <p>Note for anyone adding to the auth lane: the WebKit library does NOT
 * support {@code mediation: "conditional"}. Nothing in lib/auth/passkey.ts asks
 * for it today. If that changes, it has to change here too.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Debug builds only. A remotely inspectable WebView exposes the page —
        // and the signing ceremony running in it — to anything with adb on the
        // device, so a release build must never carry this. Read from the
        // manifest flag the packager itself sets rather than a constant someone
        // can forget to flip back; BuildConfig is not generated at all under
        // AGP 8's defaults, which is how the first attempt at this failed.
        boolean debuggable =
            (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        boolean webAuthnSupported =
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION);

        // Tell the PAGE what the native side decided, by marking the user agent.
        //
        // /diag can see window.PublicKeyCredential, which in a WebView exists
        // whether or not setWebAuthenticationSupport was ever called — so the
        // JS-visible surface cannot distinguish "configured" from "not". This
        // can. A user-agent suffix rather than an injected global because it
        // survives navigation and reloads with no ordering to get wrong, and
        // nothing on the server gates on the user agent.
        WebSettings settings = this.bridge.getWebView().getSettings();
        settings.setUserAgentString(
            settings.getUserAgentString()
                + " EmpowerToursApp/1 WebAuthnSupport/"
                + (webAuthnSupported ? "1" : "0")
        );

        if (webAuthnSupported) {
            WebSettingsCompat.setWebAuthenticationSupport(
                settings,
                WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP
            );
        } else {
            // Say so in logcat rather than failing silently. If this line is
            // present, the device's system WebView cannot do WebAuthn at all and
            // no amount of correctness elsewhere will produce a sign-in.
            android.util.Log.w(
                "EmpowerTours",
                "WEB_AUTHENTICATION unsupported by this system WebView — passkey sign-in cannot work here"
            );
        }
    }
}
