-- RegistrationCode: email-verification code store for the user registration flow.
-- Mirrors PasswordResetToken semantics: code is stored hashed, single-use, time-limited.
-- PostgreSQL-compatible (the dev / docker migrate-deploy path).
CREATE TABLE "RegistrationCode" (
    "id" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    CONSTRAINT "RegistrationCode_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RegistrationCode_targetUserId_email_idx" ON "RegistrationCode"("targetUserId", "email");
CREATE INDEX "RegistrationCode_targetUserId_createdAt_idx" ON "RegistrationCode"("targetUserId", "createdAt");
