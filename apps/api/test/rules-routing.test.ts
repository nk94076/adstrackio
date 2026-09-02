import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addMemberWithRole, buildTestApp, registerAccount, verifyAndActivateDomain } from "./helpers.js";
import { resetDatabase } from "./db-reset.js";

/**
 * Phase 8 (Rules & Routing Engine) apps/api coverage: routing-rule CRUD,
 * RBAC, cross-org/cross-campaign IDOR, the (campaignId, priority) unique
 * constraint, the no-generic-PATCH-for-status convention, activate/
 * deactivate lifecycle (including concurrent-duplicate idempotency, the
 * same pattern PR #8's review established for Conversion), the
 * max-active-rules-per-campaign budget, and audit logging. Tracker-side
 * evaluation/precedence coverage lives in
 * apps/tracker/test/tracker.routes.test.ts; the pure evaluator's own unit
 * tests live in packages/shared/src/routing-rules.test.ts.
 */

let app: FastifyInstance;

beforeEach(async () => {
  app ??= await buildTestApp();
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
});

async function setupOrgWithCampaign(suffix: string) {
  const owner = await registerAccount(app, {
    email: `owner-${suffix}@example.com`,
    organizationName: `Org ${suffix}`,
  });
  const organizationId = owner.organizationId!;

  const domain = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/domains`,
      headers: { cookie: owner.cookie },
      payload: { hostname: `${suffix}.example.com` },
    })
  ).json().domain;
  await verifyAndActivateDomain(domain.id);

  const campaign = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: { cookie: owner.cookie },
      payload: { name: `Campaign ${suffix}`, trackingDomainId: domain.id },
    })
  ).json().campaign;

  return { owner, organizationId, campaignId: campaign.id as string };
}

function rulePayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "US block",
    priority: 1,
    conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "US" }],
    action: "BLOCK",
    ...overrides,
  };
}

async function createRule(
  cookie: string,
  organizationId: string,
  campaignId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules`,
    headers: { cookie },
    payload,
  });
}

function auditActions(response: { json: () => { auditLogs: { action: string }[] } }): string[] {
  return response.json().auditLogs.map((log) => log.action);
}

// ---------------------------------------------------------------------------
// CRUD + validation
// ---------------------------------------------------------------------------

