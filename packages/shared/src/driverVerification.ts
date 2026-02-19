/**
 * Driver Verification Constants and Utilities
 * 
 * Single source of truth for driver verification requirements.
 * Used across driver-service, ride-service, realtime-service, and admin-service.
 */

/**
 * Required documents for driver verification.
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

export type RequiredDocumentType = typeof REQUIRED_DOCUMENTS[number];

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
 * Check if all required documents have been uploaded
 * 
 * @param uploadedDocTypes - Array of document types that have been uploaded
 * @returns Object with isComplete flag and missing documents list
 */
export function checkRequiredDocuments(uploadedDocTypes: string[]): {
  isComplete: boolean;
  missing: string[];
  uploaded: string[];
} {
  const uploadedSet = new Set(uploadedDocTypes.map(t => t.toUpperCase()));
  const missing = REQUIRED_DOCUMENTS.filter(doc => !uploadedSet.has(doc));
  
  return {
    isComplete: missing.length === 0,
    missing: [...missing],
    uploaded: REQUIRED_DOCUMENTS.filter(doc => uploadedSet.has(doc)),
  };
}
