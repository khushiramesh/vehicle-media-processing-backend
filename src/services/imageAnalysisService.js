const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const ExifParser = require('exif-parser');

const config = require('../config');
const imageModel = require('../models/imageModel');
const processingLogModel = require('../models/processingLogModel');
const { logger } = require('../utils/logger');
const {
  PROCESSING_STEPS,
  ANALYSIS_VERSION,
} = require('../utils/constants');

// =========================================================================
// 1. BLUR DETECTION — Variance of Laplacian
// =========================================================================
// Algorithm:
//   - Read the image as a single-channel (grayscale) raw pixel buffer.
//   - Apply a 3×3 Laplacian kernel via sharp's .convolve().
//     The Laplacian kernel highlights rapid intensity changes (edges).
//   - Compute the variance of the resulting pixel values.
//     A high variance means many strong edges → sharp image.
//     A low variance means few/weak edges → blurry image.
//
// Threshold: blurScore < 100 → blurry
//   This threshold is widely used in computer vision literature
//   (e.g., "Blur Detection with OpenCV" by Adrian Rosebrock).
//   It works well for typical vehicle/outdoor photos.
// =========================================================================
const LAPLACIAN_KERNEL = {
  width: 3,
  height: 3,
  kernel: [
    0,  1, 0,
    1, -4, 1,
    0,  1, 0,
  ],
};

/**
 * Analyze image blur using Variance of Laplacian.
 * @param {string} filePath - Absolute path to the image file.
 * @param {string} imageId - Image UUID (for logging).
 * @returns {{ blur: boolean, blurScore: number }}
 */
async function analyzeBlur(filePath, imageId) {
  try {
    await processingLogModel.logStarted(
      imageId, PROCESSING_STEPS.BLUR_ANALYSIS, 'Starting blur detection (Variance of Laplacian)'
    );

    // Step 1: Read image as grayscale raw pixel data
    const { data, info } = await sharp(filePath)
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Step 2: Apply the Laplacian kernel via convolution
    const laplacianBuffer = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 1 },
    })
      .jpeg()
      .convolve(LAPLACIAN_KERNEL)
      .grayscale()
      .raw()
      .toBuffer();

    // Step 3: Compute the variance of the Laplacian pixel values
    const pixels = new Uint8Array(laplacianBuffer);
    const mean = pixels.reduce((sum, p) => sum + p, 0) / pixels.length;
    const variance = pixels.reduce((sum, p) => sum + (p - mean) ** 2, 0) / pixels.length;

    const blurScore = Math.round(variance * 100) / 100;
    const blur = blurScore < 100;

    await processingLogModel.logSuccess(
      imageId, PROCESSING_STEPS.BLUR_ANALYSIS,
      `score=${blurScore}, blurry=${blur} (threshold=100)`
    );

    return { blur, blurScore };
  } catch (err) {
    await processingLogModel.logFailure(
      imageId, PROCESSING_STEPS.BLUR_ANALYSIS, `Failed: ${err.message}`
    );
    return { blur: false, blurScore: 0 };
  }
}

// =========================================================================
// 2. BRIGHTNESS DETECTION — Average Pixel Brightness
// =========================================================================
// Algorithm:
//   - Use sharp's .stats() to get the mean brightness across all channels.
//   - Average of channel means gives a value in [0, 255].
//
// Classification thresholds:
//   0–25     → Very Dark
//   25–50    → Dark
//   50–150   → Good
//   150–200  → Bright
//   200–255  → Very Bright
// =========================================================================
const BRIGHTNESS_THRESHOLDS = [
  { max: 25, label: 'Very Dark' },
  { max: 50, label: 'Dark' },
  { max: 150, label: 'Good' },
  { max: 200, label: 'Bright' },
  { max: 255, label: 'Very Bright' },
];

/**
 * Analyze average brightness of the image.
 * @param {string} filePath - Absolute path to the image file.
 * @param {string} imageId - Image UUID (for logging).
 * @returns {{ brightness: string, brightnessScore: number }}
 */
