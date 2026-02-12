# User Profile Page – API Workflow & Issues (Documentation Only)

This document describes **every API endpoint** that a **user (passenger) profile page** may call, the **workflow** of each, and **issues found**. No code or files were changed; this is documentation only.

**Scope:** User profile screen (passenger app). Driver profile is out of scope.

---

## 1. Endpoints That Belong to the Profile Page

A typical user profile screen would use:

| Endpoint | Method | Service | Purpose |
|----------|--------|---------|---------|
| `/api/auth/me` | GET | auth-service | Load current user profile (display name, email, phone, photo, etc.) |
| `/api/auth/profile` | PUT | auth-service | Update profile (name, email, profile image) |
| `/api/user/profile` | GET | user-service | Alternative/supplementary profile endpoint (see issues) |

**Gateway routing:**  
- `GET/PUT /api/auth/*` → auth-service (5001)  
- `GET /api/user/*` → user-service (5002)

---

## 2. Workflow per Endpoint

### 2.1 GET `/api/auth/me` – Get current user profile

**Flow:**

1. Client sends request with header: `Authorization: Bearer <accessToken>`.
2. **Gateway** forwards the request to **auth-service** (no body).
3. **Auth-service** uses shared `authenticate` middleware:
   - Validates JWT with `JWT_SECRET`.
   - Loads user from DB by `decoded.userId`.
   - If user not found → **401** "User not found".
   - If `user.isActive === false` → **403** "Account has been deactivated".
   - Otherwise sets `req.user` and continues.
4. Route handler calls `AuthService.getUserProfile(req.user.id)`:
   - `prisma.user.findUnique({ where: { id: userId } })`.
   - If no user → **404** `{ success: false, message: 'User not found' }`.
   - Otherwise maps DB user to `UserProfile` (id, email, phone, firstName, lastName, profileImage, isVerified, isActive, createdAt, lastLoginAt) and returns **200** `{ success: true, data: { user } }`.

**Response shape (success):**  
`{ success: true, data: { user: { id, email?, phone, firstName, lastName?, profileImage?, isVerified, isActive, createdAt, lastLoginAt? } } }`.

**Notes:**

- Profile is read from the **User** table only (no driver/ride data).
- Deactivated users are blocked at middleware (403) before the handler runs.

---

### 2.2 PUT `/api/auth/profile` – Update user profile

**Flow:**

1. Client sends `Authorization: Bearer <accessToken>` and JSON body with any of: `firstName`, `lastName`, `email`, `profileImage`.
2. **Gateway** forwards to **auth-service**.
3. **Auth-service** uses `authenticate` (same as above; deactivated users get 403).
4. **Validation** (express-validator):
   - `firstName` – optional, must be string if present.
   - `lastName` – optional, must be string if present.
   - `email` – optional, must be valid email if present.
   - `profileImage` – optional, must be string if present.
   - If validation fails → **400** `{ success: false, message: 'Validation failed', errors: [...] }`.
5. Handler calls `AuthService.updateUserProfile(req.user.id, { firstName, lastName, email, profileImage })`:
   - `prisma.user.update({ where: { id: userId }, data: { ...updates, updatedAt: new Date() } })`.
   - Returns mapped `UserProfile` and **200** `{ success: true, message: 'Profile updated successfully', data: { user } }`.

**Allowed fields:**  
Only `firstName`, `lastName`, `email`, `profileImage`. **Phone is not updatable** (by design; phone is auth identity).

**Notes:**

- Any subset of fields can be sent; only provided keys are updated (undefined is not written).
- Empty string is valid for optional string fields (e.g. `lastName: ""`) and will persist; can effectively “clear” optional fields.

---

### 2.3 GET `/api/user/profile` – User service profile endpoint

**Flow:**

1. Client sends `Authorization: Bearer <accessToken>`.
2. **Gateway** forwards to **user-service**.
3. **User-service** uses shared `authenticate` middleware (same JWT and DB check; deactivated → 403).
4. Handler responds with **200** and body:  
   `{ message: 'User profile endpoint', userId: req.user?.id }`.

**Notes:**

- This endpoint **does not return full profile data** (no name, email, phone, profileImage, etc.).
- If the app uses this for the “profile page” instead of `GET /api/auth/me`, the screen would only get `userId` and a message – **not suitable for populating a profile UI**.

---

## 3. Issues Found (Eligible List)

