-- CreateEnum
CREATE TYPE "BotTrafficPolicyAction" AS ENUM ('SAFE_PAGE', 'TARGET', 'BLOCK');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "suspiciousTrafficPolicy" "BotTrafficPolicyAction" NOT NULL DEFAULT 'TARGET',
ADD COLUMN     "unknownTrafficPolicy" "BotTrafficPolicyAction" NOT NULL DEFAULT 'TARGET';
