import { describe, expect, it } from "vitest";
import { hasMinimumRole, isValidOrganizationRole } from "./roles.js";

describe("hasMinimumRole", () => {
  it("allows an OWNER to satisfy any minimum", () => {
    expect(hasMinimumRole("OWNER", "ADMIN")).toBe(true);
    expect(hasMinimumRole("OWNER", "OWNER")).toBe(true);
  });

  it("denies a VIEWER from satisfying an ADMIN requirement", () => {
    expect(hasMinimumRole("VIEWER", "ADMIN")).toBe(false);
  });

  it("allows a role to satisfy its own exact requirement", () => {
    expect(hasMinimumRole("MEMBER", "MEMBER")).toBe(true);
  });
});

describe("isValidOrganizationRole", () => {
  it("accepts known roles", () => {
    expect(isValidOrganizationRole("ADMIN")).toBe(true);
  });

  it("rejects unknown strings", () => {
    expect(isValidOrganizationRole("SUPERADMIN")).toBe(false);
  });
});
