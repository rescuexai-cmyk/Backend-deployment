import express, { Response } from 'express';
import { body, validationResult } from 'express-validator';
import { authenticate, AuthRequest } from '@raahi/shared';
import { asyncHandler } from '@raahi/shared';
import * as AuthService from '../authService';
import * as FirebaseAuth from '../firebaseAuth';
import { createLogger } from '@raahi/shared';

const logger = createLogger('auth-routes');
const router = express.Router();

type OtpWindowEntry = {
  timestamps: number[];
};

const otpRequestByPhone = new Map<string, OtpWindowEntry>();
const otpRequestByDevice = new Map<string, OtpWindowEntry>();
const otpRequestByIp = new Map<string, OtpWindowEntry>();

function normalizePhone(phone: string): string {
  let p = phone.replace(/[\s\-()]/g, '');
  if (!p.startsWith('+')) p = `+${p}`;
  return p;
}

function cleanupOldTimestamps(timestamps: number[], now: number): number[] {
  const oneHourAgo = now - 60 * 60 * 1000;
  return timestamps.filter((ts) => ts >= oneHourAgo);
}

function extractClientMeta(req: any): { ip: string; deviceId: string } {
  const ip = (
    req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown'
  );
  const deviceId = (req.headers['x-device-id']?.toString().trim() || 'unknown_device');
  return { ip, deviceId };
}

function checkOtpRateLimit(
  phone: string,
  deviceId: string,
  ip: string
): { allowed: boolean; message?: string; retryAfterSeconds?: number } {
  const now = Date.now();
  const tenMinutes = 10 * 60 * 1000;
  const oneHour = 60 * 60 * 1000;

  const phoneEntry = otpRequestByPhone.get(phone) ?? { timestamps: [] };
  phoneEntry.timestamps = cleanupOldTimestamps(phoneEntry.timestamps, now);
  otpRequestByPhone.set(phone, phoneEntry);

  const deviceEntry = otpRequestByDevice.get(deviceId) ?? { timestamps: [] };
  deviceEntry.timestamps = cleanupOldTimestamps(deviceEntry.timestamps, now);
  otpRequestByDevice.set(deviceId, deviceEntry);

  const ipEntry = otpRequestByIp.get(ip) ?? { timestamps: [] };
  ipEntry.timestamps = cleanupOldTimestamps(ipEntry.timestamps, now);
  otpRequestByIp.set(ip, ipEntry);

  const phoneLast10m = phoneEntry.timestamps.filter((t) => now - t <= tenMinutes);
  if (phoneLast10m.length >= 3) {
    const retryAt = phoneLast10m[0] + tenMinutes;
    return {
      allowed: false,
      message: 'Too many OTP requests for this phone number. Try again shortly.',
      retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)),
    };
  }

  if (phoneEntry.timestamps.length >= 5) {
    const retryAt = phoneEntry.timestamps[0] + oneHour;
    return {
      allowed: false,
      message: 'OTP hourly limit reached for this phone number.',
      retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)),
    };
  }

  // Device/IP abuse heuristics
  const deviceLast10m = deviceEntry.timestamps.filter((t) => now - t <= tenMinutes).length;
  const ipLast10m = ipEntry.timestamps.filter((t) => now - t <= tenMinutes).length;
  if (deviceLast10m >= 10 || ipLast10m >= 20) {
    return {
      allowed: false,
      message: 'Suspicious OTP activity detected. Please try again later.',
      retryAfterSeconds: 600,
    };
  }

  return { allowed: true };
}

function recordOtpRequest(phone: string, deviceId: string, ip: string): void {
  const now = Date.now();
  const add = (map: Map<string, OtpWindowEntry>, key: string) => {
    const entry = map.get(key) ?? { timestamps: [] };
    entry.timestamps = cleanupOldTimestamps(entry.timestamps, now);
    entry.timestamps.push(now);
    map.set(key, entry);
  };
  add(otpRequestByPhone, phone);
  add(otpRequestByDevice, deviceId);
  add(otpRequestByIp, ip);
}

/**
 * @openapi
 * components:
 *   schemas:
 *     AuthResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           example: true
 *         message:
 *           type: string
 *           example: Authentication successful
 *         data:
 *           type: object
 *           properties:
 *             user:
 *               $ref: '#/components/schemas/User'
 *             tokens:
 *               $ref: '#/components/schemas/AuthTokens'
 *             isNewUser:
 *               type: boolean
 */

