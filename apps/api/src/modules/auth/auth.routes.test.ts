import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, extractSessionCookie, registerAccount } from "../../../test/helpers.js";
import { resetDatabase } from "../../../test/db-reset.js";

let app: FastifyInstance;

beforeEach(async () => {
  app ??= await buildTestApp();
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
});

describe("POST /api/v1/auth/register", () => {
  it("creates a user and an organization, and returns a session cookie", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "owner@example.com",
        password: "Str0ngPassword1",
        name: "Owner",
        organizationName: "Acme",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user.email).toBe("owner@example.com");
    expect(body.organizationId).toBeTruthy();
    expect(() => extractSessionCookie(response.headers["set-cookie"])).not.toThrow();
  });

  it("rejects a duplicate email", async () => {
    await registerAccount(app, { email: "dupe@example.com" });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "dupe@example.com",
        password: "Str0ngPassword1",
        name: "Dupe",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
  });

  it("rejects a weak password with a validation error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "weak@example.com", password: "weak", name: "Weak" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/v1/auth/login", () => {
  it("logs in with correct credentials", async () => {
    const account = await registerAccount(app, { email: "login@example.com" });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: account.email, password: "Str0ngPassword1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.email).toBe(account.email);
  });

  it("rejects an incorrect password without leaking whether the email exists", async () => {
    const account = await registerAccount(app, { email: "wrongpass@example.com" });

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: account.email, password: "WrongPassword1" },
    });
    const unknownEmail = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@example.com", password: "WrongPassword1" },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json().error.message).toBe(unknownEmail.json().error.message);
  });
});

describe("GET /api/v1/auth/me", () => {
  it("requires authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("returns the current user and their memberships", async () => {
    const account = await registerAccount(app, {
      email: "me@example.com",
      organizationName: "Me Org",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: account.cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.email).toBe("me@example.com");
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].role).toBe("OWNER");
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("clears the session cookie", async () => {
    const account = await registerAccount(app, { email: "logout@example.com" });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: account.cookie },
    });

    expect(response.statusCode).toBe(204);
    const setCookie = response.headers["set-cookie"];
    expect(String(setCookie)).toMatch(/adstrackio_session=;/);
  });

  it("returns a 400 validation error (not a 500) for a JSON content-type with no body", async () => {
    // Regression test: a real browser client that sends
    // Content-Type: application/json on a body-less POST must not surface
    // as an opaque 500 — apps/dashboard's apiFetch avoids sending this
    // header when there is no body, and the API's error handler maps
    // Fastify's own body-parser errors to a proper 4xx either way.
    const account = await registerAccount(app, { email: "logout-empty-body@example.com" });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: account.cookie, "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });
});
