import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import * as MSG91Service from './msg91Service';

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

/**
 * Send OTP via MSG91
 */
export async function sendMobileOTP(phone: string, countryCode: string = '+91'): Promise<{ success: boolean; message: string; mode?: string }> {
  // Normalize phone - remove leading 0 and format with country code
  let normalizedPhone = phone.replace(/^0+/, '');
  const fullPhone = `${countryCode}${normalizedPhone}`;
  
  // For MSG91, we need phone without + (e.g., 919876543210)
  const msg91Phone = fullPhone.replace('+', '');
  
  logger.info(`[AUTH] Sending OTP to ${fullPhone} (MSG91 format: ${msg91Phone})`);
  
  // Create user if doesn't exist
  let user = await prisma.user.findUnique({ where: { phone: fullPhone } });
  if (!user) {
    user = await prisma.user.create({
      data: { phone: fullPhone, firstName: 'User', isVerified: false },
    });
    logger.info(`[AUTH] Created new user for ${fullPhone}`);
  }
  
  // Send OTP via MSG91
  const result = await MSG91Service.sendOTP(msg91Phone);
  
  if (result.success) {
    logger.info(`[AUTH] OTP sent via MSG91 for ${fullPhone}`);
    return { 
      success: true, 
      message: 'OTP sent successfully',
      mode: 'msg91',
    };
  }
  
  throw new Error(result.message || 'Failed to send OTP');
}

/**
 * Verify OTP via MSG91
 */
export async function verifyMobileOTP(phone: string, otp: string, countryCode: string = '+91'): Promise<{ user: UserProfile; tokens: AuthTokens }> {
  let normalizedPhone = phone.replace(/^0+/, '');
  const fullPhone = `${countryCode}${normalizedPhone}`;
  const msg91Phone = fullPhone.replace('+', '');
  
  logger.info(`[AUTH] Verifying OTP for ${fullPhone}`);
  
  // Validate OTP format (4-6 digits)
  if (!/^\d{4,6}$/.test(otp)) {
    logger.warn(`[AUTH] Invalid OTP format for ${fullPhone}`);
    throw new Error('Invalid OTP format');
  }
  
  // Verify OTP via MSG91
  const result = await MSG91Service.verifyOTP(msg91Phone, otp);
  
  if (!result.success) {
    logger.warn(`[AUTH] OTP verification failed for ${fullPhone}: ${result.message}`);
    throw new Error(result.message || 'Invalid OTP');
  }
  
  logger.info(`[AUTH] OTP verified successfully for ${fullPhone}`);
  
  // Get or create user
  let user = await prisma.user.findUnique({ where: { phone: fullPhone } });
  if (!user) {
    user = await prisma.user.create({ data: { phone: fullPhone, firstName: 'User', isVerified: true } });
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { isVerified: true, lastLoginAt: new Date() },
    });
  }
  
  const tokens = generateTokens(user.id);
  await saveRefreshToken(user.id, tokens.refreshToken);
  
  return {
    user: {
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
    },
    tokens,
  };
}

/**
 * Resend OTP via MSG91
 */
export async function resendOTP(phone: string, countryCode: string = '+91', method: 'text' | 'voice' = 'text'): Promise<{ success: boolean; message: string }> {
  let normalizedPhone = phone.replace(/^0+/, '');
  const fullPhone = `${countryCode}${normalizedPhone}`;
  const msg91Phone = fullPhone.replace('+', '');
  
  logger.info(`[AUTH] Resending OTP to ${fullPhone} via ${method}`);
  
  const result = await MSG91Service.resendOTP(msg91Phone, method);
  
  if (result.success) {
    logger.info(`[AUTH] OTP resent via MSG91 for ${fullPhone}`);
    return { success: true, message: result.message };
  }
  
  throw new Error(result.message || 'Failed to resend OTP');
}

/**
 * Get MSG91 OTP service status
 */
export function getOTPServiceStatus(): { available: boolean; provider: string } {
  const status = MSG91Service.getMsg91Status();
  return {
    available: status.configured,
    provider: 'MSG91',
  };
}

/**
 * Authenticate with a verified phone number (MSG91 Widget flow)
 * 
 * This is called after the client has verified OTP with MSG91 Widget.
 * Client sends the access token from MSG91 Widget for server-side verification.
 * 
 * @param phone - Phone number with country code (e.g., +919876543210)
 * @param widgetToken - Optional access token from MSG91 Widget for server-side verification
 */
