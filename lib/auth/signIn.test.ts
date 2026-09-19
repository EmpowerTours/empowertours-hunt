import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The sign-in branch, which until now had no test at all.
//
// It earned one the hard way: a player on Android Chrome opened the hunt, tapped
// CONTINUE WITH YOUR PHONE, and got Google's own sheet — "No passkeys available
// for empowertours.xyz on this device" — twice, because the flow counted two
// failed assertions before a third tap would create a wallet. They reported the
// app as broken, which from where they sat it was: the only route to a wallet
// was to disbelieve the system dialog and tap again.
//
// What must hold now:
//   * a failed assertion on a device that knows no credential OFFERS to create,
//     structurally (a flag), and never creates by itself;
//   * a failed assertion on a device that DOES know one never offers;
//   * creating refuses outright where a credential is already known — that is
//     the case that would hand someone a second wallet and strand the first.
// ---------------------------------------------------------------------------

const passkey = vi.hoisted(() => ({
  RP_ID: "empowertours.xyz",
  signInAccount: vi.fn(),
  createAccount: vi.fn(),
  accountFromPrfOutput: vi.fn(),
  storedCredential: vi.fn(),
  explainPasskeyError: vi.fn((e: unknown) =>
    e instanceof Error ? e.message : "broken",
  ),
}));

vi.mock("./passkey", () => passkey);

/**
 * The second road: Credential Manager, reached natively. Mocked because the
 * bridge only exists inside the app, and the branch it guards is the one that
 * rescues a device whose WebView path is broken.
 */
const native = vi.hoisted(() => ({
  nativePasskeyAvailable: vi.fn(async () => false),
  getPrfViaNative: vi.fn(),
}));
vi.mock("./native-passkey", () => native);
vi.mock("@/lib/auth/turnstile", () => ({ getCaptchaToken: async () => null }));

const { createWalletWithPasskey, signInWithPasskey } = await import("./signIn");

