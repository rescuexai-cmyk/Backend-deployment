/**
 * SMS/OTP Service
 * 
 * This service handles OTP sending via Twilio for legacy/fallback authentication.
 * 
 * RECOMMENDATION: Use Firebase Phone Authentication instead!
 * - No per-SMS cost (included in Firebase Auth free tier)
 * - Built-in rate limiting and abuse protection
 * - reCAPTCHA integration
 * - Better security (OTP never passes through your server)
 * 
 * See authService.ts authenticateWithFirebasePhone() for Firebase integration.
 * 
 * This Twilio-based service is kept for:
 * - Backward compatibility
 * - Fallback if Firebase is not configured
 * - Development/testing without Firebase setup
 */

import { createLogger } from '@raahi/shared';

const logger = createLogger('sms-service');

export interface OTPResult {
  success: boolean;
  otp?: string;
  message?: string;
  sid?: string; // Twilio message/verification SID
}

export interface VerifyResult {
  success: boolean;
  valid: boolean;
  message?: string;
}

// Check if Twilio is properly configured
function isTwilioConfigured(): boolean {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    (process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_VERIFY_SERVICE_SID)
  );
}

// Get Twilio client (lazy initialization)
function getTwilioClient() {
  if (!isTwilioConfigured()) {
    return null;
  }
  
  try {
    const twilio = require('twilio');
    return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  } catch (error) {
    logger.error('Failed to initialize Twilio client', { error });
    return null;
  }
}

/**
 * Send OTP using Twilio Verify API (recommended for production)
 * This is more secure as Twilio handles OTP generation and verification
 */
async function sendOTPWithVerify(phoneNumber: string): Promise<OTPResult> {
  const client = getTwilioClient();
  if (!client) {
    throw new Error('Twilio client not configured');
  }
  
  const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!verifyServiceSid) {
    throw new Error('TWILIO_VERIFY_SERVICE_SID not configured');
  }
  
  try {
    const verification = await client.verify.v2
      .services(verifyServiceSid)
      .verifications.create({
        to: phoneNumber,
        channel: 'sms',
      });
    
    logger.info(`[TWILIO] Verification sent to ${phoneNumber}`, { 
      sid: verification.sid,
      status: verification.status,
      channel: verification.channel,
    });
    
    return {
      success: true,
      sid: verification.sid,
      message: 'OTP sent via Twilio Verify',
    };
  } catch (error: any) {
    logger.error(`[TWILIO] Verify API failed for ${phoneNumber}`, { 
      error: error.message,
      code: error.code,
    });
    throw error;
  }
}

/**
 * Verify OTP using Twilio Verify API
 */
async function verifyOTPWithVerify(phoneNumber: string, otp: string): Promise<VerifyResult> {
  const client = getTwilioClient();
  if (!client) {
    throw new Error('Twilio client not configured');
  }
  
  const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!verifyServiceSid) {
    throw new Error('TWILIO_VERIFY_SERVICE_SID not configured');
  }
  
  try {
    const verificationCheck = await client.verify.v2
      .services(verifyServiceSid)
      .verificationChecks.create({
        to: phoneNumber,
        code: otp,
      });
    
    logger.info(`[TWILIO] Verification check for ${phoneNumber}`, {
      status: verificationCheck.status,
      valid: verificationCheck.valid,
    });
    
    return {
      success: true,
      valid: verificationCheck.status === 'approved',
      message: verificationCheck.status === 'approved' ? 'OTP verified' : 'Invalid OTP',
    };
  } catch (error: any) {
    logger.error(`[TWILIO] Verification check failed for ${phoneNumber}`, {
      error: error.message,
      code: error.code,
    });
    
    // Handle specific Twilio errors
    if (error.code === 20404) {
      return { success: true, valid: false, message: 'OTP expired or not found' };
    }
    
    throw error;
  }
}

/**
 * Send OTP using Twilio SMS API (fallback method)
 * This sends the OTP directly via SMS - we generate and store the OTP ourselves
 */
async function sendOTPWithSMS(phoneNumber: string): Promise<OTPResult> {
  const client = getTwilioClient();
  if (!client) {
    throw new Error('Twilio client not configured');
  }
  
  const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!twilioPhoneNumber) {
    throw new Error('TWILIO_PHONE_NUMBER not configured');
  }
  
  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  
  try {
    const message = await client.messages.create({
      body: `Your Raahi verification code is: ${otp}. Valid for 10 minutes. Do not share this code.`,
      from: twilioPhoneNumber,
      to: phoneNumber,
    });
    
    logger.info(`[TWILIO] SMS sent to ${phoneNumber}`, {
      sid: message.sid,
      status: message.status,
    });
    
    return {
      success: true,
      otp, // Return OTP so it can be stored for verification
      sid: message.sid,
      message: 'OTP sent via SMS',
    };
  } catch (error: any) {
    logger.error(`[TWILIO] SMS send failed for ${phoneNumber}`, {
      error: error.message,
      code: error.code,
    });
    throw error;
  }
}

