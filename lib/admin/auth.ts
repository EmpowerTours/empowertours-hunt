// Admin authentication and authorisation.
//
// SEPARATE from player auth by design. `lib/auth/**` is Mera-passkey-first with
// a Privy fallback; Mera is preview software and must not stand between an
// operator and a button that releases native MON. Admins log in with an
// EIP-4361 (SIWE) wallet signature checked against the `AdminUser` table.
//
// Rules this file exists to make unavoidable:
//
//   * Every privileged route calls `requireAdminApi(req, AdminRole.X)`. The UI
//     hiding a button is a courtesy, never a control — an operator-shaped fetch
//     sent by hand hits the same check.
//   * The role is read from the database on every request, never trusted from
//     the cookie, so revocation is immediate.
//   * Addresses are stored and compared lowercased. A checksummed row would
//     never match the lookup and would lock the admin out — or worse, a
//     case-sensitive comparison would let two rows exist for one wallet.
//   * Fail closed. Any path that is not an explicit accept throws.

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { recoverMessageAddress, type Hex } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { AdminRole } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  ADMIN_NONCE_COOKIE,
  ADMIN_SESSION_COOKIE,
  clearedCookie,
  issueSession,
  readNonce,
  readSession,
  type CookieSpec,
} from "@/lib/admin/session";

// Monad mainnet. A signature bound to another chain id is a signature produced
// for another application.
export const ADMIN_CHAIN_ID = 143;

export const ADMIN_SIWE_STATEMENT =
  "Sign in to the EmpowerTours Hunt operator console. This authorises administrative access, including the release of native MON payouts.";

export class AdminAuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AdminAuthError";
    this.status = status;
  }
}

export interface AdminSession {
  id: string;
  walletAddress: string;
  role: AdminRole;
  label: string | null;
}

// Ordering is the whole authorisation model: a route names the *minimum* role
// it needs and anything at or above that rank passes.
const RANK: Record<AdminRole, number> = {
  [AdminRole.VIEWER]: 0,
  [AdminRole.OPERATOR]: 1,
  [AdminRole.OWNER]: 2,
};

export function roleAtLeast(have: AdminRole, need: AdminRole): boolean {
  return RANK[have] >= RANK[need];
}

/** Best-effort caller IP, recorded on every AdminAction row. */
export async function requestIp(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return (h.get("x-real-ip") ?? "unknown").slice(0, 64);
}

/**
 * Resolve the calling admin, or null. Never throws for an anonymous caller —
 * use `requireAdminApi` / `requireAdminPage` when access is mandatory.
 */
export async function getAdminSession(): Promise<AdminSession | null> {
  const token = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  const adminId = readSession(token);
  if (!adminId) return null;

  const admin = await prisma.adminUser.findUnique({
    where: { id: adminId },
    select: {
      id: true,
      walletAddress: true,
      role: true,
      label: true,
      active: true,
    },
  });
  // Deactivated admins lose access mid-session, without waiting for the cookie
  // to expire.
  if (!admin || !admin.active) return null;

  return {
    id: admin.id,
    walletAddress: admin.walletAddress,
    role: admin.role,
    label: admin.label,
  };
}

/**
 * Route-handler gate. Throws `AdminAuthError` (401 unauthenticated, 403
 * under-privileged); callers hand it to `adminErrorResponse`.
 */
export async function requireAdminApi(
  minimum: AdminRole,
): Promise<AdminSession> {
  const session = await getAdminSession();
  if (!session) throw new AdminAuthError("admin session required", 401);
  if (!roleAtLeast(session.role, minimum)) {
    throw new AdminAuthError(
      `role ${minimum} or higher required (you are ${session.role})`,
      403,
    );
  }
  return session;
}

/**
 * Server-component gate. Redirects rather than throwing so an operator lands on
 * the login screen instead of an error boundary.
 */
export async function requireAdminPage(
  minimum: AdminRole,
): Promise<AdminSession> {
  const session = await getAdminSession();
  if (!session) redirect("/admin/login");
  if (!roleAtLeast(session.role, minimum)) redirect("/admin?denied=1");
  return session;
}

/** The host this request arrived on, used as the expected SIWE domain. */
async function expectedDomain(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) throw new AdminAuthError("cannot determine request host", 400);
  return host;
}

export interface AdminLoginResult {
  session: AdminSession;
  cookies: CookieSpec[];
}

