import crypto from 'crypto';
import { prisma } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import {
  allowDevEmailOtp,
  getSmtpStatus,
  isSmtpConfigured,
  sendVerificationEmail,
} from './emailService';

const logger = createLogger('email-verification');

const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 45 * 1000;

function generateOtp(): string {
  return String(crypto.randomInt(100000, 999999));
}

function hashOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

export async function getEmailVerificationStatus(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      emailVerified: true,
      emailVerifiedAt: true,
      emailVerificationSentAt: true,
      firstName: true,
    },
  });
  if (!user) throw new Error('User not found');

  const smtp = await getSmtpStatus(false);
  return {
    email: user.email,
    emailVerified: user.emailVerified,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    canSend: Boolean(user.email) && !user.emailVerified,
    lastSentAt: user.emailVerificationSentAt?.toISOString() ?? null,
    smtp: {
      configured: smtp.configured,
      ready: smtp.ready,
      message: smtp.message,
    },
  };
}

export async function sendEmailVerificationOtp(userId: string, emailOverride?: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  const email = (emailOverride || user.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    const err: any = new Error('A valid email is required before verification');
    err.code = 'EMAIL_REQUIRED';
    throw err;
  }

  if (user.emailVerified && user.email === email) {
    return {
      alreadyVerified: true,
      email,
      message: 'Email is already verified',
      smtp: await getSmtpStatus(false),
    };
  }

  // Ensure email is unique if changing
  if (user.email !== email) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && existing.id !== userId) {
      const err: any = new Error('Email is already in use by another account');
      err.code = 'EMAIL_ALREADY_IN_USE';
      throw err;
    }
  }

  const now = Date.now();
  if (
    user.emailVerificationSentAt &&
    now - user.emailVerificationSentAt.getTime() < RESEND_COOLDOWN_MS
  ) {
    const retryAfterSeconds = Math.ceil(
      (RESEND_COOLDOWN_MS - (now - user.emailVerificationSentAt.getTime())) / 1000,
    );
    const err: any = new Error(`Please wait ${retryAfterSeconds}s before requesting another code`);
    err.code = 'RATE_LIMITED';
    err.retryAfterSeconds = retryAfterSeconds;
    throw err;
  }

  if (!isSmtpConfigured() && !allowDevEmailOtp()) {
    const err: any = new Error('Email delivery is not configured on the server');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  const otp = generateOtp();
  const expiresAt = new Date(now + OTP_TTL_MS);

  await prisma.user.update({
    where: { id: userId },
    data: {
      email,
      emailVerified: false,
      emailVerifiedAt: null,
      emailVerificationOtp: hashOtp(otp),
      emailVerificationOtpExpiresAt: expiresAt,
      emailVerificationSentAt: new Date(now),
    },
  });

  const delivery = await sendVerificationEmail({
    to: email,
    otp,
    firstName: user.firstName,
  });

  logger.info(`[EMAIL_VERIFY] OTP issued for user=${userId} mode=${delivery.mode}`);

  return {
    alreadyVerified: false,
    email,
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    deliveryMode: delivery.mode,
    message:
      delivery.mode === 'smtp'
        ? `Verification code sent to ${email}`
        : `Dev mode: OTP logged on server for ${email}`,
    smtp: await getSmtpStatus(false),
    ...(delivery.mode === 'dev_log' && allowDevEmailOtp() ? { devOtp: otp } : {}),
  };
}

export async function verifyEmailOtp(userId: string, otp: string) {
  const cleaned = (otp || '').trim();
  if (!/^\d{6}$/.test(cleaned)) {
    const err: any = new Error('Enter the 6-digit code from your email');
    err.code = 'INVALID_OTP';
    throw err;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');
  if (!user.email) {
    const err: any = new Error('No email on file to verify');
    err.code = 'EMAIL_REQUIRED';
    throw err;
  }
  if (user.emailVerified) {
    return {
      email: user.email,
      emailVerified: true,
      message: 'Email is already verified',
    };
  }
  if (!user.emailVerificationOtp || !user.emailVerificationOtpExpiresAt) {
    const err: any = new Error('No active verification code. Request a new one.');
    err.code = 'OTP_NOT_FOUND';
    throw err;
  }
  if (user.emailVerificationOtpExpiresAt.getTime() < Date.now()) {
    const err: any = new Error('Verification code expired. Request a new one.');
    err.code = 'OTP_EXPIRED';
    throw err;
  }
  if (user.emailVerificationOtp !== hashOtp(cleaned)) {
    const err: any = new Error('Incorrect verification code');
    err.code = 'INVALID_OTP';
    throw err;
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      emailVerified: true,
      emailVerifiedAt: new Date(),
      emailVerificationOtp: null,
      emailVerificationOtpExpiresAt: null,
    },
  });

  logger.info(`[EMAIL_VERIFY] Verified email for user=${userId}`);
  return {
    email: updated.email,
    emailVerified: true,
    emailVerifiedAt: updated.emailVerifiedAt?.toISOString() ?? null,
    message: 'Email verified successfully',
  };
}
