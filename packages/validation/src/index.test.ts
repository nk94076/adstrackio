import { describe, expect, it } from "vitest";
import {
  createCampaignSchema,
  createReferralConfigurationSchema,
  createTrackingDomainSchema,
  loginSchema,
  registerSchema,
  submitReferralProofSchema,
} from "./index.js";

describe("registerSchema", () => {
  it("accepts a strong password", () => {
    const result = registerSchema.safeParse({
      email: "USER@Example.com",
      password: "Str0ngPassword",
      name: "Test User",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("user@example.com");
    }
  });

  it("rejects a weak password", () => {
    const result = registerSchema.safeParse({
      email: "user@example.com",
      password: "weak",
      name: "Test User",
    });
    expect(result.success).toBe(false);
  });
});

describe("loginSchema", () => {
  it("requires a non-empty password", () => {
    const result = loginSchema.safeParse({ email: "user@example.com", password: "" });
    expect(result.success).toBe(false);
  });
});

describe("createTrackingDomainSchema", () => {
  it("accepts a valid hostname", () => {
    expect(
      createTrackingDomainSchema.safeParse({ hostname: "track.example.com" }).success,
    ).toBe(true);
  });

  it("rejects an invalid hostname", () => {
    expect(createTrackingDomainSchema.safeParse({ hostname: "not a hostname" }).success).toBe(
      false,
    );
  });
});

describe("createCampaignSchema", () => {
  it("rejects an endDate before startDate", () => {
    const result = createCampaignSchema.safeParse({
      name: "Summer Sale",
      startDate: "2026-06-01",
      endDate: "2026-01-01",
    });
    expect(result.success).toBe(false);
  });
});

describe("createReferralConfigurationSchema", () => {
  it("requires customReferrerValue for CUSTOM_PARTNER_ATTRIBUTION", () => {
    const result = createReferralConfigurationSchema.safeParse({
      type: "CUSTOM_PARTNER_ATTRIBUTION",
    });
    expect(result.success).toBe(false);
  });

  it("accepts NORMAL without customReferrerValue", () => {
    const result = createReferralConfigurationSchema.safeParse({ type: "NORMAL" });
    expect(result.success).toBe(true);
  });
});

describe("submitReferralProofSchema", () => {
  it("requires at least one evidence field", () => {
    expect(submitReferralProofSchema.safeParse({}).success).toBe(false);
  });

  it("accepts an evidence URL alone", () => {
    expect(
      submitReferralProofSchema.safeParse({ evidenceUrl: "https://example.com/proof.pdf" })
        .success,
    ).toBe(true);
  });
});
