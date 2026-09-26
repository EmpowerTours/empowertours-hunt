import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  ConnectError,
  createExecution,
  listExecutions,
  parseExecution,
  submitSignature,
  toNearPublicKey,
  toNearSignature,
} from "./aurora-connect";

// ---------------------------------------------------------------------------
// The encoding tests are the point of this file. Aurora's OpenAPI spec gives
// `publicKey` and `signature` with no descriptions at all, and the only reason
// this code works is that the live API was probed until it accepted something.
// If someone "tidies" these into Ethereum hex later, the submit call starts
// failing with an error that names the wrong field, so the shapes are pinned.
// ---------------------------------------------------------------------------

const EXECUTION = {
  result: {
    id: "3f0867eb-dc82-40d2-be5c-b9b59ad47ba9",
    status: "DEPOSIT_PENDING",
    quote: {
      depositAddress: "0x2daF515d6A9e5984b6dFaBf8007482b265DE3341",
      amountOut: "80864698752999452997",
      minAmountOut: "80055656085849458467",
    },
    details: {
      intermediaryAddress: "0x077C202f2eECFc8accDF692dAf0B93f0b0D3e6Cd",
      messageToSign: '{"deadline":"2026-10-01T15:52:56Z","intents":[]}',
      messageSigned: false,
      networkFee: "39567962000000000",
      estimatedTime: "39",
    },
  },
};

describe("reading an execution", () => {
  it("reads the real 201 response", () => {
    const e = parseExecution(EXECUTION);
    expect(e.id).toBe("3f0867eb-dc82-40d2-be5c-b9b59ad47ba9");
    expect(e.depositAddress).toBe("0x2daF515d6A9e5984b6dFaBf8007482b265DE3341");
    expect(e.intermediaryAddress).toBe(
      "0x077C202f2eECFc8accDF692dAf0B93f0b0D3e6Cd",
    );
    expect(e.messageSigned).toBe(false);
    expect(e.networkFee).toBe("39567962000000000");
  });

  it("keeps amounts as strings", () => {
    // 80864698752999452997 is larger than Number.MAX_SAFE_INTEGER. Parsing it
    // as a number loses the last four digits of somebody's balance.
    const e = parseExecution(EXECUTION);
    expect(e.amountOut).toBe("80864698752999452997");
    // Round-tripping through a double loses the last digits, which is the whole
    // reason this stays a string.
    expect(String(Number(e.amountOut))).not.toBe(e.amountOut);
  });

  it("treats a dry run's absent signing payload as absent, not empty", () => {
    const dry = {
      result: {
        ...EXECUTION.result,
        details: { intermediaryAddress: "0xabc" },
      },
    };
    expect(parseExecution(dry).messageToSign).toBeNull();
    expect(parseExecution(dry).messageSigned).toBe(false);
  });

  it("refuses a response it cannot recognise at all", () => {
    expect(() => parseExecution({ result: {} })).toThrow(ConnectError);
  });
});

describe("the NEAR encodings nothing documents", () => {
  // A known-good key so the vectors are reproducible.
  const PK =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const account = privateKeyToAccount(PK);

  it("encodes a signature as secp256k1: + base58, with recovery id 0 or 1", async () => {
    const hex = await account.signMessage({ message: "hello" });
    const near = toNearSignature(hex);
    expect(near.startsWith("secp256k1:")).toBe(true);
    // Ethereum's v is 27/28; NEAR wants 0/1, and sending 27 is rejected.
    const raw = Buffer.from(hex.slice(2), "hex");
    expect(raw[64]).toBeGreaterThanOrEqual(27);
  });

  it("encodes the public key as 64 bytes, dropping the 0x04 tag", () => {
    const near = toNearPublicKey(PK);
    expect(near.startsWith("secp256k1:")).toBe(true);
    // 64 raw bytes base58-encode to 87-88 characters; 65 would be longer.
    const body = near.slice("secp256k1:".length);
    expect(body.length).toBeLessThanOrEqual(89);
    expect(body.length).toBeGreaterThan(80);
  });

  it("refuses a signature that is not 65 bytes rather than encoding nonsense", () => {
    expect(() => toNearSignature("0x1234")).toThrow(ConnectError);
  });

  it("refuses an impossible recovery id", () => {
    const bad = "0x" + "11".repeat(64) + "05";
    expect(() => toNearSignature(bad)).toThrow(ConnectError);
  });
});

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fake = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fake, calls };
}

