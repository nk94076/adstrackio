import { describe, expect, it } from "vitest";
import { prisma } from "./index.js";

describe("prisma client", () => {
  it("exposes a delegate for every Phase 1 model", () => {
    const expectedDelegates = [
      "user",
      "organization",
      "organizationMember",
      "trackingDomain",
      "campaign",
      "trackingLink",
      "destination",
      "click",
      "conversion",
      "botEvent",
      "referralConfiguration",
      "referralProof",
      "auditLog",
    ] as const;

    for (const delegate of expectedDelegates) {
      expect(prisma[delegate]).toBeDefined();
    }
  });

  it("returns the same singleton instance on repeated import", async () => {
    const { prisma: prismaAgain } = await import("./index.js");
    expect(prismaAgain).toBe(prisma);
  });
});