/**
 * @openapi
 * /api/auth/verify-otp:
 *   post:
 *     tags: [Authentication]
 *     summary: Verify OTP and authenticate user
 *     description: |
 *       Primary authentication endpoint. Supports two modes:
 *       - **Firebase Token (production)**: Send idToken from Firebase Auth SDK
 *       - **Dev/Testing mode**: Send phone + otp (accepts "123456" in dev mode)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               idToken:
 *                 type: string
 *                 description: Firebase ID token (for production)
 *               phone:
 *                 type: string
 *                 description: Phone number in E.164 format (for dev mode)
 *                 example: "+919876543210"
 *               otp:
 *                 type: string
 *                 description: OTP code (use "123456" in dev mode)
 *                 example: "123456"
 *           examples:
 *             firebase:
 *               summary: Firebase authentication
 *               value:
 *                 idToken: "eyJhbGciOiJSUzI1NiIs..."
 *             devMode:
 *               summary: Dev mode authentication
 *               value:
 *                 phone: "+919876543210"
 *                 otp: "123456"
 *     responses:
 *       200:
 *         description: Authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       400:
 *         description: Validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationError'
 *       401:
 *         description: Invalid OTP
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: Invalid OTP
 *                 code:
 *                   type: string
 *                   example: INVALID_OTP
 *       403:
 *         description: Dev OTP mode disabled
 */
router.post(
  '/verify-otp',
  [
    body('idToken').optional().isString(),
    body('firebaseIdToken').optional().isString(),
  ],
  asyncHandler(async (req, res: Response) => {
    const idToken = req.body.idToken || req.body.firebaseIdToken;

    // Firebase token verification (single production flow)
    if (!idToken) {
      res.status(400).json({
        success: false,
        message: 'idToken (Firebase) is required',
        errors: [
          { msg: 'Provide Firebase idToken from client-side OTP verification' }
        ],
      });
      return;
    }

    const result = await AuthService.authenticateWithFirebasePhone(idToken);

    res.status(200).json({
      success: true,
      message: result.isNewUser ? 'Account created successfully' : 'Authentication successful',
      data: result,
    });
  })
);

/**
 * @openapi
 * /api/auth/firebase-phone:
 *   post:
 *     tags: [Authentication]
 *     summary: Firebase phone authentication
 *     description: Authenticate using Firebase ID token from phone verification
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idToken]
 *             properties:
 *               idToken:
 *                 type: string
 *                 description: Firebase ID token
 *     responses:
 *       200:
 *         description: Authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       400:
 *         description: Validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationError'
 */
