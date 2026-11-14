-- AlterTable
ALTER TABLE "CashSession" ADD COLUMN     "closingNotes" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "cashTendered" INTEGER,
ADD COLUMN     "changeGiven" INTEGER,
ADD COLUMN     "clientRequestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_clientRequestId_key" ON "Invoice"("clientRequestId");

