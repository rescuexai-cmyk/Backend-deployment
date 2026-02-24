/**
 * Google Cloud Vision API Service
 * 
 * Handles OCR text extraction and document validation for driver documents.
 * Supports: LICENSE, PAN_CARD, AADHAAR_CARD, RC, INSURANCE
 * 
 * Authentication methods (in order of preference):
 * 1. API Key (GOOGLE_VISION_API_KEY) - simplest, uses REST API
 * 2. Service Account Key File (GOOGLE_VISION_KEY_FILE)
 * 3. Inline JSON Credentials (GOOGLE_VISION_CREDENTIALS)
 * 4. Default Application Credentials (GOOGLE_APPLICATION_CREDENTIALS)
 */

import { ImageAnnotatorClient } from '@google-cloud/vision';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { createLogger } from '@raahi/shared';
import { downloadDocument, isSpacesUrl } from './storage';

const logger = createLogger('driver-service:vision');

const VISION_API_URL = 'https://vision.googleapis.com/v1/images:annotate';

let visionClient: ImageAnnotatorClient | null = null;
let useApiKey = false;

function getApiKey(): string | null {
  return process.env.GOOGLE_VISION_API_KEY || null;
}

function getVisionClient(): ImageAnnotatorClient {
  if (visionClient) return visionClient;

  const keyFilePath = process.env.GOOGLE_VISION_KEY_FILE;
  const credentials = process.env.GOOGLE_VISION_CREDENTIALS;

  if (keyFilePath && fs.existsSync(keyFilePath)) {
    visionClient = new ImageAnnotatorClient({ keyFilename: keyFilePath });
    logger.info('[VISION] Initialized with key file');
  } else if (credentials) {
    visionClient = new ImageAnnotatorClient({
      credentials: JSON.parse(credentials),
    });
    logger.info('[VISION] Initialized with JSON credentials');
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    visionClient = new ImageAnnotatorClient();
    logger.info('[VISION] Initialized with GOOGLE_APPLICATION_CREDENTIALS');
  } else {
    throw new Error('Google Cloud Vision API not configured');
  }

  return visionClient;
}

export function isVisionConfigured(): boolean {
  const apiKey = getApiKey();
  if (apiKey) {
    useApiKey = true;
    logger.info('[VISION] Using API Key authentication');
    return true;
  }
  return !!(
    process.env.GOOGLE_VISION_KEY_FILE ||
    process.env.GOOGLE_VISION_CREDENTIALS ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
}

/**
 * Call Vision API using REST with API Key
 */
async function callVisionApiWithKey(imageBuffer: Buffer, features: string[]): Promise<any> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('API Key not configured');

  const requestBody = {
    requests: [
      {
        image: {
          content: imageBuffer.toString('base64'),
        },
        features: features.map((type) => ({ type })),
      },
    ],
  };

  const response = await axios.post(`${VISION_API_URL}?key=${apiKey}`, requestBody, {
    headers: { 'Content-Type': 'application/json' },
  });

  return response.data.responses[0];
}

export function getConfidenceThreshold(): number {
  return parseFloat(process.env.VISION_CONFIDENCE_THRESHOLD || '0.70');
}

export interface ValidationResult {
  isValid: boolean;
  confidence: number;
  extractedData: Record<string, any>;
  mismatchReason: string | null;
}

