/**
 * Firebase Authentication Service
 * 
 * Uses Firebase Admin SDK to verify phone OTP authentication.
 * 
 * Flow:
 *   1. Client uses Firebase Auth SDK to initiate phone OTP (send/verify OTP happens client-side)
 *   2. After verification, client receives a Firebase ID Token
 *   3. Client sends the ID Token to our backend
 *   4. Backend verifies the token via Firebase Admin SDK
 *   5. Backend extracts phone number and creates/authenticates the user
 */

import * as admin from 'firebase-admin';
import { createLogger } from '@raahi/shared';
import path from 'path';
import fs from 'fs';

const logger = createLogger('firebase-auth');

let firebaseApp: admin.app.App | null = null;

/**
 * Initialize Firebase Admin SDK
 * Supports three configuration methods (tried in order):
 *   1. Service account JSON file path (FIREBASE_SERVICE_ACCOUNT_PATH)
 *   2. Inline service account JSON string (FIREBASE_SERVICE_ACCOUNT_JSON)
 *   3. Individual env vars (FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL)
 */
export function initializeFirebase(): admin.app.App | null {
  if (firebaseApp) {
    return firebaseApp;
  }

  // Reuse existing Firebase app if already initialized (e.g., by another module)
  if (admin.apps.length > 0) {
    firebaseApp = admin.apps[0]!;
    logger.info('[FIREBASE] Reusing existing Firebase app instance');
    return firebaseApp;
  }

  try {
    // Method 1: Service account file path
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (serviceAccountPath) {
      const resolvedPath = path.resolve(serviceAccountPath);
      if (fs.existsSync(resolvedPath)) {
        const serviceAccount = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
        firebaseApp = admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          projectId: serviceAccount.project_id,
        });
        logger.info(`[FIREBASE] Initialized with service account file: ${resolvedPath}`);
        return firebaseApp;
      } else {
        logger.warn(`[FIREBASE] Service account file not found: ${resolvedPath}`);
      }
    }

    // Method 2: Inline JSON string
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id,
      });
      logger.info('[FIREBASE] Initialized with inline service account JSON');
      return firebaseApp;
    }

    // Method 3: Individual environment variables
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

    if (projectId && privateKey && clientEmail) {
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert({ projectId, privateKey, clientEmail }),
        projectId,
      });
      logger.info(`[FIREBASE] Initialized with env vars for project: ${projectId}`);
      return firebaseApp;
    }

    logger.warn('[FIREBASE] No Firebase credentials configured. Firebase auth will be unavailable.');
    return null;
  } catch (error: any) {
    logger.error(`[FIREBASE] Initialization failed: ${error.message}`);
    return null;
  }
}

/**
 * Check if Firebase is properly initialized and ready
 */
export function isFirebaseReady(): boolean {
  return firebaseApp !== null || admin.apps.length > 0;
}

/**
 * Get Firebase configuration status
 */
export function getFirebaseStatus(): {
  initialized: boolean;
  projectId: string | null;
  method: string;
} {
  if (firebaseApp) {
    const options = firebaseApp.options as any;
    return {
      initialized: true,
      projectId: options.projectId || process.env.FIREBASE_PROJECT_ID || null,
      method: process.env.FIREBASE_SERVICE_ACCOUNT_PATH
        ? 'service_account_file'
        : process.env.FIREBASE_SERVICE_ACCOUNT_JSON
          ? 'inline_json'
          : 'env_vars',
    };
  }
  return { initialized: false, projectId: null, method: 'none' };
}

export interface FirebaseVerifyResult {
  success: boolean;
  phone?: string;
  uid?: string;
  email?: string;
  name?: string;
  picture?: string;
  error?: string;
}

/**
 * Verify a Firebase ID Token and extract user information
 * 
 * @param idToken - The Firebase ID Token from client-side authentication
 * @returns Verified user information including phone number
 */
export async function verifyFirebaseToken(idToken: string): Promise<FirebaseVerifyResult> {
  if (!isFirebaseReady()) {
    logger.error('[FIREBASE] Cannot verify token - Firebase not initialized');
    return { success: false, error: 'Firebase not initialized' };
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    
    const phone = decodedToken.phone_number;
    if (!phone) {
      logger.warn(`[FIREBASE] Token verified but no phone number found. UID: ${decodedToken.uid}`);
      return { 
        success: false, 
        uid: decodedToken.uid,
        error: 'No phone number associated with this Firebase account',
      };
    }

    logger.info(`[FIREBASE] Token verified. UID: ${decodedToken.uid}, Phone: ${phone}`);

    return {
      success: true,
      phone,
      uid: decodedToken.uid,
      email: decodedToken.email,
      name: decodedToken.name,
      picture: decodedToken.picture,
    };
  } catch (error: any) {
    const code = error.code || '';
    let message = 'Token verification failed';

    if (code === 'auth/id-token-expired') {
      message = 'Firebase token has expired. Please re-authenticate.';
    } else if (code === 'auth/id-token-revoked') {
      message = 'Firebase token has been revoked. Please re-authenticate.';
    } else if (code === 'auth/argument-error') {
      message = 'Invalid Firebase token format.';
    } else {
      message = error.message || message;
    }

    logger.warn(`[FIREBASE] Token verification failed: ${message} (code: ${code})`);
    return { success: false, error: message };
  }
}

/**
 * Get Firebase user by UID
 */
export async function getFirebaseUser(uid: string): Promise<admin.auth.UserRecord | null> {
  if (!isFirebaseReady()) return null;
  try {
    return await admin.auth().getUser(uid);
  } catch {
    return null;
  }
}

/**
 * Get Firebase user by phone number
 */
export async function getFirebaseUserByPhone(phone: string): Promise<admin.auth.UserRecord | null> {
  if (!isFirebaseReady()) return null;
  try {
    return await admin.auth().getUserByPhoneNumber(phone);
  } catch {
    return null;
  }
}
