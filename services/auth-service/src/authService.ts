import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import * as FirebaseAuth from './firebaseAuth';

const logger = createLogger('auth-service');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface UserProfile {
  id: string;
  email?: string;
  phone: string;
  firstName: string;
  lastName?: string;
  profileImage?: string;
  isVerified: boolean;
  isActive: boolean;
  createdAt: Date;
  lastLoginAt?: Date;
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
  isActive: boolean; createdAt: Date; lastLoginAt: Date | null;
}): UserProfile {
  return {
    id: user.id,
    email: user.email ?? undefined,
    phone: user.phone,
    firstName: user.firstName,
    lastName: user.lastName ?? undefined,
    profileImage: user.profileImage ?? undefined,
    isVerified: user.isVerified,
    isActive: user.isActive,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt ?? undefined,
  };
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

  logger.info(`[AUTH] Firebase Phone auth successful for user: ${user.id}`);

  return { user: toUserProfile(user), tokens, isNewUser };
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

  return { user: toUserProfile(user), tokens, isNewUser };
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
      },
    });
    logger.info(`[AUTH] Existing user logged in via Google: ${user.id}`);
  }

  const tokens = generateTokens(user.id);
  await saveRefreshToken(user.id, tokens.refreshToken);

  const requiresPhone = user.phone.startsWith('google_') || user.phone === '';

  return {
    user: toUserProfile(user),
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

  return { user: toUserProfile(user), tokens, isNewUser };
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

  if (currentUser.phone && !currentUser.phone.startsWith('google_') && currentUser.phone !== '') {
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

  return { user: toUserProfile(user) };
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
  return toUserProfile(user);
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
  const filteredUpdates: { firstName?: string; lastName?: string; email?: string; profileImage?: string } = {};

  if (updates.firstName !== undefined && updates.firstName.trim() !== '') {
    filteredUpdates.firstName = updates.firstName.trim();
  }
  if (updates.lastName !== undefined && updates.lastName.trim() !== '') {
    filteredUpdates.lastName = updates.lastName.trim();
  }
  if (updates.email !== undefined && updates.email.trim() !== '') {
    filteredUpdates.email = updates.email.trim().toLowerCase();
  }
  if (updates.profileImage !== undefined && updates.profileImage.trim() !== '') {
    filteredUpdates.profileImage = updates.profileImage.trim();
  }

  if (Object.keys(filteredUpdates).length === 0) {
    const currentUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!currentUser) throw new Error('User not found');
    return toUserProfile(currentUser);
  }

  if (filteredUpdates.email) {
    const existingUser = await prisma.user.findUnique({ where: { email: filteredUpdates.email } });
    if (existingUser && existingUser.id !== userId) {
      throw new DuplicateEmailError(filteredUpdates.email);
    }
  }

  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { ...filteredUpdates, updatedAt: new Date() },
    });
    logger.info(`[AUTH] User profile updated for ${userId}: ${Object.keys(filteredUpdates).join(', ')}`);
    return toUserProfile(user);
  } catch (error: any) {
    if (error.code === 'P2002' && error.meta?.target?.includes('email')) {
      throw new DuplicateEmailError(filteredUpdates.email!);
    }
    throw error;
  }
}
