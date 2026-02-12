/**
 * Firebase Authentication Service
 * 
 * Handles phone number authentication using Firebase Auth.
 * Firebase provides:
 * - Phone number verification via SMS OTP
 * - reCAPTCHA protection
 * - Global phone number support
 * - No per-SMS cost for verification (included in Firebase Auth)
 * 
 * Flow:
 * 1. Client initiates phone auth with Firebase SDK → gets verificationId
 * 2. User receives OTP via SMS (Firebase handles this)
 * 3. Client verifies OTP with Firebase SDK → gets Firebase ID token
 * 4. Client sends Firebase ID token to backend
 * 5. Backend verifies Firebase ID token → creates/updates user → returns JWT
 */

import * as admin from 'firebase-admin';
import { createLogger } from '@raahi/shared';

const logger = createLogger('firebase-service');

// Firebase app instance
let firebaseApp: admin.app.App | null = null;

/**
 * Check if Firebase is configured
 */
export function isFirebaseConfigured(): boolean {
  // Firebase can be configured via:
  // 1. Service account JSON file (FIREBASE_SERVICE_ACCOUNT_PATH)
  // 2. Service account JSON string (FIREBASE_SERVICE_ACCOUNT_JSON)
  // 3. Individual credentials (FIREBASE_PROJECT_ID, etc.)
  return !!(
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL)
  );
}

/**
 * Initialize Firebase Admin SDK
 * Should be called once at app startup
 */
export function initializeFirebase(): admin.app.App | null {
  if (firebaseApp) {
    return firebaseApp;
  }

  if (!isFirebaseConfigured()) {
    logger.warn('[FIREBASE] Not configured - phone auth will use fallback');
    return null;
  }

  try {
    let credential: admin.credential.Credential;

    // Option 1: Service account JSON file path
    if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
      credential = admin.credential.cert(serviceAccount);
      logger.info('[FIREBASE] Initializing with service account file');
    }
    // Option 2: Service account JSON string (for containerized environments)
    else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      credential = admin.credential.cert(serviceAccount);
      logger.info('[FIREBASE] Initializing with service account JSON');
    }
    // Option 3: Individual credentials
    else {
      credential = admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      });
      logger.info('[FIREBASE] Initializing with individual credentials');
    }

    firebaseApp = admin.initializeApp({
      credential,
      projectId: process.env.FIREBASE_PROJECT_ID,
    });

    logger.info('[FIREBASE] Admin SDK initialized successfully', {
      projectId: process.env.FIREBASE_PROJECT_ID,
    });

    return firebaseApp;
  } catch (error: any) {
    logger.error('[FIREBASE] Failed to initialize Admin SDK', {
      error: error.message,
    });
    return null;
  }
}

/**
 * Get Firebase Auth instance
 */
export function getFirebaseAuth(): admin.auth.Auth | null {
  if (!firebaseApp) {
    firebaseApp = initializeFirebase();
  }
  return firebaseApp?.auth() || null;
}

export interface FirebaseVerifyResult {
  success: boolean;
  uid?: string;
  phone?: string;
  email?: string;
  name?: string;
  picture?: string;
  error?: string;
}

/**
 * Verify Firebase ID token
 * 
 * This is the main function for backend verification.
 * Client authenticates with Firebase, gets ID token, sends to backend.
 * Backend verifies the token and extracts user info.
 * 
 * @param idToken - Firebase ID token from client
 * @param checkRevoked - Whether to check if token was revoked (default: true)
 */