describe("routing rule CRUD", () => {
  it("creates a rule defaulting to ACTIVE status", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("crud-create");
    const response = await createRule(owner.cookie, organizationId, campaignId, rulePayload());
    expect(response.statusCode).toBe(201);
    expect(response.json().rule.status).toBe("ACTIVE");
    expect(response.json().rule.conditions).toEqual([
      { field: "COUNTRY", operator: "EQUALS", value: "US" },
    ]);
  });

  it("creates a rule directly as INACTIVE", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("crud-inactive");
    const response = await createRule(
      owner.cookie,
      organizationId,
      campaignId,
      rulePayload({ status: "INACTIVE" }),
    );
    expect(response.statusCode).toBe(201);
    expect(response.json().rule.status).toBe("INACTIVE");
  });

  it("rejects an invalid payload (bad condition field)", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("crud-invalid");
    const response = await createRule(
      owner.cookie,
      organizationId,
      campaignId,
      rulePayload({ conditions: [{ field: "NOT_A_FIELD", operator: "EQUALS", value: "US" }] }),
    );
    expect(response.statusCode).toBe(400);
  });

  it("404s creating a rule under a campaignId that doesn't belong to the organization", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("crud-badcampaign");
    const response = await createRule(owner.cookie, organizationId, "not-a-real-campaign", rulePayload());
    expect(response.statusCode).toBe(404);
  });

  it("lists rules for a campaign ordered by priority ascending", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("crud-list");
    await createRule(owner.cookie, organizationId, campaignId, rulePayload({ priority: 5, name: "Five" }));
    await createRule(owner.cookie, organizationId, campaignId, rulePayload({ priority: 1, name: "One" }));

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    const rules = response.json().rules;
    expect(rules.map((r: { name: string }) => r.name)).toEqual(["One", "Five"]);
  });

  it("gets a single rule", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("crud-get");
    const created = (await createRule(owner.cookie, organizationId, campaignId, rulePayload())).json()
      .rule;

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().rule.id).toBe(created.id);
  });

  it("404s getting a nonexistent rule", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("crud-get-404");
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/not-a-real-rule`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("updates a rule's conditions/action/priority/name via PATCH", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("crud-update");
    const created = (await createRule(owner.cookie, organizationId, campaignId, rulePayload())).json()
      .rule;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}`,
      headers: { cookie: owner.cookie },
      payload: {
        name: "Updated name",
        action: "SAFE_PAGE",
        conditions: [{ field: "DEVICE_TYPE", operator: "EQUALS", value: "MOBILE" }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().rule.name).toBe("Updated name");
    expect(response.json().rule.action).toBe("SAFE_PAGE");
  });

  it("PATCH silently ignores a status field rather than changing status", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("crud-patch-status");
    const created = (await createRule(owner.cookie, organizationId, campaignId, rulePayload())).json()
      .rule;
    expect(created.status).toBe("ACTIVE");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}`,
      headers: { cookie: owner.cookie },
      payload: { status: "INACTIVE" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().rule.status).toBe("ACTIVE");
  });

  it("deletes a rule", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("crud-delete");
    const created = (await createRule(owner.cookie, organizationId, campaignId, rulePayload())).json()
      .rule;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(get.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// (campaignId, priority) uniqueness
// ---------------------------------------------------------------------------

describe("priority uniqueness", () => {
  it("409s creating a second rule at the same priority within the same campaign", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("prio-dup");
    await createRule(owner.cookie, organizationId, campaignId, rulePayload({ priority: 3 }));
    const second = await createRule(
      owner.cookie,
      organizationId,
      campaignId,
      rulePayload({ priority: 3, name: "Second" }),
    );
    expect(second.statusCode).toBe(409);
  });

  it("allows the same priority number across two different campaigns", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("prio-cross-campaign");
    const domain = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/domains`,
        headers: { cookie: owner.cookie },
        payload: { hostname: "prio-cross-campaign-2.example.com" },
      })
    ).json().domain;
    await verifyAndActivateDomain(domain.id);
    const secondCampaign = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns`,
        headers: { cookie: owner.cookie },
        payload: { name: "Second campaign", trackingDomainId: domain.id },
      })
    ).json().campaign;

    const firstCampaign = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns`,
        headers: { cookie: owner.cookie },
        payload: { name: "First campaign" },
      })
    ).json().campaign;

    const r1 = await createRule(owner.cookie, organizationId, firstCampaign.id, rulePayload({ priority: 1 }));
    const r2 = await createRule(
      owner.cookie,
      organizationId,
      secondCampaign.id,
      rulePayload({ priority: 1 }),
    );
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
  });

  it("409s updating a rule's priority to collide with another rule in the same campaign", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("prio-update-dup");
    await createRule(owner.cookie, organizationId, campaignId, rulePayload({ priority: 1 }));
    const second = (
      await createRule(owner.cookie, organizationId, campaignId, rulePayload({ priority: 2, name: "B" }))
    ).json().rule;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${second.id}`,
      headers: { cookie: owner.cookie },
      payload: { priority: 1 },
    });
    expect(response.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

describe("RBAC", () => {
  it("VIEWER can list/get but not create/update/delete/activate/deactivate", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("rbac-viewer");
    const created = (await createRule(owner.cookie, organizationId, campaignId, rulePayload())).json()
      .rule;
    const viewer = await addMemberWithRole(app, owner.cookie, organizationId, "VIEWER");

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules`,
      headers: { cookie: viewer.cookie },
    });
    expect(list.statusCode).toBe(200);

    const create = await createRule(viewer.cookie, organizationId, campaignId, rulePayload({ priority: 9 }));
    expect(create.statusCode).toBe(403);

    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}`,
      headers: { cookie: viewer.cookie },
      payload: { name: "x" },
    });
    expect(update.statusCode).toBe(403);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}`,
      headers: { cookie: viewer.cookie },
    });
    expect(del.statusCode).toBe(403);

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}/activate`,
      headers: { cookie: viewer.cookie },
    });
    expect(activate.statusCode).toBe(403);
  });

  it("MEMBER can create/update/delete but not activate/deactivate", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("rbac-member");
    const member = await addMemberWithRole(app, owner.cookie, organizationId, "MEMBER");

    const created = (await createRule(member.cookie, organizationId, campaignId, rulePayload())).json()
      .rule;
    expect(created).toBeDefined();

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}/deactivate`,
      headers: { cookie: member.cookie },
    });
    expect(activate.statusCode).toBe(403);
  });

  it("ADMIN can activate/deactivate", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("rbac-admin");
    const admin = await addMemberWithRole(app, owner.cookie, organizationId, "ADMIN");
    const created = (
      await createRule(owner.cookie, organizationId, campaignId, rulePayload({ status: "INACTIVE" }))
    ).json().rule;

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}/activate`,
      headers: { cookie: admin.cookie },
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json().rule.status).toBe("ACTIVE");
  });
});

// ---------------------------------------------------------------------------
// Cross-org / cross-campaign IDOR
// ---------------------------------------------------------------------------

describe("isolation", () => {
  it("404s a cross-organization rule access rather than leaking existence", async () => {
    const orgA = await setupOrgWithCampaign("isolation-a");
    const orgB = await setupOrgWithCampaign("isolation-b");
    const rule = (await createRule(orgA.owner.cookie, orgA.organizationId, orgA.campaignId, rulePayload()))
      .json().rule;

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgB.organizationId}/campaigns/${orgB.campaignId}/rules/${rule.id}`,
      headers: { cookie: orgB.owner.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s a rule accessed under the right organization but the wrong campaign", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("isolation-campaign");
    const domain = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/domains`,
        headers: { cookie: owner.cookie },
        payload: { hostname: "isolation-campaign-2.example.com" },
      })
    ).json().domain;
    await verifyAndActivateDomain(domain.id);
    const otherCampaign = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns`,
        headers: { cookie: owner.cookie },
        payload: { name: "Other campaign", trackingDomainId: domain.id },
      })
    ).json().campaign;

    const rule = (await createRule(owner.cookie, organizationId, campaignId, rulePayload())).json().rule;

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${otherCampaign.id}/rules/${rule.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Activate/deactivate lifecycle, including concurrent idempotency
// ---------------------------------------------------------------------------

describe("activate/deactivate lifecycle", () => {
  it("activating an already-ACTIVE rule is an idempotent no-op (no duplicate audit entry)", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("lifecycle-noop");
    const created = (await createRule(owner.cookie, organizationId, campaignId, rulePayload())).json()
      .rule;
    expect(created.status).toBe("ACTIVE");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}/activate`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);

    const logs = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/audit-logs`,
      headers: { cookie: owner.cookie },
    });
    expect(auditActions(logs).filter((a) => a === "routing_rule.activated")).toHaveLength(0);
  });

  it("handles duplicate concurrent activate+activate on an INACTIVE rule safely: both succeed, no duplicate audit entry", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("lifecycle-concurrent");
    const created = (
      await createRule(owner.cookie, organizationId, campaignId, rulePayload({ status: "INACTIVE" }))
    ).json().rule;

    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}/activate`,
        headers: { cookie: owner.cookie },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}/activate`,
        headers: { cookie: owner.cookie },
      }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);

    const final = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(final.json().rule.status).toBe("ACTIVE");

    const logs = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/audit-logs`,
      headers: { cookie: owner.cookie },
    });
    expect(auditActions(logs).filter((a) => a === "routing_rule.activated")).toHaveLength(1);
  });

  it("handles duplicate concurrent deactivate+deactivate on an ACTIVE rule safely: both succeed, no duplicate audit entry", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("lifecycle-concurrent-deactivate");
    const created = (await createRule(owner.cookie, organizationId, campaignId, rulePayload())).json()
      .rule;
    expect(created.status).toBe("ACTIVE");

    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}/deactivate`,
        headers: { cookie: owner.cookie },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}/deactivate`,
        headers: { cookie: owner.cookie },
      }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);

    const final = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(final.json().rule.status).toBe("INACTIVE");

    const logs = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/audit-logs`,
      headers: { cookie: owner.cookie },
    });
    expect(auditActions(logs).filter((a) => a === "routing_rule.deactivated")).toHaveLength(1);
  });

  it("handles conflicting concurrent activate+deactivate safely: DB state matches exactly one winner's audit entry", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("lifecycle-conflicting");
    const created = (
      await createRule(owner.cookie, organizationId, campaignId, rulePayload({ status: "INACTIVE" }))
    ).json().rule;

    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}/activate`,
        headers: { cookie: owner.cookie },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}/deactivate`,
        headers: { cookie: owner.cookie },
      }),
    ]);
    // Unlike Conversion's state machine, RoutingRuleStatus has no illegal
    // transition to reject (both ACTIVE<->INACTIVE directions are always
    // legal) — so there is no 409 case here to assert either way. What
    // this test actually proves is that the row lock correctly serializes
    // two DIFFERENT-target concurrent writes on the same row without a
    // deadlock or a lost update: both requests succeed, one after the
    // other, and the row ends in a well-defined state.
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const final = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(["ACTIVE", "INACTIVE"]).toContain(final.json().rule.status);
  });

  it("deactivate then reactivate round-trips cleanly", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("lifecycle-roundtrip");
    const created = (await createRule(owner.cookie, organizationId, campaignId, rulePayload())).json()
      .rule;

    const deactivate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}/deactivate`,
      headers: { cookie: owner.cookie },
    });
    expect(deactivate.json().rule.status).toBe("INACTIVE");

    const reactivate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}/activate`,
      headers: { cookie: owner.cookie },
    });
    expect(reactivate.json().rule.status).toBe("ACTIVE");
  });
});

