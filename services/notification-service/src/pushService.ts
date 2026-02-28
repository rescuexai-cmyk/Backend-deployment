/**
 * Push Notification Service using Firebase Cloud Messaging (FCM)
 * 
 * Supports:
 * - iOS (via APNs through FCM)
 * - Android (native FCM)
 * - Web (FCM for web)
 * 
 * FCM handles the complexity of APNs for iOS automatically.
 * 
 * Notification Types:
 * - RIDE_UPDATE: Driver assigned, arriving, started, completed, cancelled
 * - PAYMENT: Payment status updates
 * - PROMOTION: Marketing notifications
 * - SYSTEM: System alerts, emergency
 * - SUPPORT: Support ticket updates
 */

import * as admin from 'firebase-admin';
import { createLogger } from '@raahi/shared';

const logger = createLogger('push-service');

// Firebase app instance (reuse from auth service if available)
let firebaseApp: admin.app.App | null = null;

/**
 * Check if Firebase is configured for push notifications
 */
export function isFirebaseConfigured(): boolean {
  return !!(
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL)
  );
}

/**
 * Initialize Firebase Admin SDK for push notifications
 */
export function initializeFirebase(): admin.app.App | null {
  if (firebaseApp) {
    return firebaseApp;
  }

  // Check if Firebase is already initialized (by another service)
  const existingApps = admin.apps;
  if (existingApps.length > 0) {
    firebaseApp = existingApps[0];
    logger.info('[PUSH] Using existing Firebase app instance');
    return firebaseApp;
  }

  if (!isFirebaseConfigured()) {
    logger.warn('[PUSH] Firebase not configured - push notifications disabled');
    return null;
  }

  try {
    let credential: admin.credential.Credential;

    if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
      credential = admin.credential.cert(serviceAccount);
      logger.info('[PUSH] Initializing Firebase with service account file');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      credential = admin.credential.cert(serviceAccount);
      logger.info('[PUSH] Initializing Firebase with service account JSON');
    } else {
      credential = admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      });
      logger.info('[PUSH] Initializing Firebase with individual credentials');
    }

    firebaseApp = admin.initializeApp({
      credential,
      projectId: process.env.FIREBASE_PROJECT_ID,
    });

    logger.info('[PUSH] Firebase Admin SDK initialized for push notifications');
    return firebaseApp;
  } catch (error: any) {
    logger.error('[PUSH] Failed to initialize Firebase', { error: error.message });
    return null;
  }
}

/**
 * Get Firebase Messaging instance
 */
function getMessaging(): admin.messaging.Messaging | null {
  if (!firebaseApp) {
    firebaseApp = initializeFirebase();
  }
  return firebaseApp?.messaging() || null;
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
  sound?: string;
  badge?: number;
  // iOS specific
  apns?: {
    sound?: string;
    badge?: number;
    category?: string;
  };
  // Android specific
  android?: {
    channelId?: string;
    priority?: 'high' | 'normal';
    sound?: string;
  };
}

export interface PushResult {
  success: boolean;
  messageId?: string;
  error?: string;
  invalidToken?: boolean;
}

/**
 * Send push notification to a single device
 */
