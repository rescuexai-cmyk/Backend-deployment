import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createLogger } from '@raahi/shared';

const logger = createLogger('auth-service:storage');

// AWS S3 configuration (same env vars as the other services)
const AWS_S3_REGION = process.env.AWS_S3_REGION;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_CLOUDFRONT_DOMAIN = process.env.AWS_CLOUDFRONT_DOMAIN;

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
  logger.warn('[STORAGE] AWS S3 not configured — profile photo upload disabled');
}

/**
 * Generate a presigned PUT URL for uploading a profile photo to S3.
 */
export const generatePresignedUploadUrl = async (
  key: string,
  contentType: string,
  expiresIn: number = 900
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
 * Public download URL for a stored file key.
 */
export const getPublicUrl = (key: string): string => {
  if (AWS_CLOUDFRONT_DOMAIN) {
    return `https://${AWS_CLOUDFRONT_DOMAIN}/${key}`;
  }
  return `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/${key}`;
};
