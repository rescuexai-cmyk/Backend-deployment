/**
 * AWS S3 Storage Module
 * 
 * Uses AWS S3 for document uploads.
 * Falls back to local disk storage if S3 is not configured.
 * 
 * File naming convention: {driverId}_{DOCUMENT_TYPE}_{timestamp}.{extension}
 * Folder structure: /{DOCUMENT_TYPE}/{driverId}_{DOCUMENT_TYPE}_{timestamp}.{extension}
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import multer from 'multer';
import multerS3 from 'multer-s3';
import path from 'path';
import fs from 'fs';
import { createLogger } from '@raahi/shared';
import { Readable } from 'stream';

const logger = createLogger('driver-service:storage');

// AWS S3 configuration
const AWS_S3_REGION = process.env.AWS_S3_REGION; // e.g., 'ap-south-1'
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET; // e.g., 'raahi-documents'
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_CLOUDFRONT_DOMAIN = process.env.AWS_CLOUDFRONT_DOMAIN; // Optional CloudFront CDN domain

// Check if AWS S3 is configured
export const isS3Configured = (): boolean => {
  return !!(AWS_S3_REGION && AWS_S3_BUCKET && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY);
};

// Keep legacy export name for backward compatibility
export const isSpacesConfigured = isS3Configured;

// S3 client for AWS
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
  logger.warn('[STORAGE] AWS S3 not configured, using local disk storage');
}

/**
 * Generate filename in format: {driverId}_{DOCUMENT_TYPE}_{timestamp}.{extension}
 */
const generateDriverDocFilename = (driverId: string, documentType: string, originalFilename: string): string => {
  const ext = path.extname(originalFilename).toLowerCase() || '.jpg';
  const docType = documentType.toUpperCase();
  const timestamp = Date.now();
  return `${driverId}_${docType}_${timestamp}${ext}`;
};

/**
 * Generate the full storage key/path
 * Format: {DOCUMENT_TYPE}/{driverId}_{DOCUMENT_TYPE}_{timestamp}.{extension}
 */
const generateStorageKey = (driverId: string, documentType: string, originalFilename: string): string => {
  const docType = documentType.toUpperCase();
  const filename = generateDriverDocFilename(driverId, documentType, originalFilename);
  return `${docType}/${filename}`;
};

// File filter for documents
const fileFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowed = /jpeg|jpg|png|pdf/;
  const extValid = allowed.test(path.extname(file.originalname).toLowerCase());
  const mimeValid = allowed.test(file.mimetype);
  
  if (extValid && mimeValid) {
    cb(null, true);
  } else {
    cb(new Error('Only .png, .jpg, .jpeg and .pdf files are allowed'));
  }
};

// Extend Express Request to include driver info
declare global {
  namespace Express {
    interface Request {
      driverInfo?: {
        id: string;
        documentType: string;
      };
    }
  }
}

/**
 * Create multer upload middleware for driver documents
 * 
 * IMPORTANT: Before using this middleware, you must set req.driverInfo with:
 *   - id: driver's unique ID
 *   - documentType: type of document (LICENSE, RC, etc.)
 */
export const createUploadMiddleware = () => {
  if (isS3Configured() && s3Client) {
    // AWS S3 storage
    return multer({
      storage: multerS3({
        s3: s3Client,
        bucket: AWS_S3_BUCKET!,
        acl: 'public-read', // Expose uploaded files publicly
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: (req: any, file, cb) => {
          const driverId = req.driverInfo?.id || 'unknown';
          const documentType = req.driverInfo?.documentType || req.body?.documentType || 'DOCUMENT';
          const key = generateStorageKey(driverId, documentType, file.originalname);
          
          logger.info(`[STORAGE] Uploading to S3: ${key}`);
          cb(null, key);
        },
        metadata: (req: any, file, cb) => {
          cb(null, {
            originalName: file.originalname,
            driverId: req.driverInfo?.id || 'unknown',
            documentType: req.driverInfo?.documentType || req.body?.documentType || 'unknown',
            uploadedAt: new Date().toISOString(),
          });
        },
      }),
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
      fileFilter,
    });
  } else {
    // Local disk storage fallback
    const baseUploadDir = path.join(process.cwd(), 'uploads');
    
    return multer({
      storage: multer.diskStorage({
        destination: (req: any, _file, cb) => {
          const documentType = (req.driverInfo?.documentType || req.body?.documentType || 'DOCUMENT').toUpperCase();
          const uploadDir = path.join(baseUploadDir, documentType);
          
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }
          cb(null, uploadDir);
        },
        filename: (req: any, file, cb) => {
          const driverId = req.driverInfo?.id || 'unknown';
          const documentType = req.driverInfo?.documentType || req.body?.documentType || 'DOCUMENT';
          const filename = generateDriverDocFilename(driverId, documentType, file.originalname);
          
          logger.info(`[STORAGE] Saving locally: ${documentType}/${filename}`);
          cb(null, filename);
        },
      }),
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
      fileFilter,
    });
  }
};