async function analyzeBrightness(filePath, imageId) {
  try {
    await processingLogModel.logStarted(
      imageId, PROCESSING_STEPS.BRIGHTNESS_ANALYSIS, 'Starting brightness analysis'
    );

    const stats = await sharp(filePath).stats();
    const channels = stats.channels;

    const totalMean = channels.reduce((sum, ch) => sum + ch.mean, 0);
    const brightnessScore = Math.round((totalMean / channels.length) * 100) / 100;

    let brightness = 'Unknown';
    for (const threshold of BRIGHTNESS_THRESHOLDS) {
      if (brightnessScore <= threshold.max) {
        brightness = threshold.label;
        break;
      }
    }

    await processingLogModel.logSuccess(
      imageId, PROCESSING_STEPS.BRIGHTNESS_ANALYSIS,
      `score=${brightnessScore}, classification="${brightness}"`
    );

    return { brightness, brightnessScore };
  } catch (err) {
    await processingLogModel.logFailure(
      imageId, PROCESSING_STEPS.BRIGHTNESS_ANALYSIS, `Failed: ${err.message}`
    );
    return { brightness: 'Good', brightnessScore: 128 };
  }
}

// =========================================================================
// 3. OCR DETECTION — Tesseract.js Text Extraction
// =========================================================================
// Uses Tesseract.js with the English language pack.
// Extracts all visible text from the image.
// =========================================================================

/**
 * Extract visible text from the image using Tesseract.js OCR.
 * @param {string} filePath - Absolute path to the image file.
 * @param {string} imageId - Image UUID (for logging).
 * @returns {{ ocrText: string }}
 */
async function extractOCR(filePath, imageId) {
  try {
    await processingLogModel.logStarted(
      imageId, PROCESSING_STEPS.OCR_ANALYSIS, 'Starting OCR (Tesseract.js)'
    );

    const { data } = await Tesseract.recognize(filePath, 'eng', {
      logger: (info) => {
        if (info.status === 'recognizing text') {
          logger.debug(`[OCR] Progress: ${Math.round(info.progress * 100)}%`, imageId, PROCESSING_STEPS.OCR_ANALYSIS);
        }
      },
    });

    const ocrText = (data.text || '').trim();

    await processingLogModel.logSuccess(
      imageId, PROCESSING_STEPS.OCR_ANALYSIS,
      `Extracted ${ocrText.length} chars: "${ocrText.substring(0, 50)}..."`
    );

    return { ocrText };
  } catch (err) {
    await processingLogModel.logFailure(
      imageId, PROCESSING_STEPS.OCR_ANALYSIS, `Failed: ${err.message}`
    );
    return { ocrText: '' };
  }
}

// =========================================================================
// 4. VEHICLE NUMBER PLATE EXTRACTION
// =========================================================================
// Regex: /[A-Z]{2}[0-9]{1,2}[A-Z]{1,2}[0-9]{4}/
// Supports: AA00AA0000 (KA19AB1234) and AA00A0000 (DL01C5678)
// =========================================================================
const VEHICLE_NUMBER_REGEX = /[A-Z]{2}[0-9]{1,2}[A-Z]{1,2}[0-9]{4}/;

/**
 * Extract vehicle number from OCR text using Indian plate regex.
 * @param {string} ocrText - The text extracted via OCR.
 * @param {string} imageId - Image UUID (for logging).
 * @returns {{ vehicleNumber: string }}
 */
function extractVehicleNumber(ocrText, imageId) {
  try {
    const normalized = (ocrText || '').toUpperCase().replace(/[^A-Z0-9]/g, ' ');
    const match = normalized.match(VEHICLE_NUMBER_REGEX);
    const vehicleNumber = match ? match[0] : '';

    logger.info(
      `Extracted vehicle number: "${vehicleNumber}"`,
      imageId,
      PROCESSING_STEPS.PLATE_EXTRACTION
    );

    return { vehicleNumber };
  } catch (err) {
    logger.error(
      `Plate extraction failed: ${err.message}`,
      imageId,
      PROCESSING_STEPS.PLATE_EXTRACTION
    );
    return { vehicleNumber: '' };
  }
}

// =========================================================================
// 5. NUMBER PLATE VALIDATION
// =========================================================================

