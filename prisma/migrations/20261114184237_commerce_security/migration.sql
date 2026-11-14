-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'CREDIT_NOTE';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "amountPaid" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "validUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "amountPaid" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "cashierCanSellOnCredit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paymentTermDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "quoteValidityDays" INTEGER NOT NULL DEFAULT 15;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "failedLogins" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3);


-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "atIssue" BOOLEAN NOT NULL DEFAULT false;
-- Avant cette version, tout règlement était fait à l'émission de la pièce.
UPDATE "Payment" SET "atIssue" = true WHERE direction = 'IN';

-- Rattrapage : les tickets existants sont réglés ; amountPaid = Σ règlements reçus.
UPDATE "Invoice" i
SET "amountPaid" = COALESCE((SELECT SUM(p.amount) FROM "Payment" p WHERE p."invoiceId" = i.id AND p.direction = 'IN'), 0);