router.post(
  '/firebase-phone',
  [
    body('idToken').isString().notEmpty().withMessage('Firebase ID token is required'),
  ],
  asyncHandler(async (req, res: Response) => {
    if (process.env.NODE_ENV === 'production') {
      res.status(403).json({
        success: false,
        message: 'Direct phone authentication is disabled in production.',
        code: 'PHONE_AUTH_DISABLED',
      });
      return;
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const { idToken } = req.body;
    const { ip, deviceId } = extractClientMeta(req);

    // Verify once here so we can apply per-phone abuse protection before login.
    const verified = await FirebaseAuth.verifyFirebaseToken(idToken);
    if (!verified.success || !verified.phone) {
      res.status(401).json({
        success: false,
        message: verified.error || 'Invalid Firebase token',
        code: 'INVALID_FIREBASE_TOKEN',
      });
      return;
    }

    const rate = checkOtpRateLimit(verified.phone, deviceId, ip);
    if (!rate.allowed) {
      logger.warn(`[AUTH] OTP abuse protection blocked firebase-phone login phone=${verified.phone} ip=${ip} device=${deviceId}`);
      res.status(429).json({
        success: false,
        message: rate.message,
        code: 'OTP_RATE_LIMITED',
        retryAfterSeconds: rate.retryAfterSeconds,
      });
      return;
    }
    recordOtpRequest(verified.phone, deviceId, ip);

    const result = await AuthService.authenticateWithFirebasePhone(idToken);

    res.status(200).json({
      success: true,
      message: result.isNewUser ? 'Account created successfully' : 'Authentication successful',
      data: result,
    });
  })
);

// Alias endpoint required by mobile clients.
router.post(
  '/firebase-login',
  [body('firebaseIdToken').isString().notEmpty().withMessage('Firebase ID token is required')],
  asyncHandler(async (req, res: Response) => {
    req.body.idToken = req.body.firebaseIdToken;
    const { idToken } = req.body;
    const { ip, deviceId } = extractClientMeta(req);

    const verified = await FirebaseAuth.verifyFirebaseToken(idToken);
    if (!verified.success || !verified.phone) {
      res.status(401).json({
        success: false,
        message: verified.error || 'Invalid Firebase token',
        code: 'INVALID_FIREBASE_TOKEN',
      });
      return;
    }

    const rate = checkOtpRateLimit(verified.phone, deviceId, ip);
    if (!rate.allowed) {
      logger.warn(`[AUTH] OTP abuse protection blocked firebase-login phone=${verified.phone} ip=${ip} device=${deviceId}`);
      res.status(429).json({
        success: false,
        message: rate.message,
        code: 'OTP_RATE_LIMITED',
        retryAfterSeconds: rate.retryAfterSeconds,
      });
      return;
    }
    recordOtpRequest(verified.phone, deviceId, ip);

    const result = await AuthService.authenticateWithFirebasePhone(idToken);
    res.status(200).json({
      success: true,
      message: result.isNewUser ? 'Account created successfully' : 'Authentication successful',
      data: result,
    });
  })
);

/**
 * @openapi
 * /api/auth/otp-status:
 *   get:
 *     tags: [Authentication]
 *     summary: Get OTP service status
 *     description: Returns the availability and provider information for OTP service
 *     responses:
 *       200:
 *         description: OTP service status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     otpServiceAvailable:
 *                       type: boolean
 *                     provider:
 *                       type: string
 *                       example: Firebase
 *                     projectId:
 *                       type: string
 *                       nullable: true
 */
router.get(
  '/otp-status',
  asyncHandler(async (_req, res: Response) => {
    const status = AuthService.getOTPServiceStatus();
    res.status(200).json({
      success: true,
      data: {
        otpServiceAvailable: status.available,
        provider: status.provider,
        projectId: status.projectId,
      },
    });
  })
);

// ─── Legacy Phone Auth (dev/testing) ────────────────────────────────────

/**
 * @openapi
 * /api/auth/send-otp:
 *   post:
 *     tags: [Authentication]
 *     summary: Send OTP (dev/testing)
 *     description: |
 *       Dev/testing endpoint. In dev mode, OTP is always "123456".
 *       Client should then call /verify-otp with the phone and OTP.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone]
 *             properties:
 *               phone:
 *                 type: string
 *                 description: Phone number
 *                 example: "+919876543210"
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: OTP sent successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     phone:
 *                       type: string
 *                     otpSent:
 *                       type: boolean
 *                     expiresIn:
 *                       type: integer
 *                       example: 300
 *                     devOtp:
 *                       type: string
 *                       example: "123456"
 *                       description: Only in non-production environments
 *       400:
 *         description: Validation failed
 *       403:
 *         description: Dev OTP mode disabled in production
 */
router.post(
  '/send-otp',
  [
    body('phone').isString().notEmpty().withMessage('Phone number is required'),
  ],
  asyncHandler(async (req, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array(),
      });
      return;
    }

    const phone = normalizePhone(req.body.phone);
    const { ip, deviceId } = extractClientMeta(req);
    const rate = checkOtpRateLimit(phone, deviceId, ip);
    if (!rate.allowed) {
      logger.warn(`[AUTH] OTP precheck blocked phone=${phone} ip=${ip} device=${deviceId}`);
      res.status(429).json({
        success: false,
        message: rate.message,
        code: 'OTP_RATE_LIMITED',
        retryAfterSeconds: rate.retryAfterSeconds,
      });
      return;
    }
    recordOtpRequest(phone, deviceId, ip);

    // This endpoint is now only a precheck/guard.
    // Actual OTP sending is done via Firebase client SDK.
    res.status(200).json({
      success: true,
      message: 'OTP request allowed. Proceed with Firebase phone verification.',
      data: {
        phone,
        otpRequestAllowed: true,
        resendCooldownSeconds: 30,
      },
    });
  })
);

/**
 * @openapi
 * /api/auth/phone:
 *   post:
 *     tags: [Authentication]
 *     summary: Phone authentication (dev/testing)
 *     description: |
 *       Direct phone authentication without Firebase.
 *       For local development and automated testing.
 *       In production, use /verify-otp or /firebase-phone instead.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone]
 *             properties:
 *               phone:
 *                 type: string
 *                 description: Phone number in E.164 format
 *                 example: "+919876543210"
 *     responses:
 *       200:
 *         description: Authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       400:
 *         description: Invalid phone format
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                 code:
 *                   type: string
 *                   example: INVALID_PHONE_FORMAT
 */
