import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import { sendOTP, verifyOTPViaTwilio } from './smsService';
import { setOtp, getOtp, deleteOtp } from './otpStore';
import * as FirebaseService from './firebaseService';

const logger = createLogger('auth-service');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Initialize Firebase at module load
FirebaseService.initializeFirebase();

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

export async function sendMobileOTP(phone: string, countryCode: string = '+91'): Promise<{ success: boolean; message: string; mode?: string }> {
  const fullPhone = `${countryCode}${phone}`;
  
  logger.info(`[AUTH] Sending OTP to ${fullPhone}`);
  
  // Create user if doesn't exist
  let user = await prisma.user.findUnique({ where: { phone: fullPhone } });
  if (!user) {
    user = await prisma.user.create({
      data: { phone: fullPhone, firstName: 'User', isVerified: false },
    });
    logger.info(`[AUTH] Created new user for ${fullPhone}`);
  }
  
  // Send OTP via Twilio
  const result = await sendOTP(fullPhone);
  
  if (result.success) {
    // If OTP is returned (SMS mode or dev mode), store it for verification
    if (result.otp) {
      await setOtp(fullPhone, result.otp);
      logger.info(`[AUTH] OTP stored for ${fullPhone} (SMS/dev mode)`);
    } else {
      // Twilio Verify mode - OTP is managed by Twilio
      logger.info(`[AUTH] OTP sent via Twilio Verify for ${fullPhone}`);
    }
    
    return { 
      success: true, 
      message: 'OTP sent successfully',
      mode: result.otp ? 'sms' : 'verify', // Indicate which mode was used
    };
  }
  
  throw new Error('Failed to send OTP');
}

export async function verifyMobileOTP(phone: string, otp: string, countryCode: string = '+91'): Promise<{ user: UserProfile; tokens: AuthTokens }> {
  const fullPhone = `${countryCode}${phone}`;
  
  logger.info(`[AUTH] Verifying OTP for ${fullPhone}`);
  
  // Validate OTP format (6 digits)
  if (!/^\d{6}$/.test(otp)) {
    logger.warn(`[AUTH] Invalid OTP format for ${fullPhone}`);
    throw new Error('Invalid OTP format - must be 6 digits');
  }
  
  // Fixed OTP for development/testing: 123456
  const DEV_OTP = '123456';
  
  // Try Twilio Verify first (if configured in production)
  const twilioResult = await verifyOTPViaTwilio(fullPhone, otp);
  
  if (twilioResult.valid) {
    // OTP verified via Twilio Verify API
    logger.info(`[AUTH] OTP verified via Twilio Verify for ${fullPhone}`);
  } else if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    // Development mode - accept fixed OTP or stored OTP
    if (otp === DEV_OTP) {
      logger.info(`[AUTH] DEV MODE - Fixed OTP accepted for ${fullPhone}`);
    } else {
      // Verify against stored OTP
      const storedOTP = await getOtp(fullPhone);
      if (!storedOTP || storedOTP !== otp) {
        logger.warn(`[AUTH] Invalid OTP for ${fullPhone} - stored: ${storedOTP}, provided: ${otp}`);
        throw new Error('Invalid OTP');
      }
      await deleteOtp(fullPhone);
      logger.info(`[AUTH] DEV MODE - Stored OTP verified for ${fullPhone}`);
    }
  } else {
    // Production mode - verify against stored OTP (for SMS mode)
    const storedOTP = await getOtp(fullPhone);
    if (!storedOTP || storedOTP !== otp) {
      logger.warn(`[AUTH] Invalid OTP for ${fullPhone}`);
      throw new Error('Invalid OTP');
    }
    await deleteOtp(fullPhone);
    logger.info(`[AUTH] OTP verified via stored OTP for ${fullPhone}`);
  }
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
 * Authenticate user with Firebase Phone Auth
 * 
 * This is the recommended method for production phone verification.
 * The client handles the entire OTP flow using Firebase SDK:
 * 1. Client calls signInWithPhoneNumber() → Firebase sends SMS
 * 2. User enters OTP → Client verifies with Firebase
 * 3. Client gets Firebase ID token → Sends to this endpoint
 * 4. Backend verifies Firebase token → Creates/updates user → Returns JWT
 * 
 * Benefits:
 * - No SMS costs (included in Firebase Auth free tier)
 * - Built-in rate limiting and abuse prevention
 * - Global phone number support
 * - reCAPTCHA protection
 * 
 * @param firebaseIdToken - Firebase ID token from client after phone verification
 * @returns User profile and JWT tokens
 */
