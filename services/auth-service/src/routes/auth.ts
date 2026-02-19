import express, { Response } from 'express';
import { body, validationResult } from 'express-validator';
import { authenticate, AuthRequest } from '@raahi/shared';
import { asyncHandler } from '@raahi/shared';
import * as AuthService from '../authService';
import { createLogger } from '@raahi/shared';

const logger = createLogger('auth-routes');
const router = express.Router();

// ─── Firebase Phone OTP Authentication ──────────────────────────────────

/**
 * Verify Firebase Phone OTP
 * 
 * Primary authentication endpoint for phone-based login.
 * 
 * Supports two modes:
 * 
 * MODE 1 - Firebase Token (production):
 *   Body: { "idToken": "firebase-id-token" }
 *   Client verifies OTP via Firebase Auth SDK, then sends the ID token here.
 * 
 * MODE 2 - Dev/Testing mode (when Firebase bypassed):
 *   Body: { "phone": "+91XXXXXXXXXX", "otp": "123456" }
 *   Accepts static OTP "123456" for any phone number in dev/test mode.
 *   In production, only works if ALLOW_DEV_OTP=true is set.
 */
router.post(
  '/verify-otp',
  [
    body('idToken').optional().isString(),
    body('phone').optional().isString(),
    body('otp').optional().isString(),
  ],
  asyncHandler(async (req, res: Response) => {
    const { idToken, phone, otp } = req.body;

    // MODE 2: Dev/Testing - direct phone + OTP verification
    if (phone && otp) {
      const isDevMode = process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEV_OTP === 'true';
      
      if (!isDevMode) {
        res.status(403).json({
          success: false,
          message: 'Dev OTP mode is disabled in production. Use Firebase authentication.',
          code: 'DEV_OTP_DISABLED',
        });
        return;
      }

      // Accept static OTP "123456" for dev/testing
      if (otp !== '123456') {
        res.status(401).json({
          success: false,
          message: 'Invalid OTP',
          code: 'INVALID_OTP',
        });
        return;
      }

      logger.info(`[AUTH] Dev mode OTP verification for phone: ${phone}`);
      const result = await AuthService.authenticateWithVerifiedPhone(phone);

      res.status(200).json({
        success: true,
        message: result.isNewUser ? 'Account created successfully' : 'Authentication successful',
        data: result,
      });
      return;
    }

    // MODE 1: Firebase Token verification (production flow)
    if (!idToken) {
      res.status(400).json({
        success: false,
        message: 'Either idToken (Firebase) or phone+otp (dev mode) is required',
        errors: [
          { msg: 'Provide idToken for Firebase auth, or phone+otp for dev mode' }
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
 * Firebase phone auth (alias for verify-otp for clarity)
 */
router.post(
  '/firebase-phone',
  [
    body('idToken').isString().notEmpty().withMessage('Firebase ID token is required'),
  ],
  asyncHandler(async (req, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const { idToken } = req.body;
    const result = await AuthService.authenticateWithFirebasePhone(idToken);

    res.status(200).json({
      success: true,
      message: result.isNewUser ? 'Account created successfully' : 'Authentication successful',
      data: result,
    });
  })
);

/**
 * Get OTP service status
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
 * Send OTP (dev/testing endpoint)
 * 
 * In dev mode, this just returns success (OTP is always "123456").
 * Client should then call /verify-otp with { phone, otp: "123456" }
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

    let { phone } = req.body;

    // Normalize phone number format
    phone = phone.replace(/[\s\-()]/g, '');
    if (!phone.startsWith('+')) {
      phone = `+${phone}`;
    }

    const isDevMode = process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEV_OTP === 'true';

    if (!isDevMode) {
      res.status(403).json({
        success: false,
        message: 'Dev OTP mode is disabled in production. Use Firebase authentication on the client.',
        code: 'DEV_OTP_DISABLED',
      });
      return;
    }

    logger.info(`[AUTH] Dev mode: send-otp requested for ${phone} (OTP: 123456)`);

    res.status(200).json({
      success: true,
      message: 'OTP sent successfully',
      data: {
        phone,
        otpSent: true,
        expiresIn: 300, // 5 minutes
        // In dev mode, include the OTP in response for convenience
        ...(process.env.NODE_ENV !== 'production' && { devOtp: '123456' }),
      },
    });
  })
);

/**
 * Phone authentication (dev/testing fallback)
 * 
 * Allows direct phone authentication without Firebase.
 * Kept for local development and automated testing.
 * In production, clients should use /verify-otp or /firebase-phone.
 * 
 * This endpoint creates/logs in a user directly by phone number.
 * Use this when you've verified the OTP on the client side (e.g., with "123456").
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
 * Add phone number using Firebase verification
 * 
 * For users who signed up with Google and need to add a phone number.
 * Client verifies the phone via Firebase OTP, then sends the ID token here.
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