router.post(
  '/phone',
  [
    body('phone').isString().notEmpty().withMessage('Phone number is required'),
  ],
  asyncHandler(async (req, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array(),
      });
      return;
    }

    let { phone } = req.body;

    // Normalize phone number format
    phone = phone.replace(/[\s\-()]/g, '');
    if (!phone.startsWith('+')) {
      phone = `+${phone}`;
    }

    logger.info(`[AUTH] Phone authentication request for: ${phone}`);

    try {
      const result = await AuthService.authenticateWithVerifiedPhone(phone);

      res.status(200).json({
        success: true,
        message: result.isNewUser ? 'Account created successfully' : 'Phone authentication successful',
        data: result,
      });
    } catch (error: any) {
      logger.error(`[AUTH] Phone auth failed for ${phone}:`, { error: error.message, stack: error.stack });
      
      if (error.message?.includes('Invalid phone number format')) {
        res.status(400).json({
          success: false,
          message: 'Invalid phone number format. Use E.164 format (e.g., +919876543210)',
          code: 'INVALID_PHONE_FORMAT',
        });
        return;
      }
      
      throw error;
    }
  })
);

// ─── Google Authentication ──────────────────────────────────────────────

/**
 * @openapi
 * /api/auth/google:
 *   post:
 *     tags: [Authentication]
 *     summary: Google sign-in
 *     description: Authenticate using Google ID token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idToken]
 *             properties:
 *               idToken:
 *                 type: string
 *                 description: Google ID token from Google Sign-In
 *     responses:
 *       200:
 *         description: Authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Google authentication successful
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     tokens:
 *                       $ref: '#/components/schemas/AuthTokens'
 *                     isNewUser:
 *                       type: boolean
 *                     requiresPhone:
 *                       type: boolean
 *                       description: True if user needs to add phone number
 *       400:
 *         description: Validation failed
 */
router.post(
  '/google',
  [body('idToken').isString()],
  asyncHandler(async (req, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const result = await AuthService.authenticateWithGoogle(req.body.idToken);
    res.status(200).json({ success: true, message: 'Google authentication successful', data: result });
  })
);

// ─── Truecaller Authentication ──────────────────────────────────────────

/**
 * @openapi
 * /api/auth/truecaller:
 *   post:
 *     tags: [Authentication]
 *     summary: Truecaller sign-in
 *     description: Authenticate using Truecaller profile or phone number
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               phone:
 *                 type: string
 *                 description: Phone number
 *               profile:
 *                 type: object
 *                 properties:
 *                   phoneNumber:
 *                     type: string
 *                   firstName:
 *                     type: string
 *                   lastName:
 *                     type: string
 *               truecallerToken:
 *                 type: string
 *               accessToken:
 *                 type: string
 *           examples:
 *             withPhone:
 *               summary: With phone number
 *               value:
 *                 phone: "+919876543210"
 *                 truecallerToken: "token123"
 *             withProfile:
 *               summary: With profile object
 *               value:
 *                 profile:
 *                   phoneNumber: "+919876543210"
 *                   firstName: "John"
 *                 accessToken: "token123"
 *     responses:
 *       200:
 *         description: Authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       400:
 *         description: Either phone or profile.phoneNumber is required
 */
router.post(
  '/truecaller',
  [
    body('phone').optional().isMobilePhone('any'),
    body('profile').optional().isObject(),
    body('profile.phoneNumber').optional().isString(),
    body('truecallerToken').optional().isString(),
    body('accessToken').optional().isString(),
  ],
  asyncHandler(async (req, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const { phone, profile, truecallerToken, accessToken } = req.body;

    let payload: string | AuthService.TruecallerProfile;
    let token: string | undefined;

    if (profile && profile.phoneNumber) {
      payload = profile;
      token = accessToken;
    } else if (phone) {
      payload = phone;
      token = truecallerToken;
    } else {
      res.status(400).json({
        success: false,
        message: 'Either phone or profile.phoneNumber is required',
      });
      return;
    }

    const result = await AuthService.authenticateWithTruecaller(payload, token);
    res.status(200).json({
      success: true,
      message: result.isNewUser ? 'Account created with Truecaller' : 'Truecaller authentication successful',
      data: result,
    });
  })
);

// ─── Token Management ───────────────────────────────────────────────────