const PAN_REGEX = /[A-Z]{5}[0-9]{4}[A-Z]/;
const AADHAAR_REGEX = /\b\d{4}\s?\d{4}\s?\d{4}\b/;
const VEHICLE_REG_REGEX = /[A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{1,4}/i;
const DL_NUMBER_REGEX = /[A-Z]{2}\d{2}\s?\d{4}\s?\d{7}/;

const DOCUMENT_KEYWORDS: Record<string, { keywords: string[]; threshold: number }> = {
  PAN_CARD: {
    keywords: ['income tax', 'permanent account number', 'govt of india', 'government of india', 'pan', 'date of birth'],
    threshold: 2,
  },
  AADHAAR_CARD: {
    keywords: ['aadhaar', 'unique identification', 'uidai', 'government of india', 'dob', 'male', 'female'],
    threshold: 2,
  },
  LICENSE: {
    keywords: ['driving licence', 'driving license', 'transport', 'motor vehicle', 'validity', 'date of issue', 'rto'],
    threshold: 2,
  },
  RC: {
    keywords: ['registration certificate', 'registering authority', 'vehicle', 'chassis', 'engine', 'owner'],
    threshold: 2,
  },
  INSURANCE: {
    keywords: ['insurance', 'policy', 'premium', 'insured', 'third party', 'vehicle', 'cover note'],
    threshold: 2,
  },
};

async function fetchImageBuffer(documentUrl: string): Promise<Buffer> {
  // Handle DO Spaces private files - use S3 download instead of HTTP
  if (isSpacesUrl(documentUrl)) {
    logger.info(`[VISION] Downloading private file from DO Spaces: ${documentUrl.substring(0, 60)}...`);
    const buffer = await downloadDocument(documentUrl);
    if (!buffer) {
      throw new Error(`Failed to download document from DO Spaces: ${documentUrl}`);
    }
    return buffer;
  }
  
  // Handle public HTTP URLs (non-DO Spaces)
  if (documentUrl.startsWith('http://') || documentUrl.startsWith('https://')) {
    const response = await axios.get(documentUrl, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
  }
  
  // Handle local files
  const localPath = path.join(process.cwd(), documentUrl);
  return fs.promises.readFile(localPath);
}

function countKeywordMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
}

/**
 * Extract text from an image using Cloud Vision OCR
 */
export async function extractText(imageUrl: string): Promise<string> {
  const imageBuffer = await fetchImageBuffer(imageUrl);
  
  if (useApiKey) {
    const result = await callVisionApiWithKey(imageBuffer, ['TEXT_DETECTION']);
    const detections = result.textAnnotations || [];
    if (detections.length === 0) return '';
    return detections[0].description || '';
  }
  
  const client = getVisionClient();
  const [result] = await client.textDetection({ image: { content: imageBuffer } });
  const detections = result.textAnnotations || [];
  
  if (detections.length === 0) {
    return '';
  }
  
  return detections[0].description || '';
}

/**
 * Validate PAN Card - extract PAN number and cross-validate
 */
export async function validatePanCard(imageUrl: string, expectedPan?: string | null): Promise<ValidationResult> {
  const text = await extractText(imageUrl);
  const extractedData: Record<string, any> = { rawTextLength: text.length };
  let confidence = 0;

  if (text.length < 10) {
    return {
      isValid: false,
      confidence: 0.1,
      extractedData,
      mismatchReason: 'Could not read text from document. Please upload a clearer image.',
    };
  }

  const kwMatch = countKeywordMatches(text, DOCUMENT_KEYWORDS.PAN_CARD.keywords);
  if (kwMatch >= DOCUMENT_KEYWORDS.PAN_CARD.threshold) {
    confidence += 0.35;
    extractedData.keywordsMatched = kwMatch;
  } else if (kwMatch >= 1) {
    confidence += 0.15;
    extractedData.keywordsMatched = kwMatch;
  }

  const panMatch = text.replace(/\s/g, '').match(PAN_REGEX);
  if (panMatch) {
    extractedData.panNumber = panMatch[0];
    confidence += 0.35;

    if (expectedPan) {
      const normalizedExpected = expectedPan.replace(/\s/g, '').toUpperCase();
      const normalizedExtracted = panMatch[0].toUpperCase();
      
      if (normalizedExtracted === normalizedExpected) {
        confidence += 0.30;
        extractedData.panMatched = true;
      } else {
        extractedData.panMatched = false;
        return {
          isValid: false,
          confidence: Math.min(confidence, 0.5),
          extractedData,
          mismatchReason: `PAN number mismatch: document shows ${panMatch[0]}, but registration has ${expectedPan}`,
        };
      }
    }
  } else {
    return {
      isValid: false,
      confidence: Math.min(confidence, 0.3),
      extractedData,
      mismatchReason: 'Could not detect a valid PAN number on the document',
    };
  }

  const threshold = getConfidenceThreshold();
  return {
    isValid: confidence >= threshold,
    confidence: Math.min(confidence, 1),
    extractedData,
    mismatchReason: confidence < threshold ? 'Document confidence too low for auto-verification' : null,
  };
}

/**
 * Validate Aadhaar Card - extract Aadhaar number and cross-validate
 */
export async function validateAadhaar(imageUrl: string, expectedAadhaar?: string | null): Promise<ValidationResult> {
  const text = await extractText(imageUrl);
  const extractedData: Record<string, any> = { rawTextLength: text.length };
  let confidence = 0;

  if (text.length < 10) {
    return {
      isValid: false,
      confidence: 0.1,
      extractedData,
      mismatchReason: 'Could not read text from document. Please upload a clearer image.',
    };
  }

  const kwMatch = countKeywordMatches(text, DOCUMENT_KEYWORDS.AADHAAR_CARD.keywords);
  if (kwMatch >= DOCUMENT_KEYWORDS.AADHAAR_CARD.threshold) {
    confidence += 0.35;
    extractedData.keywordsMatched = kwMatch;
  } else if (kwMatch >= 1) {
    confidence += 0.15;
    extractedData.keywordsMatched = kwMatch;
  }

  const aadhaarMatch = text.match(AADHAAR_REGEX);
  if (aadhaarMatch) {
    const detected = aadhaarMatch[0].replace(/\s/g, '');
    extractedData.aadhaarNumber = `${detected.slice(0, 4)} ${detected.slice(4, 8)} ${detected.slice(8)}`;
    confidence += 0.35;

    if (expectedAadhaar) {
      const normalizedExpected = expectedAadhaar.replace(/\s/g, '');
      
      if (detected === normalizedExpected) {
        confidence += 0.30;
        extractedData.aadhaarMatched = true;
      } else {
        extractedData.aadhaarMatched = false;
        return {
          isValid: false,
          confidence: Math.min(confidence, 0.5),
          extractedData,
          mismatchReason: `Aadhaar number mismatch: document shows ${extractedData.aadhaarNumber}, but registration has different number`,
        };
      }
    }
  } else {
    return {
      isValid: false,
      confidence: Math.min(confidence, 0.3),
      extractedData,
      mismatchReason: 'Could not detect a valid Aadhaar number on the document',
    };
  }

  const threshold = getConfidenceThreshold();
  return {
    isValid: confidence >= threshold,
    confidence: Math.min(confidence, 1),
    extractedData,
    mismatchReason: confidence < threshold ? 'Document confidence too low for auto-verification' : null,
  };
}

/**
 * Validate Driving License - extract DL number and expiry
 */
export async function validateLicense(imageUrl: string): Promise<ValidationResult> {
  const text = await extractText(imageUrl);
  const extractedData: Record<string, any> = { rawTextLength: text.length };
  let confidence = 0;

  if (text.length < 10) {
    return {
      isValid: false,
      confidence: 0.1,
      extractedData,
      mismatchReason: 'Could not read text from document. Please upload a clearer image.',
    };
  }

  const kwMatch = countKeywordMatches(text, DOCUMENT_KEYWORDS.LICENSE.keywords);
  if (kwMatch >= DOCUMENT_KEYWORDS.LICENSE.threshold) {
    confidence += 0.40;
    extractedData.keywordsMatched = kwMatch;
  } else if (kwMatch >= 1) {
    confidence += 0.20;
    extractedData.keywordsMatched = kwMatch;
  }

  const dlMatch = text.replace(/\s/g, '').match(DL_NUMBER_REGEX);
  if (dlMatch) {
    extractedData.licenseNumber = dlMatch[0];
    confidence += 0.40;
  }

  const expiryMatch = text.match(/valid\s*(till|upto|to|until)[:\s]*(\d{2}[/-]\d{2}[/-]\d{4})/i);
  if (expiryMatch) {
    extractedData.expiryDate = expiryMatch[2];
    confidence += 0.20;
  }

  if (confidence < 0.3) {
    return {
      isValid: false,
      confidence,
      extractedData,
      mismatchReason: 'Document does not appear to be a valid driving licence',
    };
  }

  const threshold = getConfidenceThreshold();
  return {
    isValid: confidence >= threshold,
    confidence: Math.min(confidence, 1),
    extractedData,
    mismatchReason: confidence < threshold ? 'Document confidence too low for auto-verification' : null,
  };
}

/**
 * Validate Registration Certificate - extract vehicle number and cross-validate
 */
export async function validateRC(imageUrl: string, expectedVehicleNumber?: string | null): Promise<ValidationResult> {
  const text = await extractText(imageUrl);
  const extractedData: Record<string, any> = { rawTextLength: text.length };
  let confidence = 0;

  if (text.length < 10) {
    return {
      isValid: false,
      confidence: 0.1,
      extractedData,
      mismatchReason: 'Could not read text from document. Please upload a clearer image.',
    };
  }

  const kwMatch = countKeywordMatches(text, DOCUMENT_KEYWORDS.RC.keywords);
  if (kwMatch >= DOCUMENT_KEYWORDS.RC.threshold) {
    confidence += 0.35;
    extractedData.keywordsMatched = kwMatch;
  } else if (kwMatch >= 1) {
    confidence += 0.15;
    extractedData.keywordsMatched = kwMatch;
  }

  const regMatch = text.replace(/\s/g, '').match(VEHICLE_REG_REGEX);
  if (regMatch) {
    extractedData.vehicleNumber = regMatch[0];
    confidence += 0.35;

    if (expectedVehicleNumber) {
      const normalizedExpected = expectedVehicleNumber.replace(/[\s-]/g, '').toUpperCase();
      const normalizedExtracted = regMatch[0].replace(/[\s-]/g, '').toUpperCase();
      
      if (normalizedExtracted === normalizedExpected) {
        confidence += 0.30;
        extractedData.vehicleNumberMatched = true;
      } else {
        extractedData.vehicleNumberMatched = false;
        return {
          isValid: false,
          confidence: Math.min(confidence, 0.5),
          extractedData,
          mismatchReason: `Vehicle number mismatch: document shows ${regMatch[0]}, but registration has ${expectedVehicleNumber}`,
        };
      }
    }
  }

  if (confidence < 0.3) {
    return {
      isValid: false,
      confidence,
      extractedData,
      mismatchReason: 'Document does not appear to be a valid Registration Certificate',
    };
  }

  const threshold = getConfidenceThreshold();
  return {
    isValid: confidence >= threshold,
    confidence: Math.min(confidence, 1),
    extractedData,
    mismatchReason: confidence < threshold ? 'Document confidence too low for auto-verification' : null,
  };
}

/**
 * Validate Insurance document - extract policy number and expiry
 */
export async function validateInsurance(imageUrl: string): Promise<ValidationResult> {
  const text = await extractText(imageUrl);
  const extractedData: Record<string, any> = { rawTextLength: text.length };
  let confidence = 0;

  if (text.length < 10) {
    return {
      isValid: false,
      confidence: 0.1,
      extractedData,
      mismatchReason: 'Could not read text from document. Please upload a clearer image.',
    };
  }

  const kwMatch = countKeywordMatches(text, DOCUMENT_KEYWORDS.INSURANCE.keywords);
  if (kwMatch >= DOCUMENT_KEYWORDS.INSURANCE.threshold) {
    confidence += 0.50;
    extractedData.keywordsMatched = kwMatch;
  } else if (kwMatch >= 1) {
    confidence += 0.25;
    extractedData.keywordsMatched = kwMatch;
  }

  const policyMatch = text.match(/policy\s*(?:no|number|#)[.:\s]*([A-Z0-9/-]+)/i);
  if (policyMatch) {
    extractedData.policyNumber = policyMatch[1].trim();
    confidence += 0.30;
  }

  const expiryMatch = text.match(/(expir|valid\s*(?:till|upto|to|until))[:\s]*(\d{2}[/-]\d{2}[/-]\d{4})/i);
  if (expiryMatch) {
    extractedData.expiryDate = expiryMatch[2];
    confidence += 0.20;
  }

  if (confidence < 0.3) {
    return {
      isValid: false,
      confidence,
      extractedData,
      mismatchReason: 'Document does not appear to be a valid insurance document',
    };
  }

  const threshold = getConfidenceThreshold();
  return {
    isValid: confidence >= threshold,
    confidence: Math.min(confidence, 1),
    extractedData,
    mismatchReason: confidence < threshold ? 'Document confidence too low for auto-verification' : null,
  };
}

export type DocumentType = 'LICENSE' | 'PAN_CARD' | 'AADHAAR_CARD' | 'RC' | 'INSURANCE';

export interface DriverContext {
  panNumber?: string | null;
  aadhaarNumber?: string | null;
  vehicleNumber?: string | null;
}

/**
 * Validate a document based on its type
 */
export async function validateDocument(
  documentType: DocumentType,
  imageUrl: string,
  driverContext: DriverContext,
): Promise<ValidationResult> {
  logger.info(`[VISION] Validating ${documentType}`, { imageUrl: imageUrl.substring(0, 50) });

  switch (documentType) {
    case 'PAN_CARD':
      return validatePanCard(imageUrl, driverContext.panNumber);
    case 'AADHAAR_CARD':
      return validateAadhaar(imageUrl, driverContext.aadhaarNumber);
    case 'LICENSE':
      return validateLicense(imageUrl);
    case 'RC':
      return validateRC(imageUrl, driverContext.vehicleNumber);
    case 'INSURANCE':
      return validateInsurance(imageUrl);
    default:
      return {
        isValid: false,
        confidence: 0,
        extractedData: {},
        mismatchReason: `Unsupported document type: ${documentType}`,
      };
  }
}
