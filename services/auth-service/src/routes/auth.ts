import express, { Response } from 'express';
import { body, validationResult } from 'express-validator';
import { authenticate, AuthRequest } from '@raahi/shared';
import { asyncHandler } from '@raahi/shared';
import * as AuthService from '../authService';
import { createLogger } from '@raahi/shared';

const logger = createLogger('auth-routes');
const router = express.Router();

/**
 * Send OTP via MSG91
 */
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
    res.status(200).json({ success: true, message: result.message, data: { mode: result.mode } });
  })
);

/**
 * Verify OTP via MSG91
 */
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

/**
 * Resend OTP via MSG91
 */
router.post(
  '/resend-otp',
  [
    body('phone').isMobilePhone('any'),
    body('countryCode').optional().isString(),
    body('method').optional().isIn(['text', 'voice']),
  ],
  asyncHandler(async (req, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const { phone, countryCode = '+91', method = 'text' } = req.body;
    const result = await AuthService.resendOTP(phone, countryCode, method);
    res.status(200).json({ success: true, message: result.message });
  })
);

/**
 * Get OTP service status (MSG91)
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
      }
    });
  })
);

/**
 * Phone authentication (after MSG91 OTP verified on client)
 * 
 * This endpoint is called after the client has verified OTP with MSG91 Widget.
 * The phone number is trusted since MSG91 verification was completed on client side.
 * Optionally, pass the widget access token for server-side verification.
 */
router.post(
  '/phone',
  [
    body('phone').isString().notEmpty().withMessage('Phone number is required'),
    body('widgetToken').optional().isString(),
  ],
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
    
    let { phone, widgetToken } = req.body;
    
    // Normalize phone number format
    phone = phone.replace(/[\s\-()]/g, '');
    if (!phone.startsWith('+')) {
      phone = `+${phone}`;
    }
    
    logger.info(`[AUTH] Phone authentication request for: ${phone}`);
    
    const result = await AuthService.authenticateWithVerifiedPhone(phone, widgetToken);
    
    res.status(200).json({ 
      success: true, 
      message: result.isNewUser ? 'Account created successfully' : 'Phone authentication successful', 
      data: result 
    });
  })
);

/**
 * Google Authentication
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

/**
 * Truecaller Authentication
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

/**
 * Refresh Token
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
 * Logout
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

/**
 * Get current user profile
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
 * Update user profile
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

/**
 * Add phone number for users who signed up with Google
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