export async function authenticateWithVerifiedPhone(
  phone: string,
  widgetToken?: string
): Promise<{ user: UserProfile; tokens: AuthTokens; isNewUser: boolean }> {
  logger.info(`[AUTH] Authenticating with verified phone: ${phone}`);
  
  // If widget token provided, verify it server-side
  if (widgetToken && MSG91Service.isMsg91Configured()) {
    const verifyResult = await MSG91Service.verifyWidgetToken(widgetToken);
    if (!verifyResult.success) {
      logger.warn(`[AUTH] MSG91 widget token verification failed: ${verifyResult.message}`);
      throw new Error('Phone verification failed');
    }
    // Use the phone number from verification if available
    if (verifyResult.phone) {
      phone = verifyResult.phone.startsWith('+') ? verifyResult.phone : `+${verifyResult.phone}`;
    }
  }
  
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
  
  // Check if user exists by phone
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
    logger.info(`[AUTH] Created new user via MSG91 Phone: ${user.id}`);
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        isVerified: true,
        lastLoginAt: new Date(),
      },
    });
    logger.info(`[AUTH] Existing user login via MSG91 Phone: ${user.id}`);
  }
  
  const tokens = generateTokens(user.id);
  await saveRefreshToken(user.id, tokens.refreshToken);
  
  logger.info(`[AUTH] MSG91 Phone auth successful for user: ${user.id}`);
  
  return {
    user: {
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
    },
    tokens,
    isNewUser,
  };
}

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
    user: {
      id: user.id,
      email: user.email ?? undefined,
      phone: requiresPhone ? '' : user.phone,
      firstName: user.firstName,
      lastName: user.lastName ?? undefined,
      profileImage: user.profileImage ?? undefined,
      isVerified: user.isVerified,
      isActive: user.isActive,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt ?? undefined,
    },
    tokens,
    isNewUser,
    requiresPhone,
  };
}

/**
 * Truecaller Authentication
 */
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
  
  return {
    user: {
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
    },
    tokens,
    isNewUser,
  };
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

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
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

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`Email '${email}' is already in use by another account`);
    this.name = 'DuplicateEmailError';
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
    return {
      id: currentUser.id,
      email: currentUser.email ?? undefined,
      phone: currentUser.phone,
      firstName: currentUser.firstName,
      lastName: currentUser.lastName ?? undefined,
      profileImage: currentUser.profileImage ?? undefined,
      isVerified: currentUser.isVerified,
      isActive: currentUser.isActive,
      createdAt: currentUser.createdAt,
      lastLoginAt: currentUser.lastLoginAt ?? undefined,
    };
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
  } catch (error: any) {
    if (error.code === 'P2002' && error.meta?.target?.includes('email')) {
      throw new DuplicateEmailError(filteredUpdates.email!);
    }
    throw error;
  }
}

export class DuplicatePhoneError extends Error {
  constructor(phone: string) {
    super(`Phone number is already in use by another account`);
    this.name = 'DuplicatePhoneError';
  }
}

/**
 * Add phone number for Google signup users
 * Sends OTP via MSG91 to verify the phone number
 */
export async function addPhoneNumber(
  userId: string,
  phone: string,
  countryCode: string = '+91'
): Promise<{ otpSent: boolean }> {
  let normalizedPhone = phone.replace(/^0+/, '');
  const fullPhone = `${countryCode}${normalizedPhone}`;
  const msg91Phone = fullPhone.replace('+', '');
  
  logger.info(`[AUTH] Adding phone number ${fullPhone} for user ${userId}`);
  
  const existingUser = await prisma.user.findUnique({ where: { phone: fullPhone } });
  if (existingUser && existingUser.id !== userId) {
    throw new DuplicatePhoneError(fullPhone);
  }
  
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error('User not found');
  }
  
  if (user.phone && !user.phone.startsWith('google_') && user.phone !== '') {
    throw new Error('Phone number already set. Use profile update to change it.');
  }
  
  // Send OTP via MSG91
  const result = await MSG91Service.sendOTP(msg91Phone);
  
  if (result.success) {
    logger.info(`[AUTH] OTP sent for phone verification: ${fullPhone}`);
    return { otpSent: true };
  }
  
  throw new Error(result.message || 'Failed to send OTP');
}

/**
 * Verify phone number OTP and add to user profile
 */
export async function verifyAndAddPhone(
  userId: string,
  phone: string,
  otp: string,
  countryCode: string = '+91'
): Promise<UserProfile> {
  let normalizedPhone = phone.replace(/^0+/, '');
  const fullPhone = `${countryCode}${normalizedPhone}`;
  const msg91Phone = fullPhone.replace('+', '');
  
  logger.info(`[AUTH] Verifying phone OTP for user ${userId}: ${fullPhone}`);
  
  if (!/^\d{4,6}$/.test(otp)) {
    throw new Error('Invalid OTP format');
  }
  
  // Verify OTP via MSG91
  const result = await MSG91Service.verifyOTP(msg91Phone, otp);
  
  if (!result.success) {
    throw new Error(result.message || 'Invalid OTP');
  }
  
  logger.info(`[AUTH] Phone OTP verified for ${fullPhone}`);
  
  const existingUser = await prisma.user.findUnique({ where: { phone: fullPhone } });
  if (existingUser && existingUser.id !== userId) {
    throw new DuplicatePhoneError(fullPhone);
  }
  
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      phone: fullPhone,
      isVerified: true,
      updatedAt: new Date(),
    },
  });
  
  logger.info(`[AUTH] Phone number added successfully for user ${userId}: ${fullPhone}`);
  
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