export async function authenticateWithFirebasePhone(
  firebaseIdToken: string
): Promise<{ user: UserProfile; tokens: AuthTokens; isNewUser: boolean }> {
  logger.info('[AUTH] Authenticating with Firebase Phone');
  
  // Check if Firebase is configured
  if (!FirebaseService.isFirebaseConfigured()) {
    logger.error('[AUTH] Firebase not configured');
    throw new Error('Firebase authentication is not configured');
  }
  
  // Verify the Firebase ID token
  const verifyResult = await FirebaseService.verifyFirebaseToken(firebaseIdToken);
  
  if (!verifyResult.success) {
    logger.error('[AUTH] Firebase token verification failed', {
      error: verifyResult.error,
    });
    throw new Error(verifyResult.error || 'Firebase token verification failed');
  }
  
  if (!verifyResult.phone) {
    logger.error('[AUTH] Firebase token does not contain phone number');
    throw new Error('Phone number not found in Firebase token');
  }
  
  const phoneNumber = verifyResult.phone;
  const firebaseUid = verifyResult.uid!;
  
  logger.info(`[AUTH] Firebase auth for phone: ${phoneNumber}`, {
    firebaseUid,
  });
  
  // Check if user exists by phone
  let user = await prisma.user.findUnique({ where: { phone: phoneNumber } });
  let isNewUser = false;
  
  if (!user) {
    isNewUser = true;
    // Create new user with Firebase data
    user = await prisma.user.create({
      data: {
        phone: phoneNumber,
        email: verifyResult.email ?? undefined,
        firstName: verifyResult.name?.split(' ')[0] || 'User',
        lastName: verifyResult.name?.split(' ').slice(1).join(' ') || undefined,
        profileImage: verifyResult.picture ?? undefined,
        isVerified: true, // Phone is verified by Firebase
        firebaseUid, // Store Firebase UID for reference
      },
    });
    logger.info(`[AUTH] Created new user via Firebase Phone: ${user.id}`);
  } else {
    // Update existing user
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        isVerified: true,
        lastLoginAt: new Date(),
        firebaseUid: user.firebaseUid || firebaseUid, // Only set if not already set
      },
    });
    logger.info(`[AUTH] Updated existing user via Firebase Phone: ${user.id}`);
  }
  
  // Link Firebase user to backend user (for custom claims)
  await FirebaseService.linkFirebaseUser(firebaseUid, user.id);
  
  // Generate our own JWT tokens
  const tokens = generateTokens(user.id);
  await saveRefreshToken(user.id, tokens.refreshToken);
  
  logger.info(`[AUTH] Firebase Phone auth successful for user: ${user.id}`);
  
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

/**
 * Get Firebase auth configuration status
 * Useful for client to know which auth methods are available
 */
export function getFirebaseAuthStatus(): {
  available: boolean;
  projectId?: string;
} {
  const status = FirebaseService.getFirebaseConfigStatus();
  return {
    available: status.configured,
    projectId: status.projectId,
  };
}

