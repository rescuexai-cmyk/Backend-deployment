-- =============================================================================
-- Seed: 3 Fully Verified & Onboarded Rescue Drivers (SAFE RE-RUNNABLE)
-- =============================================================================
-- Cleans up any previous partial seed, then inserts fresh.
-- =============================================================================

BEGIN;

-- Clean up any previous seed attempt (safe - only deletes our seeded data)
DELETE FROM driver_documents WHERE "driverId" IN ('rescue_driver_001', 'rescue_driver_002', 'rescue_driver_003');
DELETE FROM drivers WHERE id IN ('rescue_driver_001', 'rescue_driver_002', 'rescue_driver_003');
DELETE FROM users WHERE id IN ('rescue_user_001', 'rescue_user_002', 'rescue_user_003');

-- ─── DRIVER 1: Rajesh Kumar ─────────────────────────────────────────────────

INSERT INTO users (id, phone, "firstName", "lastName", "isVerified", "isActive", "createdAt", "updatedAt")
VALUES ('rescue_user_001', '+919876500001', 'Rajesh', 'Kumar', true, true, NOW(), NOW());

INSERT INTO drivers (
  id, "userId", "licenseNumber", "licenseExpiry", "vehicleNumber", "vehicleModel",
  "vehicleColor", "vehicleYear", "isVerified", "isActive", "isOnline",
  "currentLatitude", "currentLongitude", "h3Index", "rating", "ratingCount",
  "totalRides", "totalEarnings", "totalOnlineSeconds", "joinedAt",
  "onboardingStatus", "vehicleType", "serviceTypes",
  "documentsSubmittedAt", "documentsVerifiedAt",
  "aadhaarNumber", "aadhaarVerified", "aadhaarVerifiedAt",
  "panNumber", "panVerified", "panVerifiedAt"
)
VALUES (
  'rescue_driver_001', 'rescue_user_001',
  'DL-1420110098701', '2028-12-31', 'DL01RX0001', 'Honda Activa 6G',
  'Black', 2023, true, true, true,
  28.6139, 77.2090, '8829a5dffffffff', 4.8, 52, 120, 45000.00, 360000,
  NOW() - INTERVAL '90 days', 'COMPLETED', 'bike',
  ARRAY['bike_rescue', 'raahi_driver'],
  NOW() - INTERVAL '89 days', NOW() - INTERVAL '88 days',
  '234567890123', true, NOW() - INTERVAL '88 days',
  'RXABC1234F', true, NOW() - INTERVAL '88 days'
);

INSERT INTO driver_documents (id, "driverId", "documentType", "documentUrl", "isVerified", "verifiedAt", "uploadedAt", "verificationStatus")
VALUES
  ('doc_rx1_license',  'rescue_driver_001', 'LICENSE',       'https://placeholder.rescue/docs/r1_license.jpg',       true, NOW(), NOW(), 'verified'),
  ('doc_rx1_rc',       'rescue_driver_001', 'RC',            'https://placeholder.rescue/docs/r1_rc.jpg',            true, NOW(), NOW(), 'verified'),
  ('doc_rx1_ins',      'rescue_driver_001', 'INSURANCE',     'https://placeholder.rescue/docs/r1_insurance.jpg',     true, NOW(), NOW(), 'verified'),
  ('doc_rx1_pan',      'rescue_driver_001', 'PAN_CARD',      'https://placeholder.rescue/docs/r1_pan.jpg',           true, NOW(), NOW(), 'verified'),
  ('doc_rx1_aadhaar',  'rescue_driver_001', 'AADHAAR_CARD',  'https://placeholder.rescue/docs/r1_aadhaar.jpg',       true, NOW(), NOW(), 'verified'),
  ('doc_rx1_photo',    'rescue_driver_001', 'PROFILE_PHOTO', 'https://placeholder.rescue/docs/r1_profile.jpg',       true, NOW(), NOW(), 'verified');

-- ─── DRIVER 2: Amit Sharma ──────────────────────────────────────────────────

INSERT INTO users (id, phone, "firstName", "lastName", "isVerified", "isActive", "createdAt", "updatedAt")
VALUES ('rescue_user_002', '+919876500002', 'Amit', 'Sharma', true, true, NOW(), NOW());

INSERT INTO drivers (
  id, "userId", "licenseNumber", "licenseExpiry", "vehicleNumber", "vehicleModel",
  "vehicleColor", "vehicleYear", "isVerified", "isActive", "isOnline",
  "currentLatitude", "currentLongitude", "h3Index", "rating", "ratingCount",
  "totalRides", "totalEarnings", "totalOnlineSeconds", "joinedAt",
  "onboardingStatus", "vehicleType", "serviceTypes",
  "documentsSubmittedAt", "documentsVerifiedAt",
  "aadhaarNumber", "aadhaarVerified", "aadhaarVerifiedAt",
  "panNumber", "panVerified", "panVerifiedAt"
)
VALUES (
  'rescue_driver_002', 'rescue_user_002',
  'DL-0520130098702', '2029-06-30', 'DL05RX0002', 'TVS Jupiter 125',
  'Blue', 2024, true, true, true,
  28.5355, 77.2100, '8829a5dffffffff', 4.6, 38, 85, 32000.00, 252000,
  NOW() - INTERVAL '60 days', 'COMPLETED', 'bike',
  ARRAY['bike_rescue', 'raahi_driver'],
  NOW() - INTERVAL '59 days', NOW() - INTERVAL '58 days',
  '345678901234', true, NOW() - INTERVAL '58 days',
  'RXFGH5678K', true, NOW() - INTERVAL '58 days'
);

