import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createLogger } from '@raahi/shared';

const logger = createLogger('rescue-service:storage');

// AWS S3 configuration
const AWS_S3_REGION = process.env.AWS_S3_REGION;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_CLOUDFRONT_DOMAIN = process.env.AWS_CLOUDFRONT_DOMAIN;

/**
 * Check if S3 credentials and bucket details are configured
 */
export const isS3Configured = (): boolean => {
  return !!(AWS_S3_REGION && AWS_S3_BUCKET && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY);
};

let s3Client: S3Client | null = null;

if (isS3Configured()) {
  s3Client = new S3Client({
    region: AWS_S3_REGION!,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID!,
      secretAccessKey: AWS_SECRET_ACCESS_KEY!,
    },
  });
  logger.info(`[STORAGE] AWS S3 configured: ${AWS_S3_BUCKET} in ${AWS_S3_REGION}`);
} else {
  logger.warn('[STORAGE] AWS S3 not configured, using local disk storage fallback');
}

/**
 * Generate a presigned PUT URL for S3 upload.
 * 
 * @param key - Destination path inside S3 bucket
 * @param contentType - MIME type of the file
 * @param expiresIn - URL expiration time in seconds (default: 3600s / 1 hour)
 */
export const generatePresignedUploadUrl = async (
  key: string,
  contentType: string,
  expiresIn: number = 3600
): Promise<string | null> => {
  if (!isS3Configured() || !s3Client) {
    logger.warn('[STORAGE] Cannot generate presigned PUT URL: S3 not configured');
    return null;
  }

  try {
    const command = new PutObjectCommand({
      Bucket: AWS_S3_BUCKET!,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn });
    logger.info(`[STORAGE] Generated presigned upload URL for ${key} (expires in ${expiresIn}s)`);
    return uploadUrl;
  } catch (error: any) {
    logger.error('[STORAGE] Failed to generate presigned upload URL', { error: error.message, key });
    return null;
  }
};

/**
 * Get public download URL for a file key.
 * 
 * @param key - Storage path of the file
 */
export const getPublicUrl = (key: string): string => {
  if (isS3Configured()) {
    if (AWS_CLOUDFRONT_DOMAIN) {
      return `https://${AWS_CLOUDFRONT_DOMAIN}/${key}`;
    }
    return `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/${key}`;
  }
  // Local fallback path
  return `/uploads/${key}`;
};
