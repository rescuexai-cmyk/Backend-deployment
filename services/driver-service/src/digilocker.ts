/**
 * DigiLocker Integration Service
 * 
 * Implements OAuth2 + PKCE flow for DigiLocker document verification.
 * 
 * Flow:
 * 1. Generate authorization URL with PKCE code challenge
 * 2. User authenticates on DigiLocker and authorizes
 * 3. Exchange authorization code for access token
 * 4. Fetch user details and documents (Aadhaar, PAN, DL, etc.)
 * 5. Verify documents and store verification status
 * 
 * API Documentation:
 * - https://sandbox.api-setu.in/digilocker-steps
 * - https://partners.digitallocker.gov.in/
 */

import crypto from 'crypto';
import { createLogger } from '@raahi/shared';

const logger = createLogger('digilocker-service');

// Encryption key for sensitive data (32 bytes for AES-256)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex').slice(0, 32);
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

// DigiLocker API Configuration
const DIGILOCKER_CONFIG = {
  // Production URLs
  authUrl: process.env.DIGILOCKER_AUTH_URL || 'https://api.digitallocker.gov.in/public/oauth2/1/authorize',
  tokenUrl: process.env.DIGILOCKER_TOKEN_URL || 'https://api.digitallocker.gov.in/public/oauth2/1/token',
  apiBaseUrl: process.env.DIGILOCKER_API_URL || 'https://api.digitallocker.gov.in/public/oauth2/3',
  revokeUrl: process.env.DIGILOCKER_REVOKE_URL || 'https://api.digitallocker.gov.in/public/oauth2/1/revoke',
  
  // Sandbox URLs (for development/testing)
  sandboxAuthUrl: 'https://digilocker.meripehchaan.gov.in/public/oauth2/1/authorize',
  sandboxTokenUrl: 'https://digilocker.meripehchaan.gov.in/public/oauth2/1/token',
  sandboxApiUrl: 'https://digilocker.meripehchaan.gov.in/public/oauth2/3',
  
  // Client credentials (from DigiLocker partner portal)
  clientId: process.env.DIGILOCKER_CLIENT_ID || '',
  clientSecret: process.env.DIGILOCKER_CLIENT_SECRET || '',
  // FIXED: Default redirect URI now points to driver service port (5003), not gateway (3000)
  redirectUri: process.env.DIGILOCKER_REDIRECT_URI || 'http://localhost:5003/api/driver/digilocker/callback',
  
  // Scopes for document access
  scopes: [
    'openid',
    'profile',
    'address',
    'aadhaar',
    'dl',        // Driving License
    'voterid',   // Voter ID
    'pan',       // PAN Card
    'rc',        // Vehicle RC
  ],
};

// In-memory store for PKCE verifiers (should use Redis in production)
const pkceStore = new Map<string, { verifier: string; driverId: string; expiresAt: Date }>();

// Rate limiting stores
const otpRateLimitStore = new Map<string, { count: number; windowStart: Date }>();
const digilockerRateLimitStore = new Map<string, { count: number; windowStart: Date }>();