/**
 * Verify a SIWE login and mint a session.
 *
 * Checked, in order, all of which must hold:
 *   1. a nonce cookie this server signed and has not yet consumed
 *   2. the message parses as EIP-4361 and its nonce, domain, chainId, version
 *      and time window all validate
 *   3. the signature recovers to the address named in the message
 *   4. that address exists in AdminUser and is active
 *
 * Any failure returns the same opaque message. Telling an attacker whether a
 * wallet is an admin is free reconnaissance.
 */
export async function verifyAdminLogin(
  message: string,
  signature: string,
): Promise<AdminLoginResult> {
  const jar = await cookies();
  const issuedNonce = readNonce(jar.get(ADMIN_NONCE_COOKIE)?.value);
  if (!issuedNonce) {
    throw new AdminAuthError(
      "login challenge expired — request a new one",
      401,
    );
  }

  if (
    typeof message !== "string" ||
    message.length === 0 ||
    message.length > 4000
  ) {
    throw new AdminAuthError("invalid login", 401);
  }
  if (!/^0x[0-9a-fA-F]+$/.test(signature) || signature.length > 400) {
    throw new AdminAuthError("invalid login", 401);
  }

  const fields = parseSiweMessage(message);
  const claimedAddress = fields.address;
  if (!claimedAddress) throw new AdminAuthError("invalid login", 401);

  const domain = await expectedDomain();
  const valid = validateSiweMessage({
    message: fields,
    address: claimedAddress,
    domain,
    nonce: issuedNonce,
  });
  // validateSiweMessage does not check chainId or version against our
  // expectations, only internal consistency, so pin both here.
  if (!valid || fields.chainId !== ADMIN_CHAIN_ID || fields.version !== "1") {
    throw new AdminAuthError("invalid login", 401);
  }

  let recovered: string;
  try {
    recovered = await recoverMessageAddress({
      message,
      signature: signature as Hex,
    });
  } catch {
    throw new AdminAuthError("invalid login", 401);
  }

  const walletAddress = recovered.toLowerCase();
  if (walletAddress !== claimedAddress.toLowerCase()) {
    throw new AdminAuthError("invalid login", 401);
  }

  const admin = await resolveAdmin(walletAddress);
  if (!admin) throw new AdminAuthError("invalid login", 401);

  return {
    session: admin,
    cookies: [
      issueSession(admin.id),
      // Consume the nonce. Without this the same signature replays until the
      // 5-minute TTL runs out.
      clearedCookie(ADMIN_NONCE_COOKIE),
    ],
  };
}

/**
 * Look up the admin row, with a one-time bootstrap.
 *
 * `ADMIN_BOOTSTRAP_ADDRESS` promotes exactly one wallet to OWNER, and ONLY
 * while the table is empty — the create is guarded by a count inside the same
 * transaction, so it cannot be used to add a second admin later. Without this
 * the console would be permanently locked out of itself on a fresh database.
 */
async function resolveAdmin(
  walletAddress: string,
): Promise<AdminSession | null> {
  const existing = await prisma.adminUser.findUnique({
    where: { walletAddress },
    select: {
      id: true,
      walletAddress: true,
      role: true,
      label: true,
      active: true,
    },
  });
  if (existing) {
    if (!existing.active) return null;
    return {
      id: existing.id,
      walletAddress: existing.walletAddress,
      role: existing.role,
      label: existing.label,
    };
  }

  const bootstrap = process.env.ADMIN_BOOTSTRAP_ADDRESS?.toLowerCase();
  if (!bootstrap || bootstrap !== walletAddress) return null;

  try {
    return await prisma.$transaction(async (tx) => {
      const count = await tx.adminUser.count();
      if (count > 0) return null;
      const created = await tx.adminUser.create({
        data: {
          walletAddress,
          role: AdminRole.OWNER,
          label: "bootstrap owner",
        },
        select: { id: true, walletAddress: true, role: true, label: true },
      });
      await tx.adminAction.create({
        data: {
          adminId: created.id,
          action: "admin.bootstrap",
          targetType: "AdminUser",
          targetId: created.id,
          detail: "first admin created from ADMIN_BOOTSTRAP_ADDRESS",
        },
      });
      return created;
    });
  } catch {
    // A concurrent bootstrap lost the unique race. Fail closed; retrying the
    // login will now find the existing row.
    return null;
  }
}
