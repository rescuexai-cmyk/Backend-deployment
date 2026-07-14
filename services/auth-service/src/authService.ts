import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import * as FirebaseAuth from './firebaseAuth';
import { OnboardingStatus, PenaltyStatus } from '@prisma/client';
import { verifyAppleIdentityToken } from './appleAuth';

const logger = createLogger('auth-service');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const TEST_DRIVER_PHONE_DIGITS = '919794696252';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type UserType = 'rider' | 'driver' | 'both';

export interface UserProfile {
  id: string;
  email?: string;
  phone: string;
  firstName: string;
  lastName?: string;
  profileImage?: string;
  isVerified: boolean;
  emailVerified: boolean;
  isActive: boolean;
  createdAt: Date;
  lastLoginAt?: Date;
  /** rider = passenger only; driver = driver profile, no rides yet; both = driver + has booked rides */
  user_type: UserType;
  userType: UserType;
}

function normalizePhoneDigits(phone: string): string {
  return (phone || '').replace(/\D/g, '');
}

function isTestDriverPhone(phone: string): boolean {
  const digits = normalizePhoneDigits(phone);
  return digits === TEST_DRIVER_PHONE_DIGITS || digits === `0${TEST_DRIVER_PHONE_DIGITS}`;
}

async function applyTestDriverOverrides(userId: string, phone: string): Promise<void> {
  if (!isTestDriverPhone(phone)) return;

  const now = new Date();
  const driver = await prisma.driver.findFirst({
    where: { userId },
    select: { id: true },
  });

  if (!driver) return;

  const paid = await prisma.driverPenalty.updateMany({
    where: { driverId: driver.id, status: PenaltyStatus.PENDING },
    data: { status: PenaltyStatus.PAID, paidAt: now },
  });

  await prisma.driver.update({
    where: { id: driver.id },
    data: {
      onboardingStatus: OnboardingStatus.COMPLETED,
      isVerified: true,
      isActive: true,
      documentsVerifiedAt: now,
      verificationNotes: 'Auto-test override: onboarding completed and penalties cleared at login.',
    },
  });

  logger.info(`[AUTH] Applied test-driver override for ${phone} (driverId=${driver.id}, penalties_cleared=${paid.count})`);
}

function generateTokens(userId: string): AuthTokens {
  const jwtSecret = process.env.JWT_SECRET || 'fallback-secret-key';
  const refreshSecret = process.env.REFRESH_TOKEN_SECRET || 'fallback-refresh-secret';
  const jwtAny = jwt as any;
  const accessToken = jwtAny.sign({ userId, type: 'access' }, jwtSecret, { expiresIn: '7d' });
  const refreshToken = jwtAny.sign({ userId, type: 'refresh' }, refreshSecret, { expiresIn: '30d' });
  return { accessToken, refreshToken, expiresIn: 7 * 24 * 60 * 60 };
}

async function saveRefreshToken(userId: string, token: string): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  await prisma.refreshToken.create({ data: { userId, token, expiresAt } });
}

function toUserProfile(user: {
  id: string; email: string | null; phone: string; firstName: string;
  lastName: string | null; profileImage: string | null; isVerified: boolean;
  emailVerified?: boolean;
  isActive: boolean; createdAt: Date; lastLoginAt: Date | null;
}, userType: UserType): UserProfile {
  return {
    id: user.id,
    email: user.email ?? undefined,
    phone: user.phone,
    firstName: user.firstName,
    lastName: user.lastName ?? undefined,
    profileImage: user.profileImage ?? undefined,
    isVerified: user.isVerified,
    emailVerified: user.emailVerified ?? false,
    isActive: user.isActive,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt ?? undefined,
    user_type: userType,
    userType,
  };
}

/** Derive app role from linked driver profile and passenger ride history. */
export async function resolveUserType(userId: string): Promise<UserType> {
  const [driver, passengerRide] = await Promise.all([
    prisma.driver.findFirst({ where: { userId }, select: { id: true } }),
    prisma.ride.findFirst({ where: { passengerId: userId }, select: { id: true } }),
  ]);
  if (!driver) return 'rider';
  return passengerRide ? 'both' : 'driver';
}