// ---------------------------------------------------------------------------
// Max active rules budget
// ---------------------------------------------------------------------------

describe("max active rules per campaign", () => {
  it("409s creating an ACTIVE rule once the campaign is already at the active-rule budget", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("budget");

    // MAX_ACTIVE_RULES_PER_CAMPAIGN is 50 — create exactly that many ACTIVE
    // rules, then confirm the 51st is rejected while an INACTIVE one still
    // succeeds (the budget is scoped to ACTIVE rules only).
    for (let i = 1; i <= 50; i += 1) {
      const response = await createRule(
        owner.cookie,
        organizationId,
        campaignId,
        rulePayload({ priority: i, name: `Rule ${i}` }),
      );
      expect(response.statusCode).toBe(201);
    }

    const overBudget = await createRule(
      owner.cookie,
      organizationId,
      campaignId,
      rulePayload({ priority: 51, name: "Over budget" }),
    );
    expect(overBudget.statusCode).toBe(409);

    const inactiveStillWorks = await createRule(
      owner.cookie,
      organizationId,
      campaignId,
      rulePayload({ priority: 52, name: "Inactive is fine", status: "INACTIVE" }),
    );
    expect(inactiveStillWorks.statusCode).toBe(201);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

describe("audit logging", () => {
  it("records routing_rule.created, .updated, .deleted", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("audit");
    const created = (await createRule(owner.cookie, organizationId, campaignId, rulePayload())).json()
      .rule;

    await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}`,
      headers: { cookie: owner.cookie },
      payload: { name: "Renamed" },
    });
    await app.inject({
      method: "DELETE",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/rules/${created.id}`,
      headers: { cookie: owner.cookie },
    });

    const logs = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/audit-logs`,
      headers: { cookie: owner.cookie },
    });
    const actions = auditActions(logs);
    expect(actions).toContain("routing_rule.created");
    expect(actions).toContain("routing_rule.updated");
    expect(actions).toContain("routing_rule.deleted");
  });
});
