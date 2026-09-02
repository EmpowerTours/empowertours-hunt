import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToHex } from "viem";
import {
  ACCOUNT_PATH,
  HUNT_PRF_SALT,
  HUNT_PRF_SALT_LABEL,
  walletFromPrfOutput,
} from "./derive";

// Every value pinned here is load-bearing for player funds. A change to any of
// them silently points existing players at a different wallet — their credit and
// any payout would be stranded at an address nobody can open. These are not
// characterisation tests; they are the reason the constants cannot drift.

describe("HUNT_PRF_SALT", () => {
  it("is exactly the 32 bytes every existing wallet was derived under", () => {
    expect(bytesToHex(HUNT_PRF_SALT)).toBe(
      "0x9fc345cea9c77d56f4238d9940dfdc757b6a69fb1d83893e067cefbeda0f648f",
    );
    expect(HUNT_PRF_SALT.length).toBe(32);
  });

  it("is derived from the pinned label", () => {
    // Guards the label separately, so a typo in it fails here with an obvious
    // cause rather than only as a mismatched hash above.
    expect(HUNT_PRF_SALT_LABEL).toBe("empowertours-hunt/passkey/v1");
  });

  it("is not the salt mera uses by default", () => {
    // If this ever equalled mera's default, a hunt passkey and a default-salt
    // passkey on the same credential would derive the SAME wallet — which is
    // exactly the Regalo bleed-through the salt exists to prevent.
    const allZero = new Uint8Array(32);
    expect(bytesToHex(HUNT_PRF_SALT)).not.toBe(bytesToHex(allZero));
  });
});

describe("walletFromPrfOutput", () => {
  it("maps a known PRF output to a known mnemonic and address", () => {
    const prf = new Uint8Array(32).fill(7);
    const { mnemonic, privateKey } = walletFromPrfOutput(prf);

    expect(mnemonic.split(" ")).toHaveLength(24);
    expect(privateKeyToAccount(bytesToHex(privateKey)).address).toBe(
      "0x29458C602E3DB4fC3b54EC2bbEE26Dbe64C7779f",
    );
  });

  it("is deterministic — same face, same wallet", () => {
    const prf = new Uint8Array(32).fill(11);
    expect(walletFromPrfOutput(prf)).toEqual(walletFromPrfOutput(prf));
  });

  it("gives different PRF outputs different wallets", () => {
    const a = walletFromPrfOutput(new Uint8Array(32).fill(1));
    const b = walletFromPrfOutput(new Uint8Array(32).fill(2));
    expect(bytesToHex(a.privateKey)).not.toBe(bytesToHex(b.privateKey));
    expect(a.mnemonic).not.toBe(b.mnemonic);
  });

  it("derives the standard first account, so the phrase opens in MetaMask", () => {
    expect(ACCOUNT_PATH).toBe("m/44'/60'/0'/0/0");
  });

  it("rejects a PRF output that is not 32 bytes", () => {
    // An authenticator returning short entropy must be a loud failure, not a
    // weaker-but-working wallet.
    expect(() => walletFromPrfOutput(new Uint8Array(16))).toThrow(/32 bytes/);
    expect(() => walletFromPrfOutput(new Uint8Array(33))).toThrow(/32 bytes/);
  });
});