async function buildUserProfile(user: {
  id: string; email: string | null; phone: string; firstName: string;
  lastName: string | null; profileImage: string | null; isVerified: boolean;
  emailVerified?: boolean;
  isActive: boolean; createdAt: Date; lastLoginAt: Date | null;
}): Promise<UserProfile> {
  const userType = await resolveUserType(user.id);
  return toUserProfile(user, userType);
}

// ─── Firebase Phone Authentication ─────────────────────────────────────

/**
 * Authenticate with Firebase ID Token (phone OTP verified client-side)
 * 
 * This is the primary authentication flow:
 *   1. Client uses Firebase Auth SDK to verify phone via OTP
 *   2. Client gets Firebase ID Token
 *   3. Client sends ID Token here
 *   4. We verify with Firebase Admin SDK, extract phone, create/login user
 */
export async function authenticateWithFirebasePhone(
  idToken: string
): Promise<{ user: UserProfile; tokens: AuthTokens; isNewUser: boolean }> {
  logger.info('[AUTH] Authenticating with Firebase phone token');

  const result = await FirebaseAuth.verifyFirebaseToken(idToken);

  if (!result.success || !result.phone) {
    logger.warn(`[AUTH] Firebase token verification failed: ${result.error}`);
    throw new Error(result.error || 'Firebase phone verification failed');
  }

  const phone = result.phone; // Already in E.164 format from Firebase
  const firebaseUid = result.uid!;

  logger.info(`[AUTH] Firebase verified phone: ${phone}, UID: ${firebaseUid}`);

  // Find or create user
  let user = await prisma.user.findUnique({ where: { phone } });
  let isNewUser = false;

  if (!user) {
    // Also check by firebaseUid
    user = await prisma.user.findFirst({ where: { firebaseUid } });
  }

  if (!user) {
    isNewUser = true;
    user = await prisma.user.create({
      data: {
        phone,
        firstName: result.name || 'User',
        email: result.email ?? undefined,
        profileImage: result.picture ?? undefined,
        firebaseUid,
        isVerified: true,
      },
    });
    logger.info(`[AUTH] Created new user via Firebase Phone: ${user.id}`);
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        isVerified: true,
        lastLoginAt: new Date(),
        firebaseUid, // Keep firebaseUid in sync
        // Update phone if it changed (e.g., user linked new number)
        phone: phone,
      },
    });
    logger.info(`[AUTH] Existing user login via Firebase Phone: ${user.id}`);
  }

  const tokens = generateTokens(user.id);
  await saveRefreshToken(user.id, tokens.refreshToken);
  await applyTestDriverOverrides(user.id, user.phone);

  logger.info(`[AUTH] Firebase Phone auth successful for user: ${user.id}`);

  return { user: await buildUserProfile(user), tokens, isNewUser };
}

/**
 * Get Firebase auth service status
 */
export function getOTPServiceStatus(): { available: boolean; provider: string; projectId: string | null } {
  const status = FirebaseAuth.getFirebaseStatus();
  return {
    available: status.initialized,
    provider: 'Firebase',
    projectId: status.projectId,
  };
}

// ─── Legacy Phone Auth (dev/testing) ────────────────────────────────────

/**
 * Authenticate with a verified phone number (dev/testing fallback)
 * 
 * In production, use authenticateWithFirebasePhone instead.
 * This endpoint is kept for local development and automated testing
 * where Firebase client SDK is not available.
 */
export async function authenticateWithVerifiedPhone(
  phone: string
): Promise<{ user: UserProfile; tokens: AuthTokens; isNewUser: boolean }> {
  logger.info(`[AUTH] Authenticating with verified phone (legacy): ${phone}`);

  // Normalize phone number format
  let normalizedPhone = phone.replace(/[\s\-()]/g, '');
  if (!normalizedPhone.startsWith('+')) {
    normalizedPhone = `+${normalizedPhone}`;
  }

  // Validate E.164 format
  if (!/^\+[1-9]\d{6,14}$/.test(normalizedPhone)) {
    logger.warn(`[AUTH] Invalid phone format: ${normalizedPhone}`);
    throw new Error('Invalid phone number format');
  }

  let user = await prisma.user.findUnique({ where: { phone: normalizedPhone } });
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    user = await prisma.user.create({
      data: {
        phone: normalizedPhone,
        firstName: 'User',
        isVerified: true,
      },
    });
    logger.info(`[AUTH] Created new user via legacy phone auth: ${user.id}`);
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        isVerified: true,
        lastLoginAt: new Date(),
      },
    });
    logger.info(`[AUTH] Existing user login via legacy phone auth: ${user.id}`);
  }

  const tokens = generateTokens(user.id);
  await saveRefreshToken(user.id, tokens.refreshToken);
  await applyTestDriverOverrides(user.id, user.phone);

  return { user: await buildUserProfile(user), tokens, isNewUser };
}

