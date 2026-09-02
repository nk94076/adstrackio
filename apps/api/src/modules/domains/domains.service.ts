import type { PrismaClient } from "@adstrackio/database";
import { ApiError, InvalidHostnameError, normalizeTrackingHostname } from "@adstrackio/shared";
import type { CreateTrackingDomainInput } from "@adstrackio/validation";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";
import {
  checkDnsVerification,
  generateVerificationToken,
  verificationRecordName,
  verificationRecordValue,
  type TxtResolver,
} from "./dns-verification.js";

/**
 * Minimum time between verification attempts on the same domain. Each
 * attempt performs a real DNS lookup and writes two audit log entries, so
 * this exists to stop a member from hammering the endpoint (accidental
 * retry loops in a script, or a deliberate attempt to use it as a DNS
 * lookup oracle) rather than for any correctness reason. Kept short enough
 * that a legitimate "I just fixed my DNS record" retry never has to wait
 * long.
 */
export const VERIFICATION_RETRY_COOLDOWN_MS = 10_000;

function normalizeOrThrow(hostname: string): string {
  try {
    return normalizeTrackingHostname(hostname);
  } catch (error) {
    if (error instanceof InvalidHostnameError) {
      throw ApiError.validation(error.message);
    }
    throw error;
  }
}

/** Shape of the DNS record the customer must create, safe to return to the client. */
export function verificationInstructions(hostname: string, token: string | null) {
  if (!token) {
    return null;
  }
  return {
    recordType: "TXT" as const,
    recordName: verificationRecordName(hostname),
    recordValue: verificationRecordValue(token),
  };
}

/**
 * A domain is created PENDING and inactive. Its verification token is
 * generated immediately so the dashboard can show DNS setup instructions
 * without a separate step — the token itself is not a secret (it is meant
 * to be published in public DNS), it just proves the caller controls the
 * zone once it shows up there.
 */
export async function createTrackingDomain(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  input: CreateTrackingDomainInput,
) {
  const hostname = normalizeOrThrow(input.hostname);

  const existing = await prisma.trackingDomain.findUnique({ where: { hostname } });
  if (existing) {
    throw ApiError.conflict(`Hostname "${hostname}" is already registered`);
  }

  return prisma.$transaction(async (tx) => {
    const domain = await tx.trackingDomain.create({
      data: {
        organizationId,
        hostname,
        verificationToken: generateVerificationToken(),
      },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "domain.created",
      entityType: "TrackingDomain",
      entityId: domain.id,
      metadata: { hostname: domain.hostname },
    });

    return domain;
  });
}

export async function listTrackingDomains(prisma: PrismaClient, organizationId: string) {
  return prisma.trackingDomain.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getTrackingDomain(
  prisma: PrismaClient,
  organizationId: string,
  domainId: string,
) {
  const domain = await prisma.trackingDomain.findFirst({
    where: { id: domainId, organizationId },
  });
  if (!domain) {
    throw ApiError.notFound("Tracking domain not found");
  }
  return domain;
}

/**
 * Runs the real, server-side DNS TXT check for a domain. This never trusts
 * a client-supplied "verified" flag — the only way `verificationStatus`
 * becomes VERIFIED is a successful lookup performed right here.
 *
 * Token lifecycle: the token generated at creation time is reused across
 * every retry rather than rotated per attempt — regenerating it on each
 * call would invalidate the DNS record the customer just published,
 * turning "retry after fixing DNS" into an impossible moving target. A
 * fresh token is only ever generated in the defensive fallback below (a
 * pre-migration row with no token), never as part of normal retry flow.
 * `verificationRequestedAt` is stamped on every attempt (success or
 * failure) and doubles as the retry-cooldown clock below.
 *
 * Once a domain is ACTIVE, the database's `isActive => VERIFIED` invariant
 * means it must stay VERIFIED; re-running verification on an active domain
 * is a safe no-op rather than something that could flip it to FAILED and
 * violate that invariant (deactivate first to re-verify from scratch).
 */
export async function verifyTrackingDomain(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  domainId: string,
  resolveTxt?: TxtResolver,
) {
  const domain = await getTrackingDomain(prisma, organizationId, domainId);

  if (domain.isActive) {
    return domain;
  }

  if (domain.verificationRequestedAt) {
    const elapsedMs = Date.now() - domain.verificationRequestedAt.getTime();
    if (elapsedMs < VERIFICATION_RETRY_COOLDOWN_MS) {
      const retryInSeconds = Math.ceil((VERIFICATION_RETRY_COOLDOWN_MS - elapsedMs) / 1000);
      throw ApiError.rateLimited(
        `Verification was already attempted recently for this domain; retry in ${retryInSeconds}s`,
      );
    }
  }

  const token = domain.verificationToken ?? generateVerificationToken();
  const requestedAt = new Date();

  return prisma.$transaction(async (tx) => {
    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "domain.verification_requested",
      entityType: "TrackingDomain",
      entityId: domain.id,
      metadata: { hostname: domain.hostname },
    });

    const verified = await checkDnsVerification(domain.hostname, token, resolveTxt);

    const updated = await tx.trackingDomain.update({
      where: { id: domainId },
      data: {
        verificationToken: token,
        verificationRequestedAt: requestedAt,
        verificationStatus: verified ? "VERIFIED" : "FAILED",
        verifiedAt: verified ? new Date() : null,
      },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: verified ? "domain.verified" : "domain.verification_failed",
      entityType: "TrackingDomain",
      entityId: domain.id,
      metadata: { hostname: domain.hostname },
    });

    return updated;
  });
}

/**
 * Activation requires the domain to already be VERIFIED. The check and the
 * write happen in the same conditional UPDATE (rather than read-then-write)
 * so a concurrent verification-status change can't create a window where an
 * unverified domain is activated.
 */
export async function activateTrackingDomain(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  domainId: string,
) {
  await getTrackingDomain(prisma, organizationId, domainId);

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.trackingDomain.updateMany({
      where: { id: domainId, organizationId, verificationStatus: "VERIFIED" },
      data: { isActive: true },
    });

    if (count === 0) {
      throw ApiError.conflict("Domain must be verified before it can be activated");
    }

    const domain = await tx.trackingDomain.findUniqueOrThrow({ where: { id: domainId } });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "domain.activated",
      entityType: "TrackingDomain",
      entityId: domain.id,
      metadata: { hostname: domain.hostname },
    });

    return domain;
  });
}

export async function deactivateTrackingDomain(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  domainId: string,
) {
  const domain = await getTrackingDomain(prisma, organizationId, domainId);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.trackingDomain.update({
      where: { id: domainId },
      data: { isActive: false },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "domain.deactivated",
      entityType: "TrackingDomain",
      entityId: domain.id,
      metadata: { hostname: domain.hostname },
    });

    return updated;
  });
}
