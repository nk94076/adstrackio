-- AlterTable
ALTER TABLE "tracking_domains" ADD COLUMN     "verificationRequestedAt" TIMESTAMP(3),
ADD COLUMN     "verificationToken" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ALTER COLUMN "isActive" SET DEFAULT false;

-- Phase 1 allowed isActive=true regardless of verificationStatus (the
-- column defaulted to true). Phase 2's activation rule is
-- isActive => verificationStatus = 'VERIFIED'; correct any pre-existing
-- rows before the CHECK constraint below can be added, so this migration
-- doesn't fail against data created under the old default.
UPDATE "tracking_domains" SET "isActive" = false WHERE "verificationStatus" != 'VERIFIED';

-- Database-level backstop for the activation invariant (service layer also
-- enforces this): a domain can only be active once it has been verified.
-- Mirrors the pattern used for the referral-activation gate in
-- migration 20260901204759_enforce_referral_activation_gate, but a plain
-- CHECK suffices here since the invariant is same-row, not cross-table.
ALTER TABLE "tracking_domains" ADD CONSTRAINT "tracking_domains_active_requires_verified"
  CHECK (NOT "isActive" OR "verificationStatus" = 'VERIFIED');
