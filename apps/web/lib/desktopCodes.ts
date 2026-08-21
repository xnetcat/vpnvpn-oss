"use server";

import { prisma } from "@vpnvpn/db";
import { randomInt } from "node:crypto";

const MAX_CODE_ATTEMPTS = 5;

function randomSixDigitCode(): string {
  return String(randomInt(100000, 1000000));
}

export async function createDesktopCode(
  email: string,
  url: string,
): Promise<string> {
  const normalisedEmail = email.trim().toLowerCase();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  let code = randomSixDigitCode();
  for (let i = 0; i < 3; i += 1) {
    const existing = await prisma.desktopLoginCode.findFirst({
      where: {
        email: normalisedEmail,
        code,
        expiresAt: { gt: new Date() },
      },
    });
    if (!existing) break;
    code = randomSixDigitCode();
  }

  await prisma.desktopLoginCode.updateMany({
    where: { email: normalisedEmail, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  await prisma.desktopLoginCode.create({
    data: {
      email: normalisedEmail,
      code,
      url,
      expiresAt,
    },
  });

  return code;
}

export async function consumeDesktopCode(
  email: string,
  code: string,
): Promise<string | null> {
  const normalisedEmail = email.trim().toLowerCase();
  const now = new Date();

  const candidate = await prisma.desktopLoginCode.findFirst({
    where: {
      email: normalisedEmail,
      expiresAt: { gt: now },
      consumedAt: null,
    },
    orderBy: { createdAt: "desc" },
  });

  if (!candidate || candidate.attempts >= MAX_CODE_ATTEMPTS) return null;

  if (candidate.code !== code) {
    await prisma.desktopLoginCode.update({
      where: { id: candidate.id },
      data: { attempts: { increment: 1 } },
    });
    return null;
  }

  await prisma.desktopLoginCode.update({
    where: { id: candidate.id },
    data: { consumedAt: now },
  });

  return candidate.url;
}