| # | Severity | Issue | Where / Detail |
|---|----------|--------|----------------|
| 1 | **High** | **GET `/api/user/profile` is not a real profile endpoint** | user-service. Returns only `{ message: 'User profile endpoint', userId }`. No name, email, phone, profileImage, etc. If the client uses this for the profile screen, the page cannot show or edit user data. Recommendation: either implement full profile (e.g. same shape as `/api/auth/me`) or document that profile screen must use **GET /api/auth/me** only. |
| 2 | **Medium** | **Duplicate email on PUT `/api/auth/profile` returns 500** | auth-service. `User.email` is `@unique`. If the client updates to an email already used by another user, Prisma throws `P2002` (unique constraint). The shared `errorHandler` does not map Prisma errors to 4xx; the API returns **500** and a raw Prisma message in development. Recommendation: catch P2002 in the profile update flow and return **409** with a clear message (e.g. "Email already in use"). |
| 3 | **Low** | **Empty string can clear optional profile fields** | PUT `/api/auth/profile`. Validation allows optional strings; sending `lastName: ""` or `firstName: ""` will persist and effectively clear the field. Not necessarily wrong, but behaviour is not documented; clients might send empty strings by mistake (e.g. “no change”) and unintentionally clear data. |
| 4 | **Low** | **Phone is read-only** | PUT `/api/auth/profile` does not accept `phone`. Phone is the auth identifier and is intentionally not updatable here. If the profile UI shows “Phone” without marking it read-only or explaining that it cannot be changed, users may be confused. Document for frontend. |
| 5 | **Low** | **Two “profile” endpoints with different contracts** | `/api/auth/me` (and PUT `/api/auth/profile`) vs GET `/api/user/profile`. Naming and API docs suggest both are “profile”, but only auth endpoints return full user data. Risk of client using the wrong one (see issue 1). Recommendation: document clearly which endpoint the profile screen must use. |

---

## 4. Summary Table – Profile Page APIs

| Endpoint | Auth | Returns full profile? | Suitable for profile screen? |
|----------|------|----------------------|------------------------------|
| GET `/api/auth/me` | Bearer | Yes (user object) | **Yes** – use for loading profile. |
| PUT `/api/auth/profile` | Bearer | Yes (updated user) | **Yes** – use for saving edits. |
| GET `/api/user/profile` | Bearer | No (message + userId only) | **No** – do not use for profile data. |

---

## 5. Recommended Profile Page Flow (for frontend)

1. **On load:**  
   `GET /api/auth/me` → use `data.user` to populate name, email, phone, profileImage, etc.

2. **On save:**  
   `PUT /api/auth/profile` with only the fields that changed (e.g. `{ firstName, lastName, email, profileImage }`).  
   Do not use GET `/api/user/profile` for profile data.

3. **Error handling:**  
   - 403 "Account has been deactivated" → show message and optionally redirect to login.  
   - 400 "Validation failed" → show validation errors.  
   - If backend is updated to return 409 for duplicate email, show “Email already in use”.

---

## 6. Profile Screen Content: Saved Places, Notifications, Help & Support, About

This section checks whether the **content inside the profile screen** (saved places, notifications, help and support, about) has a **complete endpoint workflow**. Only documentation; no code changed.

---

### 6.1 Saved places

**Expected workflow (typical):**  
User can view a list of saved/favorite addresses (e.g. Home, Work) and add/edit/delete them. APIs would be something like: GET list, POST add, PUT/PATCH update, DELETE remove.

**Current backend:**

| Check | Result |
|-------|--------|
| Endpoint for listing saved places | **None.** No route under `/api/user` or elsewhere for saved places. |
| Endpoint for adding/updating/deleting a saved place | **None.** |
| Database model for saved places | **None.** Prisma schema has no model such as `SavedPlace`, `FavoriteAddress`, or `UserAddress`. |

**Workflow status:** **Not implemented.** There is no backend support for saved places.

**Issues:**

| # | Severity | Issue |
|---|----------|--------|
| 6.1.1 | **High** | **No saved-places API.** If the profile screen has a “Saved places” section, the app has no endpoint to list, add, update, or delete saved addresses. Either implement endpoints + model or remove/hide the section in the app. |

---

### 6.2 Notifications

**Expected workflow (typical):**  
User opens “Notifications” from profile → API returns list of notifications (ride updates, promotions, system) for the current user, with pagination and optionally mark-as-read.

**Current backend:**

| Check | Result |
|-------|--------|
| Endpoint for listing notifications | **GET `/api/notifications`** exists (notification-service, gateway → 5006). |
| What it returns | **Stub only.** Response is `{ message: 'Notifications endpoint', userId: req.user?.id }`. It does **not** query the `Notification` table. |
| Mark as read / mark all read | **None.** No PATCH/PUT for `isRead`. |
| Database | **Notification** model exists (userId, title, message, type, isRead, data, createdAt). Notifications are **created** elsewhere (e.g. ride-service for emergency/SYSTEM). |

**Workflow status:** **Incomplete.** The endpoint exists and is authenticated but does not return real notification data; no mark-read API.