// ─── Google Authentication ──────────────────────────────────────────────

export async function authenticateWithGoogle(idToken: string): Promise<{ user: UserProfile; tokens: AuthTokens; isNewUser: boolean; requiresPhone: boolean }> {
  logger.info('[AUTH] Authenticating with Google');

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (error: any) {
    logger.error('[AUTH] Google token verification failed', { error: error.message });
    throw new Error('Invalid Google token - verification failed');
  }

  if (!payload?.email) {
    throw new Error('Invalid Google token - email not provided');
  }

  const { email, given_name, family_name, picture, sub: googleId } = payload;
  logger.info(`[AUTH] Google auth for email: ${email}`);

  let user = await prisma.user.findUnique({ where: { email } });
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    const placeholderPhone = `google_${googleId}`;

    user = await prisma.user.create({
      data: {
        email,
        phone: placeholderPhone,
        firstName: given_name || 'User',
        lastName: family_name ?? undefined,
        profileImage: picture ?? undefined,
        isVerified: true,
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });
    logger.info(`[AUTH] Created new user via Google: ${user.id}`);
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        profileImage: picture || user.profileImage,
        firstName: user.firstName === 'User' && given_name ? given_name : user.firstName,
        lastName: user.lastName || family_name || undefined,
        // Trust Google-provided email ownership when the stored email matches.
        ...(user.email === email && !user.emailVerified
          ? { emailVerified: true, emailVerifiedAt: new Date() }
          : {}),
      },
    });
    logger.info(`[AUTH] Existing user logged in via Google: ${user.id}`);
  }

  const tokens = generateTokens(user.id);
  await saveRefreshToken(user.id, tokens.refreshToken);
  await applyTestDriverOverrides(user.id, user.phone);

  const requiresPhone = user.phone.startsWith('google_') || user.phone === '';

  return {
    user: await buildUserProfile(user),
    tokens,
    isNewUser,
    requiresPhone,
  };
}

// ─── Apple Authentication ───────────────────────────────────────────────

export async function authenticateWithApple(params: {
  identityToken: string;
  nonce?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}): Promise<{ user: UserProfile; tokens: AuthTokens; isNewUser: boolean; requiresPhone: boolean }> {
  logger.info('[AUTH] Authenticating with Apple');

  const payload = await verifyAppleIdentityToken(params.identityToken, params.nonce);
  const appleId = payload.sub;
  const emailFromToken = payload.email?.toLowerCase();
  const emailFromClient = params.email?.trim().toLowerCase();
  const email = emailFromToken || emailFromClient || undefined;
  const firstName = params.firstName?.trim() || 'User';
  const lastName = params.lastName?.trim() || undefined;
  const placeholderPhone = `apple_${appleId}`;

  logger.info(`[AUTH] Apple auth for sub=${appleId} email=${email || '(none)'}`);

  let user =
    (await prisma.user.findUnique({ where: { phone: placeholderPhone } })) ||
    (email ? await prisma.user.findUnique({ where: { email } }) : null);

  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    const markEmailVerified = Boolean(email);
    user = await prisma.user.create({
      data: {
        email: email ?? null,
        phone: placeholderPhone,
        firstName,
        lastName,
        isVerified: true,
        ...(markEmailVerified
          ? { emailVerified: true, emailVerifiedAt: new Date() }
          : {}),
      },
    });
    logger.info(`[AUTH] Created new user via Apple: ${user.id}`);
  } else {
    const updates: Record<string, unknown> = {
      lastLoginAt: new Date(),
    };
    if (user.firstName === 'User' && firstName !== 'User') {
      updates.firstName = firstName;
    }
    if (!user.lastName && lastName) {
      updates.lastName = lastName;
    }
    if (!user.email && email) {
      updates.email = email;
      updates.emailVerified = true;
      updates.emailVerifiedAt = new Date();
    } else if (email && user.email === email && !user.emailVerified) {
      updates.emailVerified = true;
      updates.emailVerifiedAt = new Date();
    }
    // If we found by email but phone is still a different social placeholder, keep existing phone.
    // If user somehow has empty phone, bind apple placeholder only when safe.
    if (!user.phone || user.phone === '') {
      updates.phone = placeholderPhone;
    }

    user = await prisma.user.update({
      where: { id: user.id },
      data: updates,
    });
    logger.info(`[AUTH] Existing user logged in via Apple: ${user.id}`);
  }

  const tokens = generateTokens(user.id);
  await saveRefreshToken(user.id, tokens.refreshToken);
  await applyTestDriverOverrides(user.id, user.phone);

  const requiresPhone =
    user.phone.startsWith('apple_') ||
    user.phone.startsWith('google_') ||
    user.phone === '';

  return {
    user: await buildUserProfile(user),
    tokens,
    isNewUser,
    requiresPhone,
  };
}