export async function sendPushNotification(
  fcmToken: string,
  payload: PushNotificationPayload
): Promise<PushResult> {
  const messaging = getMessaging();
  
  if (!messaging) {
    logger.warn('[PUSH] Messaging not available - notification not sent');
    return { success: false, error: 'Push notifications not configured' };
  }

  if (!fcmToken) {
    logger.warn('[PUSH] No FCM token provided');
    return { success: false, error: 'No FCM token' };
  }

  try {
    const message: admin.messaging.Message = {
      token: fcmToken,
      notification: {
        title: payload.title,
        body: payload.body,
        imageUrl: payload.imageUrl,
      },
      data: payload.data || {},
      // iOS-specific configuration (APNs)
      apns: {
        payload: {
          aps: {
            alert: {
              title: payload.title,
              body: payload.body,
            },
            sound: payload.apns?.sound || 'default',
            badge: payload.apns?.badge,
            category: payload.apns?.category,
            'mutable-content': 1,
            'content-available': 1,
          },
        },
        headers: {
          'apns-priority': '10', // High priority
          'apns-push-type': 'alert',
        },
      },
      // Android-specific configuration
      android: {
        priority: payload.android?.priority || 'high',
        notification: {
          title: payload.title,
          body: payload.body,
          sound: payload.android?.sound || 'default',
          channelId: payload.android?.channelId || 'raahi_rides',
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
    };

    const response = await messaging.send(message);
    
    logger.info('[PUSH] Notification sent successfully', {
      messageId: response,
      title: payload.title,
    });

    return { success: true, messageId: response };
  } catch (error: any) {
    logger.error('[PUSH] Failed to send notification', {
      error: error.message,
      code: error.code,
      token: fcmToken.substring(0, 20) + '...',
    });

    // Check if token is invalid
    const invalidToken = 
      error.code === 'messaging/invalid-registration-token' ||
      error.code === 'messaging/registration-token-not-registered';

    return { 
      success: false, 
      error: error.message,
      invalidToken,
    };
  }
}

/**
 * Send push notification to multiple devices
 */
export async function sendPushNotificationMultiple(
  fcmTokens: string[],
  payload: PushNotificationPayload
): Promise<{ successCount: number; failureCount: number; invalidTokens: string[] }> {
  const messaging = getMessaging();
  
  if (!messaging) {
    logger.warn('[PUSH] Messaging not available');
    return { successCount: 0, failureCount: fcmTokens.length, invalidTokens: [] };
  }

  if (fcmTokens.length === 0) {
    return { successCount: 0, failureCount: 0, invalidTokens: [] };
  }

  try {
    const message: admin.messaging.MulticastMessage = {
      tokens: fcmTokens,
      notification: {
        title: payload.title,
        body: payload.body,
        imageUrl: payload.imageUrl,
      },
      data: payload.data || {},
      apns: {
        payload: {
          aps: {
            alert: {
              title: payload.title,
              body: payload.body,
            },
            sound: payload.apns?.sound || 'default',
            badge: payload.apns?.badge,
            'mutable-content': 1,
            'content-available': 1,
          },
        },
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert',
        },
      },
      android: {
        priority: payload.android?.priority || 'high',
        notification: {
          title: payload.title,
          body: payload.body,
          sound: payload.android?.sound || 'default',
          channelId: payload.android?.channelId || 'raahi_rides',
          priority: 'high',
        },
      },
    };

    const response = await messaging.sendEachForMulticast(message);
    
    const invalidTokens: string[] = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success && resp.error) {
        if (
          resp.error.code === 'messaging/invalid-registration-token' ||
          resp.error.code === 'messaging/registration-token-not-registered'
        ) {
          invalidTokens.push(fcmTokens[idx]);
        }
      }
    });

    logger.info('[PUSH] Multicast notification sent', {
      successCount: response.successCount,
      failureCount: response.failureCount,
      invalidTokens: invalidTokens.length,
    });

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      invalidTokens,
    };
  } catch (error: any) {
    logger.error('[PUSH] Failed to send multicast notification', { error: error.message });
    return { successCount: 0, failureCount: fcmTokens.length, invalidTokens: [] };
  }
}

// ============================================
// Pre-built Notification Templates for Rides
// ============================================

/**
 * Notification when driver accepts/is assigned to a ride
 */
