/**
 * Helpers for the admin driver-document review flow:
 * - Presigned S3 URLs so admins can preview private driver documents in the browser.
 * - Driver push notifications (via notification-service) so approvals/rejections
 *   reflect in the driver app in near-realtime.
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createLogger } from '@raahi/shared';

const logger = createLogger('admin-service:driver-docs');

const AWS_S3_REGION = process.env.AWS_S3_REGION;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:5006';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'raahi-internal-service-key';

function isS3Configured(): boolean {
  return !!(AWS_S3_REGION && AWS_S3_BUCKET && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY);
}

let s3Client: S3Client | null = null;
if (isS3Configured()) {
  s3Client = new S3Client({
    region: AWS_S3_REGION!,
    credentials: { accessKeyId: AWS_ACCESS_KEY_ID!, secretAccessKey: AWS_SECRET_ACCESS_KEY! },
  });
}

function extractKeyFromUrl(documentUrl: string): string | null {
  try {
    const url = new URL(documentUrl);
    const host = url.hostname.toLowerCase();
    const isKnownStorage =
      host.includes('.s3.') ||
      host.endsWith('.amazonaws.com') ||
      host.includes('digitaloceanspaces.com') ||
      host.includes('cloudfront.net');
    if (!isKnownStorage) return null;
    return decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
}

/**
 * Returns a browser-viewable URL for a driver document.
 * Local uploads pass through; S3 objects get a presigned GET URL.
 */
export async function presignDocumentUrl(documentUrl: string, expiresIn = 3600): Promise<string | null> {
  if (!documentUrl) return null;
  if (documentUrl.startsWith('/uploads/')) return documentUrl;

  if (!isS3Configured() || !s3Client) {
    logger.warn('[DOCS] S3 not configured; cannot presign document URL');
    return null;
  }
  const key = extractKeyFromUrl(documentUrl);
  if (!key) {
    logger.warn('[DOCS] Could not extract S3 key', { documentUrl });
    return null;
  }
  try {
    const command = new GetObjectCommand({ Bucket: AWS_S3_BUCKET!, Key: key });
    return await getSignedUrl(s3Client, command, { expiresIn });
  } catch (error: any) {
    logger.error('[DOCS] Failed to presign document URL', { error: error.message, documentUrl });
    return null;
  }
}

export type DriverDocEvent =
  | 'DOCUMENT_APPROVED'
  | 'DOCUMENT_REJECTED'
  | 'VERIFIED'
  | 'REJECTED';

/**
 * Send a push + in-app notification to a driver's user account after an admin
 * review action. The `data.type: DRIVER_ONBOARDING` payload is what the driver
 * app listens for to refresh onboarding status in realtime.
 *
 * Fire-and-forget: notification failure must never fail the admin action.
 */
export async function notifyDriverVerification(params: {
  userId: string;
  event: DriverDocEvent;
  title: string;
  message: string;
  documentType?: string;
  onboardingStatus?: string;
}): Promise<void> {
  const { userId, event, title, message, documentType, onboardingStatus } = params;
  try {
    const doFetch = (globalThis as any).fetch as (url: string, init?: any) => Promise<any>;
    const resp = await doFetch(`${NOTIFICATION_SERVICE_URL}/api/notifications/internal/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-api-key': INTERNAL_API_KEY },
      body: JSON.stringify({
        userId,
        title,
        message,
        type: 'SYSTEM',
        sendPush: true,
        data: {
          type: 'DRIVER_ONBOARDING',
          event,
          status: onboardingStatus || '',
          documentType: documentType || '',
        },
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      logger.warn('[DOCS] Driver notification failed', { userId, event, status: resp.status, body });
    } else {
      logger.info('[DOCS] Driver notified', { userId, event });
    }
  } catch (error: any) {
    logger.warn('[DOCS] Driver notification error', { userId, event, error: error.message });
  }
}