/**
 * Get document URL based on storage type
 */
export const getDocumentUrl = (file: Express.Multer.File & { key?: string; location?: string }, documentType?: string): string => {
  if (isS3Configured() && file.key) {
    // Use CloudFront CDN if configured, otherwise construct direct S3 URL
    if (AWS_CLOUDFRONT_DOMAIN) {
      return `https://${AWS_CLOUDFRONT_DOMAIN}/${file.key}`;
    }
    return `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/${file.key}`;
  }
  
  // Local storage URL
  const docType = (documentType || 'DOCUMENT').toUpperCase();
  return `/uploads/${docType}/${file.filename}`;
};

/**
 * Check if a document URL is an S3 URL (supports both legacy DO Spaces and AWS S3)
 */
const isS3Url = (documentUrl: string): boolean => {
  return documentUrl.includes('amazonaws.com') || documentUrl.includes('digitaloceanspaces.com');
};

/**
 * Delete document from storage
 */
export const deleteDocument = async (documentUrl: string): Promise<boolean> => {
  try {
    if (isS3Configured() && s3Client && isS3Url(documentUrl)) {
      // Extract key from URL
      const urlParts = new URL(documentUrl);
      const key = urlParts.pathname.substring(1); // Remove leading slash
      
      await s3Client.send(new DeleteObjectCommand({
        Bucket: AWS_S3_BUCKET!,
        Key: key,
      }));
      logger.info(`[STORAGE] Deleted from S3: ${key}`);
      return true;
    } else if (documentUrl.startsWith('/uploads/')) {
      // Local file deletion
      const localPath = path.join(process.cwd(), documentUrl);
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
        logger.info(`[STORAGE] Deleted local file: ${localPath}`);
        return true;
      }
    }
    return false;
  } catch (error) {
    logger.error('[STORAGE] Failed to delete document', { error, documentUrl });
    return false;
  }
};

/**
 * Delete old document before uploading new one (for re-uploads)
 */
export const deleteOldDocument = async (driverId: string, documentType: string): Promise<void> => {
  const docType = documentType.toUpperCase();
  
  if (isS3Configured() && s3Client) {
    // Delete all historical variants for this document type.
    // Prefix without trailing underscore matches both legacy and timestamped keys.
    const prefix = `${docType}/${driverId}_${docType}`;
    try {
      const listed = await s3Client.send(new ListObjectsV2Command({
        Bucket: AWS_S3_BUCKET!,
        Prefix: prefix,
      }));
      for (const obj of listed.Contents ?? []) {
        if (!obj.Key) continue;
        await s3Client.send(new DeleteObjectCommand({
          Bucket: AWS_S3_BUCKET!,
          Key: obj.Key,
        }));
        logger.info(`[STORAGE] Deleted old document: ${obj.Key}`);
      }
    } catch (error: any) {
      logger.warn('[STORAGE] Failed to list/delete old S3 documents', {
        driverId,
        documentType: docType,
        error: error?.message,
      });
    }
  } else {
    // Local storage
    const uploadDir = path.join(process.cwd(), 'uploads', docType);
    if (fs.existsSync(uploadDir)) {
      const files = fs.readdirSync(uploadDir);
      const pattern = `${driverId}_${docType}`;
      for (const file of files) {
        if (file.startsWith(pattern)) {
          fs.unlinkSync(path.join(uploadDir, file));
          logger.info(`[STORAGE] Deleted old local file: ${file}`);
        }
      }
    }
  }
};

