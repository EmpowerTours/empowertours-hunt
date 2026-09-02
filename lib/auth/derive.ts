import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
// @scure/bip39@1.6.0's export map has NO ".js" suffix on this path. mera's own
// docs show the v2 style ("wordlists/english.js"), which fails the Next build.
import { wordlist } from "@scure/bip39/wordlists/english";
import { sha256, stringToBytes } from "viem";

// ---------------------------------------------------------------------------
// Key derivation for a passkey-backed player wallet.
//
// No mera import here on purpose: this half is pure and runs under vitest with
// no browser. `lib/auth/passkey.ts` owns the WebAuthn ceremony that produces the
// 32 PRF bytes this file consumes.
//
// A passkey's PRF output is 32 secret bytes the authenticator reproduces for the
// same (credential, rpId, salt) forever. Mapping them through BIP-39 to a plain
// 24-word mnemonic and deriving m/44'/60'/0'/0/0 gives an ORDINARY Ethereum
// account — which is the whole point: a player must be able to walk away with a
// payout. A key derived straight from the PRF bytes would work for signing and
// be permanently trapped in this app, so an airdrop into it would be worthless.
// ---------------------------------------------------------------------------

/** Standard first Ethereum account. Changing this orphans every wallet. */
export const ACCOUNT_PATH = "m/44'/60'/0'/0/0";

/**
 * Hunt's own 32-byte WebAuthn PRF salt.
 *
 * This is the SECOND of two independent mechanisms keeping hunt wallets separate
 * from Regalo's. The first is the relying-party id — a passkey is bound to its
 * domain, so hunt.empowertours.xyz and regalo.empowertours.xyz already yield
 * different credentials. The salt means the wallets stay different even if the
 * two apps were ever served from one host, which the RP id alone would not
 * survive.
 *
 * Derived from a label rather than written as a magic blob so its provenance is
 * readable. **It must never change**: a different salt is a different PRF output
 * is a different wallet for every existing player. `derive.test.ts` pins the
 * exact bytes so an edit to the label fails the suite instead of silently
 * orphaning accounts.
 */
export const HUNT_PRF_SALT_LABEL = "empowertours-hunt/passkey/v1";
export const HUNT_PRF_SALT: Uint8Array = sha256(
  stringToBytes(HUNT_PRF_SALT_LABEL),
  "bytes",
);

export interface DerivedWallet {
  /** BIP-39 phrase. Imports into MetaMask, Rabby or anything else. */
  mnemonic: string;
  /** Raw secp256k1 private key for m/44'/60'/0'/0/0. mera's signing session
   *  takes exactly this shape and keeps its own copy it can later zero. */
  privateKey: Uint8Array;
}

/**
 * Map 32 PRF bytes to a mnemonic and the account key beneath it.
 *
 * @throws when `prfOutput` is not exactly 32 bytes. BIP-39 would otherwise
 *         happily produce a shorter phrase from weaker entropy, and the caller
 *         would never learn the authenticator short-changed it.
 */
export function walletFromPrfOutput(prfOutput: Uint8Array): DerivedWallet {
  if (prfOutput.length !== 32) {
    throw new Error(
      `expected 32 bytes of PRF output, got ${String(prfOutput.length)}`,
    );
  }

  const mnemonic = entropyToMnemonic(prfOutput, wordlist);
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(
    ACCOUNT_PATH,
  );
  if (node.privateKey === null) throw new Error("derivation produced no key");

  return { mnemonic, privateKey: node.privateKey };
}
