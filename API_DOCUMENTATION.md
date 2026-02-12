# Raahi Backend API Documentation

## Gateway Service

**Base URL:** `http://localhost:3000` (or configured PORT)

### Health Check
- **GET** `/health`
- **Description:** Gateway health check
- **Authentication:** None
- **Response:**
```json
{
  "status": "OK",
  "service": "api-gateway",
  "timestamp": "2026-02-10T...",
  "uptime": 123.45
}
```

### Route Proxies
The gateway proxies requests to microservices:
- `/api/auth/*` → Auth Service (port 5001)
- `/api/user/*` → User Service (port 5002)
- `/api/driver/*` → Driver Service (port 5003)
- `/api/rides/*` → Ride Service (port 5004)
- `/api/pricing/*` → Pricing Service (port 5005)
- `/api/notifications/*` → Notification Service (port 5006)
- `/api/realtime/*` → Realtime Service (port 5007)
- `/api/admin/*` → Admin Service (port 5008)
- `/uploads/*` → Driver Service (port 5003)
- `/socket.io/*` → Realtime Service WebSocket (port 5007)

**Note:** `/internal/*` routes are blocked by the gateway (403 Forbidden)

---

## Auth Service

**Base Path:** `/api/auth`

### Send OTP
- **POST** `/api/auth/send-otp`
- **Description:** Send OTP to phone number for authentication. Uses Twilio Verify API if configured, otherwise logs OTP to console.
- **Authentication:** None
- **Request Body:**
```json
{
  "phone": "9876543210",
  "countryCode": "+91"
}
```
- **Response:**
```json
{
  "success": true,
  "message": "OTP sent successfully"
}
```

### Verify OTP
- **POST** `/api/auth/verify-otp`
- **Description:** Verify OTP and authenticate user. Returns JWT tokens.
- **Authentication:** None
- **Request Body:**
```json
{
  "phone": "9876543210",
  "otp": "123456",
  "countryCode": "+91"
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Authentication successful",
  "data": {
    "user": {
      "id": "user-id",
      "email": "user@example.com",
      "phone": "+919876543210",
      "firstName": "John",
      "lastName": "Doe",
      "profileImage": "url",
      "isVerified": true,
      "isActive": true,
      "createdAt": "2026-02-10T...",
      "lastLoginAt": "2026-02-10T..."
    },
    "accessToken": "jwt-token",
    "refreshToken": "refresh-token",
    "expiresIn": 604800
  }
}
```

### Google Authentication
- **POST** `/api/auth/google`
- **Description:** Authenticate using Google ID token
- **Authentication:** None
- **Request Body:**
```json
{
  "idToken": "google-id-token"
}
```
- **Response:** Same as Verify OTP

### Truecaller Authentication
- **POST** `/api/auth/truecaller`
- **Description:** Authenticate using Truecaller token
- **Authentication:** None
- **Request Body:**
```json
{
  "phone": "+919876543210",
  "truecallerToken": "truecaller-token"
}
```
- **Response:** Same as Verify OTP

### Refresh Token
- **POST** `/api/auth/refresh`
- **Description:** Refresh access token using refresh token
- **Authentication:** None
- **Request Body:**
```json
{
  "refreshToken": "refresh-token"
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Token refreshed successfully",
  "data": {
    "accessToken": "new-jwt-token",
    "expiresIn": 604800
  }
}
```

### Logout
- **POST** `/api/auth/logout`
- **Description:** Logout user and invalidate refresh token
- **Authentication:** Required (Bearer token)
- **Request Body:**
```json
{
  "refreshToken": "refresh-token"
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Logout successful"
}
```

### Get Current User
- **GET** `/api/auth/me`
- **Description:** Get authenticated user profile
- **Authentication:** Required (Bearer token)
- **Response:**
```json
{
  "success": true,
  "data": {
    "user": { /* user object */ }
  }
}
```

