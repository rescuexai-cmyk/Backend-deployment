/**
 * BullMQ Worker for Document Verification
 * 
 * Processes verification jobs from the queue, calls Cloud Vision API,
 * and updates document status in the database.
 */

import { Worker, Job } from 'bullmq';
import { createLogger, prisma } from '@raahi/shared';
import { OnboardingStatus } from '@prisma/client';
import { getConnectionOptions, VerificationJobData } from './queues';
import { validateDocument, isVisionConfigured, DocumentType, DriverContext, crossVerifyDocuments } from './visionService';
import { checkRequiredDocuments } from '@raahi/shared';

const logger = createLogger('driver-service:worker');

let worker: Worker<VerificationJobData> | null = null;

async function processVerificationJob(job: Job<VerificationJobData>): Promise<void> {
  const { documentId, driverId, documentType, documentUrl } = job.data;
  
  logger.info(`[WORKER] Processing verification job`, {
    jobId: job.id,
    documentId,
    documentType,
  });
  
  await prisma.driverDocument.update({
    where: { id: documentId },
    data: { verificationStatus: 'processing' },
  });
  
  if (!isVisionConfigured()) {
    logger.warn('[WORKER] Vision API not configured, skipping verification');
    await prisma.driverDocument.update({
      where: { id: documentId },
      data: {
        verificationStatus: 'pending',
        aiExtractedData: { skipped: true, reason: 'Vision API not configured' },
      },
    });
    return;
  }
  
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: {
      panNumber: true,
      aadhaarNumber: true,
      vehicleNumber: true,
    },
  });
  
  if (!driver) {
    logger.error('[WORKER] Driver not found', { driverId });
    await prisma.driverDocument.update({
      where: { id: documentId },
      data: {
        verificationStatus: 'failed',
        aiMismatchReason: 'Driver not found',
      },
    });
    return;
  }
  
  const driverContext: DriverContext = {
    panNumber: driver.panNumber,
    aadhaarNumber: driver.aadhaarNumber,
    vehicleNumber: driver.vehicleNumber,
  };
  
  try {
    const result = await validateDocument(
      documentType as DocumentType,
      documentUrl,
      driverContext,
    );
    
    logger.info(`[WORKER] Validation complete for ${documentType}`, {
      documentId,
      isValid: result.isValid,
      confidence: result.confidence,
    });
    
    let verificationStatus: string;
    let isVerified = false;
    let verifiedBy: string | null = null;
    let verifiedAt: Date | null = null;
    
    if (result.isValid) {
      verificationStatus = 'verified';
      isVerified = true;
      verifiedBy = 'AI_VISION';
      verifiedAt = new Date();
    } else if (result.mismatchReason) {
      verificationStatus = 'flagged';
    } else {
      verificationStatus = 'flagged';
    }
    
    await prisma.driverDocument.update({
      where: { id: documentId },
      data: {
        aiVerified: result.isValid,
        aiConfidence: result.confidence,
        aiExtractedData: result.extractedData,
        aiVerifiedAt: new Date(),
        aiMismatchReason: result.mismatchReason,
        verificationStatus,
        isVerified,
        verifiedBy,
        verifiedAt,
      },
    });
    
    if (result.isValid) {
      await checkAndCompleteOnboarding(driverId);
    }
    
  } catch (error: any) {
    logger.error('[WORKER] Verification failed', {
      documentId,
      error: error.message,
    });
    
    if (job.attemptsMade >= (job.opts.attempts || 3) - 1) {
      await prisma.driverDocument.update({
        where: { id: documentId },
        data: {
          verificationStatus: 'failed',
          aiMismatchReason: `Verification failed: ${error.message}`,
        },
      });
    }
    
    throw error;
  }
}

async function checkAndCompleteOnboarding(driverId: string): Promise<void> {
  const allDocs = await prisma.driverDocument.findMany({
    where: { driverId },
    select: {
      documentType: true,
      isVerified: true,
      verificationStatus: true,
      aiExtractedData: true,
    },
  });
  
  const docCheck = checkRequiredDocuments(allDocs.map((d) => d.documentType));
  const allVerified = allDocs.length > 0 && allDocs.every((d) => d.isVerified);
  
  if (docCheck.isComplete && allVerified) {
    // Perform cross-document verification to ensure all docs belong to same person
    const crossVerification = await crossVerifyDocuments(
      allDocs.map((d) => ({
        documentType: d.documentType,
        aiExtractedData: d.aiExtractedData as any,
      }))
    );
    
    if (!crossVerification.isConsistent) {
      // Names don't match across documents - flag for manual review
      logger.warn(`[WORKER] Cross-verification FAILED for driver ${driverId}`, {
        mismatchDetails: crossVerification.mismatchDetails,
        extractedNames: crossVerification.extractedNames,
      });
      
      await prisma.driver.update({
        where: { id: driverId },
        data: {
          onboardingStatus: OnboardingStatus.DOCUMENT_VERIFICATION,
          isVerified: false,
          verificationNotes: `Cross-verification failed: ${crossVerification.mismatchDetails}. Manual review required.`,
        },
      });
      
      return;
    }
    
    // All checks passed - complete onboarding
    await prisma.driver.update({
      where: { id: driverId },
      data: {
        onboardingStatus: OnboardingStatus.COMPLETED,
        isVerified: true,
        documentsVerifiedAt: new Date(),
        verificationNotes: `All documents auto-verified by AI Vision. Cross-verification passed (${(crossVerification.confidence * 100).toFixed(0)}% name match confidence).`,
      },
    });
    
    logger.info(`[WORKER] Driver ${driverId} auto-verified - all documents passed, cross-verification OK`, {
      extractedNames: crossVerification.extractedNames,
      confidence: crossVerification.confidence,
    });
  }
}

export function startVerificationWorker(): Worker<VerificationJobData> {
  if (worker) {
    logger.warn('[WORKER] Worker already running');
    return worker;
  }
  
  worker = new Worker<VerificationJobData>(
    'document-verification',
    processVerificationJob,
    {
      connection: getConnectionOptions(),
      concurrency: 5,
    },
  );
  
  worker.on('completed', (job) => {
    logger.info(`[WORKER] Job completed`, { jobId: job.id });
  });
  
  worker.on('failed', (job, error) => {
    logger.error(`[WORKER] Job failed`, {
      jobId: job?.id,
      error: error.message,
      attempts: job?.attemptsMade,
    });
  });
  
  worker.on('error', (error) => {
    logger.error('[WORKER] Worker error', { error: error.message });
  });
  
  logger.info('[WORKER] Document verification worker started');
  return worker;
}

export async function stopVerificationWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('[WORKER] Worker stopped');
  }
}

export function isWorkerRunning(): boolean {
  return worker !== null && worker.isRunning();
}