/**
 * Validate an extracted vehicle number against the Indian plate format.
 * @param {string} vehicleNumber - The extracted vehicle number.
 * @param {string} imageId - Image UUID (for logging).
 * @returns {{ validNumberPlate: boolean }}
 */
function validateVehicleNumber(vehicleNumber, imageId) {
  try {
    const valid = VEHICLE_NUMBER_REGEX.test((vehicleNumber || '').toUpperCase());

    logger.info(
      `Plate validation: number="${vehicleNumber}", valid=${valid}`,
      imageId,
      PROCESSING_STEPS.PLATE_VALIDATION
    );

    return { validNumberPlate: valid };
  } catch (err) {
    logger.error(
      `Plate validation failed: ${err.message}`,
      imageId,
      PROCESSING_STEPS.PLATE_VALIDATION
    );
    return { validNumberPlate: false };
  }
}

// =========================================================================
// 6. DUPLICATE DETECTION — SHA256 Hash Comparison
// =========================================================================

/**
 * Check if an image is a duplicate by comparing SHA256 hash.
 * @param {string} filePath - Absolute path to the image file.
 * @param {string} imageId - Image UUID (for logging).
 * @returns {{ duplicate: boolean, imageHash: string }}
 */
async function checkDuplicate(filePath, imageId) {
  try {
    await processingLogModel.logStarted(
      imageId, PROCESSING_STEPS.DUPLICATE_CHECK, 'Starting duplicate check (SHA256)'
    );

    const fileBuffer = fs.readFileSync(filePath);
    const imageHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    const existing = await imageModel.findByHash(imageHash);
    const duplicate = existing !== null;

    await processingLogModel.logSuccess(
      imageId, PROCESSING_STEPS.DUPLICATE_CHECK,
      `hash=${imageHash.substring(0, 16)}..., duplicate=${duplicate}`
    );

    return { duplicate, imageHash };
  } catch (err) {
    await processingLogModel.logFailure(
      imageId, PROCESSING_STEPS.DUPLICATE_CHECK, `Failed: ${err.message}`
    );
    return { duplicate: false, imageHash: '' };
  }
}

// =========================================================================
// 7. SCREENSHOT DETECTION — Heuristic Analysis
// =========================================================================
// Heuristics:
//   1. No EXIF data
//   2. High resolution (both dimensions ≥ 1080px)
//   3. Perfect aspect ratio (16:9 or 16:10)
//   4. Low color variance (avg std dev < 40)
// Threshold: 3+ positive heuristics → screenshot
// =========================================================================

/**
 * Detect if the image is a screenshot using heuristic analysis.
 * @param {string} filePath - Absolute path to the image file.
 * @param {string} imageId - Image UUID (for logging).
 * @returns {{ screenshot: boolean }}
 */
async function detectScreenshot(filePath, imageId) {
  try {
    await processingLogModel.logStarted(
      imageId, PROCESSING_STEPS.SCREENSHOT_CHECK, 'Starting screenshot detection'
    );

    let positiveHeuristics = 0;
    const reasons = [];

    // Heuristic 1: No EXIF data
    try {
      const exifBuf = await sharp(filePath).metadata().then((m) => m.exif || null);
      if (!exifBuf) {
        positiveHeuristics++;
        reasons.push('no_exif');
      } else {
        const parsed = ExifParser.create(exifBuf).parse();
        if (!parsed || Object.keys(parsed.tags).length < 3) {
          positiveHeuristics++;
          reasons.push('minimal_exif');
        }
      }
    } catch {
      positiveHeuristics++;
      reasons.push('exif_read_error');
    }

    // Heuristic 2: High resolution
    const metadata = await sharp(filePath).metadata();
    const { width, height } = metadata;

    if (width >= 1080 && height >= 1080) {
      positiveHeuristics++;
      reasons.push(`high_res_${width}x${height}`);
    }

    // Heuristic 3: Perfect aspect ratio
    const aspectRatio = width / height;
    const ratio16x9 = 16 / 9;
    const ratio16x10 = 16 / 10;

    const is16x9 = Math.abs(aspectRatio - ratio16x9) < 0.02;
    const is16x10 = Math.abs(aspectRatio - ratio16x10) < 0.02;

    if (is16x9 || is16x10) {
      positiveHeuristics++;
      reasons.push(`perfect_aspect_${is16x9 ? '16:9' : '16:10'}`);
    }

    // Heuristic 4: Low image complexity
    try {
      const stats = await sharp(filePath).stats();
      const avgStdDev = stats.channels.reduce((sum, ch) => sum + ch.stdev, 0) / stats.channels.length;
      if (avgStdDev < 40) {
        positiveHeuristics++;
        reasons.push(`low_complexity_stddev_${Math.round(avgStdDev)}`);
      }
    } catch {
      // Optional heuristic — ignore on failure
    }

    const screenshot = positiveHeuristics >= 3;

    await processingLogModel.logSuccess(
      imageId, PROCESSING_STEPS.SCREENSHOT_CHECK,
      `heuristics=${positiveHeuristics}/4, screenshot=${screenshot}, reasons=[${reasons.join(', ')}]`
    );

    return { screenshot };
  } catch (err) {
    await processingLogModel.logFailure(
      imageId, PROCESSING_STEPS.SCREENSHOT_CHECK, `Failed: ${err.message}`
    );
    return { screenshot: false };
  }
}