export async function authenticateWithGoogle(idToken: string): Promise<{ user: UserProfile; tokens: AuthTokens; isNewUser: boolean; requiresPhone: boolean }> {
  logger.info('[AUTH] Authenticating with Google');
  
  // Verify the Google ID token
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
  
  // Check if user exists by email
  let user = await prisma.user.findUnique({ where: { email } });
  let isNewUser = false;
  
  if (!user) {
    isNewUser = true;
    // Create new user with Google data
    // Phone is required in our schema, so we use a placeholder that indicates Google signup
    // The user should be prompted to add their phone number after signup
    const placeholderPhone = `google_${googleId}`;
    
    user = await prisma.user.create({
      data: {
        email,
        phone: placeholderPhone,
        firstName: given_name || 'User',
        lastName: family_name ?? undefined,
        profileImage: picture ?? undefined,
        isVerified: true, // Email is verified by Google
      },
    });
    logger.info(`[AUTH] Created new user via Google: ${user.id}`);
  } else {
    // Update existing user with latest Google data
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        profileImage: picture || user.profileImage,
        // Update name if not set
        firstName: user.firstName === 'User' && given_name ? given_name : user.firstName,
        lastName: user.lastName || family_name || undefined,
      },
    });
    logger.info(`[AUTH] Existing user logged in via Google: ${user.id}`);
  }
  
  const tokens = generateTokens(user.id);
  await saveRefreshToken(user.id, tokens.refreshToken);
  
  // Check if user needs to add phone number (has placeholder phone)
  const requiresPhone = user.phone.startsWith('google_') || user.phone === '';
  
  return {
    user: {
      id: user.id,
      email: user.email ?? undefined,
      phone: requiresPhone ? '' : user.phone, // Don't expose placeholder phone
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
 * 
 * Truecaller SDK provides a payload containing:
 * - accessToken: JWT token from Truecaller
 * - profile: { firstName, lastName, phoneNumber, ... }
 * 
 * In production, we should verify the token with Truecaller's API.
 * For now, we trust the SDK's verification on the client side.
 * 
 * @see https://docs.truecaller.com/truecaller-sdk/
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
  
  // Handle both string (legacy) and object payload
  if (typeof truecallerPayload === 'string') {
    // Legacy format: phone number string
    profile = {
      phoneNumber: truecallerPayload,
    };
  } else {
    profile = truecallerPayload;
  }
  
  // Normalize phone number
  let phone = profile.phoneNumber;
  const countryCode = profile.countryCode || '+91';
  
  // Ensure phone has country code
  if (!phone.startsWith('+')) {
    phone = `${countryCode}${phone.replace(/^0+/, '')}`; // Remove leading zeros
  }
  
  // Validate phone format (E.164)
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    logger.warn(`[AUTH] Invalid Truecaller phone format: ${phone}`);
    throw new Error('Invalid phone number format from Truecaller');
  }
  
  logger.info(`[AUTH] Truecaller auth for phone: ${phone}`);
  
  // Verify Truecaller token in production (or if client ID is configured)
  if (accessToken && process.env.TRUECALLER_CLIENT_ID) {
    const verificationResult = await verifyTruecallerToken(accessToken, phone);
    if (!verificationResult.valid) {
      logger.warn('[AUTH] Truecaller token verification failed');
      throw new Error('Truecaller verification failed');
    }
    // Use the verified phone number if available
    if (verificationResult.phoneNumber) {
      const verifiedPhone = `+${verificationResult.phoneNumber.replace(/[^0-9]/g, '')}`;
      if (verifiedPhone !== phone) {
        logger.info(`[AUTH] Using Truecaller verified phone: ${verifiedPhone}`);
        phone = verifiedPhone;
      }
    }
  }
  
  // Check if user exists
  let user = await prisma.user.findUnique({ where: { phone } });
  let isNewUser = false;
  
  if (!user) {
    isNewUser = true;
    // Create new user with Truecaller data
    user = await prisma.user.create({
      data: {
        phone,
        firstName: profile.firstName || 'User',
        lastName: profile.lastName ?? undefined,
        email: profile.email ?? undefined,
        profileImage: profile.avatarUrl ?? undefined,
        isVerified: true, // Truecaller verifies the phone
      },
    });
    logger.info(`[AUTH] Created new user via Truecaller: ${user.id}`);
  } else {
    // Update existing user with Truecaller data (if more complete)
    const updateData: any = { lastLoginAt: new Date() };
    
    // Update name if current is placeholder
    if (user.firstName === 'User' && profile.firstName) {
      updateData.firstName = profile.firstName;
    }
    if (!user.lastName && profile.lastName) {
      updateData.lastName = profile.lastName;
    }
    // Update profile image if not set
    if (!user.profileImage && profile.avatarUrl) {
      updateData.profileImage = profile.avatarUrl;
    }
    // Update email if not set
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

/**
 * Verify Truecaller access token with their official API
 * API Docs: https://docs.truecaller.com/truecaller-sdk/android/oauth-sdk-3.2.0/integration-steps/non-truecaller-user-verification/server-side-validation
 * 
 * Returns the phone number if valid, null if invalid
 */
async function verifyTruecallerToken(accessToken: string, expectedPhone: string): Promise<{ valid: boolean; phoneNumber?: string }> {
  const TRUECALLER_CLIENT_ID = process.env.TRUECALLER_CLIENT_ID;
  
  if (!TRUECALLER_CLIENT_ID) {
    logger.warn('[AUTH] TRUECALLER_CLIENT_ID not configured, skipping server-side verification');
    return { valid: true }; // Skip verification if not configured (trust client SDK)
  }
  
  // Official Truecaller verification endpoint
  const verificationUrl = `https://sdk-otp-verification-noneu.truecaller.com/v1/otp/client/installation/phoneNumberDetail/${accessToken}`;
  
  try {
    const response = await fetch(verificationUrl, {
      method: 'GET',
      headers: {
        'clientId': TRUECALLER_CLIENT_ID,
      },
    });
    
    if (response.status === 404) {
      const errorData = await response.json().catch(() => ({}));
      if (errorData.message?.includes('Invalid partner credentials')) {
        logger.error('[AUTH] Truecaller: Invalid partner credentials (check TRUECALLER_CLIENT_ID)');
      } else if (errorData.message?.includes('Invalid access token')) {
        logger.warn('[AUTH] Truecaller: Invalid access token');
      }
      return { valid: false };
    }
    
    if (response.status === 500) {
      logger.error('[AUTH] Truecaller API internal error');
      // On Truecaller server error, trust client verification
      return { valid: true };
    }
    
    if (!response.ok) {
      logger.warn(`[AUTH] Truecaller API returned ${response.status}`);
      return { valid: false };
    }
    
    const data = await response.json();
    // Response: { "phoneNumber": "919999XXXXX9", "countryCode": "IN" }
    
    if (data.phoneNumber) {
      // Normalize phone numbers for comparison
      const returnedPhone = String(data.phoneNumber);
      const normalizedExpected = expectedPhone.replace(/[^0-9]/g, '');
      const normalizedReturned = returnedPhone.replace(/[^0-9]/g, '');
      
      // Check if phones match (handle with/without country code)
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
    // On network error, trust client SDK verification
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
  // SECURITY: Only delete the token if it belongs to the requesting user
  const tokenRecord = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
    select: { userId: true },
  });
  
  if (!tokenRecord) {
    // Token doesn't exist - already logged out or invalid
    return;
  }
  
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

// Custom error class for duplicate email
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
  // Filter out empty string values to prevent accidentally clearing fields
  // Only include fields that have actual values
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
  
  // If no valid updates, return current profile
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

  // If email is being updated, check if it's already in use by another user
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
    // Handle Prisma unique constraint violation (P2002)
    if (error.code === 'P2002' && error.meta?.target?.includes('email')) {
      throw new DuplicateEmailError(filteredUpdates.email!);
    }
    throw error;
  }
}

// Custom error class for duplicate phone
export class DuplicatePhoneError extends Error {
  constructor(phone: string) {
    super(`Phone number is already in use by another account`);
    this.name = 'DuplicatePhoneError';
  }
}

/**
 * Add phone number for Google signup users
 * Sends OTP to verify the phone number
 */
export async function addPhoneNumber(
  userId: string,
  phone: string,
  countryCode: string = '+91'
): Promise<{ otpSent: boolean }> {
  const fullPhone = `${countryCode}${phone}`;
  
  logger.info(`[AUTH] Adding phone number ${fullPhone} for user ${userId}`);
  
  // Check if phone number is already in use by another user
  const existingUser = await prisma.user.findUnique({ where: { phone: fullPhone } });
  if (existingUser && existingUser.id !== userId) {
    throw new DuplicatePhoneError(fullPhone);
  }
  
  // Get current user
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error('User not found');
  }
  
  // Check if user already has a valid phone number
  if (user.phone && !user.phone.startsWith('google_') && user.phone !== '') {
    throw new Error('Phone number already set. Use profile update to change it.');
  }
  
  // Send OTP for verification
  const result = await sendOTP(fullPhone);
  
  if (result.success) {
    // Store OTP for verification
    if (result.otp) {
      await setOtp(fullPhone, result.otp);
    }
    
    // Store pending phone number temporarily (will be set after OTP verification)
    await setOtp(`pending_phone_${userId}`, fullPhone);
    
    logger.info(`[AUTH] OTP sent for phone verification: ${fullPhone}`);
    return { otpSent: true };
  }
  
  throw new Error('Failed to send OTP');
}

