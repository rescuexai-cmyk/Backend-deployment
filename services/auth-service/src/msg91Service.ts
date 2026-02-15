/**
 * MSG91 OTP Service
 * 
 * Handles sending and verifying OTPs via MSG91 API
 * Documentation: https://docs.msg91.com/
 */

import { createLogger } from '@raahi/shared';

const logger = createLogger('msg91-service');

const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY || '';
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID || '';
const MSG91_SENDER_ID = process.env.MSG91_SENDER_ID || 'RAAHI';

// MSG91 OTP API endpoints
const MSG91_SEND_OTP_URL = 'https://control.msg91.com/api/v5/otp';
const MSG91_VERIFY_OTP_URL = 'https://control.msg91.com/api/v5/otp/verify';
const MSG91_RESEND_OTP_URL = 'https://control.msg91.com/api/v5/otp/retry';

// Widget verification endpoint (for client-side verification)
const MSG91_WIDGET_VERIFY_URL = 'https://control.msg91.com/api/v5/widget/verifyAccessToken';

export interface MSG91SendOTPResponse {
  success: boolean;
  type: string;
  message: string;
  request_id?: string;
}

export interface MSG91VerifyOTPResponse {
  success: boolean;
  type: string;
  message: string;
}

/**
 * Check if MSG91 is configured
 */
export function isMsg91Configured(): boolean {
  return Boolean(MSG91_AUTH_KEY);
}

/**
 * Get MSG91 configuration status
 */
export function getMsg91Status(): { configured: boolean; authKeySet: boolean; templateIdSet: boolean } {
  return {
    configured: isMsg91Configured(),
    authKeySet: Boolean(MSG91_AUTH_KEY),
    templateIdSet: Boolean(MSG91_TEMPLATE_ID),
  };
}

/**
 * Send OTP via MSG91
 * 
 * @param phone - Phone number with country code (e.g., 919876543210)
 * @param otp - Optional OTP to send (if not provided, MSG91 generates one)
 */
export async function sendOTP(phone: string): Promise<{ success: boolean; message: string; requestId?: string }> {
  if (!isMsg91Configured()) {
    logger.warn('[MSG91] Not configured, using development mode');
    return {
      success: true,
      message: 'Development mode - use OTP 123456',
    };
  }

  // Normalize phone number - remove + and any spaces
  const normalizedPhone = phone.replace(/[\s\-+()]/g, '');
  
  logger.info(`[MSG91] Sending OTP to ${normalizedPhone}`);

  try {
    const response = await fetch(MSG91_SEND_OTP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authkey': MSG91_AUTH_KEY,
      },
      body: JSON.stringify({
        template_id: MSG91_TEMPLATE_ID,
        mobile: normalizedPhone,
        sender: MSG91_SENDER_ID,
        otp_length: 6,
        otp_expiry: 10, // 10 minutes
      }),
    });

    const data = await response.json() as MSG91SendOTPResponse;
    
    if (data.type === 'success' || response.ok) {
      logger.info(`[MSG91] OTP sent successfully to ${normalizedPhone}`, { requestId: data.request_id });
      return {
        success: true,
        message: 'OTP sent successfully',
        requestId: data.request_id,
      };
    } else {
      logger.error(`[MSG91] Failed to send OTP: ${data.message}`, { response: data });
      return {
        success: false,
        message: data.message || 'Failed to send OTP',
      };
    }
  } catch (error: any) {
    logger.error(`[MSG91] Error sending OTP: ${error.message}`);
    return {
      success: false,
      message: error.message || 'Failed to send OTP',
    };
  }
}

/**
 * Verify OTP via MSG91
 * 
 * @param phone - Phone number with country code (e.g., 919876543210)
 * @param otp - OTP to verify
 */