// =========================================================================
// 8. CONFIDENCE SCORE — Composite Quality Metric
// =========================================================================
// Formula:
//   Base:        50
//   Blur:        −20 (if blurry)
//   Brightness:  +0 to +10 (Good=+10, Dark/Bright=+5, Very*=+0)
//   OCR success: +15 (if non-empty)
//   Plate valid: +25
// =========================================================================

/**
 * Calculate overall confidence score (0–100) based on analysis results.
 * @param {Object} analysis - { blur, brightness, ocrText, validNumberPlate }.
 * @param {string} imageId - Image UUID (for logging).
 * @returns {{ overallConfidence: number }}
 */
function calculateConfidence(analysis, imageId) {
  try {
    let score = 50;

    if (analysis.blur) score -= 20;

    const brightnessMap = {
      'Very Dark': 0, 'Dark': 3, 'Good': 10, 'Bright': 5, 'Very Bright': 0,
    };
    score += brightnessMap[analysis.brightness] || 5;

    if (analysis.ocrText && analysis.ocrText.trim().length > 0) score += 15;
    if (analysis.validNumberPlate) score += 25;

    const overallConfidence = Math.max(0, Math.min(100, score));

    logger.info(
      `Confidence score: raw=${score}, clamped=${overallConfidence}`,
      imageId,
      PROCESSING_STEPS.CONFIDENCE_CALCULATION
    );

    return { overallConfidence };
  } catch (err) {
    logger.error(
      `Confidence calculation failed: ${err.message}`,
      imageId,
      PROCESSING_STEPS.CONFIDENCE_CALCULATION
    );
    return { overallConfidence: 0 };
  }
}

// =========================================================================
// ORCHESTRATOR — processImage()
// =========================================================================

/**
 * Process an image analysis job.
 * Runs all 8 analysis algorithms, logs every step, records timing.
 *
 * @param {string} imageId - The UUID of the image to process.
 * @param {number} attemptNumber - The current retry attempt (0-based).
 */
