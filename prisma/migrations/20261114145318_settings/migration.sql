-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "defaultVatRate" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "defaultAlertThreshold" DECIMAL(14,3) NOT NULL DEFAULT 5,
    "maxDiscountRate" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "cashDifferenceTolerance" INTEGER NOT NULL DEFAULT 500,
    "minOpeningFloat" INTEGER NOT NULL DEFAULT 0,
    "receiptFooter" TEXT NOT NULL DEFAULT 'Merci de votre visite !',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