// Clean up expired PKCE entries every 5 minutes
setInterval(() => {
  const now = new Date();
  for (const [key, value] of pkceStore.entries()) {
    if (value.expiresAt < now) {
      pkceStore.delete(key);
    }
  }
  // Clean up old rate limit entries (older than 1 hour)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  for (const [key, value] of otpRateLimitStore.entries()) {
    if (value.windowStart < oneHourAgo) {
      otpRateLimitStore.delete(key);
    }
  }
  for (const [key, value] of digilockerRateLimitStore.entries()) {
    if (value.windowStart < oneHourAgo) {
      digilockerRateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Encrypt sensitive data using AES-256-GCM
 */
export function encryptSensitiveData(plaintext: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'utf8'), iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  // Format: iv:authTag:encryptedData (all hex encoded)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt sensitive data
 */
export function decryptSensitiveData(encryptedData: string): string {
  try {
    const [ivHex, authTagHex, encrypted] = encryptedData.split(':');
    
    if (!ivHex || !authTagHex || !encrypted) {
      // Data might be stored unencrypted (legacy), return as-is
      return encryptedData;
    }
    
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'utf8'), iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    // If decryption fails, data might be unencrypted (legacy)
    logger.warn('[DIGILOCKER] Decryption failed, data may be unencrypted');
    return encryptedData;
  }
}

/**
 * Check rate limit for OTP requests
 * Allows 3 OTP requests per hour per driver
 */
export function checkOtpRateLimit(driverId: string): { allowed: boolean; retryAfterSeconds?: number } {
  const limit = 3;
  const windowMs = 60 * 60 * 1000; // 1 hour
  
  const now = new Date();
  const entry = otpRateLimitStore.get(driverId);
  
  if (!entry || (now.getTime() - entry.windowStart.getTime() > windowMs)) {
    // New window or expired window
    otpRateLimitStore.set(driverId, { count: 1, windowStart: now });
    return { allowed: true };
  }
  
  if (entry.count >= limit) {
    const retryAfterSeconds = Math.ceil((entry.windowStart.getTime() + windowMs - now.getTime()) / 1000);
    return { allowed: false, retryAfterSeconds };
  }
  
  entry.count++;
  return { allowed: true };
}

/**
 * Check rate limit for DigiLocker initiation
 * Allows 5 DigiLocker initiations per day per driver
 */
export function checkDigiLockerRateLimit(driverId: string): { allowed: boolean; retryAfterSeconds?: number } {
  const limit = 5;
  const windowMs = 24 * 60 * 60 * 1000; // 24 hours
  
  const now = new Date();
  const entry = digilockerRateLimitStore.get(driverId);
  
  if (!entry || (now.getTime() - entry.windowStart.getTime() > windowMs)) {
    // New window or expired window
    digilockerRateLimitStore.set(driverId, { count: 1, windowStart: now });
    return { allowed: true };
  }
  
  if (entry.count >= limit) {
    const retryAfterSeconds = Math.ceil((entry.windowStart.getTime() + windowMs - now.getTime()) / 1000);
    return { allowed: false, retryAfterSeconds };
  }
  
  entry.count++;
  return { allowed: true };
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE(): { verifier: string; challenge: string } {
  // Generate random 43-128 character verifier
  const verifier = crypto.randomBytes(32).toString('base64url');
  
  // Create SHA256 hash and base64url encode
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
  
  return { verifier, challenge };
}

/**
 * Generate state parameter for CSRF protection
 */
function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}

export interface DigiLockerAuthUrl {
  url: string;
  state: string;
}

/**
 * Generate DigiLocker authorization URL
 * 
 * @param driverId - Driver ID to associate with this auth session
 * @returns Authorization URL and state for CSRF validation
 */
export function generateAuthorizationUrl(driverId: string): DigiLockerAuthUrl {
  // FIXED: Validate both client ID and secret
  if (!DIGILOCKER_CONFIG.clientId || !DIGILOCKER_CONFIG.clientSecret) {
    throw new Error('DigiLocker credentials not configured. Please set DIGILOCKER_CLIENT_ID and DIGILOCKER_CLIENT_SECRET environment variables.');
  }
  
  // Check rate limit
  const rateLimit = checkDigiLockerRateLimit(driverId);
  if (!rateLimit.allowed) {
    throw new Error(`Too many DigiLocker requests. Please try again in ${Math.ceil(rateLimit.retryAfterSeconds! / 3600)} hour(s).`);
  }
  
  const { verifier, challenge } = generatePKCE();
  const state = generateState();
  
  // Store PKCE verifier for later use (expires in 10 minutes)
  pkceStore.set(state, {
    verifier,
    driverId,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  
  const useSandbox = process.env.NODE_ENV === 'development' || process.env.DIGILOCKER_USE_SANDBOX === 'true';
  const authUrl = useSandbox ? DIGILOCKER_CONFIG.sandboxAuthUrl : DIGILOCKER_CONFIG.authUrl;
  
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: DIGILOCKER_CONFIG.clientId,
    redirect_uri: DIGILOCKER_CONFIG.redirectUri,
    scope: DIGILOCKER_CONFIG.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  
  const url = `${authUrl}?${params.toString()}`;
  
  logger.info(`[DIGILOCKER] Generated auth URL for driver ${driverId}`);
  
  return { url, state };
}

export interface DigiLockerTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn: number;
  scope: string;
}

/**
 * Exchange authorization code for access token
 * 
 * @param code - Authorization code from callback
 * @param state - State parameter for CSRF validation
 * @returns Access token and driver ID
 */
export async function exchangeCodeForToken(
  code: string,
  state: string
): Promise<{ tokens: DigiLockerTokens; driverId: string }> {
  const pkceData = pkceStore.get(state);
  
  if (!pkceData) {
    throw new Error('Invalid or expired state parameter');
  }
  
  if (pkceData.expiresAt < new Date()) {
    pkceStore.delete(state);
    throw new Error('Authorization session expired');
  }
  
  const useSandbox = process.env.NODE_ENV === 'development' || process.env.DIGILOCKER_USE_SANDBOX === 'true';
  const tokenUrl = useSandbox ? DIGILOCKER_CONFIG.sandboxTokenUrl : DIGILOCKER_CONFIG.tokenUrl;
  
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: DIGILOCKER_CONFIG.clientId,
    client_secret: DIGILOCKER_CONFIG.clientSecret,
    redirect_uri: DIGILOCKER_CONFIG.redirectUri,
    code_verifier: pkceData.verifier,
  });
  
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[DIGILOCKER] Token exchange failed: ${response.status} - ${errorText}`);
      
      // Try to parse error details from DigiLocker
      let errorMessage = `Token exchange failed: ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error_description) {
          errorMessage = errorJson.error_description;
        } else if (errorJson.error) {
          errorMessage = errorJson.error;
        } else if (errorJson.message) {
          errorMessage = errorJson.message;
        }
      } catch {
        // Not JSON, use status code message
      }
      
      throw new Error(errorMessage);
    }
    
    const data = await response.json();
    
    // Clean up PKCE data
    pkceStore.delete(state);
    
    logger.info(`[DIGILOCKER] Token exchange successful for driver ${pkceData.driverId}`);
    
    return {
      tokens: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        tokenType: data.token_type,
        expiresIn: data.expires_in,
        scope: data.scope,
      },
      driverId: pkceData.driverId,
    };
  } catch (error: any) {
    logger.error(`[DIGILOCKER] Token exchange error: ${error.message}`);
    throw error;
  }
}