INSERT INTO driver_documents (id, "driverId", "documentType", "documentUrl", "isVerified", "verifiedAt", "uploadedAt", "verificationStatus")
VALUES
  ('doc_rx2_license',  'rescue_driver_002', 'LICENSE',       'https://placeholder.rescue/docs/r2_license.jpg',       true, NOW(), NOW(), 'verified'),
  ('doc_rx2_rc',       'rescue_driver_002', 'RC',            'https://placeholder.rescue/docs/r2_rc.jpg',            true, NOW(), NOW(), 'verified'),
  ('doc_rx2_ins',      'rescue_driver_002', 'INSURANCE',     'https://placeholder.rescue/docs/r2_insurance.jpg',     true, NOW(), NOW(), 'verified'),
  ('doc_rx2_pan',      'rescue_driver_002', 'PAN_CARD',      'https://placeholder.rescue/docs/r2_pan.jpg',           true, NOW(), NOW(), 'verified'),
  ('doc_rx2_aadhaar',  'rescue_driver_002', 'AADHAAR_CARD',  'https://placeholder.rescue/docs/r2_aadhaar.jpg',       true, NOW(), NOW(), 'verified'),
  ('doc_rx2_photo',    'rescue_driver_002', 'PROFILE_PHOTO', 'https://placeholder.rescue/docs/r2_profile.jpg',       true, NOW(), NOW(), 'verified');

-- ─── DRIVER 3: Priya Singh ──────────────────────────────────────────────────

INSERT INTO users (id, phone, "firstName", "lastName", "isVerified", "isActive", "createdAt", "updatedAt")
VALUES ('rescue_user_003', '+919876500003', 'Priya', 'Singh', true, true, NOW(), NOW());

INSERT INTO drivers (
  id, "userId", "licenseNumber", "licenseExpiry", "vehicleNumber", "vehicleModel",
  "vehicleColor", "vehicleYear", "isVerified", "isActive", "isOnline",
  "currentLatitude", "currentLongitude", "h3Index", "rating", "ratingCount",
  "totalRides", "totalEarnings", "totalOnlineSeconds", "joinedAt",
  "onboardingStatus", "vehicleType", "serviceTypes",
  "documentsSubmittedAt", "documentsVerifiedAt",
  "aadhaarNumber", "aadhaarVerified", "aadhaarVerifiedAt",
  "panNumber", "panVerified", "panVerifiedAt"
)
VALUES (
  'rescue_driver_003', 'rescue_user_003',
  'DL-0820140098703', '2029-03-15', 'DL08RX0003', 'Suzuki Access 125',
  'White', 2024, true, true, true,
  28.6692, 77.4538, '8829a5dffffffff', 4.9, 65, 150, 58000.00, 432000,
  NOW() - INTERVAL '120 days', 'COMPLETED', 'bike',
  ARRAY['bike_rescue', 'raahi_driver'],
  NOW() - INTERVAL '119 days', NOW() - INTERVAL '118 days',
  '456789012345', true, NOW() - INTERVAL '118 days',
  'RXKLM9012P', true, NOW() - INTERVAL '118 days'
);

INSERT INTO driver_documents (id, "driverId", "documentType", "documentUrl", "isVerified", "verifiedAt", "uploadedAt", "verificationStatus")
VALUES
  ('doc_rx3_license',  'rescue_driver_003', 'LICENSE',       'https://placeholder.rescue/docs/r3_license.jpg',       true, NOW(), NOW(), 'verified'),
  ('doc_rx3_rc',       'rescue_driver_003', 'RC',            'https://placeholder.rescue/docs/r3_rc.jpg',            true, NOW(), NOW(), 'verified'),
  ('doc_rx3_ins',      'rescue_driver_003', 'INSURANCE',     'https://placeholder.rescue/docs/r3_insurance.jpg',     true, NOW(), NOW(), 'verified'),
  ('doc_rx3_pan',      'rescue_driver_003', 'PAN_CARD',      'https://placeholder.rescue/docs/r3_pan.jpg',           true, NOW(), NOW(), 'verified'),
  ('doc_rx3_aadhaar',  'rescue_driver_003', 'AADHAAR_CARD',  'https://placeholder.rescue/docs/r3_aadhaar.jpg',       true, NOW(), NOW(), 'verified'),
  ('doc_rx3_photo',    'rescue_driver_003', 'PROFILE_PHOTO', 'https://placeholder.rescue/docs/r3_profile.jpg',       true, NOW(), NOW(), 'verified');

COMMIT;

-- ─── Verify seed ────────────────────────────────────────────────────────────
SELECT d.id, u."firstName" || ' ' || u."lastName" AS name, u.phone,
       d."isVerified", d."isActive", d."isOnline", d."onboardingStatus",
       d."vehicleNumber", d."vehicleModel", d."serviceTypes",
       (SELECT COUNT(*) FROM driver_documents dd WHERE dd."driverId" = d.id AND dd."isVerified" = true) AS verified_docs
FROM drivers d
JOIN users u ON u.id = d."userId"
WHERE d.id IN ('rescue_driver_001', 'rescue_driver_002', 'rescue_driver_003');
