import { describe, expect, it } from "vitest";
import { createSessionToken, InvalidSessionError, verifySessionToken } from "./session.js";

const SECRET = "a".repeat(32);

describe("session tokens", () => {
  it("round-trips a userId and activeOrganizationId", async () => {
    const token = await createSessionToken({
      secret: SECRET,
      payload: { userId: "user_1", activeOrganizationId: "org_1" },
    });

    const payload = await verifySessionToken(token, SECRET);
    expect(payload.userId).toBe("user_1");
    expect(payload.activeOrganizationId).toBe("org_1");
  });

  it("round-trips without an active organization", async () => {
    const token = await createSessionToken({ secret: SECRET, payload: { userId: "user_1" } });
    const payload = await verifySessionToken(token, SECRET);
    expect(payload.userId).toBe("user_1");
    expect(payload.activeOrganizationId).toBeUndefined();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken({ secret: SECRET, payload: { userId: "user_1" } });
    await expect(verifySessionToken(token, "b".repeat(32))).rejects.toBeInstanceOf(
      InvalidSessionError,
    );
  });

  it("rejects an expired token", async () => {
    const token = await createSessionToken({
      secret: SECRET,
      payload: { userId: "user_1" },
      ttlSeconds: -1,
    });
    await expect(verifySessionToken(token, SECRET)).rejects.toBeInstanceOf(InvalidSessionError);
  });

  it("rejects garbage input", async () => {
    await expect(verifySessionToken("not-a-jwt", SECRET)).rejects.toBeInstanceOf(
      InvalidSessionError,
    );
  });
});