// ─── Truecaller Authentication ──────────────────────────────────────────

export interface TruecallerProfile {
  firstName?: string;
  lastName?: string;
  phoneNumber: string;
  countryCode?: string;
  email?: string;
  avatarUrl?: string;
}

export async function authenticateWithTruecaller(
  truecallerPayload: string | TruecallerProfile,
  accessToken?: string
): Promise<{ user: UserProfile; tokens: AuthTokens; isNewUser: boolean }> {
  logger.info('[AUTH] Authenticating with Truecaller');

  let profile: TruecallerProfile;

  if (typeof truecallerPayload === 'string') {
    profile = { phoneNumber: truecallerPayload };
  } else {
    profile = truecallerPayload;
  }

  let phone = profile.phoneNumber;
  const countryCode = profile.countryCode || '+91';

  if (!phone.startsWith('+')) {
    phone = `${countryCode}${phone.replace(/^0+/, '')}`;
  }

  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    logger.warn(`[AUTH] Invalid Truecaller phone format: ${phone}`);
    throw new Error('Invalid phone number format from Truecaller');
  }

  logger.info(`[AUTH] Truecaller auth for phone: ${phone}`);

  if (accessToken && process.env.TRUECALLER_CLIENT_ID) {
    const verificationResult = await verifyTruecallerToken(accessToken, phone);
    if (!verificationResult.valid) {
      logger.warn('[AUTH] Truecaller token verification failed');
      throw new Error('Truecaller verification failed');
    }
    if (verificationResult.phoneNumber) {
      const verifiedPhone = `+${verificationResult.phoneNumber.replace(/[^0-9]/g, '')}`;
      if (verifiedPhone !== phone) {
        logger.info(`[AUTH] Using Truecaller verified phone: ${verifiedPhone}`);
        phone = verifiedPhone;
      }
    }
  }

  let user = await prisma.user.findUnique({ where: { phone } });
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    user = await prisma.user.create({
      data: {
        phone,
        firstName: profile.firstName || 'User',
        lastName: profile.lastName ?? undefined,
        email: profile.email ?? undefined,
        profileImage: profile.avatarUrl ?? undefined,
        isVerified: true,
      },
    });
    logger.info(`[AUTH] Created new user via Truecaller: ${user.id}`);
  } else {
    const updateData: any = { lastLoginAt: new Date() };

    if (user.firstName === 'User' && profile.firstName) {
      updateData.firstName = profile.firstName;
    }
    if (!user.lastName && profile.lastName) {
      updateData.lastName = profile.lastName;
    }
    if (!user.profileImage && profile.avatarUrl) {
      updateData.profileImage = profile.avatarUrl;
    }
    if (!user.email && profile.email) {
      updateData.email = profile.email;
    }

    user = await prisma.user.update({
      where: { id: user.id },
      data: updateData,
    });
    logger.info(`[AUTH] Existing user logged in via Truecaller: ${user.id}`);
  }

  const tokens = generateTokens(user.id);
  await saveRefreshToken(user.id, tokens.refreshToken);
  await applyTestDriverOverrides(user.id, user.phone);

  return { user: await buildUserProfile(user), tokens, isNewUser };
}

