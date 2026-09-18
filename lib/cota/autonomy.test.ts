import { describe, expect, it } from "vitest";
import {
  agentMay,
  AUTONOMY_MODES,
  isAutonomyMode,
  parseAutonomy,
} from "./autonomy";

describe("parseAutonomy fails closed", () => {
  it("reads the two real grants", () => {
    expect(parseAutonomy("exit_only")).toBe("exit_only");
    expect(parseAutonomy("full")).toBe("full");
  });

  it("reads ANYTHING else as off", () => {
    // The one place here that must fail closed. An unreadable grant is not a
    // grant — a bad migration or a fat-fingered update must not authorise
    // unattended trading on every leash at once.
    for (const v of [
      null,
      undefined,
      "",
      "off",
      "OFF",
      "Full",
      "exit-only",
      "true",
      "1",
      "yes",
      "full ",
    ]) {
      expect(parseAutonomy(v as string | null)).toBe("off");
    }
  });

  it("is case-sensitive on purpose — a near miss is not a grant", () => {
    expect(parseAutonomy("FULL")).toBe("off");
  });
});

describe("agentMay", () => {
  it("off permits nothing", () => {
    expect(agentMay("off", "open")).toBe(false);
    expect(agentMay("off", "close")).toBe(false);
  });

  it("exit_only may close and may NEVER open", () => {
    // The property that makes this mode safe to hand out: it cannot increase
    // exposure. The worst it can do is take a profit earlier than the hunter
    // would have.
    expect(agentMay("exit_only", "close")).toBe(true);
    expect(agentMay("exit_only", "open")).toBe(false);
  });

  it("full may do both", () => {
    expect(agentMay("full", "open")).toBe(true);
    expect(agentMay("full", "close")).toBe(true);
  });

  it("no mode permits opening without permitting closing", () => {
    // An agent that may open but not close is the ratchet this whole design
    // exists to avoid. Assert it structurally rather than trusting the table.
    for (const m of AUTONOMY_MODES) {
      if (agentMay(m, "open")) expect(agentMay(m, "close")).toBe(true);
    }
  });
});

describe("isAutonomyMode", () => {
  it("accepts exactly the three modes", () => {
    for (const m of AUTONOMY_MODES) expect(isAutonomyMode(m)).toBe(true);
  });

  it("rejects everything else", () => {
    for (const v of [null, 1, {}, "FULL", "exit-only", ""]) {
      expect(isAutonomyMode(v)).toBe(false);
    }
  });
});

// --- signed grants ---------------------------------------------------------

import { privateKeyToAccount } from "viem/accounts";
import { autonomyTypedData } from "./typedData";
import { verifyStoredGrant } from "./autonomy";

const KEY = `0x${"11".repeat(32)}` as const;
const signer = privateKeyToAccount(KEY);
const DIGEST = `0x${"ab".repeat(32)}` as const;
const FUTURE = new Date(Date.now() + 86_400_000);

async function signGrant(mode: "exit_only" | "full", notAfter = FUTURE) {
  return signer.signTypedData(
    autonomyTypedData({
      cotaDigest: DIGEST,
      mode,
      notAfter: BigInt(Math.floor(notAfter.getTime() / 1000)),
      nonce: "n-1",
    }),
  );
}