export function buildDriverAssignedNotification(
  driverName: string,
  vehicleInfo: string,
  eta?: number,
  rideId?: string,
  otp?: string
): PushNotificationPayload {
  const otpText = otp ? ` Your ride PIN: ${otp}` : '';
  return {
    title: '🚗 Driver Assigned!',
    body: `${driverName} is on the way in a ${vehicleInfo}${eta ? `. ETA: ${eta} min` : ''}.${otpText}`,
    data: {
      type: 'RIDE_UPDATE',
      event: 'DRIVER_ASSIGNED',
      rideId: rideId || '',
      ...(otp ? { otp } : {}),
    },
    android: {
      channelId: 'raahi_rides',
      priority: 'high',
    },
    apns: {
      sound: 'default',
      category: 'RIDE_UPDATE',
    },
  };
}

/**
 * Notification when driver is arriving (near pickup)
 */
export function buildDriverArrivingNotification(
  driverName: string,
  eta: number,
  rideId?: string
): PushNotificationPayload {
  return {
    title: '📍 Driver Arriving!',
    body: `${driverName} will arrive in ${eta} minute${eta !== 1 ? 's' : ''}. Please be ready!`,
    data: {
      type: 'RIDE_UPDATE',
      event: 'DRIVER_ARRIVING',
      rideId: rideId || '',
    },
    android: {
      channelId: 'raahi_rides',
      priority: 'high',
    },
    apns: {
      sound: 'default',
      category: 'RIDE_UPDATE',
    },
  };
}

/**
 * Notification when driver has arrived at pickup
 */
export function buildDriverArrivedNotification(
  driverName: string,
  otp: string,
  rideId?: string
): PushNotificationPayload {
  return {
    title: '✅ Driver Has Arrived!',
    body: `${driverName} has arrived. Share your ride PIN with the driver to start your trip.`,
    data: {
      type: 'RIDE_UPDATE',
      event: 'DRIVER_ARRIVED',
      rideId: rideId || '',
      otp: otp,
    },
    android: {
      channelId: 'raahi_rides',
      priority: 'high',
      sound: 'arrival',
    },
    apns: {
      sound: 'arrival.wav',
      category: 'RIDE_ARRIVED',
    },
  };
}

/**
 * Notification when ride has started
 */
export function buildRideStartedNotification(
  driverName: string,
  destination: string,
  rideId?: string
): PushNotificationPayload {
  return {
    title: '🚀 Ride Started!',
    body: `Your ride to ${destination} has started with ${driverName}.`,
    data: {
      type: 'RIDE_UPDATE',
      event: 'RIDE_STARTED',
      rideId: rideId || '',
    },
    android: {
      channelId: 'raahi_rides',
      priority: 'high',
    },
    apns: {
      sound: 'default',
      category: 'RIDE_UPDATE',
    },
  };
}

/**
 * Notification when ride is completed (for passenger)
 */
export function buildRideCompletedPassengerNotification(
  fare: number,
  distance: number,
  rideId?: string
): PushNotificationPayload {
  return {
    title: '🎉 Ride Completed!',
    body: `Your ride is complete. Total fare: ₹${fare.toFixed(2)} for ${distance.toFixed(1)} km. Please rate your driver!`,
    data: {
      type: 'RIDE_UPDATE',
      event: 'RIDE_COMPLETED',
      rideId: rideId || '',
      fare: fare.toString(),
    },
    android: {
      channelId: 'raahi_rides',
      priority: 'high',
    },
    apns: {
      sound: 'success.wav',
      category: 'RIDE_COMPLETED',
    },
  };
}

/**
 * Notification when ride is completed (for driver)
 */
export function buildRideCompletedDriverNotification(
  earnings: number,
  rideId?: string
): PushNotificationPayload {
  return {
    title: '💰 Ride Completed!',
    body: `Great job! You earned ₹${earnings.toFixed(2)} from this ride.`,
    data: {
      type: 'RIDE_UPDATE',
      event: 'RIDE_COMPLETED',
      rideId: rideId || '',
      earnings: earnings.toString(),
    },
    android: {
      channelId: 'raahi_earnings',
      priority: 'high',
    },
    apns: {
      sound: 'cash.wav',
      category: 'EARNINGS',
    },
  };
}