/**
 * @openapi
 * /api/auth/refresh:
 *   post:
 *     tags: [Token Management]
 *     summary: Refresh access token
 *     description: Get a new access token using a valid refresh token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 description: Valid refresh token
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Token refreshed successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     accessToken:
 *                       type: string
 *                     expiresIn:
 *                       type: integer
 *       400:
 *         description: Invalid refresh token
 */
router.post(
  '/refresh',
  [body('refreshToken').isString()],
  asyncHandler(async (req, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const result = await AuthService.refreshAccessToken(req.body.refreshToken);
    res.status(200).json({ success: true, message: 'Token refreshed successfully', data: result });
  })
);

/**
 * @openapi
 * /api/auth/logout:
 *   post:
 *     tags: [Token Management]
 *     summary: Logout user
 *     description: Invalidate the refresh token and logout the user
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 description: Refresh token to invalidate
 *     responses:
 *       200:
 *         description: Logout successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Logout successful
 *       400:
 *         description: Validation failed
 *       403:
 *         description: Token does not belong to user
 */
router.post(
  '/logout',
  authenticate,
  [body('refreshToken').isString()],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    try {
      await AuthService.logout(req.user!.id, req.body.refreshToken);
      res.status(200).json({ success: true, message: 'Logout successful' });
    } catch (error: any) {
      if (error.message.includes('Unauthorized')) {
        res.status(403).json({ success: false, message: 'Cannot logout with a token that does not belong to you' });
        return;
      }
      throw error;
    }
  })
);

// ─── User Profile ───────────────────────────────────────────────────────

/**
 * @openapi
 * /api/auth/me:
 *   get:
 *     tags: [User Profile]
 *     summary: Get current user profile
 *     description: Returns the authenticated user's profile information
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: User not found
 */
router.get(
  '/me',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await AuthService.getUserProfile(req.user!.id);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    res.status(200).json({ success: true, data: { user } });
  })
);

/**
 * @openapi
 * /api/auth/profile:
 *   put:
 *     tags: [User Profile]
 *     summary: Update user profile
 *     description: Update the authenticated user's profile information
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               firstName:
 *                 type: string
 *                 example: John
 *               lastName:
 *                 type: string
 *                 example: Doe
 *               email:
 *                 type: string
 *                 format: email
 *                 example: john@example.com
 *               profileImage:
 *                 type: string
 *                 description: URL to profile image
 *     responses:
 *       200:
 *         description: Profile updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Profile updated successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *       400:
 *         description: Validation failed
 *       409:
 *         description: Email already in use
 */
router.put(
  '/profile',
  authenticate,
  [
    body('firstName').optional().isString(),
    body('lastName').optional().isString(),
    body('email').optional().isEmail(),
    body('profileImage').optional().isString(),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const { firstName, lastName, email, profileImage } = req.body;

    try {
      const user = await AuthService.updateUserProfile(req.user!.id, {
        firstName,
        lastName,
        email,
        profileImage,
      });
      res.status(200).json({ success: true, message: 'Profile updated successfully', data: { user } });
    } catch (error: any) {
      if (error.name === 'DuplicateEmailError') {
        res.status(409).json({
          success: false,
          message: error.message,
          code: 'EMAIL_ALREADY_IN_USE',
        });
        return;
      }
      throw error;
    }
  })
);

// ─── Phone Number Management (for Google signup users) ──────────────────

/**
 * @openapi
 * /api/auth/add-phone:
 *   post:
 *     tags: [User Profile]
 *     summary: Add phone number to account
 *     description: |
 *       For users who signed up with Google and need to add a phone number.
 *       Client verifies the phone via Firebase OTP, then sends the ID token here.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idToken]
 *             properties:
 *               idToken:
 *                 type: string
 *                 description: Firebase ID token from phone verification
 *     responses:
 *       200:
 *         description: Phone number added successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Phone number verified and added successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *       400:
 *         description: Validation failed
 *       409:
 *         description: Phone number already in use
 */
router.post(
  '/add-phone',
  authenticate,
  [
    body('idToken').isString().notEmpty().withMessage('Firebase ID token is required'),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    try {
      const result = await AuthService.addPhoneWithFirebase(req.user!.id, req.body.idToken);
      res.status(200).json({
        success: true,
        message: 'Phone number verified and added successfully',
        data: result,
      });
    } catch (error: any) {
      if (error.name === 'DuplicatePhoneError') {
        res.status(409).json({
          success: false,
          message: error.message,
          code: 'PHONE_ALREADY_IN_USE',
        });
        return;
      }
      throw error;
    }
  })
);

export default router;
