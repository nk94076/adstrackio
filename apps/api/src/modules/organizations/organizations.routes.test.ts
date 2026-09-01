import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, registerAccount } from "../../../test/helpers.js";
import { resetDatabase } from "../../../test/db-reset.js";

let app: FastifyInstance;

beforeEach(async () => {
  app ??= await buildTestApp();
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
});

describe("organizations", () => {
  it("creates an organization and lists it for the creator", async () => {
    const account = await registerAccount(app, { email: "org-owner@example.com" });

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: { cookie: account.cookie },
      payload: { name: "New Org" },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/organizations",
      headers: { cookie: account.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().organizations).toHaveLength(1);
  });

  it("rejects unauthenticated access", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/organizations" });
    expect(response.statusCode).toBe(401);
  });

  it("prevents a user who is not a member from reading an organization", async () => {
    const owner = await registerAccount(app, {
      email: "owner2@example.com",
      organizationName: "Private Org",
    });
    const stranger = await registerAccount(app, { email: "stranger@example.com" });

    const orgResponse = await app.inject({
      method: "GET",
      url: "/api/v1/organizations",
      headers: { cookie: owner.cookie },
    });
    const organizationId = orgResponse.json().organizations[0].id;

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}`,
      headers: { cookie: stranger.cookie },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });

  it("lets an ADMIN add an existing user as a member, but blocks a VIEWER from doing so", async () => {
    const owner = await registerAccount(app, {
      email: "owner3@example.com",
      organizationName: "Team Org",
    });
    const invitee = await registerAccount(app, { email: "invitee@example.com" });

    const organizationId = owner.organizationId!;

    const addResponse = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/members`,
      headers: { cookie: owner.cookie },
      payload: { email: invitee.email, role: "VIEWER" },
    });
    expect(addResponse.statusCode).toBe(201);
    const memberId = addResponse.json().membership.id;

    const viewerTriesToAdd = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/members`,
      headers: { cookie: invitee.cookie },
      payload: { email: "someoneelse@example.com", role: "VIEWER" },
    });
    expect(viewerTriesToAdd.statusCode).toBe(403);

    const promote = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/members/${memberId}`,
      headers: { cookie: owner.cookie },
      payload: { role: "MEMBER" },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json().membership.role).toBe("MEMBER");
  });

  it("refuses to demote the organization's last OWNER", async () => {
    const owner = await registerAccount(app, {
      email: "sole-owner@example.com",
      organizationName: "Solo Org",
    });

    const membersResponse = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${owner.organizationId}/members`,
      headers: { cookie: owner.cookie },
    });
    const ownerMembership = membersResponse.json().members[0];

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${owner.organizationId}/members/${ownerMembership.id}`,
      headers: { cookie: owner.cookie },
      payload: { role: "ADMIN" },
    });

    expect(response.statusCode).toBe(409);
  });

  it("records audit log entries for organization creation and membership changes", async () => {
    const owner = await registerAccount(app, {
      email: "audit-owner@example.com",
      organizationName: "Audit Org",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${owner.organizationId}/audit-logs`,
      headers: { cookie: owner.cookie },
    });

    expect(response.statusCode).toBe(200);
    const actions = response.json().auditLogs.map((log: { action: string }) => log.action);
    expect(actions).toContain("organization.created");
    expect(actions).toContain("organization.member_added");
  });
});
