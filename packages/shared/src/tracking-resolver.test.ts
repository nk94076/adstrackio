import { describe, expect, it } from "vitest";
import { NotImplementedTrackingResolver } from "./tracking-resolver.js";

describe("NotImplementedTrackingResolver", () => {
  it("rejects instead of pretending to resolve a click", async () => {
    const resolver = new NotImplementedTrackingResolver();
    await expect(
      resolver.resolve({ hostname: "track.example.com", slug: "abc123" }),
    ).rejects.toThrow(/no implementation registered/i);
  });
});
