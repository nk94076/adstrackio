import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiClientError } from "./api-client";

describe("apiFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ hello: "world" }),
      }),
    );

    const result = await apiFetch<{ hello: string }>("/api/v1/whatever");
    expect(result).toEqual({ hello: "world" });
  });

  it("returns undefined for a 204 response without parsing the body", async () => {
    const json = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 204, json }));

    const result = await apiFetch("/api/v1/auth/logout", { method: "POST" });
    expect(result).toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it("throws ApiClientError with the server's error code and message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: { code: "CONFLICT", message: "Already exists" } }),
      }),
    );

    await expect(apiFetch("/api/v1/organizations")).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
      message: "Already exists",
    });
  });

  it("omits the Content-Type header when there is no request body", async () => {
    // Regression test: Fastify rejects a JSON content-type with an empty
    // body (e.g. POST /auth/logout), so apiFetch must not send that header
    // unless it's actually sending a body.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json: vi.fn() });
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/v1/auth/logout", { method: "POST" });

    const headers = fetchMock.mock.calls[0]![1].headers;
    expect(headers).not.toHaveProperty("Content-Type");
  });

  it("sets the Content-Type header when a body is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/v1/organizations", {
      method: "POST",
      body: JSON.stringify({ name: "Acme" }),
    });

    const headers = fetchMock.mock.calls[0]![1].headers;
    expect(headers).toHaveProperty("Content-Type", "application/json");
  });

  it("wraps a non-JSON failure response in a generic ApiClientError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => {
          throw new Error("not json");
        },
      }),
    );

    const error = await apiFetch("/api/v1/organizations").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).statusCode).toBe(500);
  });
});