/**
 * Notification when ride is cancelled by passenger (to driver)
 */
export function buildRideCancelledToDriverNotification(
  passengerName: string,
  reason?: string,
  rideId?: string
): PushNotificationPayload {
  return {
    title: '❌ Ride Cancelled',
    body: `${passengerName} cancelled the ride${reason ? `: ${reason}` : '.'}`,
    data: {
      type: 'RIDE_UPDATE',
      event: 'RIDE_CANCELLED',
      cancelledBy: 'PASSENGER',
      rideId: rideId || '',
    },
    android: {
      channelId: 'raahi_rides',
      priority: 'high',
    },
    apns: {
      sound: 'cancel.wav',
      category: 'RIDE_CANCELLED',
    },
  };
}

/**
 * Notification when ride is cancelled by driver (to passenger)
 */
export function buildRideCancelledToPassengerNotification(
  driverName: string,
  reason?: string,
  rideId?: string
): PushNotificationPayload {
  return {
    title: '❌ Ride Cancelled',
    body: `${driverName} cancelled the ride${reason ? `: ${reason}` : '. We\'re finding you another driver.'}`,
    data: {
      type: 'RIDE_UPDATE',
      event: 'RIDE_CANCELLED',
      cancelledBy: 'DRIVER',
      rideId: rideId || '',
    },
    android: {
      channelId: 'raahi_rides',
      priority: 'high',
    },
    apns: {
      sound: 'cancel.wav',
      category: 'RIDE_CANCELLED',
    },
  };
}

/**
 * Notification for new ride request (to driver)
 */
export function buildNewRideRequestNotification(
  pickupAddress: string,
  estimatedFare: number,
  distance: number,
  rideId?: string
): PushNotificationPayload {
  return {
    title: '🔔 New Ride Request!',
    body: `Pickup: ${pickupAddress} • ₹${estimatedFare.toFixed(0)} • ${distance.toFixed(1)} km`,
    data: {
      type: 'RIDE_UPDATE',
      event: 'NEW_RIDE_REQUEST',
      rideId: rideId || '',
      fare: estimatedFare.toString(),
    },
    android: {
      channelId: 'raahi_ride_requests',
      priority: 'high',
      sound: 'ride_request',
    },
    apns: {
      sound: 'ride_request.wav',
      category: 'RIDE_REQUEST',
    },
  };
}

/**
 * Notification when ride request is accepted by another driver
 */
export function buildRideTakenNotification(rideId?: string): PushNotificationPayload {
  return {
    title: 'Ride Already Taken',
    body: 'This ride has been accepted by another driver.',
    data: {
      type: 'RIDE_UPDATE',
      event: 'RIDE_TAKEN',
      rideId: rideId || '',
    },
    android: {
      channelId: 'raahi_rides',
      priority: 'normal',
    },
    apns: {
      sound: 'default',
    },
  };
}

/**
 * Notification for OTP verification reminder
 */
export function buildOtpReminderNotification(
  otp: string,
  driverName: string,
  rideId?: string
): PushNotificationPayload {
  return {
    title: '🔐 Share Your OTP',
    body: `Share OTP ${otp} with ${driverName} to start your ride.`,
    data: {
      type: 'RIDE_UPDATE',
      event: 'OTP_REMINDER',
      rideId: rideId || '',
      otp: otp,
    },
    android: {
      channelId: 'raahi_rides',
      priority: 'high',
    },
    apns: {
      sound: 'default',
      category: 'OTP_VERIFICATION',
    },
  };
}

/**
 * Get push notification status
 */
export function getPushNotificationStatus(): {
  enabled: boolean;
  projectId?: string;
} {
  return {
    enabled: isFirebaseConfigured() && !!getMessaging(),
    projectId: process.env.FIREBASE_PROJECT_ID,
  };
}