### Update Profile
- **PUT** `/api/auth/profile`
- **Description:** Update user profile information
- **Authentication:** Required (Bearer token)
- **Request Body:**
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@example.com",
  "profileImage": "url"
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Profile updated successfully",
  "data": {
    "user": { /* updated user object */ }
  }
}
```

---

## User Service

**Base Path:** `/api/user`

### Get User Profile
- **GET** `/api/user/profile`
- **Description:** Get user profile
- **Authentication:** Required (Bearer token)
- **Response:**
```json
{
  "message": "User profile endpoint",
  "userId": "user-id"
}
```

---

## Driver Service

**Base Path:** `/api/driver`

### Get Driver Profile
- **GET** `/api/driver/profile`
- **Description:** Get complete driver profile with documents, earnings, and status
- **Authentication:** Required (Driver Bearer token)
- **Response:**
```json
{
  "success": true,
  "data": {
    "driver_id": "driver-id",
    "email": "driver@example.com",
    "name": "John Doe",
    "phone": "+919876543210",
    "license_number": "DL123456",
    "vehicle_info": {
      "make": "Toyota",
      "model": "Camry",
      "year": 2020,
      "license_plate": "ABC123",
      "color": "White"
    },
    "documents": {
      "license_verified": true,
      "insurance_verified": true,
      "vehicle_registration_verified": true,
      "all_verified": true,
      "pending_count": 0
    },
    "onboarding": {
      "status": "COMPLETED",
      "is_verified": true,
      "documents_submitted": true,
      "documents_verified": true,
      "can_start_rides": true,
      "verification_notes": "All documents verified"
    },
    "status": "active",
    "rating": 4.5,
    "total_trips": 150,
    "earnings": {
      "today": 500,
      "week": 3500,
      "month": 15000,
      "total": 50000
    },
    "is_online": true,
    "current_location": {
      "latitude": 28.6139,
      "longitude": 77.209
    }
  }
}
```

### Update Driver Status
- **PATCH** `/api/driver/status`
- **Description:** Update driver online/offline status and location. **Stop Riding penalty:** When driver goes from online to offline ("Stop Riding"), a penalty of ₹10 (or `PENALTY_STOP_RIDING_AMOUNT`) is created. The driver **cannot go online again** until the penalty is paid (see POST /api/driver/penalties/pay). If they try to set `online: true` with unpaid penalties, the API returns **403** with `code: PENALTY_UNPAID`.
- **Authentication:** Required (Driver Bearer token)
- **Request Body:**
```json
{
  "online": true,
  "location": {
    "latitude": 28.6139,
    "longitude": 77.209
  }
}
```
- **Response (success):**
```json
{
  "success": true,
  "message": "Driver is now online",
  "data": {
    "driver_id": "driver-id",
    "online": true,
    "last_seen": "2026-02-10T...",
    "location": {
      "latitude": 28.6139,
      "longitude": 77.209
    },
    "status_verified": true,
    "status_change_timestamp": "2026-02-10T..."
  }
}
```
- **Response (403 when penalty unpaid):**
```json
{
  "success": false,
  "message": "Pay penalty of ₹10 to start riding again. You were charged for stopping mid-day.",
  "code": "PENALTY_UNPAID",
  "penaltyDue": 10,
  "unpaidCount": 1
}
```

### Get Driver Penalties
- **GET** `/api/driver/penalties`
- **Description:** List driver penalties. Optional query `?status=PENDING` or `?status=PAID`. Used to show "Pay ₹10 to go online" in the app.
- **Authentication:** Required (Driver Bearer token)
- **Response:**
```json
{
  "success": true,
  "data": {
    "penalties": [
      {
        "id": "penalty-id",
        "amount": 10,
        "reason": "STOP_RIDING",
        "status": "PENDING",
        "createdAt": "2026-02-10T...",
        "paidAt": null
      }
    ],
    "unpaidTotal": 10,
    "canGoOnline": false
  }
}
```

### Pay Driver Penalties
- **POST** `/api/driver/penalties/pay`
- **Description:** Mark all unpaid penalties as paid. After this, the driver can go online again (PATCH /api/driver/status with `online: true`).
- **Authentication:** Required (Driver Bearer token)
- **Response:**
```json
{
  "success": true,
  "message": "Penalty of ₹10 paid. You can go online now.",
  "data": { "paidCount": 1, "totalPaid": 10 }
}
```

### Get Driver Earnings
- **GET** `/api/driver/earnings`
- **Description:** Get driver earnings breakdown (today, week, month, total)
- **Authentication:** Required (Driver Bearer token)
- **Response:**
```json
{
  "success": true,
  "data": {
    "today": {
      "amount": 500,
      "trips": 5,
      "hours_online": 6.5,
      "average_per_trip": 100
    },
    "week": {
      "amount": 3500,
      "trips": 35,
      "hours_online": 42,
      "average_per_trip": 100
    },
    "month": {
      "amount": 15000,
      "trips": 150,
      "hours_online": 168,
      "average_per_trip": 100
    },
    "total": {
      "amount": 50000,
      "trips": 500,
      "hours_online": 420,
      "average_per_trip": 100
    },
    "breakdown": {
      "base_fare": 5000,
      "distance_fare": 35000,
      "time_fare": 7500,
      "surge_bonus": 2500
    }
  }
}
```

### Get Driver Trips
- **GET** `/api/driver/trips`
- **Description:** Get paginated list of driver trips
- **Authentication:** Required (Driver Bearer token)
- **Query Parameters:**
  - `page` (optional, default: 1)
  - `limit` (optional, default: 10)
- **Response:**
```json
{
  "success": true,
  "data": {
    "trips": [
      {
        "trip_id": "ride-id",
        "passenger_name": "Jane Doe",
        "passenger_phone": "+919876543210",
        "pickup_address": "123 Main St",
        "drop_address": "456 Oak Ave",
        "distance": 5.2,
        "duration": 15,
        "fare": 150,
        "status": "ride_completed",
        "rating": 4.5,
        "created_at": "2026-02-10T..."
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 150,
      "totalPages": 15,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

### Submit Support Request
- **POST** `/api/driver/support`
- **Description:** Submit a support request
- **Authentication:** Required (Driver Bearer token)
- **Request Body:**
```json
{
  "issue_type": "payment",
  "description": "Issue description",
  "priority": "high"
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Support request submitted successfully",
  "data": {
    "request_id": "support_1234567890",
    "driver_id": "driver-id",
    "issue_type": "payment",
    "description": "Issue description",
    "priority": "high",
    "status": "submitted",
    "created_at": "2026-02-10T..."
  }
}
```

### Start Driver Onboarding
- **POST** `/api/driver/onboarding/start`
- **Description:** Start driver onboarding process
- **Authentication:** Required (Bearer token)
- **Response:**
```json
{
  "success": true,
  "message": "Driver onboarding started",
  "data": {
    "driver_id": "driver-id",
    "onboarding_status": "EMAIL_COLLECTION",
    "current_step": "EMAIL_COLLECTION"
  }
}
```

### Update Language Preference
- **PUT** `/api/driver/onboarding/language`
- **Description:** Update driver language preference
- **Authentication:** Required (Bearer token)
- **Request Body:**
```json
{
  "language": "en"
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Language preference saved",
  "data": {
    "driver_id": "driver-id",
    "language": "en",
    "next_step": "EARNING_SETUP"
  }
}
```

### Update Vehicle Information
- **PUT** `/api/driver/onboarding/vehicle`
- **Description:** Update vehicle type and service types
- **Authentication:** Required (Bearer token)
- **Request Body:**
```json
{
  "vehicleType": "sedan",
  "serviceTypes": ["standard", "premium"]
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Vehicle information saved",
  "data": {
    "driver_id": "driver-id",
    "vehicle_type": "sedan",
    "service_types": ["standard", "premium"],
    "next_step": "LICENSE_UPLOAD"
  }
}
```

### Upload Document
- **POST** `/api/driver/onboarding/document/upload`
- **Description:** Upload driver document (license, RC, insurance, etc.)
- **Authentication:** Required (Bearer token)
- **Content-Type:** `multipart/form-data`
- **Request Body:**
  - `document` (file): Document file (PNG, JPG, JPEG, PDF, max 10MB)
  - `documentType` (string): LICENSE, RC, INSURANCE, PAN_CARD, AADHAAR_CARD, PROFILE_PHOTO
- **Response:**
```json
{
  "success": true,
  "message": "Document uploaded successfully",
  "data": {
    "document_id": "doc-id",
    "document_type": "LICENSE",
    "document_url": "/uploads/driver-documents/license-1234567890.jpg",
    "uploaded_at": "2026-02-10T...",
    "next_step": "PROFILE_PHOTO"
  }
}
```

### Submit Documents for Verification
- **POST** `/api/driver/onboarding/documents/submit`
- **Description:** Submit all uploaded documents for verification
- **Authentication:** Required (Bearer token)
- **Response:**
```json
{
  "success": true,
  "message": "Documents submitted for verification",
  "data": {
    "driver_id": "driver-id",
    "status": "DOCUMENT_VERIFICATION",
    "submitted_at": "2026-02-10T...",
    "estimated_verification_time": "24-48 hours"
  }
}
```

### Get Onboarding Status
- **GET** `/api/driver/onboarding/status`
- **Description:** Get current driver onboarding status
- **Authentication:** Required (Bearer token)
- **Response:**
```json
{
  "success": true,
  "data": {
    "driver_id": "driver-id",
    "onboarding_status": "DOCUMENT_VERIFICATION",
    "current_step": "DOCUMENT_VERIFICATION",
    "is_verified": false,
    "documents_submitted": true,
    "documents_verified": false,
    "pending_documents": [
      {
        "type": "LICENSE",
        "uploaded_at": "2026-02-10T..."
      }
    ],
    "can_start_rides": false,
    "verification_notes": null
  }
}
```

---

## Ride Service

**Base Path:** `/api/rides`

### Create Ride
- **POST** `/api/rides`
- **Description:** Create a new ride request. Generates a 4-digit OTP for the passenger.
- **Authentication:** Required (Bearer token)
- **Request Body:**
```json
{
  "pickupLat": 28.6139,
  "pickupLng": 77.209,
  "dropLat": 28.5355,
  "dropLng": 77.3910,
  "pickupAddress": "123 Main St",
  "dropAddress": "456 Oak Ave",
  "paymentMethod": "UPI",
  "scheduledTime": "2026-02-10T18:00:00Z",
  "vehicleType": "sedan"
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Ride created successfully",
  "data": {
    "id": "ride-id",
    "passengerId": "user-id",
    "driverId": null,
    "pickupLat": 28.6139,
    "pickupLng": 77.209,
    "dropLat": 28.5355,
    "dropLng": 77.3910,
    "pickupAddress": "123 Main St",
    "dropAddress": "456 Oak Ave",
    "distance": 5.2,
    "duration": 15,
    "baseFare": 25,
    "distanceFare": 62.4,
    "timeFare": 30,
    "surgeMultiplier": 1.0,
    "totalFare": 117.4,
    "status": "PENDING",
    "paymentMethod": "UPI",
    "paymentStatus": "PENDING",
    "rideOtp": "1234",
    "scheduledAt": null,
    "createdAt": "2026-02-10T..."
  }
}
```

### Get User Rides
- **GET** `/api/rides`
- **Description:** Get paginated list of user's rides
- **Authentication:** Required (Bearer token)
- **Query Parameters:**
  - `page` (optional, default: 1)
  - `limit` (optional, default: 10, max: 50)
- **Response:**
```json
{
  "success": true,
  "data": {
    "rides": [ /* ride objects */ ],
    "total": 50,
    "page": 1,
    "totalPages": 5
  }
}
```

### Get Available Rides (Driver)
- **GET** `/api/rides/available`
- **Description:** Get available rides for driver near their location
- **Authentication:** Required (Driver Bearer token)
- **Query Parameters:**
  - `lat` (required): Driver latitude
  - `lng` (required): Driver longitude
  - `radius` (optional, default: 10): Search radius in km (1-50)
- **Response:**
```json
{
  "success": true,
  "data": {
    "rides": [
      {
        "id": "ride-id",
        "ride_type": "cab",
        "earning": 93.92,
        "pickup_distance": "2.5 km",
        "pickup_time": "8 min",
        "drop_distance": "5.2 km",
        "drop_time": "15 min",
        "pickup_address": "123 Main St",
        "drop_address": "456 Oak Ave",
        "pickup_location": { "lat": 28.6139, "lng": 77.209 },
        "destination_location": { "lat": 28.5355, "lng": 77.3910 },
        "rider_name": "Jane Doe",
        "rider_phone": "+919876543210",
        "otp": "1234",
        "is_golden": false,
        "created_at": "2026-02-10T...",
        "total_fare": 117.4
      }
    ],
    "total": 5
  }
}
```

### Get Ride by ID
- **GET** `/api/rides/:id`
- **Description:** Get ride details by ID (passenger sees OTP, driver doesn't)
- **Authentication:** Required (Bearer token)
- **Response:**
```json
{
  "success": true,
  "data": {
    "id": "ride-id",
    "passengerId": "user-id",
    "driverId": "driver-id",
    "pickupLat": 28.6139,
    "pickupLng": 77.209,
    "dropLat": 28.5355,
    "dropLng": 77.3910,
    "pickupAddress": "123 Main St",
    "dropAddress": "456 Oak Ave",
    "distance": 5.2,
    "duration": 15,
    "baseFare": 25,
    "distanceFare": 62.4,
    "timeFare": 30,
    "surgeMultiplier": 1.0,
    "totalFare": 117.4,
    "status": "DRIVER_ASSIGNED",
    "paymentMethod": "UPI",
    "paymentStatus": "PENDING",
    "rideOtp": "1234",
    "driver": {
      "id": "driver-id",
      "firstName": "John",
      "lastName": "Doe",
      "profileImage": "url",
      "rating": 4.5,
      "vehicleNumber": "ABC123",
      "vehicleModel": "Toyota Camry",
      "phone": "+919876543210"
    },
    "passenger": {
      "id": "user-id",
      "firstName": "Jane",
      "lastName": "Doe",
      "phone": "+919876543210",
      "email": "jane@example.com"
    },
    "createdAt": "2026-02-10T..."
  }
}
```

### Accept Ride (Driver)
- **POST** `/api/rides/:id/accept`
- **Description:** Driver accepts a ride request
- **Authentication:** Required (Driver Bearer token)
- **Response:**
```json
{
  "success": true,
  "message": "Ride accepted successfully",
  "data": { /* ride object */ }
}
```

### Start Ride
- **POST** `/api/rides/:id/start`
- **Description:** Start ride with OTP verification (driver must enter passenger's OTP)
- **Authentication:** Required (Driver Bearer token)
- **Request Body:**
```json
{
  "otp": "1234"
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Ride started successfully",
  "data": { /* ride object with status RIDE_STARTED */ }
}
```

### Update Ride Status
- **PUT** `/api/rides/:id/status`
- **Description:** Update ride status
- **Authentication:** Required (Bearer token)
- **Request Body:**
```json
{
  "status": "DRIVER_ARRIVED",
  "cancellationReason": "Reason",
  "otp": "1234"
}
```
- **Valid Status Values:**
  - `CONFIRMED` - Ride confirmed
  - `DRIVER_ARRIVED` - Driver arrived at pickup
  - `RIDE_STARTED` - Ride started (requires OTP)
  - `RIDE_COMPLETED` - Ride completed
  - `CANCELLED` - Ride cancelled (requires cancellationReason)
- **Response:**
```json
{
  "success": true,
  "message": "Ride status updated successfully",
  "data": { /* updated ride object */ }
}
```

### Cancel Ride
- **POST** `/api/rides/:id/cancel`
- **Description:** Cancel a ride
- **Authentication:** Required (Bearer token)
- **Request Body:**
```json
{
  "reason": "Change of plans"
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Ride cancelled successfully",
  "data": { /* ride object with status CANCELLED */ }
}
```

### Submit Ride Rating
- **POST** `/api/rides/:id/rating`
- **Description:** Submit rating and feedback for a completed ride
- **Authentication:** Required (Bearer token)
- **Request Body:**
```json
{
  "rating": 4.5,
  "feedback": "Great driver!"
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Rating submitted successfully",
  "data": { /* updated ride object */ }
}
```

### Get Ride Receipt
- **GET** `/api/rides/:id/receipt`
- **Description:** Get ride receipt/invoice
- **Authentication:** Required (Bearer token - passenger or driver)
- **Response:**
```json
{
  "success": true,
  "data": {
    "rideId": "ride-id",
    "receiptNumber": "RCP-12345678",
    "passenger": {
      "id": "user-id",
      "name": "Jane Doe"
    },
    "driver": {
      "id": "driver-id",
      "name": "John Doe",
      "vehicleNumber": "ABC123",
      "vehicleModel": "Toyota Camry"
    },
    "pickup": {
      "address": "123 Main St",
      "latitude": 28.6139,
      "longitude": 77.209
    },
    "drop": {
      "address": "456 Oak Ave",
      "latitude": 28.5355,
      "longitude": 77.3910
    },
    "distance": 5.2,
    "duration": 15,
    "fare": {
      "baseFare": 25,
      "distanceFare": 62.4,
      "timeFare": 30,
      "surgeMultiplier": 1.0,
      "totalFare": 117.4
    },
    "paymentMethod": "UPI",
    "paymentStatus": "PAID",
    "status": "RIDE_COMPLETED",
    "timestamps": {
      "created": "2026-02-10T...",
      "started": "2026-02-10T...",
      "completed": "2026-02-10T..."
    }
  }
}
```

### Get Ride Messages
- **GET** `/api/rides/:id/messages`
- **Description:** Get chat messages for a ride
- **Authentication:** Required (Bearer token - passenger or driver)
- **Response:**
```json
{
  "success": true,
  "data": {
    "messages": [
      {
        "id": "msg-id",
        "rideId": "ride-id",
        "senderId": "user-id",
        "message": "Hello",
        "timestamp": "2026-02-10T..."
      }
    ]
  }
}
```

### Send Ride Message
- **POST** `/api/rides/:id/messages`
- **Description:** Send a chat message in a ride. The message is persisted and broadcast to the ride room so the other party receives it in real time (listen for Socket.io event `ride-chat-message`). Both parties should join the ride room with `join-ride` (rideId) for live chat.
- **Authentication:** Required (Bearer token - passenger or driver)
- **Request Body:**
```json
{
  "message": "Hello, I'm on my way"
}
```
- **Response:**
```json
{
  "success": true,
  "data": {
    "message": {
      "id": "msg-id",
      "rideId": "ride-id",
      "senderId": "user-id",
      "message": "Hello, I'm on my way",
      "timestamp": "2026-02-10T..."
    }
  }
}
```

### Report Emergency (Safety)
- **POST** `/api/rides/:id/emergency`
- **Description:** Report a safety/emergency during the ride. Notifies the other party (driver or passenger) via a SYSTEM notification and logs the event.
- **Authentication:** Required (Bearer token - passenger or driver of the ride)
- **Request Body:**
```json
{
  "reason": "Optional description"
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Safety alert sent",
  "data": { "rideId": "..." }
}
```

### Share Ride (create link)
- **POST** `/api/rides/:id/share`
- **Description:** Create a shareable link for this ride (e.g. to share with family). Returns a token and URL valid for 24 hours. Only passenger or driver can create.
- **Authentication:** Required (Bearer token - passenger or driver)
- **Response:**
```json
{
  "success": true,
  "message": "Share link created",
  "data": {
    "shareToken": "uuid",
    "shareUrl": "https://app.raahi.com/ride/share/uuid",
    "expiresAt": "2026-02-11T..."
  }
}
```

### Get shared ride (public)
- **GET** `/api/rides/share/:token`
- **Description:** Public endpoint (no auth). Returns minimal ride info for a share token: status, pickup/drop addresses, driver name/vehicle. No phone numbers. 404 if token invalid or expired.
- **Response:**
```json
{
  "success": true,
  "data": {
    "rideId": "...",
    "status": "DRIVER_ARRIVED",
    "pickupAddress": "...",
    "dropAddress": "...",
    "pickup": { "lat": 28.61, "lng": 77.20 },
    "drop": { "lat": 28.53, "lng": 77.39 },
    "createdAt": "...",
    "driver": { "name": "...", "vehicleNumber": "...", "vehicleModel": "..." }
  }
}
```

### Track Driver Location
- **POST** `/api/rides/:id/track`
- **Description:** Update driver location during ride (for tracking)
- **Authentication:** Required (Driver Bearer token)
- **Request Body:**
```json
{
  "lat": 28.6139,
  "lng": 77.209,
  "heading": 90,
  "speed": 45
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Location updated successfully"
}
```

### Assign Driver to Ride
- **POST** `/api/rides/:id/assign-driver`
- **Description:** Assign a driver to a ride (admin/internal use)
- **Authentication:** Required (Bearer token)
- **Request Body:**
```json
{
  "driverId": "driver-id"
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Driver assigned successfully",
  "data": { /* ride object */ }
}
```

---

## Pricing Service

**Base Path:** `/api/pricing`

### Calculate Fare
- **POST** `/api/pricing/calculate`
- **Description:** Calculate ride fare based on pickup and drop locations
- **Authentication:** Optional
- **Request Body:**
```json
{
  "pickupLat": 28.6139,
  "pickupLng": 77.209,
  "dropLat": 28.5355,
  "dropLng": 77.3910,
  "vehicleType": "sedan",
  "scheduledTime": "2026-02-10T18:00:00Z"
}
```
- **Response:**
```json
{
  "success": true,
  "data": {
    "distance": 5.2,
    "estimatedDuration": 15,
    "baseFare": 25,
    "distanceFare": 62.4,
    "timeFare": 30,
    "surgeMultiplier": 1.0,
    "totalFare": 117.4,
    "breakdown": {
      "base": 25,
      "distance": 62.4,
      "time": 30,
      "surge": 0
    }
  }
}
```

### Get Nearby Drivers
- **GET** `/api/pricing/nearby-drivers`
- **Description:** Get nearby available drivers
- **Authentication:** Optional
- **Query Parameters:**
  - `lat` (required): Latitude
  - `lng` (required): Longitude
  - `radius` (optional, default: 5): Search radius in km (1-50)
- **Response:**
```json
{
  "success": true,
  "data": {
    "drivers": [
      {
        "id": "driver-id",
        "name": "John Doe",
        "rating": 4.5,
        "vehicleModel": "Toyota Camry",
        "vehicleNumber": "ABC123",
        "distance": 2.5,
        "eta": 8
      }
    ],
    "count": 5,
    "radius": 5
  }
}
```

### Get Surge Areas
- **GET** `/api/pricing/surge-areas`
- **Description:** Get active surge pricing areas
- **Authentication:** None
- **Response:**
```json
{
  "success": true,
  "data": {
    "surgeAreas": [
      {
        "id": "area-id",
        "name": "Downtown",
        "centerLatitude": 28.6139,
        "centerLongitude": 77.209,
        "radius": 2.5,
        "multiplier": 1.5
      }
    ],
    "count": 3
  }
}
```

### Get Pricing Rules
- **GET** `/api/pricing/rules`
- **Description:** Get current pricing rules and rates
- **Authentication:** None
- **Response:**
```json
{
  "success": true,
  "data": {
    "baseFare": 25,
    "perKmRate": 12,
    "perMinuteRate": 2,
    "surgeMultiplier": 1.0,
    "peakHourMultiplier": 1.0
  }
}
```

---

## Notification Service

**Base Path:** `/api/notifications`

### Get Notifications
- **GET** `/api/notifications`
- **Description:** Get user notifications
- **Authentication:** Required (Bearer token)
- **Response:**
```json
{
  "message": "Notifications endpoint",
  "userId": "user-id"
}
```

---

## Realtime Service

**Base Path:** `/api/realtime`

### WebSocket Connection
- **WebSocket** `/socket.io`
- **Description:** Socket.io connection for real-time updates

#### Client Events (Emit)
| Event | Payload | Description |
|-------|---------|-------------|
| `join-ride` | `rideId` | Join ride room for updates |
| `leave-ride` | `rideId` | Leave ride room |
| `join-driver` | `driverId/userId` | Driver joins to receive ride requests |
| `leave-driver` | `driverId/userId` | Driver leaves |
| `driver-online` | `driverId/userId` | Driver goes online |
| `driver-offline` | `driverId/userId` | Driver goes offline |
| `accept-ride-request` | `{ rideId, driverId }` | Driver accepts ride |
| `driver-arrived` | `{ rideId, driverId }` | Driver arrived at pickup |
| `location-update` | `{ rideId, lat, lng, heading?, speed? }` | Update driver location |
| `ping` | - | Heartbeat ping |
| `get-stats` | - | Get connection statistics |

#### Server Events (Listen)
| Event | Payload | Description |
|-------|---------|-------------|
| `new-ride-request` | Ride data | New ride request for driver |
| `ride-status-update` | `{ rideId, status }` | Ride status changed |
| `ride-chat-message` | `{ rideId, message: { id, senderId, message, timestamp } }` | New in-ride chat message |
| `driver-location` | `{ lat, lng, heading, speed }` | Driver location update |
| `ride-taken` | `{ rideId }` | Ride was taken by another driver |
| `registration-success` | `{ driverId, rooms }` | Driver registration successful |
| `registration-error` | `{ message }` | Driver registration failed |
| `pong` | - | Heartbeat response |

### Get Realtime Statistics
- **GET** `/api/realtime/stats`
- **Description:** Get real-time service statistics
- **Authentication:** Optional
- **Response:**
```json
{
  "success": true,
  "data": {
    "connectedDrivers": 10,
    "activeRides": 5,
    "totalConnections": 25
  }
}
```

### Debug Connections
- **GET** `/api/realtime/debug/connections`
- **Description:** Get detailed socket connection state (debug endpoint)
- **Authentication:** None
- **Response:**
```json
{
  "success": true,
  "data": {
    "socketState": {
      "totalConnections": 25,
      "uniqueDriversConnected": 10,
      "availableDriversRoomSize": 8,
      "connectedDrivers": [
        {
          "driverId": "driver-id",
          "socketIds": ["socket-id-1"],
          "inDriverRoom": true,
          "inAvailableRoom": true
        }
      ]
    },
    "dbState": {
      "onlineDriversInDb": 10,
      "drivers": [ /* driver objects */ ]
    },
    "inconsistencies": [],
    "timestamp": "2026-02-10T..."
  }
}
```

### Get Location Statistics
- **GET** `/api/realtime/location-stats`
- **Description:** Get statistics for drivers in a specific location
- **Authentication:** Optional
- **Query Parameters:**
  - `lat` (required): Latitude
  - `lng` (required): Longitude
  - `radius` (optional, default: 5): Radius in km (0.1-50)
- **Response:**
```json
{
  "success": true,
  "data": {
    "driversInRadius": 5,
    "averageRating": 4.5,
    "averageEta": 8
  }
}
```

### Update Driver Location
- **POST** `/api/realtime/update-driver-location`
- **Description:** Update driver location in real-time service
- **Authentication:** Optional
- **Request Body:**
```json
{
  "driverId": "driver-id",
  "lat": 28.6139,
  "lng": 77.209,
  "heading": 90,
  "speed": 45
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Driver location updated successfully"
}
```

### Get Driver Heatmap
- **GET** `/api/realtime/driver-heatmap`
- **Description:** Get driver location heatmap data
- **Authentication:** Optional
- **Response:**
```json
{
  "success": true,
  "data": {
    "heatmap": [
      {
        "lat": 28.6139,
        "lng": 77.209,
        "intensity": 10
      }
    ]
  }
}
```

### Get Demand Hotspots
- **GET** `/api/realtime/demand-hotspots`
- **Description:** Get demand hotspots for rides
- **Authentication:** Optional
- **Response:**
```json
{
  "success": true,
  "data": {
    "hotspots": [
      {
        "lat": 28.6139,
        "lng": 77.209,
        "demand": "high",
        "count": 15
      }
    ]
  }
}
```

---

## Admin Service

**Base Path:** `/api/admin`

> **Note:** All admin endpoints require admin authentication

### Get All Drivers
- **GET** `/api/admin/drivers`
- **Description:** Get paginated list of all drivers with filters
- **Authentication:** Required (Admin Bearer token)
- **Query Parameters:**
  - `status` (optional): Onboarding status filter
  - `search` (optional): Search by name, email, phone
  - `limit` (optional, default: 100)
  - `offset` (optional, default: 0)
  - `filter` (optional): "all", "pending", "verified", "rejected"
- **Response:**
```json
{
  "success": true,
  "data": {
    "drivers": [ /* formatted driver objects */ ],
    "pagination": {
      "total": 150,
      "limit": 100,
      "offset": 0,
      "has_more": true
    }
  }
}
```

### Get Pending Drivers
- **GET** `/api/admin/drivers/pending`
- **Description:** Get drivers with pending document verification
- **Authentication:** Required (Admin Bearer token)
- **Query Parameters:**
  - `status` (optional): Onboarding status
  - `search` (optional): Search term
  - `limit` (optional, default: 50)
  - `offset` (optional, default: 0)
- **Response:**
```json
{
  "success": true,
  "data": {
    "drivers": [ /* driver objects */ ],
    "pagination": { /* pagination object */ }
  }
}
```

### Get Driver Details
- **GET** `/api/admin/drivers/:driverId`
- **Description:** Get detailed driver information
- **Authentication:** Required (Admin Bearer token)
- **Response:**
```json
{
  "success": true,
  "data": {
    "driver_id": "driver-id",
    "user": {
      "id": "user-id",
      "name": "John Doe",
      "email": "john@example.com",
      "phone": "+919876543210",
      "created_at": "2026-02-10T..."
    },
    "onboarding_status": "DOCUMENT_VERIFICATION",
    "vehicle_info": {
      "type": "sedan",
      "model": "Toyota Camry",
      "number": "ABC123",
      "color": "White",
      "year": 2020,
      "license_number": "DL123456",
      "license_expiry": "2028-12-31"
    },
    "documents": [ /* document objects */ ],
    "documents_summary": {
      "total": 5,
      "verified": 3,
      "pending": 2,
      "rejected": 0,
      "all_verified": false
    },
    "documents_verified": false,
    "current_latitude": 28.6139,
    "current_longitude": 77.209,
    "is_verified": false,
    "is_online": false,
    "rating": 0,
    "total_trips": 0
  }
}
```

### Verify Document
- **POST** `/api/admin/documents/:documentId/verify`
- **Description:** Approve or reject a driver document
- **Authentication:** Required (Admin Bearer token)
- **Request Body:**
```json
{
  "approved": true,
  "rejection_reason": "Document unclear"
}
```
- **Response:**
```json
{
  "success": true,
  "message": "Document approved successfully",
  "data": {
    "document_id": "doc-id",
    "document_type": "LICENSE",
    "is_verified": true,
    "driver_status": {
      "all_documents_verified": true,
      "onboarding_status": "COMPLETED",
      "is_verified": true,
      "can_start_rides": true
    }
  }
}
```

### Verify All Driver Documents
- **POST** `/api/admin/drivers/:driverId/verify-all`
- **Description:** Approve or reject all documents for a driver
- **Authentication:** Required (Admin Bearer token)
- **Request Body:**
```json
{
  "approved": true,
  "notes": "All documents verified"
}
```
- **Response:**
```json
{
  "success": true,
  "message": "All documents approved successfully",
  "data": {
    "driver_id": "driver-id",
    "documents_updated": 5,
    "onboarding_status": "COMPLETED",
    "is_verified": true,
    "can_start_rides": true,
    "verification_notes": "All documents verified. You can now start accepting rides!"
  }
}
```

### Get Statistics
- **GET** `/api/admin/statistics`
- **Description:** Get admin dashboard statistics
- **Authentication:** Required (Admin Bearer token)
- **Response:**
```json
{
  "success": true,
  "data": {
    "drivers": {
      "total": 150,
      "verified": 100,
      "pending_verification": 40,
      "rejected": 10
    },
    "documents": {
      "total": 750,
      "verified": 500,
      "pending": 200
    }
  }
}
```

---

## Authentication

Most endpoints require authentication via Bearer token in the Authorization header:

```
Authorization: Bearer <jwt-access-token>
```

- **User endpoints:** Require a valid user JWT token
- **Driver endpoints:** Require a JWT token from a user with a driver profile
- **Admin endpoints:** Require a JWT token from an admin user (check `ADMIN_EMAILS` env var)

---

## Error Responses

All endpoints follow a consistent error format:

```json
{
  "success": false,
  "message": "Error message",
  "errors": [ /* validation errors if any */ ]
}
```

### HTTP Status Codes

| Code | Description |
|------|-------------|
| `200` | Success |
| `201` | Created |
| `400` | Bad Request (validation errors) |
| `401` | Unauthorized (missing/invalid token) |
| `403` | Forbidden (insufficient permissions) |
| `404` | Not Found |
| `409` | Conflict (e.g., ride already taken) |
| `500` | Internal Server Error |
| `502` | Bad Gateway (service unavailable) |

---

## Notes

1. All timestamps are in ISO 8601 format (UTC)
2. All monetary values are in INR (₹)
3. Distances are in kilometers
4. Durations are in minutes
5. Coordinates use decimal degrees (latitude, longitude)
6. The gateway blocks `/internal/*` routes from external access
7. WebSocket connections use Socket.io protocol
8. File uploads support PNG, JPG, JPEG, PDF (max 10MB)
9. OTP for rides is a 4-digit code visible only to passengers
10. Driver earnings are calculated with a 20% platform commission
11. Fixed OTP `123456` works in test/development mode
