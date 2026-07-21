/**
 * Application-wide constants and enums.
 * Centralizes string literals to avoid duplication and typos.
 */

/** Image processing statuses */
const IMAGE_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

/** Processing log step names */
const PROCESSING_STEPS = Object.freeze({
  UPLOAD_RECEIVED: 'UPLOAD_RECEIVED',
  IMAGE_SAVED: 'IMAGE_SAVED',
  QUEUE_STARTED: 'QUEUE_STARTED',
  PROCESSING_STARTED: 'PROCESSING_STARTED',
  BLUR_ANALYSIS: 'BLUR_ANALYSIS',
  BRIGHTNESS_ANALYSIS: 'BRIGHTNESS_ANALYSIS',
  OCR_ANALYSIS: 'OCR_ANALYSIS',
  PLATE_EXTRACTION: 'PLATE_EXTRACTION',
  PLATE_VALIDATION: 'PLATE_VALIDATION',
  DUPLICATE_CHECK: 'DUPLICATE_CHECK',
  SCREENSHOT_CHECK: 'SCREENSHOT_CHECK',
  CONFIDENCE_CALCULATION: 'CONFIDENCE_CALCULATION',
  RESULT_SAVED: 'RESULT_SAVED',
  PROCESSING_COMPLETED: 'PROCESSING_COMPLETED',
  FAILURE: 'FAILURE',
});

/** Log status values */
const LOG_STATUS = Object.freeze({
  STARTED: 'STARTED',
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
});

/** Analysis version */
const ANALYSIS_VERSION = 'v1.0.0';

/** Application version */
const APP_VERSION = '1.0.0';

/** Max retry attempts for processing failures */
const MAX_RETRY_COUNT = 3;

module.exports = {
  IMAGE_STATUS,
  PROCESSING_STEPS,
  LOG_STATUS,
  ANALYSIS_VERSION,
  APP_VERSION,
  MAX_RETRY_COUNT,
};

