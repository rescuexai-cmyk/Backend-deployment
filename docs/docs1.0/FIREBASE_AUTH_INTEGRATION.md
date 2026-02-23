# Firebase Phone Authentication Integration

## Overview

This document describes the Firebase Phone Authentication integration for the Raahi backend. Firebase provides a free, secure way to verify phone numbers using SMS OTP.

## Why Firebase over Twilio?

| Feature | Firebase | Twilio |
|---------|----------|--------|
| **Cost** | Free tier (10K verifications/month) | Pay per SMS (~$0.0075/SMS) |
| **OTP Management** | Handled by Firebase | You manage OTP storage |
| **Rate Limiting** | Built-in | Manual implementation |
| **reCAPTCHA** | Built-in protection | Manual integration |
| **Security** | OTP never touches your server | OTP passes through server |
| **Global Support** | 200+ countries | Carrier dependent |

## Files Modified/Created

| File | Changes |
|------|---------|
| `services/auth-service/src/firebaseService.ts` | **NEW** - Firebase Admin SDK integration |
| `services/auth-service/src/authService.ts` | Added `authenticateWithFirebasePhone()` |
| `services/auth-service/src/routes/auth.ts` | Added `/firebase-phone` and `/firebase-status` endpoints |
| `services/auth-service/src/smsService.ts` | Updated documentation (Twilio still works as fallback) |
| `prisma/schema.prisma` | Added `firebaseUid` field to User model |
| `.env` | Added Firebase configuration variables |

## Setup Instructions

### 1. Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Create a project" or select existing project
3. Enable Phone authentication:
   - Go to **Authentication** > **Sign-in method**
   - Enable **Phone** provider
   - Add test phone numbers if needed

### 2. Generate Service Account

1. Go to **Project Settings** > **Service accounts**
2. Click **"Generate new private key"**
3. Download the JSON file

### 3. Configure Backend

**Option 1: Service Account File (Recommended for local dev)**

```env
FIREBASE_SERVICE_ACCOUNT_PATH="/path/to/your-service-account.json"
```

**Option 2: Service Account JSON String (For Docker/Cloud)**

```env
FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"your-project",...}'
```

**Option 3: Individual Credentials**

```env
FIREBASE_PROJECT_ID="your-project-id"
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL="firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com"
```

### 4. Run Migration

```bash
npx prisma migrate dev --name add_firebase_uid
```

## API Endpoints

### POST /api/auth/firebase-phone

Authenticate user with Firebase Phone verification.

**Request:**
```json
{
  "firebaseIdToken": "eyJhbGciOiJSUzI1NiIsInR..."
}
```

**Response:**
```json
{
  "success": true,
  "message": "Firebase phone authentication successful",
  "data": {
    "user": {
      "id": "clxy1234",
      "phone": "+919876543210",
      "firstName": "User",
      "isVerified": true,
      "isActive": true,
      "createdAt": "2026-02-11T10:00:00.000Z"
    },
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1NiIs...",
      "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
      "expiresIn": 604800
    },
    "isNewUser": true
  }
}
```

### GET /api/auth/firebase-status

Check if Firebase authentication is available.

**Response:**
```json
{
  "success": true,
  "data": {
    "firebaseAuthAvailable": true,
    "projectId": "your-project-id"
  }
}
```

## Client Integration

### Flutter/Dart

```dart
import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;

// 1. Initialize Firebase
await Firebase.initializeApp();

// 2. Send OTP (Firebase handles SMS)
final verificationCompleted = (PhoneAuthCredential credential) async {
  // Auto-verification (e.g., on Android with SMS Retriever)
  await signIn(credential);
};

final verificationFailed = (FirebaseAuthException e) {
  print('Verification failed: ${e.message}');
};

final codeSent = (String verificationId, int? resendToken) {
  // Save verificationId for later use
  this.verificationId = verificationId;
};

await FirebaseAuth.instance.verifyPhoneNumber(
  phoneNumber: '+919876543210',
  verificationCompleted: verificationCompleted,
  verificationFailed: verificationFailed,
  codeSent: codeSent,
  codeAutoRetrievalTimeout: (String verificationId) {},
);

// 3. Verify OTP entered by user
final credential = PhoneAuthProvider.credential(
  verificationId: verificationId,
  smsCode: userEnteredOTP,
);

// 4. Sign in with Firebase
final userCredential = await FirebaseAuth.instance.signInWithCredential(credential);

// 5. Get Firebase ID token
final idToken = await userCredential.user!.getIdToken();

// 6. Send to backend
final response = await http.post(
  Uri.parse('https://api.raahi.com/api/auth/firebase-phone'),
  headers: {'Content-Type': 'application/json'},
  body: jsonEncode({'firebaseIdToken': idToken}),
);

// 7. Store backend JWT tokens
final data = jsonDecode(response.body)['data'];
await storage.write(key: 'accessToken', value: data['tokens']['accessToken']);
await storage.write(key: 'refreshToken', value: data['tokens']['refreshToken']);
```

### React Native

