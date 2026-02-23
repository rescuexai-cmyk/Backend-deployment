# Chat, Calling, Safety & Share Ride – Complete Workflow

This document describes how **in-ride chat**, **calling** (driver ↔ passenger), **safety/emergency**, and **share ride** work end-to-end, with all backend endpoints and realtime behaviour.

---

## 1. Chat (Driver ↔ Passenger)

### Flow

1. **Passenger or driver** opens the ride screen and **joins the ride room** on Socket.io so they can send and receive messages in real time.
2. **Load history:** `GET /api/rides/:id/messages` returns all messages for that ride (both sides use the same endpoint).
3. **Send message:** `POST /api/rides/:id/messages` with `{ "message": "I'm at the gate" }`. Backend saves the message and **broadcasts it to the ride room**.
4. **Receive in real time:** Anyone in the ride room (driver or passenger) receives the event **`ride-chat-message`** with the new message, so the UI can update without polling.

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/rides/:id/messages` | Yes (passenger or driver) | List all chat messages for the ride (ordered by time). |
| POST | `/api/rides/:id/messages` | Yes (passenger or driver) | Send a text message. Body: `{ "message": "string" }`. Returns the created message and broadcasts it to the ride room. |

### Realtime (Socket.io)

- **Join ride room (required for live chat):**  
  Emit **`join-ride`** with `rideId` (string). The socket is added to the room `ride-{rideId}`.
- **Leave ride room:**  
  Emit **`leave-ride`** with `rideId`.
- **Receive new messages:**  
  Listen for **`ride-chat-message`**. Payload shape:
  - `rideId`: string  
  - `message`: `{ id, senderId, message, timestamp }`  
  - `timestamp`: string (ISO)

### Backend behaviour

- **Access control:** Only the passenger or the assigned driver of the ride can call GET/POST messages (403 otherwise).
- **Persistence:** Every message is stored in `RideMessage` (rideId, senderId, message, timestamp).
- **Realtime:** After creating a message, the ride-service calls the realtime-service internal endpoint **`/internal/broadcast-ride-chat`**, which emits **`ride-chat-message`** to the room `ride-{rideId}`. So chat works with both REST and live updates.

### App checklist (chat)

- On opening the ride screen, call **`join-ride`** with the current ride id.
- On leaving the screen, call **`leave-ride`** with the same ride id.
- On load, call **GET /api/rides/:id/messages** and render the list.
- On send, call **POST /api/rides/:id/messages** and, when you receive **`ride-chat-message`**, append the message to the list (and optionally optimistically add the one you just sent).

---

## 2. Calling (Driver ↔ Passenger)

### Flow

- There is **no backend “call” or “dial” API**. Calling is done **on the device** (e.g. `tel:` link or in-app voice).
- The backend only exposes **the other party’s phone number** so the app can show “Call driver” / “Call passenger” and open the system dialler or in-app call.

### How each side gets the number

- **Passenger:**  
  **GET /api/rides/:id** (with passenger auth) returns the ride with **`driver.phone`** (and driver name, vehicle, etc.). The app uses `driver.phone` for “Call driver”.
- **Driver:**  
  **GET /api/rides/:id** (with driver auth) returns the ride with **`passenger`** object that includes **`phone`** (and name, etc.). The app uses `passenger.phone` for “Call passenger”.

### Endpoints (used for calling)

| Method | Path | Auth | Relevant response fields |
|--------|------|------|---------------------------|
| GET | `/api/rides/:id` | Yes (passenger or driver) | `driver.phone` (for passenger), `passenger.phone` (for driver). |

### App checklist (calling)

- After **GET /api/rides/:id**, show “Call driver” or “Call passenger” using the returned phone number.
- Use platform APIs (e.g. `tel:${phone}` or your voice SDK); no extra backend call endpoint is required.

---

## 3. Safety / Emergency

### Flow

1. During an active ride, passenger or driver taps **“Safety” / “Emergency”** in the app.
2. App calls **POST /api/rides/:id/emergency** (optional body: `{ "reason": "optional text" }`).
3. Backend:
   - Ensures the user is the passenger or driver of that ride.
   - Creates a **SYSTEM** notification for the **other party** (driver or passenger) with title “Safety alert” and message/reason.
   - Logs the event server-side.
4. The other party sees the alert in their notifications (e.g. **GET /api/notifications** or push if implemented).

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/rides/:id/emergency` | Yes (passenger or driver) | Report emergency for this ride. Body (optional): `{ "reason": "string" }`. Notifies the other party and logs. |

### Response

- **200:** `{ "success": true, "message": "Safety alert sent", "data": { "rideId": "..." } }`
- **403:** Not the passenger or driver of this ride.
- **404:** Ride not found.

### Notification payload

- Stored notification: `type: 'SYSTEM'`, `data: { type: 'emergency', rideId, triggeredBy (userId), reason }`. The other party’s app can use this to show a safety-specific UI or deep link to the ride.

### App checklist (safety)

- Show a “Safety” / “Emergency” button on the active ride screen.
- Call **POST /api/rides/:id/emergency** (with optional reason).
- On the other side, when fetching notifications, treat SYSTEM notifications with `data.type === 'emergency'` as safety alerts and show them prominently.

---

## 4. Share Ride

### Flow

1. **Create share link:** Passenger or driver calls **POST /api/rides/:id/share**. Backend creates a **RideShareToken** (unique token, e.g. 24h expiry) and returns **shareUrl** and **shareToken**.
2. User shares **shareUrl** (e.g. via WhatsApp/SMS) with a contact.
3. **Contact opens the link:** App or web opens something like `/ride/share/:token`. Frontend calls **GET /api/rides/share/:token** (no auth). Backend returns **minimal public ride info** (status, pickup/drop addresses, driver name/vehicle, no phone numbers).
4. Contact can see live status and basic trip info without creating an account.

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/rides/:id/share` | Yes (passenger or driver) | Create a share link. Returns `{ shareToken, shareUrl, expiresAt }`. Token valid 24 hours by default. |
| GET | `/api/rides/share/:token` | No | Public: get minimal ride info by share token. Returns status, pickup/drop addresses, driver name/vehicle (no phone). 404 if token invalid or expired. |

### POST /api/rides/:id/share response

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

### GET /api/rides/share/:token response

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
    "driver": {
      "name": "Driver Name",
      "vehicleNumber": "...",
      "vehicleModel": "..."
    }
  }
}
```

- No `phone` or other PII is exposed in this public response.

### App checklist (share ride)

- On ride screen, “Share trip” calls **POST /api/rides/:id/share** and then opens the system share sheet with **shareUrl**.
- For the shared link (e.g. `/ride/share/:token`), the app or web page calls **GET /api/rides/share/:token** and shows status, route, and driver info. Optionally poll this endpoint to show live status updates.

---

## Summary

| Feature | Main endpoints | Realtime / other |
|--------|-----------------|-------------------|
| **Chat** | GET/POST `/api/rides/:id/messages` | Join `ride-{rideId}`, listen `ride-chat-message` |
| **Calling** | GET `/api/rides/:id` (use `driver.phone` / `passenger.phone`) | None; use device/SIP for actual call |
| **Safety** | POST `/api/rides/:id/emergency` | Other party sees SYSTEM notification |
| **Share ride** | POST `/api/rides/:id/share`, GET `/api/rides/share/:token` | Optional: poll GET share for live status |

All of these workflows are implemented and wired in the backend; the app only needs to call the endpoints and use the socket events as described above.
