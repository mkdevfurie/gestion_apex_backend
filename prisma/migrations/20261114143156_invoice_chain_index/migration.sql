-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "chainIndex" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_chainIndex_key" ON "Invoice"("chainIndex");

