import { describe, expect, it } from "vitest";
import { hashRequestBody } from "./idempotency.js";

describe("hashRequestBody", () => {
  it("is stable regardless of key insertion order", () => {
    const a = hashRequestBody({ eventName: "purchase", clickId: "c1", value: 10 });
    const b = hashRequestBody({ value: 10, clickId: "c1", eventName: "purchase" });
    expect(a).toBe(b);
  });

  it("differs for a genuinely different payload", () => {
    const a = hashRequestBody({ eventName: "purchase", clickId: "c1" });
    const b = hashRequestBody({ eventName: "signup", clickId: "c1" });
    expect(a).not.toBe(b);
  });

  it("is stable for nested objects/arrays regardless of key order", () => {
    const a = hashRequestBody({ metadata: { b: 2, a: 1 }, tags: ["x", "y"] });
    const b = hashRequestBody({ tags: ["x", "y"], metadata: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });

  it("distinguishes array order (order is semantically meaningful for arrays)", () => {
    const a = hashRequestBody({ tags: ["x", "y"] });
    const b = hashRequestBody({ tags: ["y", "x"] });
    expect(a).not.toBe(b);
  });
});
