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

// Name extraction patterns
const NAME_PATTERNS = {
  // PAN Card: Name appears after "Name" label
  PAN: [
    /name[:\s]+([A-Z][A-Z\s]+)/i,
    /([A-Z]{2,}(?:\s+[A-Z]{2,}){1,3})\s*(?:father|dob|date)/i,
  ],
  // Aadhaar: Name is usually one of the first lines in caps
  AADHAAR: [
    /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*$/m,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*(?:dob|date of birth|\d{2}\/\d{2}\/\d{4})/i,
  ],
  // License: Name after "Name" or "NAME"
  LICENSE: [
    /name[:\s]+([A-Z][A-Za-z\s]+?)(?:\n|s\/o|d\/o|w\/o|father|address)/i,
    /([A-Z][A-Z\s]+)\s*s\/o/i,
  ],
  // RC: Owner name
  RC: [
    /owner['\s]*(?:name)?[:\s]+([A-Z][A-Za-z\s]+?)(?:\n|s\/o|d\/o|w\/o|address)/i,
    /registered\s+owner[:\s]+([A-Z][A-Za-z\s]+)/i,
  ],
  // Insurance: Insured name
  INSURANCE: [
    /insured['\s]*(?:name)?[:\s]+([A-Z][A-Za-z\s]+?)(?:\n|address|policy)/i,
    /name\s+of\s+(?:the\s+)?insured[:\s]+([A-Z][A-Za-z\s]+)/i,
  ],
};

/**
 * Extract name from OCR text based on document type patterns
 */
function extractName(text: string, docType: keyof typeof NAME_PATTERNS): string | null {
  const patterns = NAME_PATTERNS[docType];
  if (!patterns) return null;
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      // Clean up the extracted name
      let name = match[1].trim();
      // Remove extra whitespace
      name = name.replace(/\s+/g, ' ');
      // Remove common suffixes that might be captured
      name = name.replace(/\s*(s\/o|d\/o|w\/o|father|mother|dob|date|address).*$/i, '').trim();
      // Only return if it looks like a valid name (2-50 chars, at least 2 words or single word with 3+ chars)
      if (name.length >= 3 && name.length <= 50) {
        return name;
      }
    }
  }
  return null;
}

/**
 * Normalize name for comparison (lowercase, remove extra spaces, common variations)
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\./g, '')
    .trim();
}

/**
 * Calculate similarity between two names (0-1 score)
 * Handles common variations: order swaps, middle name presence/absence
 */
export function calculateNameSimilarity(name1: string, name2: string): number {
  const n1 = normalizeName(name1);
  const n2 = normalizeName(name2);
  
  // Exact match
  if (n1 === n2) return 1.0;
  
  // Split into parts
  const parts1 = n1.split(' ').filter(p => p.length > 1);
  const parts2 = n2.split(' ').filter(p => p.length > 1);
  
  // Check if all parts of shorter name exist in longer name
  const shorter = parts1.length <= parts2.length ? parts1 : parts2;
  const longer = parts1.length <= parts2.length ? parts2 : parts1;
  
  let matchedParts = 0;
  for (const part of shorter) {
    if (longer.some(p => p === part || levenshteinDistance(p, part) <= 1)) {
      matchedParts++;
    }
  }
  
  // Calculate score based on matched parts
  const score = matchedParts / Math.max(shorter.length, 1);
  
  // Bonus if first name matches exactly
  if (parts1[0] === parts2[0]) {
    return Math.min(score + 0.2, 1.0);
  }
  
  return score;
}

/**
 * Levenshtein distance for fuzzy matching
 */