async function verifyTruecallerToken(accessToken: string, expectedPhone: string): Promise<{ valid: boolean; phoneNumber?: string }> {
  const TRUECALLER_CLIENT_ID = process.env.TRUECALLER_CLIENT_ID;

  if (!TRUECALLER_CLIENT_ID) {
    logger.warn('[AUTH] TRUECALLER_CLIENT_ID not configured, skipping server-side verification');
    return { valid: true };
  }

  const verificationUrl = `https://sdk-otp-verification-noneu.truecaller.com/v1/otp/client/installation/phoneNumberDetail/${accessToken}`;

  try {
    const response = await fetch(verificationUrl, {
      method: 'GET',
      headers: { 'clientId': TRUECALLER_CLIENT_ID },
    });

    if (response.status === 404) {
      const errorData = await response.json().catch(() => ({}));
      if (errorData.message?.includes('Invalid partner credentials')) {
        logger.error('[AUTH] Truecaller: Invalid partner credentials');
      } else if (errorData.message?.includes('Invalid access token')) {
        logger.warn('[AUTH] Truecaller: Invalid access token');
      }
      return { valid: false };
    }

    if (response.status === 500) {
      logger.error('[AUTH] Truecaller API internal error');
      return { valid: true };
    }

    if (!response.ok) {
      logger.warn(`[AUTH] Truecaller API returned ${response.status}`);
      return { valid: false };
    }

    const data = await response.json();

    if (data.phoneNumber) {
      const returnedPhone = String(data.phoneNumber);
      const normalizedExpected = expectedPhone.replace(/[^0-9]/g, '');
      const normalizedReturned = returnedPhone.replace(/[^0-9]/g, '');

      const phonesMatch = normalizedExpected.endsWith(normalizedReturned) ||
                          normalizedReturned.endsWith(normalizedExpected) ||
                          normalizedExpected === normalizedReturned;

      if (!phonesMatch) {
        logger.warn(`[AUTH] Truecaller phone mismatch: expected ${expectedPhone}, got ${data.phoneNumber}`);
        return { valid: false };
      }

      logger.info(`[AUTH] Truecaller token verified for ${data.phoneNumber} (${data.countryCode})`);
      return { valid: true, phoneNumber: data.phoneNumber };
    }

    return { valid: false };
  } catch (error: any) {
    logger.error('[AUTH] Truecaller verification error', { error: error.message });
    return { valid: true };
  }
}

// ─── Phone Number Management (for Google signup users) ──────────────────

/**
 * Add phone number for Google signup users using Firebase verification
 * Client verifies the phone via Firebase OTP, then sends the Firebase ID token here.
 */
export async function addPhoneWithFirebase(
  userId: string,
  firebaseIdToken: string
): Promise<{ user: UserProfile }> {
  logger.info(`[AUTH] Adding phone via Firebase for user ${userId}`);

  const result = await FirebaseAuth.verifyFirebaseToken(firebaseIdToken);

  if (!result.success || !result.phone) {
    throw new Error(result.error || 'Firebase phone verification failed');
  }

  const phone = result.phone;

  // Check for duplicate phone
  const existingUser = await prisma.user.findUnique({ where: { phone } });
  if (existingUser && existingUser.id !== userId) {
    throw new DuplicatePhoneError(phone);
  }

  const currentUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!currentUser) {
    throw new Error('User not found');
  }

  if (currentUser.phone && !currentUser.phone.startsWith('google_') && !currentUser.phone.startsWith('apple_') && currentUser.phone !== '') {
    throw new Error('Phone number already set. Use profile update to change it.');
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      phone,
      firebaseUid: result.uid,
      isVerified: true,
      updatedAt: new Date(),
    },
  });

  logger.info(`[AUTH] Phone number added via Firebase for user ${userId}: ${phone}`);

  return { user: await buildUserProfile(user) };
}

