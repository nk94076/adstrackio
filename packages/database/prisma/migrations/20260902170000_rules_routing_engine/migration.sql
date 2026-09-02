-- CreateEnum
CREATE TYPE "RoutingRuleStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "RoutingRuleAction" AS ENUM ('TARGET', 'SAFE_PAGE', 'BLOCK');

-- CreateTable
CREATE TABLE "routing_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "RoutingRuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "priority" INTEGER NOT NULL,
    "conditions" JSONB NOT NULL,
    "action" "RoutingRuleAction" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "routing_rules_campaignId_status_priority_idx" ON "routing_rules"("campaignId", "status", "priority");

-- CreateIndex
CREATE INDEX "routing_rules_organizationId_idx" ON "routing_rules"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "routing_rules_campaignId_priority_key" ON "routing_rules"("campaignId", "priority");

-- AddForeignKey
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defense-in-depth backstop mirroring enforce_conversion_click_attribution
-- (Phase 7): organizationId/campaignId are set once by the service layer
-- from the authenticated request path (never client-body-supplied) and
-- must never disagree or be changed afterward. This trigger makes that a
-- database-level guarantee too, independent of the service layer staying
-- correct.
CREATE OR REPLACE FUNCTION enforce_routing_rule_campaign_organization()
RETURNS TRIGGER AS $$
DECLARE
  campaign_organization_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."campaignId" IS DISTINCT FROM OLD."campaignId"
      OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId" THEN
      RAISE EXCEPTION
        'routing rule % campaign/organization assignment is immutable after creation',
        OLD.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT "organizationId" INTO campaign_organization_id
    FROM "campaigns" WHERE id = NEW."campaignId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'routing rule references a nonexistent campaignId %', NEW."campaignId"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."organizationId" IS DISTINCT FROM campaign_organization_id THEN
    RAISE EXCEPTION
      'routing rule organizationId must match its campaign % organization',
      NEW."campaignId"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_routing_rule_campaign_organization
BEFORE INSERT OR UPDATE OF "campaignId", "organizationId" ON "routing_rules"
FOR EACH ROW
EXECUTE FUNCTION enforce_routing_rule_campaign_organization();