export async function verifyOTP(phone: string, otp: string): Promise<{ success: boolean; message: string }> {
  // Development mode - accept 123456
  if (!isMsg91Configured()) {
    if (otp === '123456') {
      logger.info(`[MSG91] Development mode - OTP verified for ${phone}`);
      return {
        success: true,
        message: 'OTP verified (development mode)',
      };
    }
    return {
      success: false,
      message: 'Invalid OTP',
    };
  }

  // Normalize phone number
  const normalizedPhone = phone.replace(/[\s\-+()]/g, '');
  
  logger.info(`[MSG91] Verifying OTP for ${normalizedPhone}`);

  try {
    const url = `${MSG91_VERIFY_OTP_URL}?mobile=${normalizedPhone}&otp=${otp}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'authkey': MSG91_AUTH_KEY,
      },
    });

    const data = await response.json() as MSG91VerifyOTPResponse;
    
    if (data.type === 'success' || data.message === 'OTP verified success') {
      logger.info(`[MSG91] OTP verified successfully for ${normalizedPhone}`);
      return {
        success: true,
        message: 'OTP verified successfully',
      };
    } else {
      logger.warn(`[MSG91] OTP verification failed: ${data.message}`);
      return {
        success: false,
        message: data.message || 'Invalid OTP',
      };
    }
  } catch (error: any) {
    logger.error(`[MSG91] Error verifying OTP: ${error.message}`);
    return {
      success: false,
      message: error.message || 'Failed to verify OTP',
    };
  }
}

/**
 * Resend OTP via MSG91
 * 
 * @param phone - Phone number with country code
 * @param retryType - 'text' for SMS, 'voice' for call
 */
export async function resendOTP(phone: string, retryType: 'text' | 'voice' = 'text'): Promise<{ success: boolean; message: string }> {
  if (!isMsg91Configured()) {
    return {
      success: true,
      message: 'Development mode - use OTP 123456',
    };
  }

  const normalizedPhone = phone.replace(/[\s\-+()]/g, '');
  
  logger.info(`[MSG91] Resending OTP to ${normalizedPhone} via ${retryType}`);

  try {
    const url = `${MSG91_RESEND_OTP_URL}?mobile=${normalizedPhone}&retrytype=${retryType}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'authkey': MSG91_AUTH_KEY,
      },
    });

    const data = await response.json();
    
    if (data.type === 'success' || response.ok) {
      logger.info(`[MSG91] OTP resent successfully to ${normalizedPhone}`);
      return {
        success: true,
        message: `OTP resent via ${retryType}`,
      };
    } else {
      logger.error(`[MSG91] Failed to resend OTP: ${data.message}`);
      return {
        success: false,
        message: data.message || 'Failed to resend OTP',
      };
    }
  } catch (error: any) {
    logger.error(`[MSG91] Error resending OTP: ${error.message}`);
    return {
      success: false,
      message: error.message || 'Failed to resend OTP',
    };
  }
}

/**
 * Verify MSG91 Widget Access Token (for client-side widget verification)
 * 
 * When using MSG91's OTP Widget on frontend, the widget returns a JWT token
 * after successful OTP verification. This function verifies that token server-side.
 * 
 * @param accessToken - JWT token from MSG91 OTP Widget
 */
export async function verifyWidgetToken(accessToken: string): Promise<{ 
  success: boolean; 
  message: string;
  phone?: string;
  data?: any;
}> {
  if (!isMsg91Configured()) {
    logger.warn('[MSG91] Not configured for widget verification');
    return {
      success: false,
      message: 'MSG91 not configured',
    };
  }

  logger.info('[MSG91] Verifying widget access token');

  try {
    const response = await fetch(MSG91_WIDGET_VERIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        authkey: MSG91_AUTH_KEY,
        'access-token': accessToken,
      }),
    });

    const data = await response.json();
    
    if (data.type === 'success' || response.ok) {
      logger.info('[MSG91] Widget token verified successfully', { 
        phone: data.mobile || data.phone_number 
      });
      return {
        success: true,
        message: 'Token verified successfully',
        phone: data.mobile || data.phone_number,
        data,
      };
    } else {
      logger.warn(`[MSG91] Widget token verification failed: ${data.message}`);
      return {
        success: false,
        message: data.message || 'Token verification failed',
      };
    }
  } catch (error: any) {
    logger.error(`[MSG91] Error verifying widget token: ${error.message}`);
    return {
      success: false,
      message: error.message || 'Failed to verify token',
    };
  }
}
