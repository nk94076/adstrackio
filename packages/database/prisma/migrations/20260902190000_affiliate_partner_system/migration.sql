-- CreateEnum
CREATE TYPE "AffiliatePartnerStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "clicks" ADD COLUMN     "affiliatePartnerId" TEXT;

-- AlterTable
ALTER TABLE "tracking_links" ADD COLUMN     "affiliatePartnerId" TEXT;

-- CreateTable
CREATE TABLE "affiliate_partners" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "externalId" TEXT,
    "email" TEXT,
    "status" "AffiliatePartnerStatus" NOT NULL DEFAULT 'PENDING',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_affiliate_partners" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "affiliatePartnerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_affiliate_partners_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "affiliate_partners_organizationId_status_idx" ON "affiliate_partners"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_partners_organizationId_externalId_key" ON "affiliate_partners"("organizationId", "externalId");

-- CreateIndex
CREATE INDEX "campaign_affiliate_partners_organizationId_idx" ON "campaign_affiliate_partners"("organizationId");

-- CreateIndex
CREATE INDEX "campaign_affiliate_partners_affiliatePartnerId_idx" ON "campaign_affiliate_partners"("affiliatePartnerId");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_affiliate_partners_campaignId_affiliatePartnerId_key" ON "campaign_affiliate_partners"("campaignId", "affiliatePartnerId");

-- CreateIndex
CREATE INDEX "clicks_affiliatePartnerId_occurredAt_idx" ON "clicks"("affiliatePartnerId", "occurredAt");

-- CreateIndex
CREATE INDEX "tracking_links_affiliatePartnerId_idx" ON "tracking_links"("affiliatePartnerId");

-- AddForeignKey
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_affiliatePartnerId_fkey" FOREIGN KEY ("affiliatePartnerId") REFERENCES "affiliate_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clicks" ADD CONSTRAINT "clicks_affiliatePartnerId_fkey" FOREIGN KEY ("affiliatePartnerId") REFERENCES "affiliate_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_partners" ADD CONSTRAINT "affiliate_partners_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_affiliate_partners" ADD CONSTRAINT "campaign_affiliate_partners_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_affiliate_partners" ADD CONSTRAINT "campaign_affiliate_partners_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_affiliate_partners" ADD CONSTRAINT "campaign_affiliate_partners_affiliatePartnerId_fkey" FOREIGN KEY ("affiliatePartnerId") REFERENCES "affiliate_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Defense-in-depth triggers (Phase 9: Affiliate/Partner System)
-- ---------------------------------------------------------------------------

-- organizationId on campaign_affiliate_partners is denormalized from
-- campaignId purely for query performance (mirrors Conversion/RoutingRule's
-- own established pattern). This trigger derives and locks it, and
-- additionally verifies the referenced AffiliatePartner belongs to the same
-- organization as the Campaign — the actual cross-org-assignment backstop
-- ("a partner from Org A must never be assignable to Org B's campaign"),
-- independent of the service layer staying correct.
CREATE OR REPLACE FUNCTION enforce_campaign_affiliate_partner_organization()
RETURNS TRIGGER AS $$
DECLARE
  campaign_organization_id TEXT;
  partner_organization_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."campaignId" IS DISTINCT FROM OLD."campaignId"
      OR NEW."affiliatePartnerId" IS DISTINCT FROM OLD."affiliatePartnerId"
      OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId" THEN
      RAISE EXCEPTION
        'campaign affiliate partner assignment % is immutable after creation',
        OLD.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT "organizationId" INTO campaign_organization_id
    FROM "campaigns" WHERE id = NEW."campaignId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'affiliate partner assignment references a nonexistent campaignId %', NEW."campaignId"
      USING ERRCODE = '23514';
  END IF;

  SELECT "organizationId" INTO partner_organization_id
    FROM "affiliate_partners" WHERE id = NEW."affiliatePartnerId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'affiliate partner assignment references a nonexistent affiliatePartnerId %', NEW."affiliatePartnerId"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."organizationId" IS DISTINCT FROM campaign_organization_id THEN
    RAISE EXCEPTION
      'affiliate partner assignment organizationId must match its campaign % organization',
      NEW."campaignId"
      USING ERRCODE = '23514';
  END IF;

  IF partner_organization_id IS DISTINCT FROM campaign_organization_id THEN
    RAISE EXCEPTION
      'affiliate partner % belongs to a different organization than campaign %',
      NEW."affiliatePartnerId", NEW."campaignId"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_campaign_affiliate_partner_organization
