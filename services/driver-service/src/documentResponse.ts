/**
 * Normalize Vision / verification fields for API responses.
 * Emits snake_case (canonical) plus camelCase and legacy aliases so clients
 * can parse either naming style — same shape for vehicle_owner and
 * independent_driver flows.
 */

export interface DocumentVisionFields {
  verificationStatus: string | null | undefined;
  aiVerified?: boolean | null;
  aiConfidence?: number | null;
  aiMismatchReason?: string | null;
  aiVerifiedAt?: Date | null;
}

/** Vision verification fields with snake_case, camelCase, and legacy aliases. */
export function withVisionFieldAliases(fields: DocumentVisionFields): Record<string, unknown> {
  const verification_status = fields.verificationStatus ?? 'pending';
  const ai_verified = fields.aiVerified ?? false;
  const ai_confidence = fields.aiConfidence ?? null;
  const ai_mismatch_reason = fields.aiMismatchReason ?? null;
  const mismatch_reason = ai_mismatch_reason;

  const out: Record<string, unknown> = {
    verification_status,
    status: verification_status,
    verificationStatus: verification_status,
    ai_verified,
    aiVerified: ai_verified,
    ai_confidence,
    aiConfidence: ai_confidence,
    ai_mismatch_reason,
    aiMismatchReason: ai_mismatch_reason,
    mismatch_reason,
  };

  if (fields.aiVerifiedAt != null) {
    out.ai_verified_at = fields.aiVerifiedAt;
    out.aiVerifiedAt = fields.aiVerifiedAt;
  }

  return out;
}

export interface DriverDocumentRow {
  documentType: string;
  documentUrl: string;
  uploadedAt: Date;
  isVerified: boolean;
  verifiedAt: Date | null;
  rejectionReason: string | null;
  verificationStatus: string;
  aiVerified: boolean;
  aiConfidence: number | null;
  aiMismatchReason: string | null;
}

/** Full document row for onboarding status lists (pending / flagged / details). */
export function formatDocumentDetail(d: DriverDocumentRow): Record<string, unknown> {
  // Once a document is verified (admin or AI), do not surface stale AI failure
  // reasons to the client — those caused the driver app to keep showing
  // "Verification Failed" after manual dashboard approval.
  const mismatch = d.isVerified ? null : d.aiMismatchReason;
  return {
    type: d.documentType,
    url: d.documentUrl,
    uploaded_at: d.uploadedAt,
    is_verified: d.isVerified,
    verified_at: d.verifiedAt,
    rejection_reason: d.isVerified ? null : d.rejectionReason,
    ...withVisionFieldAliases({
      verificationStatus: d.isVerified ? 'verified' : d.verificationStatus,
      aiVerified: d.isVerified ? true : d.aiVerified,
      aiConfidence: d.aiConfidence,
      aiMismatchReason: mismatch,
    }),
  };
}

/** Compact summary after documents/submit. */
export function formatVerificationSummary(d: {
  documentType: string;
  verificationStatus: string;
  aiVerified: boolean;
  aiConfidence: number | null;
  aiMismatchReason: string | null;
}): Record<string, unknown> {
  return {
    type: d.documentType,
    ...withVisionFieldAliases({
      verificationStatus: d.verificationStatus,
      aiVerified: d.aiVerified,
      aiConfidence: d.aiConfidence,
      aiMismatchReason: d.aiMismatchReason,
    }),
  };
}
