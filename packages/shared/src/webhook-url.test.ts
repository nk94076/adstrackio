import { describe, expect, it } from "vitest";
import { UnsafeWebhookUrlError, validateWebhookUrl } from "./webhook-url.js";

function withDns(addresses: string[]) {
  return async () => addresses;
}

describe("validateWebhookUrl", () => {
  it("accepts a public https URL resolving to a public address", async () => {
    const result = await validateWebhookUrl("https://example.com/hooks", {
      requireHttps: true,
      resolveHostname: withDns(["93.184.216.34"]),
    });
    expect(result.url).toBe("https://example.com/hooks");
    expect(result.resolvedAddresses).toEqual(["93.184.216.34"]);
  });

  it("rejects http:// when requireHttps is true", async () => {
    await expect(
      validateWebhookUrl("http://example.com/hooks", { requireHttps: true, resolveHostname: withDns(["93.184.216.34"]) }),
    ).rejects.toThrow(UnsafeWebhookUrlError);
  });

  it("allows http:// when requireHttps is false", async () => {
    const result = await validateWebhookUrl("http://example.com/hooks", {
      requireHttps: false,
      resolveHostname: withDns(["93.184.216.34"]),
    });
    expect(result.url).toBe("http://example.com/hooks");
  });

  it("rejects a malformed URL", async () => {
    await expect(validateWebhookUrl("not a url", { requireHttps: false })).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
  });

  it("rejects a dangerous scheme", async () => {
    await expect(
      validateWebhookUrl("javascript:alert(1)", { requireHttps: false }),
    ).rejects.toThrow(UnsafeWebhookUrlError);
  });

  it("rejects the literal hostname 'localhost'", async () => {
    await expect(
      validateWebhookUrl("https://localhost/hooks", { requireHttps: false }),
    ).rejects.toThrow(UnsafeWebhookUrlError);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["loopback range", "127.5.5.5"],
    ["all-zeros", "0.0.0.0"],
    ["RFC1918 10/8", "10.1.2.3"],
    ["RFC1918 172.16/12", "172.16.0.5"],
    ["RFC1918 192.168/16", "192.168.1.1"],
    ["link-local / cloud metadata", "169.254.169.254"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["broadcast", "255.255.255.255"],
    ["multicast", "224.0.0.1"],
  ])("rejects a hostname resolving to a %s address (%s)", async (_label, ip) => {
    await expect(
      validateWebhookUrl("https://attacker-controlled.example.test/hooks", {
        requireHttps: true,
        resolveHostname: withDns([ip]),
      }),
    ).rejects.toThrow(UnsafeWebhookUrlError);
  });

  it("rejects an IPv6 loopback/unique-local/link-local address", async () => {
    for (const ip of ["::1", "fc00::1", "fe80::1"]) {
      await expect(
        validateWebhookUrl("https://attacker-controlled.example.test/hooks", {
          requireHttps: true,
          resolveHostname: withDns([ip]),
        }),
      ).rejects.toThrow(UnsafeWebhookUrlError);
    }
  });

  it("rejects an IPv4-mapped IPv6 address that unwraps to a private address", async () => {
    await expect(
      validateWebhookUrl("https://attacker-controlled.example.test/hooks", {
        requireHttps: true,
        resolveHostname: withDns(["::ffff:127.0.0.1"]),
      }),
    ).rejects.toThrow(UnsafeWebhookUrlError);
  });

  it("rejects when even ONE of several DNS answers is internal (multi-answer rebinding attempt)", async () => {
    await expect(
      validateWebhookUrl("https://attacker-controlled.example.test/hooks", {
        requireHttps: true,
        resolveHostname: withDns(["93.184.216.34", "169.254.169.254"]),
      }),
    ).rejects.toThrow(UnsafeWebhookUrlError);
  });

  it("accepts a direct public IP literal with no DNS involved", async () => {
    const result = await validateWebhookUrl("https://93.184.216.34/hooks", { requireHttps: true });
    expect(result.resolvedAddresses).toEqual(["93.184.216.34"]);
  });

  it("rejects a direct private IP literal with no DNS involved", async () => {
    await expect(validateWebhookUrl("https://127.0.0.1/hooks", { requireHttps: true })).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
  });

  it("rejects when DNS resolution fails", async () => {
    await expect(
      validateWebhookUrl("https://does-not-resolve.example.test/hooks", {
        requireHttps: true,
        resolveHostname: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toThrow(UnsafeWebhookUrlError);
  });

  it("returns a lower-cased hostname for consistent storage", async () => {
    const result = await validateWebhookUrl("https://EXAMPLE.com/hooks", {
      requireHttps: true,
      resolveHostname: withDns(["93.184.216.34"]),
    });
    expect(result.hostname).toBe("example.com");
  });
});