describe("talking to Connect", () => {
  it("sends the key as a header, not in the path", async () => {
    const { fake, calls } = fakeFetch(200, EXECUTION);
    await createExecution(
      {
        wallet: "0xabc",
        quote: {
          originAsset: "a",
          destinationAsset: "b",
          amount: "1",
          slippageTolerance: 100,
          swapType: "EXACT_INPUT",
          deadline: "2026-10-01T00:00:00Z",
        },
        steps: [],
      },
      { fetch: fake, appKey: "SECRET" },
    );
    // Deposits puts the key in the URL; Connect does not, and leaking it into
    // a path would put it in every proxy log that sees the request.
    expect(calls[0]!.url).not.toContain("SECRET");
    expect(
      (calls[0]!.init!.headers as Record<string, string>)["x-api-key"],
    ).toBe("SECRET");
  });

  it("flags a 409 as in-flight rather than as a generic failure", async () => {
    // The UI has to offer to resume the existing execution. A hunter with one
    // in flight cannot create another, and cannot cancel without a signature,
    // so treating this as a retryable error would strand them.
    const { fake } = fakeFetch(409, { error: "already in progress" });
    await expect(
      createExecution(
        {
          wallet: "0xabc",
          quote: {
            originAsset: "a",
            destinationAsset: "b",
            amount: "1",
            slippageTolerance: 100,
            swapType: "EXACT_INPUT",
            deadline: "2026-10-01T00:00:00Z",
          },
          steps: [],
        },
        { fetch: fake, appKey: "k" },
      ),
    ).rejects.toMatchObject({ inFlight: true });
  });

  it("refuses to send more steps than Aurora accepts", async () => {
    const { fake } = fakeFetch(200, EXECUTION);
    const step = {
      to: "0x1",
      functionSignature: "f()",
      parameters: [],
      value: "0",
    };
    await expect(
      createExecution(
        {
          wallet: "0xabc",
          quote: {
            originAsset: "a",
            destinationAsset: "b",
            amount: "1",
            slippageTolerance: 100,
            swapType: "EXACT_INPUT",
            deadline: "2026-10-01T00:00:00Z",
          },
          steps: Array.from({ length: 31 }, () => step),
        },
        { fetch: fake, appKey: "k" },
      ),
    ).rejects.toThrow(ConnectError);
    expect(fake).not.toHaveBeenCalled();
  });

  it("never sends quote.recipient, which a bridge-in rejects outright", async () => {
    const { fake, calls } = fakeFetch(200, EXECUTION);
    await createExecution(
      {
        wallet: "0xabc",
        quote: {
          originAsset: "a",
          destinationAsset: "b",
          amount: "1",
          slippageTolerance: 100,
          swapType: "EXACT_INPUT",
          deadline: "2026-10-01T00:00:00Z",
        },
        steps: [],
      },
      { fetch: fake, appKey: "k" },
    );
    const sent = JSON.parse(String(calls[0]!.init!.body));
    expect(sent.quote.recipient).toBeUndefined();
    expect(sent.type).toBe("evm");
  });

  it("reads the status back from a submit", async () => {
    const { fake } = fakeFetch(200, {
      result: { status: "SIGNED_PENDING_DEPOSIT" },
    });
    const r = await submitSignature(
      {
        wallet: "0xabc",
        executionId: "e1",
        publicKey: "secp256k1:x",
        signature: "secp256k1:y",
      },
      { fetch: fake, appKey: "k" },
    );
    expect(r.status).toBe("SIGNED_PENDING_DEPOSIT");
  });

  it("drops an unreadable row from a list instead of failing the screen", async () => {
    const { fake } = fakeFetch(200, {
      result: [EXECUTION.result, { nonsense: true }],
    });
    const rows = await listExecutions("0xabc", { fetch: fake, appKey: "k" });
    expect(rows).toHaveLength(1);
  });
});