describe("verifyStoredGrant — the signature is checked on READ", () => {
  it("accepts a grant the hunter actually signed", async () => {
    const r = await verifyStoredGrant({
      stored: "full",
      cotaDigest: DIGEST,
      signature: await signGrant("full"),
      nonce: "n-1",
      notAfter: FUTURE,
      walletAddress: signer.address,
    });
    expect(r.mode).toBe("full");
  });

  it("rejects a row somebody WROTE without a signature", async () => {
    // The attack this closes: database write access alone flipping the mode and
    // having the legitimate server trade inside the hunter's leash.
    const r = await verifyStoredGrant({
      stored: "full",
      cotaDigest: DIGEST,
      signature: null,
      nonce: null,
      notAfter: FUTURE,
      walletAddress: signer.address,
    });
    expect(r.mode).toBe("off");
    expect(r.reason).toBe("unsigned");
  });

  it("rejects a signature from the wrong wallet", async () => {
    const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const r = await verifyStoredGrant({
      stored: "full",
      cotaDigest: DIGEST,
      signature: await signGrant("full"),
      nonce: "n-1",
      notAfter: FUTURE,
      walletAddress: other.address,
    });
    expect(r.mode).toBe("off");
    expect(r.reason).toBe("wrong_signer");
  });

  it("rejects a mode ESCALATED after signing", async () => {
    // Signed for exit_only, stored as full. The mode is inside the signed
    // struct, so the recovered address no longer matches.
    const r = await verifyStoredGrant({
      stored: "full",
      cotaDigest: DIGEST,
      signature: await signGrant("exit_only"),
      nonce: "n-1",
      notAfter: FUTURE,
      walletAddress: signer.address,
    });
    expect(r.mode).toBe("off");
    expect(r.reason).toBe("wrong_signer");
  });

  it("rejects a grant moved onto a DIFFERENT leash", async () => {
    // A grant for a $20 leash must not authorise a $500 one.
    const r = await verifyStoredGrant({
      stored: "full",
      cotaDigest: `0x${"cd".repeat(32)}`,
      signature: await signGrant("full"),
      nonce: "n-1",
      notAfter: FUTURE,
      walletAddress: signer.address,
    });
    expect(r.mode).toBe("off");
  });

  it("rejects an expired grant, even correctly signed", async () => {
    const past = new Date(Date.now() - 1000);
    const r = await verifyStoredGrant({
      stored: "full",
      cotaDigest: DIGEST,
      signature: await signGrant("full", past),
      nonce: "n-1",
      notAfter: past,
      walletAddress: signer.address,
    });
    expect(r.mode).toBe("off");
    expect(r.reason).toBe("expired");
  });

  it("rejects an extended expiry — notAfter is inside the signature", async () => {
    const signedFor = new Date(Date.now() + 3_600_000);
    const r = await verifyStoredGrant({
      stored: "full",
      cotaDigest: DIGEST,
      signature: await signGrant("full", signedFor),
      nonce: "n-1",
      notAfter: new Date(Date.now() + 999_000_000), // stretched in the DB
      walletAddress: signer.address,
    });
    expect(r.mode).toBe("off");
    expect(r.reason).toBe("wrong_signer");
  });

  it("every failure reads as off, never as a partial grant", async () => {
    const r = await verifyStoredGrant({
      stored: "garbage",
      cotaDigest: DIGEST,
      signature: "0xnot-a-signature",
      nonce: "n-1",
      notAfter: FUTURE,
      walletAddress: signer.address,
    });
    expect(r.mode).toBe("off");
  });
});

describe("observe — the hunter's own dry run", () => {
  it("authorises nothing, like off", async () => {
    const { agentMay } = await import("./autonomy");
    expect(agentMay("observe", "open")).toBe(false);
    expect(agentMay("observe", "close")).toBe(false);
  });

  it("but EVALUATES as full, unlike off", async () => {
    // The distinction that makes it useful. A log showing what a restricted
    // agent would have done is a poor basis for deciding whether to unrestrict
    // it — so observe reasons as the most permissive mode and sends nothing.
    const { evaluationMode, observeOnly } = await import("./autonomy");
    expect(evaluationMode("observe")).toBe("full");
    expect(observeOnly("observe")).toBe(true);
  });

  it("no other mode is observe-only", async () => {
    const { observeOnly } = await import("./autonomy");
    for (const m of ["off", "exit_only", "full"] as const) {
      expect(observeOnly(m)).toBe(false);
    }
  });

  it("evaluationMode leaves every other mode alone", async () => {
    const { evaluationMode } = await import("./autonomy");
    for (const m of ["off", "exit_only", "full"] as const) {
      expect(evaluationMode(m)).toBe(m);
    }
  });

  it("parses from storage, and a near miss still fails closed", async () => {
    const { parseAutonomy } = await import("./autonomy");
    expect(parseAutonomy("observe")).toBe("observe");
    for (const v of ["Observe", "OBSERVE", "observe ", "watch"]) {
      expect(parseAutonomy(v)).toBe("off");
    }
  });
});