export async function verifyFirebaseToken(
  idToken: string,
  checkRevoked: boolean = true
): Promise<FirebaseVerifyResult> {
  const auth = getFirebaseAuth();
  
  if (!auth) {
    logger.error('[FIREBASE] Auth not initialized');
    return {
      success: false,
      error: 'Firebase not configured',
    };
  }

  try {
    // Verify the ID token
    const decodedToken = await auth.verifyIdToken(idToken, checkRevoked);
    
    logger.info('[FIREBASE] Token verified successfully', {
      uid: decodedToken.uid,
      phone: decodedToken.phone_number,
      authTime: new Date(decodedToken.auth_time * 1000).toISOString(),
    });

    return {
      success: true,
      uid: decodedToken.uid,
      phone: decodedToken.phone_number,
      email: decodedToken.email,
      name: decodedToken.name,
      picture: decodedToken.picture,
    };
  } catch (error: any) {
    logger.error('[FIREBASE] Token verification failed', {
      error: error.message,
      code: error.code,
    });

    // Handle specific Firebase errors
    let errorMessage = 'Token verification failed';
    if (error.code === 'auth/id-token-expired') {
      errorMessage = 'Token expired';
    } else if (error.code === 'auth/id-token-revoked') {
      errorMessage = 'Token revoked';
    } else if (error.code === 'auth/invalid-id-token') {
      errorMessage = 'Invalid token format';
    } else if (error.code === 'auth/argument-error') {
      errorMessage = 'Invalid token';
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Get Firebase user by phone number
 */
export async function getFirebaseUserByPhone(phoneNumber: string): Promise<admin.auth.UserRecord | null> {
  const auth = getFirebaseAuth();
  
  if (!auth) {
    logger.error('[FIREBASE] Auth not initialized');
    return null;
  }

  try {
    const user = await auth.getUserByPhoneNumber(phoneNumber);
    logger.info('[FIREBASE] Found user by phone', {
      uid: user.uid,
      phone: user.phoneNumber,
    });
    return user;
  } catch (error: any) {
    if (error.code === 'auth/user-not-found') {
      logger.info('[FIREBASE] User not found by phone', { phone: phoneNumber });
      return null;
    }
    logger.error('[FIREBASE] Error getting user by phone', {
      phone: phoneNumber,
      error: error.message,
      code: error.code,
    });
    return null;
  }
}

/**
 * Get Firebase user by UID
 */
export async function getFirebaseUserByUid(uid: string): Promise<admin.auth.UserRecord | null> {
  const auth = getFirebaseAuth();
  
  if (!auth) {
    logger.error('[FIREBASE] Auth not initialized');
    return null;
  }

  try {
    const user = await auth.getUser(uid);
    return user;
  } catch (error: any) {
    if (error.code === 'auth/user-not-found') {
      return null;
    }
    logger.error('[FIREBASE] Error getting user by UID', {
      uid,
      error: error.message,
      code: error.code,
    });
    return null;
  }
}

/**
 * Create a custom token for a user
 * Useful for linking Firebase auth with existing users
 */
export async function createCustomToken(
  uid: string,
  additionalClaims?: Record<string, any>
): Promise<string | null> {
  const auth = getFirebaseAuth();
  
  if (!auth) {
    logger.error('[FIREBASE] Auth not initialized');
    return null;
  }

  try {
    const token = await auth.createCustomToken(uid, additionalClaims);
    logger.info('[FIREBASE] Created custom token', { uid });
    return token;
  } catch (error: any) {
    logger.error('[FIREBASE] Failed to create custom token', {
      uid,
      error: error.message,
    });
    return null;
  }
}

/**
 * Revoke all refresh tokens for a user
 * Useful when user logs out or security concern
 */
export async function revokeUserTokens(uid: string): Promise<boolean> {
  const auth = getFirebaseAuth();
  
  if (!auth) {
    logger.error('[FIREBASE] Auth not initialized');
    return false;
  }

  try {
    await auth.revokeRefreshTokens(uid);
    logger.info('[FIREBASE] Revoked tokens for user', { uid });
    return true;
  } catch (error: any) {
    logger.error('[FIREBASE] Failed to revoke tokens', {
      uid,
      error: error.message,
    });
    return false;
  }
}

/**
 * Delete a Firebase user
 */
export async function deleteFirebaseUser(uid: string): Promise<boolean> {
  const auth = getFirebaseAuth();
  
  if (!auth) {
    logger.error('[FIREBASE] Auth not initialized');
    return false;
  }

  try {
    await auth.deleteUser(uid);
    logger.info('[FIREBASE] Deleted user', { uid });
    return true;
  } catch (error: any) {
    logger.error('[FIREBASE] Failed to delete user', {
      uid,
      error: error.message,
    });
    return false;
  }
}

/**
 * Update Firebase user phone number
 */
export async function updateFirebaseUserPhone(uid: string, phoneNumber: string): Promise<boolean> {
  const auth = getFirebaseAuth();
  
  if (!auth) {
    logger.error('[FIREBASE] Auth not initialized');
    return false;
  }

  try {
    await auth.updateUser(uid, { phoneNumber });
    logger.info('[FIREBASE] Updated user phone', { uid, phone: phoneNumber });
    return true;
  } catch (error: any) {
    logger.error('[FIREBASE] Failed to update user phone', {
      uid,
      phone: phoneNumber,
      error: error.message,
    });
    return false;
  }
}

/**
 * Set custom user claims
 * Useful for role-based access control
 */
export async function setUserClaims(
  uid: string,
  claims: Record<string, any>
): Promise<boolean> {
  const auth = getFirebaseAuth();
  
  if (!auth) {
    logger.error('[FIREBASE] Auth not initialized');
    return false;
  }

  try {
    await auth.setCustomUserClaims(uid, claims);
    logger.info('[FIREBASE] Set custom claims', { uid, claims });
    return true;
  } catch (error: any) {
    logger.error('[FIREBASE] Failed to set custom claims', {
      uid,
      error: error.message,
    });
    return false;
  }
}

/**
 * Link Firebase UID with backend user ID
 * Store this mapping in database for quick lookups
 */
export async function linkFirebaseUser(
  firebaseUid: string,
  backendUserId: string
): Promise<boolean> {
  try {
    // Set custom claim to link backend user
    const success = await setUserClaims(firebaseUid, {
      raahiUserId: backendUserId,
    });
    
    if (success) {
      logger.info('[FIREBASE] Linked Firebase user to backend', {
        firebaseUid,
        backendUserId,
      });
    }
    
    return success;
  } catch (error: any) {
    logger.error('[FIREBASE] Failed to link users', {
      firebaseUid,
      backendUserId,
      error: error.message,
    });
    return false;
  }
}

/**
 * Get Firebase configuration status (for debugging)
 */
export function getFirebaseConfigStatus(): {
  configured: boolean;
  projectId?: string;
  method?: string;
} {
  if (!isFirebaseConfigured()) {
    return { configured: false };
  }

  let method = 'unknown';
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    method = 'service_account_file';
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    method = 'service_account_json';
  } else {
    method = 'individual_credentials';
  }

  return {
    configured: true,
    projectId: process.env.FIREBASE_PROJECT_ID,
    method,
  };
}
