import { describe, expect, it } from "vitest";
import {
  createAffiliatePartnerSchema,
  updateAffiliatePartnerSchema,
} from "./affiliate-partners.js";

function base(overrides: Record<string, unknown> = {}) {
  return { name: "Acme Partner", ...overrides };
}

describe("createAffiliatePartnerSchema", () => {
  it("accepts a minimal valid payload and defaults status to PENDING", () => {
    const result = createAffiliatePartnerSchema.safeParse(base());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("PENDING");
    }
  });

  it("accepts an explicit ACTIVE status", () => {
    expect(createAffiliatePartnerSchema.safeParse(base({ status: "ACTIVE" })).success).toBe(true);
  });

  it.each(["PAUSED", "ARCHIVED"])("rejects creating a partner directly in %s status", (status) => {
    expect(createAffiliatePartnerSchema.safeParse(base({ status })).success).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(createAffiliatePartnerSchema.safeParse(base({ name: "" })).success).toBe(false);
  });

  it("accepts and lowercases a well-formed email", () => {
    const result = createAffiliatePartnerSchema.safeParse(base({ email: "Partner@Example.COM" }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("partner@example.com");
    }
  });

  it("rejects a malformed email", () => {
    expect(createAffiliatePartnerSchema.safeParse(base({ email: "not-an-email" })).success).toBe(
      false,
    );
  });

  it("accepts an externalId", () => {
    expect(
      createAffiliatePartnerSchema.safeParse(base({ externalId: "partner-123" })).success,
    ).toBe(true);
  });

  it("rejects an empty externalId", () => {
    expect(createAffiliatePartnerSchema.safeParse(base({ externalId: "" })).success).toBe(false);
  });

  it("accepts metadata", () => {
    expect(
      createAffiliatePartnerSchema.safeParse(base({ metadata: { tier: "gold" } })).success,
    ).toBe(true);
  });

  it("does not accept organizationId, createdBy, or any attribution field from the client (mass assignment)", () => {
    const result = createAffiliatePartnerSchema.safeParse(
      base({
        organizationId: "org_attacker_supplied",
        createdBy: "user_attacker_supplied",
        affiliatePartnerId: "partner_attacker_supplied",
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("organizationId");
      expect(result.data).not.toHaveProperty("createdBy");
      expect(result.data).not.toHaveProperty("affiliatePartnerId");
    }
  });
});

describe("updateAffiliatePartnerSchema", () => {
  it("accepts a partial payload with only one field", () => {
    expect(updateAffiliatePartnerSchema.safeParse({ name: "New Name" }).success).toBe(true);
  });

  it("accepts an empty payload (no-op update)", () => {
    expect(updateAffiliatePartnerSchema.safeParse({}).success).toBe(true);
  });

  it("allows clearing externalId/email by setting them to null", () => {
    const result = updateAffiliatePartnerSchema.safeParse({ externalId: null, email: null });
    expect(result.success).toBe(true);
  });

  it("has no status field — a status key in the input is silently ignored, not rejected", () => {
    const result = updateAffiliatePartnerSchema.safeParse({ status: "ARCHIVED" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("status");
    }
  });
});
