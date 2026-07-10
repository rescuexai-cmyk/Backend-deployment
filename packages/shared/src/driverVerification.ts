/**
 * Driver Verification Constants and Utilities
 * 
 * Single source of truth for driver verification requirements.
 * Used across driver-service, ride-service, realtime-service, and admin-service.
 */

/**
 * Required documents for standard vehicle-owning drivers.
 * A driver must upload ALL of these to be eligible for verification.
 */
export const REQUIRED_DOCUMENTS = [
  'LICENSE',
  'RC',
  'INSURANCE',
  'PAN_CARD',
  'AADHAAR_CARD',
  'PROFILE_PHOTO',
] as const;

/**
 * Required documents for Independent Drivers (no vehicle ownership).
 * RC and INSURANCE are excluded because they do not own the vehicle.
 * Used for drivers registering for personal_driver / rescue service roles.
 */
export const INDEPENDENT_DRIVER_DOCUMENTS = [
  'LICENSE',
  'PAN_CARD',
  'AADHAAR_CARD',
  'PROFILE_PHOTO',
] as const;

export type RequiredDocumentType = typeof REQUIRED_DOCUMENTS[number];
export type IndependentDriverDocumentType = typeof INDEPENDENT_DRIVER_DOCUMENTS[number];

/** Sentinel vehicleType value used to identify independent drivers */
export const INDEPENDENT_DRIVER_VEHICLE_TYPE = 'independent_driver';

/**
 * Returns the required document set for a given driver type.
 * Independent drivers (no vehicle) skip RC and Insurance.
 *
 * @param vehicleType - The driver's vehicleType field from the DB
 */
export function getRequiredDocuments(vehicleType?: string | null): readonly string[] {
  if (vehicleType === INDEPENDENT_DRIVER_VEHICLE_TYPE) {
    return INDEPENDENT_DRIVER_DOCUMENTS;
  }
  return REQUIRED_DOCUMENTS;
}

/**
 * Onboarding status that indicates a fully verified driver
 */
export const COMPLETED_ONBOARDING_STATUS = 'COMPLETED';

/**
 * Driver verification state interface
 */
export interface DriverVerificationState {
  isActive: boolean;
  isVerified: boolean;
  onboardingStatus: string;
}

/**
 * Check if a driver can start rides (go online, accept rides, etc.)
 * 
 * This is the single source of truth for driver eligibility.
 * Use this function consistently across all services.
 * 
 * @param driver - Driver object with verification fields
 * @returns true if driver can start rides, false otherwise
 */
export function canDriverStartRides(driver: DriverVerificationState): boolean {
  return (
    driver.isActive === true &&
    driver.isVerified === true &&
    driver.onboardingStatus === COMPLETED_ONBOARDING_STATUS
  );
}

/**
 * Get a human-readable reason why a driver cannot start rides
 * 
 * @param driver - Driver object with verification fields
 * @returns Reason string or null if driver can start rides
 */
export function getDriverVerificationBlockReason(driver: DriverVerificationState): string | null {
  if (!driver.isActive) {
    return 'Your account has been deactivated. Please contact support.';
  }
  if (!driver.isVerified) {
    return 'Your documents are under verification. You cannot go online yet.';
  }
  if (driver.onboardingStatus !== COMPLETED_ONBOARDING_STATUS) {
    return 'Please complete your onboarding to start accepting rides.';
  }
  return null;
}

/**
 * Standard error response for unverified drivers
 */
export const DRIVER_NOT_VERIFIED_ERROR = {
  code: 'DRIVER_NOT_VERIFIED',
  message: 'Your documents are under verification. You cannot go online yet.',
} as const;

/**
 * Standard error response for unverified drivers trying to accept rides
 */
export const DRIVER_NOT_VERIFIED_RIDE_ERROR = {
  code: 'DRIVER_NOT_VERIFIED',
  message: 'Driver is not verified to start rides',
} as const;

/**
 * Check if all required documents have been uploaded for a given driver type.
 * Pass vehicleType to get the correct document set for independent drivers.
 * 
 * @param uploadedDocTypes - Array of document types that have been uploaded
 * @param vehicleType - Driver's vehicleType (pass to get per-type requirements)
 * @returns Object with isComplete flag and missing documents list
 */
export function checkRequiredDocuments(
  uploadedDocTypes: string[],
  vehicleType?: string | null,
): {
  isComplete: boolean;
  missing: string[];
  uploaded: string[];
} {
  const required = getRequiredDocuments(vehicleType);
  const uploadedSet = new Set(uploadedDocTypes.map(t => t.toUpperCase()));
  const missing = required.filter(doc => !uploadedSet.has(doc));

  return {
    isComplete: missing.length === 0,
    missing: [...missing],
    uploaded: required.filter(doc => uploadedSet.has(doc)),
  };
}

/**
 * True when every required document TYPE has at least one verified upload.
 *
 * Important: drivers can have multiple rows per type (re-uploads / PUT updates
 * that keep history). Do NOT use `documents.every(d => d.isVerified)` — a single
 * stale failed row would incorrectly block onboarding completion.
 */
export function areRequiredDocumentsVerified(
  documents: Array<{ documentType: string; isVerified: boolean }>,
  vehicleType?: string | null,
): boolean {
  if (!documents.length) return false;
  const required = getRequiredDocuments(vehicleType);
  const verifiedTypes = new Set(
    documents
      .filter((d) => d.isVerified)
      .map((d) => String(d.documentType).toUpperCase()),
  );
  return required.every((doc) => verifiedTypes.has(doc));
}

