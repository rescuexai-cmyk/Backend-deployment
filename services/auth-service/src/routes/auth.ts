import express, { Response } from 'express';
import { body, validationResult } from 'express-validator';
import { authenticate, AuthRequest } from '@raahi/shared';
import { asyncHandler } from '@raahi/shared';
import * as AuthService from '../authService';
import { createLogger } from '@raahi/shared';

const logger = createLogger('auth-service');
const router = express.Router();

router.post(
  '/send-otp',
  [body('phone').isMobilePhone('any'), body('countryCode').optional().isString()],
  asyncHandler(async (req, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const { phone, countryCode = '+91' } = req.body;
    const result = await AuthService.sendMobileOTP(phone, countryCode);
    res.status(200).json({ success: true, message: result.message });
  })
);

router.post(
  '/verify-otp',
  [
    body('phone').isMobilePhone('any'),
    body('otp').isLength({ min: 4, max: 6 }),
    body('countryCode').optional().isString(),
  ],
  asyncHandler(async (req, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const { phone, otp, countryCode = '+91' } = req.body;
    const result = await AuthService.verifyMobileOTP(phone, otp, countryCode);
    res.status(200).json({ success: true, message: 'Authentication successful', data: result });
  })
);

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

/**
 * Firebase Phone Authentication Endpoint
 * 
 * This is the recommended method for phone number verification.
 * Client handles OTP flow with Firebase SDK, then sends the Firebase ID token here.
 * 
 * Flow:
 * 1. Client initiates phone auth with Firebase SDK (signInWithPhoneNumber)
 * 2. Firebase sends SMS OTP to user
 * 3. User enters OTP, client verifies with Firebase
 * 4. Client gets Firebase ID token (user.getIdToken())
 * 5. Client sends Firebase ID token to this endpoint
 * 6. Backend verifies token, creates/updates user, returns JWT
 * 
 * Request body: { firebaseIdToken: string }
 * 
 * Benefits over Twilio:
 * - Free tier includes phone auth (no per-SMS cost)
 * - Built-in rate limiting and abuse protection
 * - reCAPTCHA integration for bot protection
 * - Global phone number support
 */
router.post(
  '/firebase-phone',
  [body('firebaseIdToken').isString().notEmpty()],
  asyncHandler(async (req, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ 
        success: false, 
        message: 'Validation failed', 
        errors: errors.array() 
      });
      return;
    }
    
    const result = await AuthService.authenticateWithFirebasePhone(req.body.firebaseIdToken);
    
    res.status(200).json({ 
      success: true, 
      message: 'Firebase phone authentication successful', 
      data: result 
    });
  })
);

/**
 * Get Firebase configuration status
 * 
 * Allows client to check if Firebase auth is available before attempting
 * This is useful for conditional UI (show Firebase auth option only if configured)
 */
router.get(
  '/firebase-status',
  asyncHandler(async (_req, res: Response) => {
    const status = AuthService.getFirebaseAuthStatus();
    
    res.status(200).json({ 
      success: true, 
      data: {
        firebaseAuthAvailable: status.available,
        projectId: status.projectId,
      }
    });
  })
);

/**
 * Truecaller Authentication Endpoint
 * 
 * Accepts either:
 * 1. Legacy format: { phone: string, truecallerToken: string }
 * 2. New format: { profile: TruecallerProfile, accessToken?: string }
 * 
 * TruecallerProfile: {
 *   firstName?: string,
 *   lastName?: string,
 *   phoneNumber: string,
 *   countryCode?: string,
 *   email?: string,
 *   avatarUrl?: string
 * }
 */
router.post(
  '/truecaller',
  [
    // Support both legacy (phone) and new (profile) format
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
    
    // Determine payload format
    let payload: string | AuthService.TruecallerProfile;
    let token: string | undefined;
    
    if (profile && profile.phoneNumber) {
      // New format with full profile
      payload = profile;
      token = accessToken;
    } else if (phone) {
      // Legacy format with just phone
      payload = phone;
      token = truecallerToken;
    } else {
      res.status(400).json({ 
        success: false, 
        message: 'Either phone or profile.phoneNumber is required' 
      });
      return;
    }
    
    const result = await AuthService.authenticateWithTruecaller(payload, token);
    res.status(200).json({ 
      success: true, 
      message: result.isNewUser ? 'Account created with Truecaller' : 'Truecaller authentication successful', 
      data: result 
    });
  })
);

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

/**
 * Add phone number for users who signed up with Google
 * This is required for ride booking and other phone-dependent features
 */
router.post(
  '/add-phone',
  authenticate,
  [
    body('phone').isMobilePhone('any').withMessage('Valid phone number is required'),
    body('countryCode').optional().isString().default('+91'),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    const { phone, countryCode = '+91' } = req.body;
    const result = await AuthService.addPhoneNumber(req.user!.id, phone, countryCode);
    
    res.status(200).json({ 
      success: true, 
      message: result.otpSent ? 'OTP sent to verify phone number' : 'Phone number added successfully',
      data: { otpSent: result.otpSent }
    });
  })
);

/**
 * Verify phone number with OTP (for Google signup users)
 */
router.post(
  '/verify-phone',
  authenticate,
  [
    body('phone').isMobilePhone('any').withMessage('Valid phone number is required'),
    body('otp').isLength({ min: 4, max: 6 }).withMessage('Valid OTP is required'),
    body('countryCode').optional().isString().default('+91'),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    const { phone, otp, countryCode = '+91' } = req.body;
    const user = await AuthService.verifyAndAddPhone(req.user!.id, phone, otp, countryCode);
    
    res.status(200).json({ 
      success: true, 
      message: 'Phone number verified and added successfully',
      data: { user }
    });
  })
);

export default router;