/** A stand-in for the object accountFromPrfOutput returns. */
function fakeAccount() {
  const end = vi.fn();
  return {
    account: {
      address: "0x1111111111111111111111111111111111111111",
      signTypedData: vi.fn(async () => "0xsig"),
    },
    session: { end },
    mnemonic: "test only",
    credentialId: "cred-1",
    end,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Nonce fetch, then session POST. 200 on both = signed in, no registration.
  fetchMock = vi.fn(async (url: unknown) =>
    String(url).includes("/api/auth/nonce")
      ? {
          ok: true,
          status: 200,
          json: async () => ({
            nonce: "n".repeat(22),
            serverTs: 1_700_000_000,
          }),
        }
      : { ok: true, status: 200, json: async () => ({}) },
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signInWithPasskey", () => {
  it("offers to create when the assertion finds nothing and no credential is known here", async () => {
    passkey.storedCredential.mockReturnValue(undefined);
    passkey.signInAccount.mockRejectedValue(
      Object.assign(new Error("NotAllowedError"), { name: "NotAllowedError" }),
    );

    const err = await signInWithPasskey().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { canCreateWallet?: unknown }).canCreateWallet).toBe(true);
    // The whole point: it did NOT quietly make a wallet on the player's behalf.
    expect(passkey.createAccount).not.toHaveBeenCalled();
  });

  it("carries the ceremony's own error, because the friendly sentence hides three causes", async () => {
    passkey.storedCredential.mockReturnValue(undefined);
    passkey.signInAccount.mockRejectedValue(
      Object.assign(new Error("WebAuthn is not supported on this device"), {
        name: "NotSupportedError",
      }),
    );

    const err = await signInWithPasskey().catch((e: unknown) => e);

    // A WebView that cannot do WebAuthn and an empty lookup produce the same
    // player-facing message. Without the cause a phone can only report the
    // symptom, and the person holding it cannot read logcat.
    expect((err as { detail?: unknown }).detail).toBe(
      "WebAuthn is not supported on this device",
    );
    expect((err as Error).message).toContain("No hunt wallet on this phone");
  });

  it("falls back to the native credential manager when the WebView path fails", async () => {
    const acct = fakeAccount();
    passkey.storedCredential.mockReturnValue(undefined);
    passkey.signInAccount.mockRejectedValue(
      Object.assign(
        new Error(
          "An unknown error occurred while talking to the credential manager",
        ),
        {
          name: "NotReadableError",
        },
      ),
    );
    native.nativePasskeyAvailable.mockResolvedValue(true);
    native.getPrfViaNative.mockResolvedValue({
      prfOutput: new Uint8Array(32).fill(7),
      credentialId: "cred-1",
    });
    passkey.accountFromPrfOutput.mockReturnValue(acct);

    await expect(signInWithPasskey()).resolves.toBeUndefined();

    // The whole point: a real session, from the road that works, and NOT an
    // offer to create a second wallet on a phone that already holds one.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.objectContaining({ method: "POST" }),
    );
    expect(passkey.createAccount).not.toHaveBeenCalled();
    expect(acct.end).toHaveBeenCalled();
  });

  it("reports the NATIVE error when both roads are shut", async () => {
    passkey.storedCredential.mockReturnValue(undefined);
    passkey.signInAccount.mockRejectedValue(
      Object.assign(new Error("webview road"), { name: "NotReadableError" }),
    );
    native.nativePasskeyAvailable.mockResolvedValue(true);
    native.getPrfViaNative.mockRejectedValue(
      new Error("native road: no credential"),
    );

    const err = await signInWithPasskey().catch((e: unknown) => e);

    // The WebView failure is already known to happen on these devices; the
    // second road's answer is the one that has not been seen before.
    expect((err as { detail?: unknown }).detail).toBe(
      "native road: no credential",
    );
    expect((err as { canCreateWallet?: unknown }).canCreateWallet).toBe(true);
  });

  it("does NOT offer to create when this device already knows a credential", async () => {
    passkey.storedCredential.mockReturnValue({ credentialId: "cred-1" });
    passkey.signInAccount.mockRejectedValue(new Error("cancelled"));

    const err = await signInWithPasskey().catch((e: unknown) => e);

    expect(
      (err as { canCreateWallet?: unknown }).canCreateWallet,
    ).toBeUndefined();
    expect(passkey.createAccount).not.toHaveBeenCalled();
  });

  it("signs in and zeroes the key when the assertion succeeds", async () => {
    const acct = fakeAccount();
    passkey.storedCredential.mockReturnValue({ credentialId: "cred-1" });
    passkey.signInAccount.mockResolvedValue(acct);

    await expect(signInWithPasskey()).resolves.toBeUndefined();

    expect(acct.end).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("createWalletWithPasskey", () => {
  it("refuses on a device that already holds one of our credentials", async () => {
    passkey.storedCredential.mockReturnValue({ credentialId: "cred-1" });

    await expect(createWalletWithPasskey()).rejects.toThrow(
      /already has a hunt passkey/i,
    );
    expect(passkey.createAccount).not.toHaveBeenCalled();
  });

  it("creates and registers when the device knows nothing", async () => {
    const acct = fakeAccount();
    passkey.storedCredential.mockReturnValue(undefined);
    passkey.createAccount.mockResolvedValue(acct);
    // 404 from /api/auth/session is "valid signature, unknown wallet" — the
    // moment a brand-new player registers.
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/auth/nonce")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            nonce: "n".repeat(22),
            serverTs: 1_700_000_000,
          }),
        };
      }
      if (u === "/api/auth/session") {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    await expect(createWalletWithPasskey()).resolves.toBeUndefined();

    expect(passkey.createAccount).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/register",
      expect.objectContaining({ method: "POST" }),
    );
    expect(acct.end).toHaveBeenCalled();
  });

  it("holds one ceremony at a time across both entry points", async () => {
    passkey.storedCredential.mockReturnValue(undefined);
    let release: (v: unknown) => void = () => {};
    passkey.signInAccount.mockReturnValue(
      new Promise((r) => {
        release = r;
      }),
    );

    const first = signInWithPasskey();
    const second = createWalletWithPasskey();
    expect(second).toBe(first);

    release(fakeAccount());
    await first;
    // The second tap joined the first rather than opening a create ceremony.
    expect(passkey.createAccount).not.toHaveBeenCalled();
  });
});
