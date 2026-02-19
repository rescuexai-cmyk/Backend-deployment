/**
 * BullMQ Queue Setup for Document Verification
 * 
 * Redis-based job queue for async document verification via Cloud Vision API.
 */

import { Queue, QueueEvents, RedisConnection } from 'bullmq';
import { createLogger } from '@raahi/shared';

const logger = createLogger('driver-service:queue');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let connectionOptions: { connection: { host: string; port: number } } | null = null;
let documentVerificationQueue: Queue | null = null;
let queueEvents: QueueEvents | null = null;

export interface VerificationJobData {
  documentId: string;
  driverId: string;
  documentType: string;
  documentUrl: string;
}

function parseRedisUrl(url: string): { host: string; port: number } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port, 10) || 6379,
    };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

export function getConnectionOptions(): { host: string; port: number } {
  if (!connectionOptions) {
    const { host, port } = parseRedisUrl(REDIS_URL);
    connectionOptions = { connection: { host, port } };
    logger.info(`[REDIS] Connection configured: ${host}:${port}`);
  }
  return connectionOptions.connection;
}

export function getDocumentVerificationQueue(): Queue<VerificationJobData> {
  if (!documentVerificationQueue) {
    documentVerificationQueue = new Queue<VerificationJobData>('document-verification', {
      connection: getConnectionOptions(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: {
          age: 24 * 3600,
          count: 1000,
        },
        removeOnFail: {
          age: 7 * 24 * 3600,
        },
      },
    });
    
    logger.info('[QUEUE] Document verification queue initialized');
  }
  return documentVerificationQueue;
}

export function getQueueEvents(): QueueEvents {
  if (!queueEvents) {
    queueEvents = new QueueEvents('document-verification', {
      connection: getConnectionOptions(),
    });
  }
  return queueEvents;
}

/**
 * Add a document verification job to the queue
 */
export async function addVerificationJob(
  documentId: string,
  driverId: string,
  documentType: string,
  documentUrl: string,
): Promise<string> {
  const queue = getDocumentVerificationQueue();
  
  const job = await queue.add(
    'verify-document',
    {
      documentId,
      driverId,
      documentType,
      documentUrl,
    },
    {
      jobId: `verify-${documentId}`,
    },
  );
  
  logger.info(`[QUEUE] Added verification job for document ${documentId}`, {
    jobId: job.id,
    documentType,
  });
  
  return job.id!;
}

/**
 * Check if Redis/Queue is available
 */
export function isQueueAvailable(): boolean {
  return !!process.env.REDIS_URL;
}

/**
 * Graceful shutdown
 */
export async function closeQueues(): Promise<void> {
  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }
  if (documentVerificationQueue) {
    await documentVerificationQueue.close();
    documentVerificationQueue = null;
  }
  connectionOptions = null;
  logger.info('[QUEUE] Queues closed');
}