BEFORE INSERT OR UPDATE OF "organizationId", "campaignId", "affiliatePartnerId" ON "campaign_affiliate_partners"
FOR EACH ROW
EXECUTE FUNCTION enforce_campaign_affiliate_partner_organization();

-- A TrackingLink's affiliatePartnerId (when set) must (a) belong to the
-- same organization as the link's own campaign, and (b) already be on that
-- campaign's roster (a campaign_affiliate_partners row) — a link cannot be
-- attributed to a partner that was never assigned to its campaign. Runs on
-- apps/api's tracking-link CRUD path (not the tracker's per-click hot
-- path), so a cross-table check here is not a performance concern — see
-- docs/architecture/affiliate-partners.md#tracker-performance.
CREATE OR REPLACE FUNCTION enforce_tracking_link_affiliate_partner()
RETURNS TRIGGER AS $$
DECLARE
  campaign_organization_id TEXT;
  partner_organization_id TEXT;
  roster_exists BOOLEAN;
BEGIN
  IF NEW."affiliatePartnerId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "organizationId" INTO campaign_organization_id
    FROM "campaigns" WHERE id = NEW."campaignId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tracking link references a nonexistent campaignId %', NEW."campaignId"
      USING ERRCODE = '23514';
  END IF;

  SELECT "organizationId" INTO partner_organization_id
    FROM "affiliate_partners" WHERE id = NEW."affiliatePartnerId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tracking link references a nonexistent affiliatePartnerId %', NEW."affiliatePartnerId"
      USING ERRCODE = '23514';
  END IF;

  IF partner_organization_id IS DISTINCT FROM campaign_organization_id THEN
    RAISE EXCEPTION
      'tracking link affiliatePartnerId % belongs to a different organization than its campaign %',
      NEW."affiliatePartnerId", NEW."campaignId"
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM "campaign_affiliate_partners"
    WHERE "campaignId" = NEW."campaignId" AND "affiliatePartnerId" = NEW."affiliatePartnerId"
  ) INTO roster_exists;

  IF NOT roster_exists THEN
    RAISE EXCEPTION
      'affiliate partner % is not assigned to campaign % — assign it to the campaign before attributing a tracking link to it',
      NEW."affiliatePartnerId", NEW."campaignId"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_tracking_link_affiliate_partner
BEFORE INSERT OR UPDATE OF "affiliatePartnerId", "campaignId" ON "tracking_links"
FOR EACH ROW
EXECUTE FUNCTION enforce_tracking_link_affiliate_partner();

-- Click.affiliatePartnerId is a denormalized, write-once snapshot (see the
-- schema doc comment). Deliberately an UPDATE-only trigger with NO
-- cross-table lookup, unlike the two triggers above: "BEFORE UPDATE OF"
-- fires only on UPDATE statements naming this column, never on INSERT, so
-- it adds zero overhead to the tracker's per-click write path while still
-- providing a real backstop against any future bug or admin tool that
-- tries to retroactively edit click attribution.
CREATE OR REPLACE FUNCTION enforce_click_affiliate_partner_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."affiliatePartnerId" IS DISTINCT FROM OLD."affiliatePartnerId" THEN
    RAISE EXCEPTION
      'click % affiliatePartnerId is immutable after creation',
      OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_click_affiliate_partner_immutable
BEFORE UPDATE OF "affiliatePartnerId" ON "clicks"
FOR EACH ROW
EXECUTE FUNCTION enforce_click_affiliate_partner_immutable();