/**
 * Main function to send OTP
 * - If Twilio is configured: Always sends real SMS (even in development)
 * - If Twilio not configured: Logs OTP to console (dev fallback)
 * - In test mode: Never sends real SMS
 */
export async function sendOTP(phoneNumber: string): Promise<OTPResult> {
  logger.info(`[OTP] Sending OTP to ${phoneNumber}`);
  
  // Test mode - never send real SMS
  if (process.env.NODE_ENV === 'test') {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    logger.info(`[OTP] TEST MODE - OTP for ${phoneNumber}: ${otp}`);
    return { 
      success: true, 
      otp, 
      message: 'OTP generated (test mode)' 
    };
  }
  
  // Check if Twilio is configured - if yes, send real SMS even in development
  if (isTwilioConfigured()) {
    try {
      // Prefer Verify API if configured (more secure)
      if (process.env.TWILIO_VERIFY_SERVICE_SID) {
        logger.info(`[OTP] Using Twilio Verify API for ${phoneNumber}`);
        return await sendOTPWithVerify(phoneNumber);
      }
      
      // Fallback to direct SMS
      logger.info(`[OTP] Using Twilio SMS API for ${phoneNumber}`);
      return await sendOTPWithSMS(phoneNumber);
    } catch (error: any) {
      logger.error(`[OTP] Failed to send OTP to ${phoneNumber}`, { error: error.message });
      
      // If in development, fall back to console logging
      if (process.env.NODE_ENV === 'development') {
        logger.warn(`[OTP] Twilio failed, falling back to dev mode`);
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        logger.info(`[OTP] FALLBACK - OTP for ${phoneNumber}: ${otp}`);
        logger.info(`[OTP] You can also use fixed OTP: 123456`);
        return { 
          success: true, 
          otp, 
          message: 'OTP generated (Twilio failed, dev fallback)' 
        };
      }
      
      // In production, fail if SMS can't be sent
      throw new Error(`Failed to send OTP: ${error.message}`);
    }
  }
  
  // Twilio not configured - dev fallback
  logger.warn(`[OTP] Twilio not configured - using dev mode`);
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  logger.info(`[OTP] DEV MODE - OTP for ${phoneNumber}: ${otp}`);
  logger.info(`[OTP] You can also use fixed OTP: 123456`);
  return { 
    success: true, 
    otp, 
    message: 'OTP generated (Twilio not configured)' 
  };
}

/**
 * Verify OTP
 * - If Twilio Verify is configured: Uses Twilio Verify check
 * - Otherwise: Returns false to indicate caller should check stored OTP
 * - In test mode: Accepts fixed OTP (123456)
 */
export async function verifyOTPViaTwilio(phoneNumber: string, otp: string): Promise<VerifyResult> {
  logger.info(`[OTP] Verifying OTP for ${phoneNumber}`);
  
  // Test mode - accept fixed OTP
  if (process.env.NODE_ENV === 'test') {
    const DEV_OTP = '123456';
    if (otp === DEV_OTP) {
      logger.info(`[OTP] TEST MODE - Fixed OTP accepted for ${phoneNumber}`);
      return { success: true, valid: true, message: 'Test OTP accepted' };
    }
    return { success: true, valid: false, message: 'Check stored OTP' };
  }
  
  // If using Twilio Verify API, verify through Twilio
  if (process.env.TWILIO_VERIFY_SERVICE_SID && isTwilioConfigured()) {
    try {
      return await verifyOTPWithVerify(phoneNumber, otp);
    } catch (error: any) {
      logger.error(`[OTP] Twilio Verify check failed for ${phoneNumber}`, { error: error.message });
      // Fall through to stored OTP check
      return { success: true, valid: false, message: 'Check stored OTP' };
    }
  }
  
  // For SMS-based OTP, verification is handled by comparing stored OTP
  // Return false to indicate caller should check stored OTP
  return { success: true, valid: false, message: 'Check stored OTP' };
}

/**
 * Legacy function for backward compatibility
 */
export function verifyOTP(_phone: string, _otp: string): boolean {
  // This is now handled by verifyOTPViaTwilio or stored OTP comparison
  return true;
}