async function processImage(imageId, attemptNumber = 0) {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  try {
    // 1. Set status to 'processing'
    await imageModel.updateStatus(imageId, 'processing');
    await processingLogModel.logSuccess(
      imageId, PROCESSING_STEPS.PROCESSING_STARTED,
      `Processing started (attempt ${attemptNumber + 1})`
    );

    // 2. Resolve file path
    const imageRecord = await imageModel.findById(imageId);
    if (!imageRecord) {
      throw new Error(`Image record not found for id=${imageId}`);
    }
    const filePath = path.join(config.uploadDir, imageRecord.filename);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found on disk: ${filePath}`);
    }

    // Record processing start time
    await imageModel.updateProcessingTiming(imageId, {
      processingStartedAt: startedAt,
      processingCompletedAt: null,
      processingTimeMs: null,
    });

    // 3. Run analyses concurrently (blur, brightness, duplicate, screenshot, OCR)
    const [blurResult, brightnessResult, duplicateResult, screenshotResult, ocrResult] = await Promise.all([
      analyzeBlur(filePath, imageId),
      analyzeBrightness(filePath, imageId),
      checkDuplicate(filePath, imageId),
      detectScreenshot(filePath, imageId),
      extractOCR(filePath, imageId),
    ]);

    // 4. Extract vehicle number from OCR text (sequential dependency)
    await processingLogModel.logStarted(
      imageId, PROCESSING_STEPS.PLATE_EXTRACTION, 'Extracting vehicle number from OCR text'
    );
    const { vehicleNumber } = extractVehicleNumber(ocrResult.ocrText, imageId);
    await processingLogModel.logSuccess(
      imageId, PROCESSING_STEPS.PLATE_EXTRACTION,
      vehicleNumber ? `Extracted: ${vehicleNumber}` : 'No plate pattern found'
    );

    // 5. Validate the extracted number
    const { validNumberPlate } = validateVehicleNumber(vehicleNumber, imageId);

    // 6. Calculate confidence
    const { overallConfidence } = calculateConfidence({
      blur: blurResult.blur,
      brightness: brightnessResult.brightness,
      ocrText: ocrResult.ocrText,
      validNumberPlate,
    }, imageId);

    // 7. Compute processing time
    const completedAt = new Date().toISOString();
    const processingTimeMs = Date.now() - startTime;

    // 8. Save all results to the database
    await imageModel.updateAnalysis(imageId, {
      status: 'completed',
      blurScore: blurResult.blurScore,
      blur: blurResult.blur ? 1 : 0,
      brightness: brightnessResult.brightness,
      brightnessScore: brightnessResult.brightnessScore,
      ocrText: ocrResult.ocrText,
      vehicleNumber,
      validNumberPlate: validNumberPlate ? 1 : 0,
      duplicate: duplicateResult.duplicate ? 1 : 0,
      screenshot: screenshotResult.screenshot ? 1 : 0,
      imageHash: duplicateResult.imageHash,
      overallConfidence,
      analysisVersion: ANALYSIS_VERSION,
      error: null,
    });

    // Record processing timing
    await imageModel.updateProcessingTiming(imageId, {
      processingStartedAt: startedAt,
      processingCompletedAt: completedAt,
      processingTimeMs,
    });

    // 9. Log completion
    await processingLogModel.logSuccess(
      imageId, PROCESSING_STEPS.RESULT_SAVED,
      `Analysis results saved to database`
    );
    await processingLogModel.logSuccess(
      imageId, PROCESSING_STEPS.PROCESSING_COMPLETED,
      `Completed in ${processingTimeMs}ms (attempt ${attemptNumber + 1})`
    );

    // Console summary
    logger.info(
      `Summary: blur=${blurResult.blur}(${blurResult.blurScore}), ` +
      `brightness=${brightnessResult.brightness}(${brightnessResult.brightnessScore}), ` +
      `ocr=${ocrResult.ocrText.length}chars, ` +
      `plate=${vehicleNumber || 'none'}, valid=${validNumberPlate}, ` +
      `dup=${duplicateResult.duplicate}, ss=${screenshotResult.screenshot}, ` +
      `confidence=${overallConfidence}, time=${processingTimeMs}ms`,
      imageId,
      'SUMMARY'
    );
  } catch (err) {
    const completedAt = new Date().toISOString();
    const processingTimeMs = Date.now() - startTime;

    // Record timing even on failure
    try {
      await imageModel.updateProcessingTiming(imageId, {
        processingStartedAt: startedAt,
        processingCompletedAt: completedAt,
        processingTimeMs,
      });
    } catch (timingErr) {
      // Non-critical
    }

    // Log failure
    await processingLogModel.logFailure(
      imageId, PROCESSING_STEPS.FAILURE,
      `Processing failed after ${processingTimeMs}ms: ${err.message}`
    );

    logger.error(
      `Processing failed after ${processingTimeMs}ms: ${err.message}`,
      imageId,
      'FAILURE'
    );

    // Re-throw so the retry service can catch it
    throw err;
  }
}

module.exports = {
  processImage,
  analyzeBlur,
  analyzeBrightness,
  extractOCR,
  extractVehicleNumber,
  validateVehicleNumber,
  checkDuplicate,
  detectScreenshot,
  calculateConfidence,
};

