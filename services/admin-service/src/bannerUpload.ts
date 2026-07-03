import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createLogger } from '@raahi/shared';

const logger = createLogger('admin-service:banner-upload');

/** In-app banner carousel slot size (must match mobile UI). */
export const BANNER_WIDTH = 320;
export const BANNER_HEIGHT = 120;

const AWS_S3_REGION = process.env.AWS_S3_REGION;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_CLOUDFRONT_DOMAIN = process.env.AWS_CLOUDFRONT_DOMAIN;

const uploadsDir = path.join(process.cwd(), 'uploads', 'banners');

function isS3Configured(): boolean {
  return !!(AWS_S3_REGION && AWS_S3_BUCKET && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY);
}

let s3Client: S3Client | null = null;
if (isS3Configured()) {
  s3Client = new S3Client({
    region: AWS_S3_REGION!,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID!,
      secretAccessKey: AWS_SECRET_ACCESS_KEY!,
    },
  });
}

const imageFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp|gif/;
  const extValid = allowed.test(path.extname(file.originalname).toLowerCase());
  const mimeValid = allowed.test(file.mimetype);
  if (extValid && mimeValid) cb(null, true);
  else cb(new Error('Only .png, .jpg, .jpeg, .webp and .gif images are allowed'));
};

export const bannerUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFilter,
}).single('image');

function publicUrlForKey(key: string): string {
  if (AWS_CLOUDFRONT_DOMAIN) {
    return `https://${AWS_CLOUDFRONT_DOMAIN}/${key}`;
  }
  return `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/${key}`;
}

function getImageDimensions(buffer: Buffer): { width: number; height: number } | null {
  // PNG: IHDR width/height at bytes 16–23
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // JPEG: scan for SOF0/SOF2 marker
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > buffer.length) break;
      if (marker === 0xc0 || marker === 0xc2) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + length;
    }
  }
  return null;
}

export function validateBannerDimensions(file: Express.Multer.File): void {
  const dims = getImageDimensions(file.buffer);
  if (!dims) {
    throw new Error('Could not read image size — use PNG or JPEG');
  }
  if (dims.width !== BANNER_WIDTH || dims.height !== BANNER_HEIGHT) {
    throw new Error(
      `Banner must be exactly ${BANNER_WIDTH}×${BANNER_HEIGHT}px (uploaded: ${dims.width}×${dims.height}px)`,
    );
  }
}

export async function uploadBannerImage(file: Express.Multer.File): Promise<string> {
  validateBannerDimensions(file);
  const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
  const key = `banners/banner_${Date.now()}${ext}`;

  if (isS3Configured() && s3Client) {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: AWS_S3_BUCKET!,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }),
    );
    const url = publicUrlForKey(key);
    logger.info(`[BANNER-UPLOAD] S3: ${key}`);
    return url;
  }

  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  const filename = path.basename(key);
  const localPath = path.join(uploadsDir, filename);
  fs.writeFileSync(localPath, file.buffer);
  logger.info(`[BANNER-UPLOAD] Local: ${localPath}`);
  return `/uploads/banners/${filename}`;
}