/**
 * Change the phone number on an existing account.
 * The client must verify ownership of the NEW number via Firebase OTP and
 * send the resulting Firebase ID token here.
 */
export async function changePhoneWithFirebase(
  userId: string,
  firebaseIdToken: string
): Promise<{ user: UserProfile }> {
  logger.info(`[AUTH] Changing phone via Firebase for user ${userId}`);

  const result = await FirebaseAuth.verifyFirebaseToken(firebaseIdToken);

  if (!result.success || !result.phone) {
    throw new Error(result.error || 'Firebase phone verification failed');
  }

  const phone = result.phone;

  const currentUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!currentUser) {
    throw new Error('User not found');
  }

  if (currentUser.phone === phone) {
    // No-op: verified the number they already have.
    return { user: await buildUserProfile(currentUser) };
  }

  // The new number must not belong to another account.
  const existingUser = await prisma.user.findUnique({ where: { phone } });
  if (existingUser && existingUser.id !== userId) {
    throw new DuplicatePhoneError(phone);
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      phone,
      firebaseUid: result.uid,
      isVerified: true,
      updatedAt: new Date(),
    },
  });

  logger.info(`[AUTH] Phone number changed via Firebase for user ${userId}: ${currentUser.phone} -> ${phone}`);

  return { user: await buildUserProfile(user) };
}

// ─── Token Management ───────────────────────────────────────────────────

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const refreshSecret = process.env.REFRESH_TOKEN_SECRET || 'fallback-refresh-secret';
  const decoded = jwt.verify(refreshToken, refreshSecret) as any;
  if (decoded.type !== 'refresh') throw new Error('Invalid token type');
  const tokenRecord = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
  if (!tokenRecord || tokenRecord.expiresAt < new Date()) throw new Error('Invalid or expired refresh token');
  const jwtSecret = process.env.JWT_SECRET || 'fallback-secret-key';
  const jwtAny = jwt as any;
  const accessToken = jwtAny.sign({ userId: decoded.userId, type: 'access' }, jwtSecret, { expiresIn: '7d' });
  return { accessToken, expiresIn: 7 * 24 * 60 * 60 };
}

export async function logout(userId: string, refreshToken: string): Promise<void> {
  const tokenRecord = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
    select: { userId: true },
  });

  if (!tokenRecord) return;

  if (tokenRecord.userId !== userId) {
    throw new Error('Unauthorized - token does not belong to this user');
  }

  await prisma.refreshToken.delete({ where: { token: refreshToken } });
}

// ─── User Profile ───────────────────────────────────────────────────────

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  return buildUserProfile(user);
}

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`Email '${email}' is already in use by another account`);
    this.name = 'DuplicateEmailError';
  }
}

export class DuplicatePhoneError extends Error {
  constructor(phone: string) {
    super(`Phone number is already in use by another account`);
    this.name = 'DuplicatePhoneError';
  }
}

export async function updateUserProfile(
  userId: string,
  updates: { firstName?: string; lastName?: string; email?: string; profileImage?: string }
): Promise<UserProfile> {
  const filteredUpdates: { firstName?: string; lastName?: string | null; email?: string; profileImage?: string | null } = {};

  if (updates.firstName !== undefined && updates.firstName.trim() !== '') {
    filteredUpdates.firstName = updates.firstName.trim();
  }
  if (updates.lastName !== undefined) {
    // Empty string is an explicit clear (e.g. "John Doe" -> "John").
    const trimmed = updates.lastName.trim();
    filteredUpdates.lastName = trimmed === '' ? null : trimmed;
  }
  if (updates.email !== undefined && updates.email.trim() !== '') {
    filteredUpdates.email = updates.email.trim().toLowerCase();
  }
  if (updates.profileImage !== undefined) {
    // Empty string is an explicit "remove photo".
    const trimmed = updates.profileImage.trim();
    filteredUpdates.profileImage = trimmed === '' ? null : trimmed;
  }

  if (Object.keys(filteredUpdates).length === 0) {
    const currentUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!currentUser) throw new Error('User not found');
    return buildUserProfile(currentUser);
  }

  if (filteredUpdates.email) {
    const existingUser = await prisma.user.findUnique({ where: { email: filteredUpdates.email } });
    if (existingUser && existingUser.id !== userId) {
      throw new DuplicateEmailError(filteredUpdates.email);
    }
  }

  try {
    const currentUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!currentUser) throw new Error('User not found');

    const emailChanged =
      filteredUpdates.email !== undefined &&
      filteredUpdates.email !== (currentUser.email || '').toLowerCase();

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...filteredUpdates,
        ...(emailChanged
          ? {
              emailVerified: false,
              emailVerifiedAt: null,
              emailVerificationOtp: null,
              emailVerificationOtpExpiresAt: null,
            }
          : {}),
        updatedAt: new Date(),
      },
    });
    logger.info(`[AUTH] User profile updated for ${userId}: ${Object.keys(filteredUpdates).join(', ')}`);
    return buildUserProfile(user);
  } catch (error: any) {
    if (error.code === 'P2002' && error.meta?.target?.includes('email')) {
      throw new DuplicateEmailError(filteredUpdates.email!);
    }
    throw error;
  }
}