export interface DigiLockerUserDetails {
  digilockerName: string;
  dateOfBirth?: string;
  gender?: string;
  mobile?: string;
  aadhaarNumber?: string; // Masked: XXXX-XXXX-1234
  address?: {
    house?: string;
    street?: string;
    landmark?: string;
    locality?: string;
    district?: string;
    state?: string;
    pincode?: string;
    country?: string;
  };
}

/**
 * Get user details from DigiLocker
 */
export async function getUserDetails(accessToken: string): Promise<DigiLockerUserDetails> {
  const useSandbox = process.env.NODE_ENV === 'development' || process.env.DIGILOCKER_USE_SANDBOX === 'true';
  const apiUrl = useSandbox ? DIGILOCKER_CONFIG.sandboxApiUrl : DIGILOCKER_CONFIG.apiBaseUrl;
  
  try {
    const response = await fetch(`${apiUrl}/user`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch user details: ${response.status}`);
    }
    
    const data = await response.json();
    
    return {
      digilockerName: data.name || data.full_name,
      dateOfBirth: data.dob,
      gender: data.gender,
      mobile: data.mobile,
      aadhaarNumber: data.aadhaar, // Already masked by DigiLocker
      address: data.address,
    };
  } catch (error: any) {
    logger.error(`[DIGILOCKER] Get user details error: ${error.message}`);
    throw error;
  }
}

export interface DigiLockerDocument {
  uri: string;
  name: string;
  type: string;
  size?: number;
  issueDate?: string;
  issuer?: string;
  description?: string;
}

/**
 * Get list of issued documents from DigiLocker
 */
export async function getIssuedDocuments(accessToken: string): Promise<DigiLockerDocument[]> {
  const useSandbox = process.env.NODE_ENV === 'development' || process.env.DIGILOCKER_USE_SANDBOX === 'true';
  const apiUrl = useSandbox ? DIGILOCKER_CONFIG.sandboxApiUrl : DIGILOCKER_CONFIG.apiBaseUrl;
  
  try {
    const response = await fetch(`${apiUrl}/files/issued`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch issued documents: ${response.status}`);
    }
    
    const data = await response.json();
    
    return (data.items || []).map((doc: any) => ({
      uri: doc.uri,
      name: doc.name,
      type: doc.doctype || doc.type,
      size: doc.size,
      issueDate: doc.date,
      issuer: doc.issuer,
      description: doc.description,
    }));
  } catch (error: any) {
    logger.error(`[DIGILOCKER] Get issued documents error: ${error.message}`);
    throw error;
  }
}

/**
 * Download a specific document from DigiLocker
 * 
 * @param accessToken - Access token
 * @param documentUri - Document URI from issued documents list
 * @returns Document content as base64 or JSON
 */
