import { describe, expect, it } from "vitest";
import { NullGeoLocationProvider, UNKNOWN_GEO_LOCATION } from "./geo-location.js";

describe("NullGeoLocationProvider", () => {
  it("always resolves to unknown location without throwing", async () => {
    const provider = new NullGeoLocationProvider();
    await expect(provider.lookup("203.0.113.1")).resolves.toEqual(UNKNOWN_GEO_LOCATION);
  });

  it("never performs a network call (resolves synchronously in practice)", async () => {
    const provider = new NullGeoLocationProvider();
    const start = Date.now();
    await provider.lookup("203.0.113.1");
    expect(Date.now() - start).toBeLessThan(50);
  });
});