**Issues:**

| # | Severity | Issue |
|---|----------|--------|
| 6.2.1 | **High** | **GET `/api/notifications` returns no notification list.** Handler does not call `prisma.notification.findMany({ where: { userId: req.user.id } })`. Profile “Notifications” screen cannot show any items. |
| 6.2.2 | **Medium** | **No mark-as-read endpoint.** Even if list is implemented, users cannot mark one or all notifications as read (no PATCH/PUT on notification or bulk update). |
| 6.2.3 | **Low** | **No pagination or limit.** When list is implemented, pagination (e.g. limit/skip or cursor) should be documented and supported. |

---

### 6.3 Help and support

**Expected workflow (typical):**  
User can submit a support request (e.g. issue type, description, priority) and optionally see status. API: POST submit, maybe GET my requests.

**Current backend:**

| Check | Result |
|-------|--------|
| Support endpoint for **user (passenger)** | **None.** No `/api/user/support`, `/api/support`, or equivalent for the passenger app. |
| Support endpoint for **driver** | **Yes.** **POST `/api/driver/support`** (driver-service): body `issue_type`, `description`, optional `priority`. Returns a stub object (request_id, driver_id, status, etc.) but is **not** persisted to DB (no SupportRequest model). |
| Persistence of support requests | Driver support creates an in-memory-style response only; no Prisma model for support tickets. |

**Workflow status:**  
- **User (profile screen):** **No workflow.** No API for passengers to submit or view support requests.  
- **Driver:** Endpoint exists but support requests are not stored in the database.

**Issues:**

| # | Severity | Issue |
|---|----------|--------|
| 6.3.1 | **High** | **No help/support API for user (passenger).** If the profile screen has “Help and support”, there is no backend endpoint for the logged-in user to submit a request. Only driver support exists (`POST /api/driver/support`). |
| 6.3.2 | **Medium** | **Driver support requests are not persisted.** POST `/api/driver/support` returns a fake `request_id` and status but does not save to DB. No model for support tickets; no way to list or track requests. |

---

### 6.4 About

**Expected workflow (typical):**  
“About” usually shows static content: app version, terms of use, privacy policy, contact. This can be client-only (hardcoded or bundled) or served via an API (e.g. GET app config / CMS).

**Current backend:**

| Check | Result |
|-------|--------|
| Endpoint for app version / config / about content | **None.** No `/api/about`, `/api/app/config`, or similar. |

**Workflow status:** **No backend workflow.** About is typically static; if the app expects dynamic “About” content from the API, it is missing.

**Issues:**

| # | Severity | Issue |
|---|----------|--------|
| 6.4.1 | **Low** | **No “About” API.** If the app is designed to fetch version/terms/privacy from the backend, no such endpoint exists. If “About” is static in the client, no change needed. |

---

## 7. Summary: Profile Screen Content – Workflow & Issues

| Content | Endpoint(s) | Workflow status | Main issue(s) |
|---------|------------|------------------|---------------|
| **Saved places** | None | Not implemented | No API, no DB model (6.1.1). |
| **Notifications** | GET `/api/notifications` | Incomplete | Returns stub only; no list, no mark-read (6.2.1, 6.2.2). |
| **Help and support** | None for user | Missing for user | No user support API (6.3.1); driver support not persisted (6.3.2). |
| **About** | None | N/A or missing | No about/config API if app expects it (6.4.1). |

---

## 8. Enlisted Issues (Full List)

| # | Severity | Area | Issue |
|---|----------|------|--------|
| 1 | High | Profile | GET `/api/user/profile` returns only message + userId, not full profile. |
| 2 | Medium | Profile | PUT `/api/auth/profile` duplicate email → 500 instead of 409. |
| 3 | Low | Profile | Empty string can clear optional profile fields; undocumented. |
| 4 | Low | Profile | Phone read-only; should be documented for frontend. |
| 5 | Low | Profile | Two profile endpoints with different contracts; document which to use. |
| 6.1.1 | High | Saved places | No saved-places API or DB model. |
| 6.2.1 | High | Notifications | GET `/api/notifications` does not return notification list from DB. |
| 6.2.2 | Medium | Notifications | No mark-as-read (single or bulk) endpoint. |
| 6.2.3 | Low | Notifications | No pagination when list is implemented. |
| 6.3.1 | High | Help & support | No support endpoint for user (passenger); only driver support exists. |
| 6.3.2 | Medium | Help & support | Driver support requests not persisted to DB. |
| 6.4.1 | Low | About | No About/app-config API if app expects backend content. |

---

**Document version:** 1.1  
**Last checked:** Backend codebase (auth, user, notification, driver services; gateway; Prisma schema). No code changes made; documentation only.