/**
 * Get storage configuration status
 */
export const getStorageConfig = () => ({
  type: isS3Configured() ? 'aws-s3' : 'local-disk',
  bucket: isS3Configured() ? AWS_S3_BUCKET : null,
  region: isS3Configured() ? AWS_S3_REGION : null,
  cdnDomain: AWS_CLOUDFRONT_DOMAIN || null,
});

/**
 * Get the S3 client for direct operations (if needed)
 */
export const getS3Client = (): S3Client | null => s3Client;

/**
 * Extract S3 key from an S3 or legacy DO Spaces URL
 * Example: https://bucket.s3.ap-south-1.amazonaws.com/LICENSE/abc_LICENSE.jpg -> LICENSE/abc_LICENSE.jpg
 * Legacy:  https://bucket.sfo3.digitaloceanspaces.com/LICENSE/abc_LICENSE.jpg -> LICENSE/abc_LICENSE.jpg
 */
export const extractKeyFromUrl = (documentUrl: string): string | null => {
  try {
    if (!isS3Url(documentUrl)) {
      return null;
    }
    const url = new URL(documentUrl);
    return url.pathname.substring(1); // Remove leading slash
  } catch {
    return null;
  }
};

/**
 * Check if a document URL is from S3 (or legacy DO Spaces)
 */
export const isSpacesUrl = (documentUrl: string): boolean => {
  return isS3Url(documentUrl);
};

/**
 * Download document from S3 as a Buffer
 * Used for sending to Vision API (private files can't be accessed via URL)
 */
export const downloadDocument = async (documentUrl: string): Promise<Buffer | null> => {
  // Handle local files
  if (documentUrl.startsWith('/uploads/')) {
    const localPath = path.join(process.cwd(), documentUrl);
    if (fs.existsSync(localPath)) {
      return fs.promises.readFile(localPath);
    }
    logger.error('[STORAGE] Local file not found', { documentUrl });
    return null;
  }

  // Handle S3 files
  if (!isS3Configured() || !s3Client) {
    logger.error('[STORAGE] Cannot download: S3 not configured');
    return null;
  }

  const key = extractKeyFromUrl(documentUrl);
  if (!key) {
    logger.error('[STORAGE] Cannot extract key from URL', { documentUrl });
    return null;
  }

  try {
    const command = new GetObjectCommand({
      Bucket: AWS_S3_BUCKET!,
      Key: key,
    });

    const response = await s3Client.send(command);
    
    if (!response.Body) {
      logger.error('[STORAGE] Empty response body from S3');
      return null;
    }

    // Convert stream to buffer
    const stream = response.Body as Readable;
    const chunks: Buffer[] = [];
    
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    
    const buffer = Buffer.concat(chunks);
    logger.info(`[STORAGE] Downloaded ${key} (${buffer.length} bytes)`);
    return buffer;
  } catch (error: any) {
    logger.error('[STORAGE] Failed to download from S3', { error: error.message, documentUrl });
    return null;
  }
};

/**
 * Generate a presigned URL for temporary access to a private document
 * Useful if you need to share the URL temporarily (e.g., admin preview)
 * 
 * @param documentUrl - The document URL (S3 or local)
 * @param expiresIn - URL expiry time in seconds (default: 1 hour)
 */
export const getPresignedUrl = async (documentUrl: string, expiresIn: number = 3600): Promise<string | null> => {
  // Local files don't need presigning
  if (documentUrl.startsWith('/uploads/')) {
    return documentUrl;
  }

  if (!isS3Configured() || !s3Client) {
    logger.warn('[STORAGE] Cannot generate presigned URL: S3 not configured');
    return null;
  }

  const key = extractKeyFromUrl(documentUrl);
  if (!key) {
    logger.error('[STORAGE] Cannot extract key from URL for presigning', { documentUrl });
    return null;
  }

  try {
    const command = new GetObjectCommand({
      Bucket: AWS_S3_BUCKET!,
      Key: key,
    });

    const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn });
    logger.info(`[STORAGE] Generated presigned URL for ${key} (expires in ${expiresIn}s)`);
    return presignedUrl;
  } catch (error: any) {
    logger.error('[STORAGE] Failed to generate presigned URL', { error: error.message, documentUrl });
    return null;
  }
};
