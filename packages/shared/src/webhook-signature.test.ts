import { describe, expect, it } from "vitest";
import {
  buildWebhookSigningInput,
  isWebhookTimestampFresh,
  signWebhookPayload,
  verifyWebhookSignature,
} from "./webhook-signature.js";

describe("signWebhookPayload / verifyWebhookSignature", () => {
  const secret = "whsec_test";
  const timestamp = "1700000000000";
  const rawBody = '{"id":"evt_1","type":"conversion.approved"}';

  it("verifies a correctly signed payload", () => {
    const signature = signWebhookPayload(secret, timestamp, rawBody);
    expect(verifyWebhookSignature(secret, timestamp, rawBody, signature)).toBe(true);
  });

  it("rejects a tampered body — signing must be over the exact raw bytes, not a re-serialization", () => {
    const signature = signWebhookPayload(secret, timestamp, rawBody);
    const reserialized = JSON.stringify(JSON.parse(rawBody)); // same object, re-stringified
    // Even a semantically-identical re-serialization must not verify
    // unless it's byte-identical — proving signing is over the raw wire
    // bytes, not a parsed-then-re-stringified object.
    const tampered = rawBody + " "; // whitespace-different but "same JSON"
    expect(verifyWebhookSignature(secret, timestamp, tampered, signature)).toBe(false);
    expect(reserialized).toBe(rawBody); // sanity: this particular body round-trips identically
  });

  it("rejects a wrong secret", () => {
    const signature = signWebhookPayload(secret, timestamp, rawBody);
    expect(verifyWebhookSignature("whsec_wrong", timestamp, rawBody, signature)).toBe(false);
  });

  it("rejects a wrong timestamp", () => {
    const signature = signWebhookPayload(secret, timestamp, rawBody);
    expect(verifyWebhookSignature(secret, "1700000099999", rawBody, signature)).toBe(false);
  });

  it("never throws on a malformed signature", () => {
    expect(verifyWebhookSignature(secret, timestamp, rawBody, "not-hex")).toBe(false);
    expect(verifyWebhookSignature(secret, timestamp, rawBody, "")).toBe(false);
  });

  it("signing input is timestamp + '.' + rawBody, documented precisely", () => {
    expect(buildWebhookSigningInput(timestamp, rawBody)).toBe(`${timestamp}.${rawBody}`);
  });
});

describe("isWebhookTimestampFresh", () => {
  it("accepts a recent timestamp and rejects an old one (replay protection)", () => {
    const now = 1_700_000_000_000;
    expect(isWebhookTimestampFresh(String(now - 1000), now)).toBe(true);
    expect(isWebhookTimestampFresh(String(now - 10 * 60 * 1000), now)).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(isWebhookTimestampFresh("not-a-number")).toBe(false);
  });
});