function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length, n = s2.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

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
 * Validate PAN Card - extract PAN number, name, and cross-validate
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

  // Extract name for cross-verification
  const extractedName = extractName(text, 'PAN');
  if (extractedName) {
    extractedData.extractedName = extractedName;
    logger.info(`[VISION] PAN Card name extracted: ${extractedName}`);
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
 * Validate Aadhaar Card - extract Aadhaar number, name, and cross-validate
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

  // Extract name for cross-verification
  const extractedName = extractName(text, 'AADHAAR');
  if (extractedName) {
    extractedData.extractedName = extractedName;
    logger.info(`[VISION] Aadhaar name extracted: ${extractedName}`);
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
 * Validate Driving License - extract DL number, name, and expiry
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

  // Extract name for cross-verification
  const extractedName = extractName(text, 'LICENSE');
  if (extractedName) {
    extractedData.extractedName = extractedName;
    logger.info(`[VISION] License name extracted: ${extractedName}`);
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
 * Validate Registration Certificate - extract vehicle number, owner name, and cross-validate
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

  // Extract owner name for cross-verification
  const extractedName = extractName(text, 'RC');
  if (extractedName) {
    extractedData.extractedName = extractedName;
    logger.info(`[VISION] RC owner name extracted: ${extractedName}`);
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
 * Validate Insurance document - extract policy number, insured name, and expiry
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

  // Extract insured name for cross-verification
  const extractedName = extractName(text, 'INSURANCE');
  if (extractedName) {
    extractedData.extractedName = extractedName;
    logger.info(`[VISION] Insurance holder name extracted: ${extractedName}`);
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

/**
 * Cross-verify that all documents belong to the same person
 * by comparing extracted names across documents
 */
export interface CrossVerificationResult {
  isConsistent: boolean;
  confidence: number;
  extractedNames: Record<string, string>;
  mismatchDetails: string | null;
  comparisonMatrix: Array<{
    doc1: string;
    doc2: string;
    similarity: number;
  }>;
}

export async function crossVerifyDocuments(
  documents: Array<{ documentType: string; aiExtractedData: any }>
): Promise<CrossVerificationResult> {
  const extractedNames: Record<string, string> = {};
  
  // Collect names from all documents
  for (const doc of documents) {
    if (doc.aiExtractedData?.extractedName) {
      extractedNames[doc.documentType] = doc.aiExtractedData.extractedName;
    }
  }
  
  const docTypes = Object.keys(extractedNames);
  
  // If we have fewer than 2 documents with names, we can't cross-verify
  if (docTypes.length < 2) {
    logger.warn('[VISION] Cross-verification skipped: insufficient names extracted', {
      documentsWithNames: docTypes.length,
      totalDocuments: documents.length,
    });
    return {
      isConsistent: true, // Assume consistent if we can't verify
      confidence: 0.5,
      extractedNames,
      mismatchDetails: docTypes.length === 0 
        ? 'No names could be extracted from documents' 
        : 'Only one document had extractable name',
      comparisonMatrix: [],
    };
  }
  
  // Compare all pairs of documents
  const comparisonMatrix: Array<{ doc1: string; doc2: string; similarity: number }> = [];
  let totalSimilarity = 0;
  let comparisons = 0;
  let minSimilarity = 1.0;
  let mismatchPair: { doc1: string; doc2: string; similarity: number } | null = null;
  
  for (let i = 0; i < docTypes.length; i++) {
    for (let j = i + 1; j < docTypes.length; j++) {
      const doc1 = docTypes[i];
      const doc2 = docTypes[j];
      const name1 = extractedNames[doc1];
      const name2 = extractedNames[doc2];
      
      const similarity = calculateNameSimilarity(name1, name2);
      comparisonMatrix.push({ doc1, doc2, similarity });
      
      totalSimilarity += similarity;
      comparisons++;
      
      if (similarity < minSimilarity) {
        minSimilarity = similarity;
        mismatchPair = { doc1, doc2, similarity };
      }
      
      logger.info(`[VISION] Name comparison: ${doc1}="${name1}" vs ${doc2}="${name2}" => ${(similarity * 100).toFixed(1)}%`);
    }
  }
  
  const avgSimilarity = totalSimilarity / comparisons;
  const NAME_MATCH_THRESHOLD = 0.6; // 60% similarity required
  
  const isConsistent = minSimilarity >= NAME_MATCH_THRESHOLD;
  
  let mismatchDetails: string | null = null;
  if (!isConsistent && mismatchPair) {
    mismatchDetails = `Name mismatch detected: "${extractedNames[mismatchPair.doc1]}" on ${mismatchPair.doc1} ` +
      `vs "${extractedNames[mismatchPair.doc2]}" on ${mismatchPair.doc2} ` +
      `(${(mismatchPair.similarity * 100).toFixed(1)}% similarity, threshold: ${NAME_MATCH_THRESHOLD * 100}%)`;
  }
  
  logger.info('[VISION] Cross-verification complete', {
    isConsistent,
    avgSimilarity: avgSimilarity.toFixed(2),
    minSimilarity: minSimilarity.toFixed(2),
    documentsCompared: docTypes.length,
  });
  
  return {
    isConsistent,
    confidence: avgSimilarity,
    extractedNames,
    mismatchDetails,
    comparisonMatrix,
  };
}