// ─── Account Deletion ────────────────────────────────────────────────────

export class ActiveRideError extends Error {
  constructor() {
    super('Cannot delete account while a ride is in progress. Please complete or cancel your current ride first.');
    this.name = 'ActiveRideError';
  }
}

/**
 * Industry-standard account deletion (Uber/Ola/Rapido model).
 *
 * Immediate effects:
 *   1. Blocks if user has an active ride (PENDING → IN_PROGRESS)
 *   2. Revokes all refresh tokens (app is logged out)
 *   3. Anonymizes all PII (phone, email, name, profile image, FCM token)
 *   4. Marks account as deleted (soft-delete via deletedAt)
 *   5. Revokes Firebase UID (best-effort, non-blocking)
 *
 * Deferred:
 *   - Past rides are retained for driver earnings + regulatory records
 *     (passenger name shows as "Deleted User" in ride history)
 *   - A separate cron job can hard-delete after 30 days using deletedAt
 */
export async function deleteAccount(userId: string, reason?: string): Promise<void> {
  logger.info(`[AUTH] Account deletion requested for user: ${userId}`);

  // 1. Guard: block deletion if an active ride exists
  const activeRide = await prisma.ride.findFirst({
    where: {
      passengerId: userId,
      status: { in: ['PENDING', 'CONFIRMED', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'RIDE_STARTED'] },
    },
    select: { id: true, status: true },
  });

  if (activeRide) {
    logger.warn(`[AUTH] Deletion blocked — active ride ${activeRide.id} (${activeRide.status}) for user ${userId}`);
    throw new ActiveRideError();
  }

  // 2. Fetch firebaseUid before we wipe it
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, firebaseUid: true, phone: true },
  });

  if (!user) {
    throw new Error('User not found');
  }

  // 3. Atomically revoke tokens + anonymize PII + soft-delete
  await prisma.$transaction(async (tx) => {
    // Invalidate all refresh tokens (forces logout on all devices)
    await tx.refreshToken.deleteMany({ where: { userId } });

    // Anonymize PII — phone is made unique so it can't conflict with a future signup
    await tx.user.update({
      where: { id: userId },
      data: {
        // Anonymise identifying fields
        phone: `deleted_${userId}`,
        email: null,
        firstName: 'Deleted',
        lastName: null,
        profileImage: null,
        fcmToken: null,
        fcmTokenUpdatedAt: null,
        firebaseUid: null,
        // Deactivate & mark as deleted (soft-delete)
        isActive: false,
        deletedAt: new Date(),
        deletionReason: reason ?? null,
        updatedAt: new Date(),
      },
    });
  });

  logger.info(`[AUTH] Account soft-deleted and PII anonymized for user: ${userId}`);

  // 4. Revoke Firebase account (best-effort — non-blocking)
  if (user.firebaseUid) {
    FirebaseAuth.deleteFirebaseUser(user.firebaseUid).catch((err) => {
      logger.warn(`[AUTH] Firebase deletion failed for uid ${user.firebaseUid}: ${err?.message}`);
    });
  }

  logger.info(`[AUTH] Account deletion complete for user: ${userId}`);
}

