// ---------------------------------------------------------------------------
// The statement a Sembrador signs before planting somebody's reward.
//
// A platform where strangers attach NFTs to physical locations will eventually
// host one somebody had no right to give away — a track whose beat lease bans
// NFTs, a right-clicked image, a master the planter does not hold. The transfer
// happens here, which makes it this platform's problem and not only theirs.
//
// ## Why a signature and not a checkbox
//
// A ticked box proves somebody clicked. A signature proves the holder of the
// key that controls that wallet affirmed a specific sentence at a specific
// time, and it survives being shown to a rights holder or a platform reviewer
// months later. The Zlatko precedent is the whole argument: a dated document,
// produced before the claim, is what actually persuaded a human reviewer.
//
// ## Why the STATEMENT is a signed field
//
// It would be easier to sign a hash of "the terms" and keep the words in a
// database. Then the words could be edited afterwards and the signature would
// still verify — which is precisely the property that makes such a signature
// worthless as evidence. The sentence itself is in the message, so what was
// signed is what was read, permanently.
//
// And it is signed in the language the planter read. A Spanish speaker in
// Guerrero affirming an English sentence has affirmed a sentence they did not
// read; the server accepts either canonical text and records which one.
// ---------------------------------------------------------------------------

import { hashTypedData } from "viem";
import { HUNT_DOMAIN } from "@/lib/auth/typedData";

export { HUNT_DOMAIN };

export const WARRANTY_TYPES = {
  PlantWarranty: [
    { name: "huntId", type: "string" },

    // The token being promised. Address and id together, because "I own token
    // 4" is meaningless without saying of what.
    { name: "nftContract", type: "address" },
    { name: "tokenId", type: "uint256" },

    // The words themselves — see above.
    { name: "statement", type: "string" },

    { name: "clientTs", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

/**
 * The exact sentences. Editing either one is a version change, not a tweak:
 * every warranty already signed refers to the text as it was on that day, and
 * the old text has to stay readable for those signatures to mean anything.
 */
export const WARRANTY_STATEMENTS = {
  en: "I own or control the rights to distribute this token, and planting it here breaches no licence I hold.",
  es: "Soy dueño o tengo los derechos para distribuir este token, y sembrarlo aquí no incumple ninguna licencia que yo tenga.",
} as const;

export type WarrantyLang = keyof typeof WARRANTY_STATEMENTS;

/** Is this exactly one of the canonical sentences? */
export function isCanonicalStatement(statement: string): boolean {
  return Object.values(WARRANTY_STATEMENTS).includes(
    statement as (typeof WARRANTY_STATEMENTS)[WarrantyLang],
  );
}

/** Which language was signed, or null if the text is not one of ours. */
export function statementLanguage(statement: string): WarrantyLang | null {
  for (const [lang, text] of Object.entries(WARRANTY_STATEMENTS)) {
    if (text === statement) return lang as WarrantyLang;
  }
  return null;
}

export interface PlantWarrantyMessage {
  huntId: string;
  nftContract: `0x${string}`;
  tokenId: bigint;
  statement: string;
  /** Unix SECONDS. */
  clientTs: bigint;
  nonce: string;
}

/**
 * EIP-712 digest of a warranty — what gets stored, and what makes it unique.
 *
 * Same reasoning as lib/cota/typedData.ts: the verifier answers who signed,
 * this answers which statement. Keeping them separate means a row can be keyed
 * by the agreement rather than by whatever a verifier happened to return.
 */
export function warrantyDigest(message: PlantWarrantyMessage): `0x${string}` {
  return hashTypedData({
    domain: HUNT_DOMAIN,
    types: WARRANTY_TYPES,
    primaryType: "PlantWarranty",
    message: {
      huntId: message.huntId,
      nftContract: message.nftContract,
      tokenId: message.tokenId,
      statement: message.statement,
      clientTs: message.clientTs,
      nonce: message.nonce,
    },
  });
}
