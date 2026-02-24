/**
 * DigitalOcean Spaces Storage Module
 * 
 * Uses S3-compatible API for document uploads.
 * Falls back to local disk storage if Spaces is not configured.
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import multer from 'multer';
import multerS3 from 'multer-s3';
import path from 'path';
import fs from 'fs';
import { createLogger } from '@raahi/shared';

const logger = createLogger('driver-service:storage');

// DigitalOcean Spaces configuration
const DO_SPACES_ENDPOINT = process.env.DO_SPACES_ENDPOINT; // e.g., 'nyc3.digitaloceanspaces.com'
const DO_SPACES_BUCKET = process.env.DO_SPACES_BUCKET; // e.g., 'raahi-documents'
const DO_SPACES_KEY = process.env.DO_SPACES_KEY;
const DO_SPACES_SECRET = process.env.DO_SPACES_SECRET;
const DO_SPACES_CDN_ENDPOINT = process.env.DO_SPACES_CDN_ENDPOINT; // Optional CDN endpoint

// Check if DO Spaces is configured
export const isSpacesConfigured = (): boolean => {
  return !!(DO_SPACES_ENDPOINT && DO_SPACES_BUCKET && DO_SPACES_KEY && DO_SPACES_SECRET);
};

// S3 client for DigitalOcean Spaces
let s3Client: S3Client | null = null;

if (isSpacesConfigured()) {
  s3Client = new S3Client({
    endpoint: `https://${DO_SPACES_ENDPOINT}`,
    region: 'us-east-1', // DigitalOcean Spaces requires this even though it's ignored
    credentials: {
      accessKeyId: DO_SPACES_KEY!,
      secretAccessKey: DO_SPACES_SECRET!,
    },
    forcePathStyle: false,
  });
  logger.info(`[STORAGE] DigitalOcean Spaces configured: ${DO_SPACES_BUCKET} at ${DO_SPACES_ENDPOINT}`);
} else {
  logger.warn('[STORAGE] DigitalOcean Spaces not configured, using local disk storage');
}

// Generate unique filename
const generateFilename = (file: Express.Multer.File): string => {
  const ext = path.extname(file.originalname).toLowerCase();
  const timestamp = Date.now();
  const random = Math.round(Math.random() * 1e9);
  return `${file.fieldname}-${timestamp}-${random}${ext}`;
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

// Create multer upload middleware
export const createUploadMiddleware = () => {
  if (isSpacesConfigured() && s3Client) {
    // DigitalOcean Spaces storage
    return multer({
      storage: multerS3({
        s3: s3Client,
        bucket: DO_SPACES_BUCKET!,
        acl: 'private', // Documents are private by default
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: (_req, file, cb) => {
          const filename = generateFilename(file);
          const key = `driver-documents/${filename}`;
          cb(null, key);
        },
        metadata: (_req, file, cb) => {
          cb(null, {
            originalName: file.originalname,
            fieldName: file.fieldname,
          });
        },
      }),
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
      fileFilter,
    });
  } else {
    // Local disk storage fallback
    const uploadDir = path.join(process.cwd(), 'uploads', 'driver-documents');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    return multer({
      storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadDir),
        filename: (_req, file, cb) => cb(null, generateFilename(file)),
      }),
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
      fileFilter,
    });
  }
};

// Get document URL based on storage type
export const getDocumentUrl = (file: Express.Multer.File & { key?: string; location?: string }): string => {
  if (isSpacesConfigured() && file.key) {
    // Use CDN endpoint if configured, otherwise construct direct URL
    if (DO_SPACES_CDN_ENDPOINT) {
      return `https://${DO_SPACES_CDN_ENDPOINT}/${file.key}`;
    }
    return `https://${DO_SPACES_BUCKET}.${DO_SPACES_ENDPOINT}/${file.key}`;
  }
  // Local storage URL
  return `/uploads/driver-documents/${file.filename}`;
};

// Delete document from storage
export const deleteDocument = async (documentUrl: string): Promise<boolean> => {
  try {
    if (isSpacesConfigured() && s3Client && documentUrl.includes(DO_SPACES_ENDPOINT!)) {
      // Extract key from URL
      const urlParts = new URL(documentUrl);
      const key = urlParts.pathname.substring(1); // Remove leading slash
      
      await s3Client.send(new DeleteObjectCommand({
        Bucket: DO_SPACES_BUCKET!,
        Key: key,
      }));
      logger.info(`[STORAGE] Deleted from Spaces: ${key}`);
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

// Get storage configuration status
export const getStorageConfig = () => ({
  type: isSpacesConfigured() ? 'digitalocean-spaces' : 'local-disk',
  bucket: isSpacesConfigured() ? DO_SPACES_BUCKET : null,
  endpoint: isSpacesConfigured() ? DO_SPACES_ENDPOINT : null,
  cdnEndpoint: DO_SPACES_CDN_ENDPOINT || null,
});

/**
 * Generate a presigned URL for temporary access to a private document.
 * Used by Vision API to download private documents for verification.
 * 
 * @param documentUrl - The stored document URL
 * @param expiresIn - URL validity in seconds (default: 5 minutes)
 * @returns Presigned URL or original URL if not using Spaces
 */
export const getPresignedUrl = async (documentUrl: string, expiresIn: number = 300): Promise<string> => {
  if (!isSpacesConfigured() || !s3Client || !documentUrl.includes(DO_SPACES_ENDPOINT!)) {
    return documentUrl;
  }

  try {
    const urlParts = new URL(documentUrl);
    const key = urlParts.pathname.substring(1);

    const command = new GetObjectCommand({
      Bucket: DO_SPACES_BUCKET!,
      Key: key,
    });

    const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn });
    logger.info(`[STORAGE] Generated presigned URL for: ${key}`);
    return presignedUrl;
  } catch (error) {
    logger.error('[STORAGE] Failed to generate presigned URL', { error, documentUrl });
    return documentUrl;
  }
};

/**
 * Download document content directly from storage.
 * Used when presigned URLs are not suitable.
 * 
 * @param documentUrl - The stored document URL
 * @returns Buffer containing the document data
 */
export const downloadDocument = async (documentUrl: string): Promise<Buffer> => {
  if (!isSpacesConfigured() || !s3Client || !documentUrl.includes(DO_SPACES_ENDPOINT!)) {
    const localPath = path.join(process.cwd(), documentUrl);
    return fs.promises.readFile(localPath);
  }

  try {
    const urlParts = new URL(documentUrl);
    const key = urlParts.pathname.substring(1);

    const command = new GetObjectCommand({
      Bucket: DO_SPACES_BUCKET!,
      Key: key,
    });

    const response = await s3Client.send(command);
    const bodyContents = await response.Body?.transformToByteArray();
    
    if (!bodyContents) {
      throw new Error('Empty response body');
    }

    logger.info(`[STORAGE] Downloaded document: ${key}`);
    return Buffer.from(bodyContents);
  } catch (error) {
    logger.error('[STORAGE] Failed to download document', { error, documentUrl });
    throw error;
  }
};
