/**
 * BullMQ Worker for Document Verification
 * 
 * Processes verification jobs from the queue, calls Cloud Vision API,
 * and updates document status in the database.
 */

import { Worker, Job } from 'bullmq';
import { createLogger, prisma, areRequiredDocumentsVerified } from '@raahi/shared';
import { OnboardingStatus } from '@prisma/client';
import { getConnectionOptions, VerificationJobData } from './queues';
import { validateDocument, isVisionConfigured, DocumentType, DriverContext, crossVerifyDocuments } from './visionService';

const logger = createLogger('driver-service:worker');

let worker: Worker<VerificationJobData> | null = null;

async function processVerificationJob(job: Job<VerificationJobData>): Promise<void> {
  const { documentId, driverId, documentType, documentUrl } = job.data;
  
  logger.info(`[WORKER] Processing verification job`, {
    jobId: job.id,
    documentId,
    documentType,
  });

  // Never let a late/stale AI job undo a manual admin approval.
  const existing = await prisma.driverDocument.findUnique({
    where: { id: documentId },
    select: { isVerified: true, verifiedBy: true, verificationStatus: true },
  });
  if (existing?.isVerified && existing.verifiedBy === 'ADMIN') {
    logger.info('[WORKER] Skipping AI overwrite of admin-verified document', {
      documentId,
      documentType,
    });
    return;
  }
  
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
    // Re-check admin lock after OCR (admin may have approved while job was running).
    const latest = await prisma.driverDocument.findUnique({
      where: { id: documentId },
      select: { isVerified: true, verifiedBy: true },
    });
    if (latest?.isVerified && latest.verifiedBy === 'ADMIN') {
      logger.info('[WORKER] Admin approved during OCR — keeping admin decision', { documentId });
      return;
    }

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
      const latest = await prisma.driverDocument.findUnique({
        where: { id: documentId },
        select: { isVerified: true, verifiedBy: true },
      });
      if (!(latest?.isVerified && latest.verifiedBy === 'ADMIN')) {
        await prisma.driverDocument.update({
          where: { id: documentId },
          data: {
            verificationStatus: 'failed',
            aiMismatchReason: `Verification failed: ${error.message}`,
          },
        });
      }
    }
    
    throw error;
  }
}

async function checkAndCompleteOnboarding(driverId: string): Promise<void> {
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { vehicleType: true },
  });

  const allDocs = await prisma.driverDocument.findMany({
    where: { driverId },
    select: {
      documentType: true,
      isVerified: true,
      verificationStatus: true,
      aiExtractedData: true,
    },
  });
  
  const allVerified = areRequiredDocumentsVerified(allDocs, driver?.vehicleType);
  
  if (allVerified) {
    // Perform cross-document verification to ensure all docs belong to same person
    const crossVerification = await crossVerifyDocuments(
      allDocs.map((d) => ({
        documentType: d.documentType,
        aiExtractedData: d.aiExtractedData as any,
      }))
    );
    
    if (!crossVerification.isConsistent) {
      // Identity document names don't match (DL vs PAN vs Aadhaar) - flag for manual review
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
    
    // Build verification notes with vehicle owner info
    let verificationNotes = `All documents auto-verified by AI Vision. Identity cross-verification passed (${(crossVerification.confidence * 100).toFixed(0)}% confidence).`;
    
    // Add vehicle owner info if RC owner differs from driver (common in India)
    if (crossVerification.vehicleOwnerInfo && !crossVerification.vehicleOwnerInfo.ownerMatchesDriver) {
      const rcOwner = crossVerification.vehicleOwnerInfo.rcOwner;
      if (rcOwner) {
        verificationNotes += ` Note: Vehicle registered to "${rcOwner}" (different from driver - this is allowed).`;
        logger.info(`[WORKER] Driver ${driverId} using vehicle owned by someone else`, {
          rcOwner,
          driverName: crossVerification.extractedNames['LICENSE'] || crossVerification.extractedNames['PAN_CARD'],
        });
      }
    }
    
    // All checks passed - complete onboarding
    await prisma.driver.update({
      where: { id: driverId },
      data: {
        onboardingStatus: OnboardingStatus.COMPLETED,
        isVerified: true,
        isActive: true,
        documentsVerifiedAt: new Date(),
        verificationNotes,
      },
    });
    
    logger.info(`[WORKER] Driver ${driverId} auto-verified - all documents passed`, {
      extractedNames: crossVerification.extractedNames,
      confidence: crossVerification.confidence,
      vehicleOwnerInfo: crossVerification.vehicleOwnerInfo,
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
