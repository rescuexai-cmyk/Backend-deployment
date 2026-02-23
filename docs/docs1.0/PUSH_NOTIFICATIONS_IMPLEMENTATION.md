# Push Notifications Implementation

## Overview

This document describes the Firebase Cloud Messaging (FCM) push notification implementation for Raahi. FCM provides cross-platform push notification delivery for iOS (via APNs), Android, and Web.

## Architecture

```
┌─────────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│   iOS Client    │────▶│  Firebase Cloud     │────▶│     APNs        │
│   (Flutter)     │     │    Messaging        │     │  (Apple Push)   │
└─────────────────┘     │                     │     └─────────────────┘
                        │                     │
┌─────────────────┐     │   ┌───────────┐    │     ┌─────────────────┐
│ Android Client  │────▶│   │FCM Server │    │────▶│  Android Push   │
│   (Flutter)     │     │   └───────────┘    │     │                 │
└─────────────────┘     │         ▲          │     └─────────────────┘
                        └─────────┼──────────┘
                                  │
                        ┌─────────┴──────────┐
                        │  Raahi Backend     │
                        │  (notification-    │
                        │   service)         │
                        └────────────────────┘
```

## Files Modified/Created

### New Files

1. **`services/notification-service/src/pushService.ts`**
   - Firebase Admin SDK initialization
   - Push notification sending (single & multicast)
   - Pre-built notification templates for ride events

2. **`prisma/migrations/20260211000003_add_fcm_token_fields/migration.sql`**
   - Adds FCM token fields to users table

### Modified Files

1. **`prisma/schema.prisma`**
   - Added `fcmToken`, `fcmTokenUpdatedAt`, `devicePlatform`, `deviceId` to User model

2. **`services/notification-service/src/index.ts`**
   - Device registration endpoints (POST/DELETE/GET `/api/notifications/device`)
   - Test push endpoint (`POST /api/notifications/test-push`)
   - Updated internal create to also send push
   - New internal endpoints for ride-specific push notifications

3. **`services/ride-service/src/rideService.ts`**
   - Updated notification helper to send push notifications
   - Added ride-specific push notification templates

4. **`services/realtime-service/src/realtimeService.ts`**
   - Added push notification fallback for drivers not connected via Socket.io

## Database Schema Changes

```prisma
model User {
  // ... existing fields ...
  
  // Push notification tokens (FCM for both iOS and Android)
  fcmToken          String?   // Firebase Cloud Messaging token
  fcmTokenUpdatedAt DateTime? // When the token was last updated
  devicePlatform    String?   // 'ios', 'android', or 'web'
  deviceId          String?   // Unique device identifier
  
  @@index([fcmToken])
}
```

## API Endpoints

### Client-Facing Endpoints

#### Register Device for Push Notifications
```http
POST /api/notifications/device
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "fcmToken": "dXJvdG9...",
  "platform": "ios",  // 'ios', 'android', or 'web'
  "deviceId": "optional-device-id"
}
```

#### Unregister Device (Logout)
```http
DELETE /api/notifications/device
Authorization: Bearer <jwt_token>
```

#### Get Device Registration Status
```http
GET /api/notifications/device
Authorization: Bearer <jwt_token>
```

Response:
```json
{
  "success": true,
  "data": {
    "isRegistered": true,
    "platform": "ios",
    "deviceId": null,
    "lastUpdated": "2026-02-11T10:30:00Z",
    "pushEnabled": true
  }
}
```

#### Test Push Notification
```http
POST /api/notifications/test-push
Authorization: Bearer <jwt_token>
```

### Internal Service Endpoints

#### Create Notification with Push (Updated)
```http
POST /api/notifications/internal/create
x-internal-api-key: raahi-internal-service-key
Content-Type: application/json

{
  "userId": "user_id",
  "title": "Notification Title",
  "message": "Notification body",
  "type": "RIDE_UPDATE",
  "data": { "rideId": "..." },
  "sendPush": true  // Default: true
}
```

#### Direct Push Notification
```http
POST /api/notifications/internal/push
x-internal-api-key: raahi-internal-service-key
Content-Type: application/json

{
  "userId": "user_id",
  "title": "Title",
  "body": "Body text",
  "data": { "custom": "data" },
  "saveToDb": false  // Default: false
}
```

#### Ride-Specific Push Notification (Templated)
```http
POST /api/notifications/internal/ride-push
x-internal-api-key: raahi-internal-service-key
Content-Type: application/json

{
  "userId": "user_id",
  "event": "DRIVER_ARRIVED",
  "rideId": "ride_id",
  "eventData": {
    "driverName": "John",
    "otp": "1234"
  }
}
```

## Notification Events

### Events that trigger push notifications:

| Event | Recipient | Template |
|-------|-----------|----------|
| `DRIVER_ASSIGNED` | Passenger | "🚗 Driver Assigned! {driverName} is on the way..." |
| `DRIVER_ARRIVING` | Passenger | "📍 Driver Arriving! {driverName} will arrive in {eta} minutes" |
| `DRIVER_ARRIVED` | Passenger | "✅ Driver Has Arrived! Share OTP: {otp} to start your ride" |
| `RIDE_STARTED` | Passenger | "🚀 Ride Started! Your ride to {destination} has started" |
| `RIDE_COMPLETED_PASSENGER` | Passenger | "🎉 Ride Completed! Total fare: ₹{fare}" |
| `RIDE_COMPLETED_DRIVER` | Driver | "💰 Ride Completed! You earned ₹{earnings}" |
| `RIDE_CANCELLED_TO_DRIVER` | Driver | "❌ Ride Cancelled - {passengerName} cancelled" |
| `RIDE_CANCELLED_TO_PASSENGER` | Passenger | "❌ Ride Cancelled - {driverName} cancelled" |
| `NEW_RIDE_REQUEST` | Driver | "🔔 New Ride Request! Pickup: {address} • ₹{fare}" |
| `OTP_REMINDER` | Passenger | "🔐 Share Your OTP - Share OTP {otp} with {driverName}" |

