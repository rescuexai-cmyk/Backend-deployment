/**
 * DigitalOcean Spaces Storage Module
 * 
 * Uses S3-compatible API for document uploads.
 * Falls back to local disk storage if Spaces is not configured.
 * 
 * File naming convention: {driverId}_{DOCUMENT_TYPE}.{extension}
 * Folder structure: /{DOCUMENT_TYPE}/{driverId}_{DOCUMENT_TYPE}.{extension}
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import multer from 'multer';
import multerS3 from 'multer-s3';
import path from 'path';
import fs from 'fs';
import { createLogger } from '@raahi/shared';
import { Readable } from 'stream';

const logger = createLogger('driver-service:storage');

// DigitalOcean Spaces configuration
const DO_SPACES_ENDPOINT = process.env.DO_SPACES_ENDPOINT; // e.g., 'sfo3.digitaloceanspaces.com'
const DO_SPACES_BUCKET = process.env.DO_SPACES_BUCKET; // e.g., 'raahidriverdocumentation'
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

/**
 * Generate filename in format: {driverId}_{DOCUMENT_TYPE}.{extension}
 */
const generateDriverDocFilename = (driverId: string, documentType: string, originalFilename: string): string => {
  const ext = path.extname(originalFilename).toLowerCase() || '.jpg';
  const docType = documentType.toUpperCase();
  return `${driverId}_${docType}${ext}`;
};

/**
 * Generate the full storage key/path
 * Format: {DOCUMENT_TYPE}/{driverId}_{DOCUMENT_TYPE}.{extension}
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
  if (isSpacesConfigured() && s3Client) {
    // DigitalOcean Spaces storage
    return multer({
      storage: multerS3({
        s3: s3Client,
        bucket: DO_SPACES_BUCKET!,
        acl: 'private', // Documents are private by default
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: (req, file, cb) => {
          const driverId = req.driverInfo?.id || 'unknown';
          const documentType = req.driverInfo?.documentType || req.body?.documentType || 'DOCUMENT';
          const key = generateStorageKey(driverId, documentType, file.originalname);
          
          logger.info(`[STORAGE] Uploading to Spaces: ${key}`);
          cb(null, key);
        },
        metadata: (req, file, cb) => {
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
        destination: (req, _file, cb) => {
          const documentType = (req.driverInfo?.documentType || req.body?.documentType || 'DOCUMENT').toUpperCase();
          const uploadDir = path.join(baseUploadDir, documentType);
          
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }
          cb(null, uploadDir);
        },
        filename: (req, file, cb) => {
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
  if (isSpacesConfigured() && file.key) {
    // Use CDN endpoint if configured, otherwise construct direct URL
    if (DO_SPACES_CDN_ENDPOINT) {
      return `https://${DO_SPACES_CDN_ENDPOINT}/${file.key}`;
    }
    return `https://${DO_SPACES_BUCKET}.${DO_SPACES_ENDPOINT}/${file.key}`;
  }
  
  // Local storage URL
  const docType = (documentType || 'DOCUMENT').toUpperCase();
  return `/uploads/${docType}/${file.filename}`;
};

/**
 * Delete document from storage
 */
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

/**
 * Delete old document before uploading new one (for re-uploads)
 */
export const deleteOldDocument = async (driverId: string, documentType: string): Promise<void> => {
  const docType = documentType.toUpperCase();
  
  if (isSpacesConfigured() && s3Client) {
    // Try common extensions
    const extensions = ['.jpg', '.jpeg', '.png', '.pdf'];
    for (const ext of extensions) {
      const key = `${docType}/${driverId}_${docType}${ext}`;
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: DO_SPACES_BUCKET!,
          Key: key,
        }));
        logger.info(`[STORAGE] Deleted old document: ${key}`);
      } catch {
        // Ignore if file doesn't exist
      }
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
  type: isSpacesConfigured() ? 'digitalocean-spaces' : 'local-disk',
  bucket: isSpacesConfigured() ? DO_SPACES_BUCKET : null,
  endpoint: isSpacesConfigured() ? DO_SPACES_ENDPOINT : null,
  cdnEndpoint: DO_SPACES_CDN_ENDPOINT || null,
});

/**
 * Get the S3 client for direct operations (if needed)
 */
export const getS3Client = (): S3Client | null => s3Client;

/**
 * Extract S3 key from a DO Spaces URL
 * Example: https://bucket.sfo3.digitaloceanspaces.com/LICENSE/abc_LICENSE.jpg -> LICENSE/abc_LICENSE.jpg
 */
export const extractKeyFromUrl = (documentUrl: string): string | null => {
  try {
    if (!documentUrl.includes('digitaloceanspaces.com')) {
      return null;
    }
    const url = new URL(documentUrl);
    return url.pathname.substring(1); // Remove leading slash
  } catch {
    return null;
  }
};

/**
 * Check if a document URL is from DO Spaces
 */
export const isSpacesUrl = (documentUrl: string): boolean => {
  return documentUrl.includes('digitaloceanspaces.com');
};

/**
 * Download document from DO Spaces as a Buffer
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

  // Handle DO Spaces files
  if (!isSpacesConfigured() || !s3Client) {
    logger.error('[STORAGE] Cannot download: Spaces not configured');
    return null;
  }

  const key = extractKeyFromUrl(documentUrl);
  if (!key) {
    logger.error('[STORAGE] Cannot extract key from URL', { documentUrl });
    return null;
  }

  try {
    const command = new GetObjectCommand({
      Bucket: DO_SPACES_BUCKET!,
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
    logger.error('[STORAGE] Failed to download from Spaces', { error: error.message, documentUrl });
    return null;
  }
};

/**
 * Generate a presigned URL for temporary access to a private document
 * Useful if you need to share the URL temporarily (e.g., admin preview)
 * 
 * @param documentUrl - The document URL (DO Spaces or local)
 * @param expiresIn - URL expiry time in seconds (default: 1 hour)
 */
export const getPresignedUrl = async (documentUrl: string, expiresIn: number = 3600): Promise<string | null> => {
  // Local files don't need presigning
  if (documentUrl.startsWith('/uploads/')) {
    return documentUrl;
  }

  if (!isSpacesConfigured() || !s3Client) {
    logger.warn('[STORAGE] Cannot generate presigned URL: Spaces not configured');
    return null;
  }

  const key = extractKeyFromUrl(documentUrl);
  if (!key) {
    logger.error('[STORAGE] Cannot extract key from URL for presigning', { documentUrl });
    return null;
  }

  try {
    const command = new GetObjectCommand({
      Bucket: DO_SPACES_BUCKET!,
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