```javascript
import auth from '@react-native-firebase/auth';

// 1. Request OTP
const confirmation = await auth().signInWithPhoneNumber('+919876543210');

// 2. Verify OTP
await confirmation.confirm(userEnteredOTP);

// 3. Get Firebase ID token
const idToken = await auth().currentUser.getIdToken();

// 4. Send to backend
const response = await fetch('https://api.raahi.com/api/auth/firebase-phone', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ firebaseIdToken: idToken }),
});

// 5. Store tokens
const { data } = await response.json();
await AsyncStorage.setItem('accessToken', data.tokens.accessToken);
```

### Web (JavaScript)

```javascript
import { getAuth, signInWithPhoneNumber, RecaptchaVerifier } from 'firebase/auth';

const auth = getAuth();

// 1. Set up reCAPTCHA verifier
const recaptchaVerifier = new RecaptchaVerifier('recaptcha-container', {
  size: 'invisible',
}, auth);

// 2. Request OTP
const confirmationResult = await signInWithPhoneNumber(
  auth, 
  '+919876543210', 
  recaptchaVerifier
);

// 3. Verify OTP
const userCredential = await confirmationResult.confirm(userEnteredOTP);

// 4. Get Firebase ID token
const idToken = await userCredential.user.getIdToken();

// 5. Send to backend
const response = await fetch('/api/auth/firebase-phone', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ firebaseIdToken: idToken }),
});
```

## Authentication Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT SIDE                              │
│                                                                  │
│  1. User enters phone number                                     │
│                    │                                             │
│                    ▼                                             │
│  2. signInWithPhoneNumber('+91xxxxxxxxxx')                      │
│                    │                                             │
│                    ▼                                             │
│  3. Firebase sends SMS OTP to user's phone                      │
│                    │                                             │
│                    ▼                                             │
│  4. User enters OTP                                              │
│                    │                                             │
│                    ▼                                             │
│  5. confirm(otp) → Firebase verifies                            │
│                    │                                             │
│                    ▼                                             │
│  6. Get Firebase ID token: user.getIdToken()                    │
│                    │                                             │
└────────────────────┼────────────────────────────────────────────┘
                     │
                     │ POST /api/auth/firebase-phone
                     │ { firebaseIdToken: "..." }
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                         BACKEND                                  │
│                                                                  │
│  7. Verify Firebase ID token with Admin SDK                     │
│                    │                                             │
│                    ▼                                             │
│  8. Extract phone number from verified token                    │
│                    │                                             │
│                    ▼                                             │
│  9. Create/update user in database                              │
│                    │                                             │
│                    ▼                                             │
│  10. Generate JWT tokens (accessToken, refreshToken)            │
│                    │                                             │
│                    ▼                                             │
│  11. Return user profile + tokens                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT SIDE                              │
│                                                                  │
│  12. Store JWT tokens for API calls                             │
│                    │                                             │
│                    ▼                                             │
│  13. Use accessToken for authenticated requests                 │
│      Authorization: Bearer <accessToken>                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Security Considerations

### Token Verification

The backend verifies Firebase ID tokens using:
- Official Firebase Admin SDK
- Token signature validation
- Token expiration check
- Optional: Check if token was revoked

### Phone Number Trust

- Phone number is extracted from **verified** Firebase token
- Firebase already verified the phone ownership
- Backend trusts Firebase's verification

### Token Storage

- Firebase UID stored in User model (`firebaseUid`)
- Links Firebase account to backend user
- Enables token revocation if needed

## Fallback to Twilio

If Firebase is not configured, the existing Twilio-based OTP system remains available:

```
POST /api/auth/send-otp     # Send OTP via Twilio
POST /api/auth/verify-otp   # Verify OTP
```

The client can check which auth methods are available:
```
GET /api/auth/firebase-status  # Check Firebase availability
```

## Testing

### Test Phone Numbers (Firebase Console)

In Firebase Console > Authentication > Phone, add test phone numbers:
- `+91 9999900001` → OTP: `123456`
- `+91 9999900002` → OTP: `654321`

These bypass actual SMS sending for testing.

### Development Mode

In development, if Firebase is not configured:
- Use Twilio fallback
- Or use fixed OTP `123456` (dev mode only)

## Troubleshooting

### "Firebase not configured" Error

Check that one of these is set:
- `FIREBASE_SERVICE_ACCOUNT_PATH`
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `FIREBASE_PROJECT_ID` + `FIREBASE_PRIVATE_KEY` + `FIREBASE_CLIENT_EMAIL`

### "Phone number not found in Firebase token" Error

Ensure the Firebase ID token was obtained after phone verification, not after email or anonymous sign-in.

### "Token verification failed" Error

- Token may be expired (default: 1 hour)
- Token may be malformed
- Project ID mismatch between client and backend

### Rate Limiting

Firebase has built-in rate limiting:
- 10K verifications/month on free tier
- Automatic abuse detection
- reCAPTCHA for web clients

## Cost Comparison

### Firebase Auth (Phone)
- **Free tier**: 10,000 verifications/month
- **Spark plan**: $0.01/verification after free tier
- No SMS cost (Firebase uses their own SMS gateway)

### Twilio Verify
- **Per verification**: ~$0.05
- 10K verifications = ~$500/month

### Savings
Using Firebase saves approximately **$500/month** for 10K verifications, with additional built-in security features.
