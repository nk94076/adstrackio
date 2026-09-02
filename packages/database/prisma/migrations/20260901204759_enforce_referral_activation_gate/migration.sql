-- Defense-in-depth for the referral-proof approval gate.
--
-- The application (apps/api/src/modules/referrals/referral-configurations.service.ts,
-- activateReferralConfiguration) already refuses to set a
-- CUSTOM_PARTNER_ATTRIBUTION configuration ACTIVE without an APPROVED
-- ReferralProof. This trigger enforces the same invariant directly in
-- Postgres so the rule holds even for writes that don't go through that
-- service — a raw SQL UPDATE, a future admin tool, a data migration, or a
-- bug in some other code path. It is not a substitute for the service-layer
-- check (which produces a proper 409 API response); it's a backstop.
CREATE OR REPLACE FUNCTION enforce_referral_configuration_activation()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'ACTIVE' AND NEW.type = 'CUSTOM_PARTNER_ATTRIBUTION' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "referral_proofs"
      WHERE "referralConfigurationId" = NEW.id
        AND "reviewStatus" = 'APPROVED'
    ) THEN
      RAISE EXCEPTION
        'CUSTOM_PARTNER_ATTRIBUTION referral_configuration % cannot be ACTIVE without an APPROVED referral_proof',
        NEW.id
        USING ERRCODE = '23514'; -- check_violation
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_referral_configuration_activation
BEFORE INSERT OR UPDATE OF status, type ON "referral_configurations"
FOR EACH ROW
EXECUTE FUNCTION enforce_referral_configuration_activation();
