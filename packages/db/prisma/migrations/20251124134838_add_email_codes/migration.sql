-- CreateTable
CREATE TABLE "DesktopLoginCode" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesktopLoginCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DesktopLoginCode_email_code_idx" ON "DesktopLoginCode"("email", "code");

-- CreateIndex
CREATE INDEX "DesktopLoginCode_expiresAt_idx" ON "DesktopLoginCode"("expiresAt");