/**
 * Verify phone number OTP and add to user profile
 * Used for Google signup users adding their phone
 */
export async function verifyAndAddPhone(
  userId: string,
  phone: string,
  otp: string,
  countryCode: string = '+91'
): Promise<UserProfile> {
  const fullPhone = `${countryCode}${phone}`;
  
  logger.info(`[AUTH] Verifying phone OTP for user ${userId}: ${fullPhone}`);
  
  // Validate OTP format
  if (!/^\d{6}$/.test(otp)) {
    throw new Error('Invalid OTP format - must be 6 digits');
  }
  
  // Fixed OTP for development
  const DEV_OTP = '123456';
  
  // Verify OTP
  const twilioResult = await verifyOTPViaTwilio(fullPhone, otp);
  
  if (twilioResult.valid) {
    logger.info(`[AUTH] Phone OTP verified via Twilio Verify for ${fullPhone}`);
  } else if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    if (otp === DEV_OTP) {
      logger.info(`[AUTH] DEV MODE - Fixed OTP accepted for phone verification`);
    } else {
      const storedOTP = await getOtp(fullPhone);
      if (!storedOTP || storedOTP !== otp) {
        throw new Error('Invalid OTP');
      }
      await deleteOtp(fullPhone);
      logger.info(`[AUTH] DEV MODE - Stored OTP verified for phone`);
    }
  } else {
    const storedOTP = await getOtp(fullPhone);
    if (!storedOTP || storedOTP !== otp) {
      throw new Error('Invalid OTP');
    }
    await deleteOtp(fullPhone);
    logger.info(`[AUTH] OTP verified for phone: ${fullPhone}`);
  }
  
  // Check if phone is already in use
  const existingUser = await prisma.user.findUnique({ where: { phone: fullPhone } });
  if (existingUser && existingUser.id !== userId) {
    throw new DuplicatePhoneError(fullPhone);
  }
  
  // Update user with verified phone number
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      phone: fullPhone,
      isVerified: true,
      updatedAt: new Date(),
    },
  });
  
  // Clean up pending phone
  await deleteOtp(`pending_phone_${userId}`);
  
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
