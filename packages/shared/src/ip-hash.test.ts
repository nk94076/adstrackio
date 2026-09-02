import { describe, expect, it } from "vitest";
import { hashIp } from "./ip-hash.js";

describe("hashIp", () => {
  it("produces a deterministic hash for the same input", () => {
    expect(hashIp("203.0.113.1", "salt")).toBe(hashIp("203.0.113.1", "salt"));
  });

  it("never returns the raw IP", () => {
    const hash = hashIp("203.0.113.1", "salt");
    expect(hash).not.toContain("203.0.113.1");
  });

  it("produces a different hash for a different salt", () => {
    expect(hashIp("203.0.113.1", "salt-a")).not.toBe(hashIp("203.0.113.1", "salt-b"));
  });

  it("produces a different hash for a different IP", () => {
    expect(hashIp("203.0.113.1", "salt")).not.toBe(hashIp("203.0.113.2", "salt"));
  });

  it("returns a fixed-length hex digest", () => {
    expect(hashIp("203.0.113.1", "salt")).toMatch(/^[0-9a-f]{64}$/);
  });
});
