package xyz.empowertours.app;

import android.os.Build;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPublicKeyCredentialOption;
import androidx.credentials.PublicKeyCredential;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The same passkey assertion, down a different road.
 *
 * <p>WHY THIS EXISTS. {@code WEB_AUTHENTICATION_SUPPORT_FOR_APP} makes the
 * WebView do WebAuthn by routing the request through Play services' <b>FIDO2</b>
 * APIs. On a vivo running OriginOS 6 that road is broken: the request is
 * dispatched, the system sheet opens, and the answer is
 * {@code NotReadableError: An unknown error occurred while talking to the
 * credential manager} — with and without extensions, so it is not about what we
 * asked for. Chrome on that same phone signs in perfectly, and Chrome uses
 * <b>Credential Manager</b>. Same device, same passkey, two code paths, one of
 * them failing.
 *
 * <p>So this plugin takes the other road. It is the Credential Manager path,
 * called natively, handed the identical WebAuthn request as JSON.
 *
 * <p>WHY IT IS HERE AND NOT AN npm DEPENDENCY. What comes back through this
 * class contains the PRF output, and the PRF output IS the wallet — it becomes
 * the private key. A third-party package in that position could be changed by a
 * version bump nobody read. This is ~100 lines against a documented API; it
 * lives in the app, where a change to it is a change to this repository.
 *
 * <p>It does GET only. Creating a passkey is the one operation that can hand
 * somebody a second wallet, and it works on the paths we already have, so there
 * is no reason for a second way to do it.
 */
@CapacitorPlugin(name = "NativePasskey")
public class NativePasskeyPlugin extends Plugin {

    private CredentialManager credentialManager;

    @Override
    public void load() {
        try {
            credentialManager = CredentialManager.create(getContext());
        } catch (Throwable t) {
            // Leave it null and report unavailable. A device without a working
            // Credential Manager must fail the capability check, not crash the
            // app on launch — the web path may still work here.
            credentialManager = null;
        }
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put(
            "available",
            credentialManager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        );
        call.resolve(result);
    }

    /**
     * Run an assertion. `requestJson` is a WebAuthn
     * PublicKeyCredentialRequestOptionsJSON — the same shape the page would
     * pass to navigator.credentials.get(), extensions and all, which is how the
     * PRF request survives the trip.
     */
    @PluginMethod
    public void get(final PluginCall call) {
        String requestJson = call.getString("requestJson");
        if (requestJson == null || requestJson.isEmpty()) {
            call.reject("requestJson is required", "TypeError");
            return;
        }
        if (credentialManager == null) {
            call.reject("Credential Manager is unavailable", "NotSupportedError");
            return;
        }

        final GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(new GetPublicKeyCredentialOption(requestJson))
            .build();

        // The ceremony shows system UI, so it needs the activity and it must be
        // started from the main thread.
        getActivity()
            .runOnUiThread(() ->
                credentialManager.getCredentialAsync(
                    getActivity(),
                    request,
                    null,
                    ContextCompat.getMainExecutor(getContext()),
                    new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                        @Override
                        public void onResult(GetCredentialResponse response) {
                            if (!(response.getCredential() instanceof PublicKeyCredential)) {
                                call.reject(
                                    "Unexpected credential type from Credential Manager",
                                    "UnknownError"
                                );
                                return;
                            }
                            PublicKeyCredential credential =
                                (PublicKeyCredential) response.getCredential();

                            // Returned verbatim. The assertion JSON carries
                            // clientExtensionResults, which is where the PRF
                            // output is — parsing it here would only be a second
                            // place for it to be got wrong.
                            JSObject result = new JSObject();
                            result.put(
                                "responseJson",
                                credential.getAuthenticationResponseJson()
                            );
                            call.resolve(result);
                        }

                        @Override
                        public void onError(GetCredentialException exception) {
                            // The exception TYPE is the stable, useful part —
                            // the message is vendor prose. Both go back so the
                            // page can show what actually happened rather than
                            // a friendly guess.
                            call.reject(
                                exception.getMessage() == null
                                    ? exception.getType()
                                    : exception.getMessage(),
                                exception.getType()
                            );
                        }
                    }
                )
            );
    }
}