export async function downloadDocument(
  accessToken: string,
  documentUri: string
): Promise<{ content: string; contentType: string }> {
  const useSandbox = process.env.NODE_ENV === 'development' || process.env.DIGILOCKER_USE_SANDBOX === 'true';
  const apiUrl = useSandbox ? DIGILOCKER_CONFIG.sandboxApiUrl : DIGILOCKER_CONFIG.apiBaseUrl;
  
  try {
    const response = await fetch(`${apiUrl}/file/${encodeURIComponent(documentUri)}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to download document: ${response.status}`);
    }
    
    const contentType = response.headers.get('content-type') || 'application/pdf';
    
    if (contentType.includes('application/json')) {
      const json = await response.json();
      return { content: JSON.stringify(json), contentType };
    } else {
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      return { content: base64, contentType };
    }
  } catch (error: any) {
    logger.error(`[DIGILOCKER] Download document error: ${error.message}`);
    throw error;
  }
}

/**
 * Get e-Aadhaar from DigiLocker
 */
export async function getEAadhaar(accessToken: string): Promise<{
  aadhaarNumber: string; // Last 4 digits visible
  name: string;
  dateOfBirth: string;
  gender: string;
  address: any;
  photo?: string; // Base64 encoded photo
}> {
  const useSandbox = process.env.NODE_ENV === 'development' || process.env.DIGILOCKER_USE_SANDBOX === 'true';
  const apiUrl = useSandbox ? DIGILOCKER_CONFIG.sandboxApiUrl : DIGILOCKER_CONFIG.apiBaseUrl;
  
  try {
    const response = await fetch(`${apiUrl}/aadhaar`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch e-Aadhaar: ${response.status}`);
    }
    
    const data = await response.json();
    
    return {
      aadhaarNumber: data.maskedAadhaar || data.uid,
      name: data.name,
      dateOfBirth: data.dob,
      gender: data.gender,
      address: data.address,
      photo: data.photo,
    };
  } catch (error: any) {
    logger.error(`[DIGILOCKER] Get e-Aadhaar error: ${error.message}`);
    throw error;
  }
}

/**
 * Revoke DigiLocker access token
 */
export async function revokeToken(accessToken: string): Promise<void> {
  const useSandbox = process.env.NODE_ENV === 'development' || process.env.DIGILOCKER_USE_SANDBOX === 'true';
  const revokeUrl = useSandbox 
    ? 'https://digilocker.meripehchaan.gov.in/public/oauth2/1/revoke'
    : DIGILOCKER_CONFIG.revokeUrl;
  
  try {
    const response = await fetch(revokeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        token: accessToken,
        client_id: DIGILOCKER_CONFIG.clientId,
        client_secret: DIGILOCKER_CONFIG.clientSecret,
      }).toString(),
    });
    
    if (!response.ok) {
      logger.warn(`[DIGILOCKER] Token revocation returned ${response.status}`);
    } else {
      logger.info('[DIGILOCKER] Token revoked successfully');
    }
  } catch (error: any) {
    logger.error(`[DIGILOCKER] Token revocation error: ${error.message}`);
    // Don't throw - revocation failure shouldn't break the flow
  }
}

/**
 * Verify Aadhaar via DigiLocker and extract details
 * This is the main function to call for Aadhaar verification
 */
export async function verifyAadhaarViaDigiLocker(accessToken: string): Promise<{
  verified: boolean;
  aadhaarLastFour: string;
  name: string;
  dateOfBirth?: string;
  gender?: string;
  address?: any;
}> {
  try {
    const aadhaarData = await getEAadhaar(accessToken);
    
    // Extract last 4 digits from masked Aadhaar
    const aadhaarLastFour = aadhaarData.aadhaarNumber.slice(-4);
    
    return {
      verified: true,
      aadhaarLastFour,
      name: aadhaarData.name,
      dateOfBirth: aadhaarData.dateOfBirth,
      gender: aadhaarData.gender,
      address: aadhaarData.address,
    };
  } catch (error: any) {
    logger.error(`[DIGILOCKER] Aadhaar verification failed: ${error.message}`);
    return {
      verified: false,
      aadhaarLastFour: '',
      name: '',
    };
  }
}

/**
 * Check if DigiLocker is properly configured
 */
export function isDigiLockerConfigured(): boolean {
  return !!(DIGILOCKER_CONFIG.clientId && DIGILOCKER_CONFIG.clientSecret);
}

/**
 * Get DigiLocker configuration status
 */
export function getConfigStatus(): {
  configured: boolean;
  sandboxMode: boolean;
  redirectUri: string;
} {
  return {
    configured: isDigiLockerConfigured(),
    sandboxMode: process.env.NODE_ENV === 'development' || process.env.DIGILOCKER_USE_SANDBOX === 'true',
    redirectUri: DIGILOCKER_CONFIG.redirectUri,
  };
}