## Client Integration (Flutter)

### 1. Add Firebase Dependencies

```yaml
# pubspec.yaml
dependencies:
  firebase_core: ^latest
  firebase_messaging: ^latest
```

### 2. Initialize Firebase Messaging

```dart
import 'package:firebase_messaging/firebase_messaging.dart';

class PushNotificationService {
  final FirebaseMessaging _messaging = FirebaseMessaging.instance;
  
  Future<void> initialize() async {
    // Request permission (iOS)
    NotificationSettings settings = await _messaging.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );
    
    if (settings.authorizationStatus == AuthorizationStatus.authorized) {
      // Get FCM token
      String? token = await _messaging.getToken();
      if (token != null) {
        await registerDevice(token);
      }
      
      // Listen for token refresh
      _messaging.onTokenRefresh.listen(registerDevice);
      
      // Handle foreground messages
      FirebaseMessaging.onMessage.listen(_handleForegroundMessage);
      
      // Handle background/terminated messages
      FirebaseMessaging.onMessageOpenedApp.listen(_handleMessageOpenedApp);
    }
  }
  
  Future<void> registerDevice(String token) async {
    await apiClient.post('/api/notifications/device', data: {
      'fcmToken': token,
      'platform': Platform.isIOS ? 'ios' : 'android',
    });
  }
  
  void _handleForegroundMessage(RemoteMessage message) {
    // Show local notification
    final notification = message.notification;
    final data = message.data;
    
    // Handle ride events
    if (data['type'] == 'RIDE_UPDATE') {
      switch (data['event']) {
        case 'DRIVER_ARRIVED':
          // Navigate to ride screen, show OTP
          break;
        case 'RIDE_STARTED':
          // Update UI to show ride in progress
          break;
        // ... handle other events
      }
    }
  }
}
```

### 3. Android Configuration

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<manifest>
  <application>
    <!-- Notification channels for Android -->
    <meta-data
      android:name="com.google.firebase.messaging.default_notification_channel_id"
      android:value="raahi_rides" />
  </application>
</manifest>
```

Create notification channels in your Android code:
- `raahi_rides` - High priority for ride updates
- `raahi_ride_requests` - High priority for new ride requests (drivers)
- `raahi_earnings` - Medium priority for earnings
- `raahi_payments` - Medium priority for payment updates
- `raahi_promotions` - Low priority for promotions
- `raahi_system` - Medium priority for system messages

### 4. iOS Configuration

1. Add push notification capability in Xcode
2. Upload APNs key to Firebase Console
3. Configure `GoogleService-Info.plist`

```swift
// AppDelegate.swift (for native iOS parts)
import FirebaseMessaging

func application(_ application: UIApplication,
                 didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
  Messaging.messaging().apnsToken = deviceToken
}
```

## Environment Variables

Add these to `.env`:

```bash
# Firebase Admin SDK (required for push notifications)
# Option 1: Service account file path
FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/serviceAccount.json

# Option 2: JSON string (for deployment)
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}

# Option 3: Individual credentials
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxx@your-project.iam.gserviceaccount.com

# Internal API key for service-to-service communication
INTERNAL_API_KEY=your-secure-internal-key

# Notification service URL (for ride/realtime services)
NOTIFICATION_SERVICE_URL=http://localhost:5006
```

## Migration Steps

1. Run the migration:
   ```bash
   npx prisma migrate deploy
   # OR for development
   npx prisma db push
   ```

2. Regenerate Prisma client:
   ```bash
   npx prisma generate
   ```

3. Configure Firebase in Firebase Console:
   - Create a Firebase project
   - Enable Cloud Messaging
   - Generate a service account key
   - For iOS: Upload APNs authentication key
   - Set environment variables

4. Deploy updated services

## Testing

### Test Push Notification
```bash
# 1. Register device
curl -X POST http://localhost:5006/api/notifications/device \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"fcmToken":"YOUR_FCM_TOKEN","platform":"ios"}'

# 2. Send test push
curl -X POST http://localhost:5006/api/notifications/test-push \
  -H "Authorization: Bearer YOUR_JWT"
```

### Verify Push Status
```bash
curl http://localhost:5006/health
# Response includes: "pushNotifications": { "enabled": true, "projectId": "..." }
```

## Fallback Behavior

1. **No FCM Token**: If a user hasn't registered their device, notifications are still saved to the database and visible in-app.

2. **Invalid Token**: If FCM returns an invalid token error, the token is automatically cleared from the database.

3. **Drivers Offline**: For ride requests, if drivers aren't connected via Socket.io, push notifications are sent as a fallback to wake them up.

4. **Push Disabled**: If Firebase isn't configured, the system continues to work with database-only notifications.

## Security Considerations

1. **Token Validation**: FCM tokens are validated before storage
2. **Token Cleanup**: Invalid tokens are automatically removed
3. **Internal APIs**: Protected by `x-internal-api-key` header
4. **Rate Limiting**: Consider adding rate limiting for push notification endpoints
5. **Token Refresh**: Handle token refresh events from Firebase SDK

## Performance Notes

1. Push notifications are sent asynchronously (non-blocking)
2. Multicast endpoint supports up to 500 tokens per request
3. Invalid token cleanup prevents wasted FCM requests
4. Consider batching notifications for high-traffic scenarios
