-- AlterTable
ALTER TABLE "clicks" ADD COLUMN     "browserVersion" TEXT,
ADD COLUMN     "osVersion" TEXT,
ADD COLUMN     "timezone" TEXT;

-- CreateIndex
CREATE INDEX "clicks_trackingLinkId_occurredAt_idx" ON "clicks"("trackingLinkId", "occurredAt");

-- CreateIndex
CREATE INDEX "clicks_campaignId_occurredAt_idx" ON "clicks"("campaignId", "occurredAt");
