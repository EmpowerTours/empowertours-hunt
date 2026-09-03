import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  WARRANTY_STATEMENTS,
  WARRANTY_TYPES,
  HUNT_DOMAIN,
  isCanonicalStatement,
  statementLanguage,
  warrantyDigest,
  type PlantWarrantyMessage,
} from "./warranty";
import {
  MemoryNonceStore,
  verifyPlantWarrantySignature,
} from "@/lib/auth/eip712";

const planter = privateKeyToAccount(`0x${"33".repeat(32)}`);
const someoneElse = privateKeyToAccount(`0x${"44".repeat(32)}`);

const NOW = new Date("2026-09-02T12:00:00Z");
const NOW_S = BigInt(Math.floor(NOW.getTime() / 1000));

let counter = 0;
function freshNonce(): string {
  counter += 1;
  return `plant${String(counter).padStart(20, "0")}`;
}

function message(
  over: Partial<PlantWarrantyMessage> = {},
): PlantWarrantyMessage {
  return {
    huntId: "hunt_abc",
    nftContract: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    tokenId: 7n,
    statement: WARRANTY_STATEMENTS.es,
    clientTs: NOW_S,
    nonce: freshNonce(),
    ...over,
  };
}

async function sign(m: PlantWarrantyMessage, as = planter) {
  return as.signTypedData({
    domain: HUNT_DOMAIN,
    types: WARRANTY_TYPES,
    primaryType: "PlantWarranty",
    message: { ...m },
  });
}

async function verify(
  m: PlantWarrantyMessage,
  signature: `0x${string}`,
  expectedAddress = planter.address,
) {
  return verifyPlantWarrantySignature(
    { ...m, signature, expectedAddress },
    { store: new MemoryNonceStore(), now: NOW },
  );
}

describe("the canonical sentences", () => {
  it("accepts only the exact texts", () => {
    expect(isCanonicalStatement(WARRANTY_STATEMENTS.en)).toBe(true);
    expect(isCanonicalStatement(WARRANTY_STATEMENTS.es)).toBe(true);
    expect(isCanonicalStatement("I promise it's mine")).toBe(false);
    // A trailing space is a different sentence. Being strict here is the point:
    // "close enough" is how an edited statement gets accepted later.
    expect(isCanonicalStatement(`${WARRANTY_STATEMENTS.en} `)).toBe(false);
  });

  it("reports which language was signed", () => {
    expect(statementLanguage(WARRANTY_STATEMENTS.es)).toBe("es");
    expect(statementLanguage(WARRANTY_STATEMENTS.en)).toBe("en");
    expect(statementLanguage("something else")).toBeNull();
  });

  it("says the two things that matter, in both languages", () => {
    for (const text of Object.values(WARRANTY_STATEMENTS)) {
      expect(text.length).toBeGreaterThan(40);
    }
    expect(WARRANTY_STATEMENTS.en).toMatch(/rights to distribute/i);
    expect(WARRANTY_STATEMENTS.en).toMatch(/breaches no licence/i);
    expect(WARRANTY_STATEMENTS.es).toMatch(/derechos para distribuir/i);
    expect(WARRANTY_STATEMENTS.es).toMatch(/no incumple ninguna licencia/i);
  });
});

describe("a warranty the planter signed", () => {
  it("verifies and returns their address", async () => {
    const m = message();
    const r = await verify(m, await sign(m));
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.address.toLowerCase()).toBe(planter.address.toLowerCase());
  });

  it("refuses one signed by somebody else", async () => {
    const m = message();
    expect(await verify(m, await sign(m, someoneElse))).toEqual({
      ok: false,
      reason: "wrong_signer",
    });
  });
});

describe("the statement is inside the signature", () => {
  it("refuses a signature lifted onto different words", async () => {
    // The whole reason the sentence is a signed field. If the text could be
    // swapped afterwards, the signature would prove nothing about what was
    // actually affirmed — which is exactly what makes a hash-of-terms
    // approach worthless as evidence.
    const m = message({ statement: WARRANTY_STATEMENTS.es });
    const sig = await sign(m);
    const swapped = { ...m, statement: "I make no promises about this token." };
    expect(await verify(swapped, sig)).toEqual({
      ok: false,
      reason: "wrong_signer",
    });
  });

  it("distinguishes the two languages", async () => {
    // A Spanish speaker signed Spanish words. Re-presenting the same signature
    // as though they had affirmed the English text is a different claim.
    const m = message({ statement: WARRANTY_STATEMENTS.es });
    const sig = await sign(m);
    const asEnglish = { ...m, statement: WARRANTY_STATEMENTS.en };
    expect(await verify(asEnglish, sig)).toEqual({
      ok: false,
      reason: "wrong_signer",
    });
  });
});

describe("the token is inside the signature", () => {
  it("refuses a signature moved to a different token id", async () => {
    const m = message({ tokenId: 7n });
    const sig = await sign(m);
    expect(await verify({ ...m, tokenId: 8n }, sig)).toEqual({
      ok: false,
      reason: "wrong_signer",
    });
  });

  it("refuses a signature moved to a different contract", async () => {
    const m = message();
    const sig = await sign(m);
    const moved = {
      ...m,
      nftContract: "0x0000000000000000000000000000000000000001" as const,
    };
    expect(await verify(moved, sig)).toEqual({
      ok: false,
      reason: "wrong_signer",
    });
  });

  it("refuses a signature moved to a different hunt", async () => {
    const m = message();
    const sig = await sign(m);
    expect(await verify({ ...m, huntId: "hunt_other" }, sig)).toEqual({
      ok: false,
      reason: "wrong_signer",
    });
  });
});

describe("the digest identifies the warranty", () => {
  it("is stable and 32 bytes", () => {
    const m = message();
    expect(warrantyDigest(m)).toBe(warrantyDigest(m));
    expect(warrantyDigest(m)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("moves when any signed field moves", () => {
    const base = message();
    const d = warrantyDigest(base);
    expect(warrantyDigest({ ...base, huntId: "x" })).not.toBe(d);
    expect(warrantyDigest({ ...base, tokenId: 8n })).not.toBe(d);
    expect(warrantyDigest({ ...base, statement: "other" })).not.toBe(d);
    expect(
      warrantyDigest({
        ...base,
        nftContract: "0x0000000000000000000000000000000000000001",
      }),
    ).not.toBe(d);
  });
});
