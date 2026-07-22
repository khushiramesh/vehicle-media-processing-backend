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
// 3. OCR DETECTION — Tesseract.js Text Extraction (Improved)
// =========================================================================
// Algorithm:
//   - Before OCR, preprocess the image using Sharp to significantly
//     improve Tesseract's accuracy on vehicle number plates.
//   - Preprocessing steps:
//     1. Convert to grayscale (removes color noise)
//     2. Normalize (spreads pixel values across full 0–255 range)
//     3. Increase contrast (gamma correction)
//     4. Sharpen (unsharp mask via convolution kernel)
//     5. Resize 2× if image is too small for OCR (< 800px on shortest side)
//   - Use Tesseract.js with optimised PSM (Page Segmentation Mode) that
//     favours reading blocks of text common on number plates.
//   - Post-process: uppercase, strip whitespace, normalize OCR errors.
// =========================================================================

// =========================================================================
// PLATE LOCALIZATION — Automatic License Plate Region Detection
// =========================================================================
// Algorithm — "Edge Density Projection" (Sharp-only, no OpenCV required):
//
// Step 1: Grayscale conversion — reduces colour noise
// Step 2: Gaussian blur (σ=1.5) — suppresses noise while preserving edges
// Step 3: Sobel X kernel convolution — detects VERTICAL edges
//         (character strokes create strong vertical edges on plates)
// Step 4: Edge magnitude thresholding — binarize edge pixels (> intensity 30)
// Step 5: Horizontal projection — sum edge pixels per row
// Step 6: Sliding window scan — find the row band with:
//   a) Highest edge density (text = dense vertical edges)
//   b) Aspect ratio 2–6 (standard license plate width/height ratio)
//   c) Sufficient area (min 3% of image height, max 25%)
// Step 7: Vertical refinement within the band — find left/right text bounds
// Step 8: Return the crop region with generous 10% margin
//
// If no plate region is found, returns null → caller falls back to full image.
//
// This technique is widely used in embedded/license plate recognition systems
// as a lightweight alternative to full contour-based detection.
// =========================================================================

// Sobel X kernel — detects vertical edges (character sides)
const SOBEL_X_KERNEL = {
  width: 3,
  height: 3,
  kernel: [
    -1, 0, 1,
    -2, 0, 2,
    -1, 0, 1,
  ],
};

// Edge threshold — minimum pixel intensity to count as edge
// Higher values = fewer noise edges; lower = more sensitivity
const EDGE_THRESHOLD = 30;

// Minimum edge density score to accept as a plate region
const MIN_PLATE_DENSITY = 0.04;

// Plate aspect ratio range (width/height)
const PLATE_ASPECT_MIN = 1.8;
const PLATE_ASPECT_MAX = 6.5;

/**
 * Detect the license plate region in an image automatically.
 * Uses edge detection + horizontal projection analysis.
 *
 * @param {string} filePath - Absolute path to the image file.
 * @returns {Promise<{left: number, top: number, width: number, height: number}|null>}
 *          Crop region, or null if no plate detected.
 */
async function _detectPlateRegion(filePath) {
  const metadata = await sharp(filePath).metadata();
  const { width, height } = metadata;

  // Skip tiny images — plates would be unrecognisable
  if (width < 200 || height < 200) {
    return null;
  }

  // ---- Step A: Edge detection pipeline via Sharp ----
  // Grayscale → Gaussian blur (σ=1.5) → Sobel X → raw pixel buffer
  const edgeBuffer = await sharp(filePath)
    .grayscale()                          // Step 1: Remove colour noise
    .blur(1.5)                            // Step 2: Gaussian blur (reduce noise)
    .convolve(SOBEL_X_KERNEL)             // Step 3: Sobel X (vertical edges)
    .raw()
    .toBuffer();

  const edgePixels = new Uint8Array(edgeBuffer);

  // ---- Step B: Horizontal projection — edge density per row ----
  const rowEdgeDensity = new Float64Array(height);

  for (let y = 0; y < height; y++) {
    let edgeCount = 0;
    const rowStart = y * width;

    for (let x = 0; x < width; x++) {
      if (edgePixels[rowStart + x] > EDGE_THRESHOLD) {
        edgeCount++;
      }
    }

    rowEdgeDensity[y] = edgeCount / width; // Normalize 0–1
  }

  // ---- Step C: Smooth projection with running average (window = 5 rows) ----
  const smoothed = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let count = 0;
    for (let dy = -2; dy <= 2; dy++) {
      const ny = y + dy;
      if (ny >= 0 && ny < height) {
        sum += rowEdgeDensity[ny];
        count++;
      }
    }
    smoothed[y] = sum / count;
  }

  // ---- Step D: Sliding window scan for best plate band ----
  const minBandH = Math.max(15, Math.floor(height * 0.03));    // Min 3% of height
  const maxBandH = Math.min(height, Math.floor(height * 0.25)); // Max 25% of height

  let bestScore = 0;
  let bestY = 0;
  let bestH = minBandH;

  for (let bandH = minBandH; bandH <= maxBandH; bandH++) {
    // Precompute running sum over smoothing array for O(n) sliding window
    let windowSum = 0;
    for (let y = 0; y < bandH; y++) {
      windowSum += smoothed[y];
    }

    for (let y = 0; y <= height - bandH; y++) {
      if (y > 0) {
        windowSum -= smoothed[y - 1];
        windowSum += smoothed[y + bandH - 1];
      }

      const avgDensity = windowSum / bandH;

      // Only consider if density is meaningful
      if (avgDensity < MIN_PLATE_DENSITY) continue;

      // Aspect ratio bonus: plates are wide rectangles
      const aspectRatio = width / bandH;
      let aspectBonus = 1.0;
      if (aspectRatio >= PLATE_ASPECT_MIN && aspectRatio <= PLATE_ASPECT_MAX) {
        // Peak bonus at ratio ~4 (typical license plate)
        const idealRatio = 4.0;
        const ratioScore = 1.0 - Math.abs(aspectRatio - idealRatio) / idealRatio;
        aspectBonus = 1.0 + Math.max(0, ratioScore) * 2.0; // 1.0x to 3.0x
      } else {
        // Penalty for non-plate aspect ratios
        aspectBonus = 0.3;
      }

      const score = avgDensity * aspectBonus;

      if (score > bestScore) {
        bestScore = score;
        bestY = y;
        bestH = bandH;
      }
    }
  }

  // ---- Step E: If no good region found, return null ----
  if (bestScore < MIN_PLATE_DENSITY * 1.0) {
    return null;
  }

  // ---- Step F: Vertical refinement — find text extent within the band ----
  // Compute vertical projection within the detected band
  const bandStart = bestY;
  const bandEnd = bestY + bestH;

  // Find leftmost and rightmost edge columns in the band
  let leftEdge = width;
  let rightEdge = 0;

  for (let y = bandStart; y < bandEnd; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      if (edgePixels[rowStart + x] > EDGE_THRESHOLD) {
        if (x < leftEdge) leftEdge = x;
        if (x > rightEdge) rightEdge = x;
      }
    }
  }

  // Add 15% margin on each side (or use full width if no edges found)
  const margin = Math.round(width * 0.10);
  const cropLeft = Math.max(0, leftEdge - margin);
  const cropRight = Math.min(width, (rightEdge > 0 ? rightEdge + margin : width));
  const cropWidth = cropRight - cropLeft;
  const cropTop = Math.max(0, bestY - Math.round(margin * 0.5));
  const cropHeight = Math.min(height - cropTop, bestH + margin);

  logger.debug(
    `Plate region detected: y=${bestY}, h=${bestH}, ` +
    `density=${bestScore.toFixed(4)}, ` +
    `crop=${cropLeft},${cropTop},${cropWidth}x${cropHeight}`
  );

  return {
    left: cropLeft,
    top: cropTop,
    width: cropWidth,
    height: cropHeight,
  };
}

// =========================================================================
// OCR PREPROCESSING — Sharp-based image enhancement for Tesseract
// =========================================================================

// Sharpen kernel — unsharp mask for crisper text edges
const SHARPEN_KERNEL = {
  width: 3,
  height: 3,
  kernel: [
    0, -1,  0,
   -1,  5, -1,
    0, -1,  0,
  ],
};

/**
 * Preprocess an image region for optimal OCR accuracy.
 * Applied to the cropped plate region (or full image as fallback).
 *
 * Pipeline:
 *   1. Convert to grayscale — removes colour noise
 *   2. Normalise — spreads histogram across full 0–255 range
 *   3. Increase contrast (gamma correction 1.5)
 *   4. Sharpen (unsharp mask via convolution)
 *   5. Resize 2× if too small (Tesseract needs ~300 DPI)
 *
 * @param {string} sourcePath - Original image path.
 * @param {Object|null} cropRegion - { left, top, width, height } or null for full image.
 * @returns {Promise<string>} Path to the preprocessed temp image.
 */
async function _preprocessForOCR(sourcePath, cropRegion) {
  let pipeline = sharp(sourcePath);

  // Step 0: Crop to detected plate region if available
  if (cropRegion) {
    pipeline = pipeline.extract(cropRegion);
  }

  const metadata = await pipeline.clone().metadata();

  // Step 1: Convert to grayscale — removes colour noise
  pipeline = pipeline.grayscale();

  // Step 2: Normalise — spreads histogram across full range
  pipeline = pipeline.normalise();

  // Step 3: Gamma correction (≈ 1.5 adjusts mid-tones for better contrast)
  pipeline = pipeline.gamma(1.5);

  // Step 4: Sharpen using custom kernel — creates crisper edges for OCR
  pipeline = pipeline.convolve(SHARPEN_KERNEL);

  // Step 5: Resize if too small — Tesseract works best on 300+ DPI
  const minDim = Math.min(metadata.width || 0, metadata.height || 0);
  const shouldResize = minDim > 0 && minDim < 600;

  if (shouldResize) {
    const scaleFactor = Math.min(4, Math.ceil(600 / minDim)); // Cap at 4×
    const newWidth = Math.round((metadata.width || 0) * scaleFactor);
    const newHeight = Math.round((metadata.height || 0) * scaleFactor);
    pipeline = pipeline.resize(newWidth, newHeight, {
      fit: 'fill',
      kernel: 'lanczos3', // high-quality upscaling
    });
  }

  // Write to a temp file alongside the original
  const parsed = path.parse(sourcePath);
  const tempPath = path.join(parsed.dir, `${parsed.name}_ocr_preprocessed.png`);

  await pipeline.png().toFile(tempPath);

  return tempPath;
}

/**
 * Normalise OCR text by cleaning common Tesseract errors on vehicle plates.
 * - Removes extra whitespace and newlines
 * - Converts to uppercase
 * - Normalises common character confusions where appropriate
 * @param {string} raw - Raw OCR output.
 * @returns {string} Cleaned text.
 */
function _normalizeOCRText(raw) {
  if (!raw) return '';

  let text = raw
    .toUpperCase()
    .replace(/[^\w\s]/g, ' ')   // Replace punctuation with space
    .replace(/\s+/g, ' ')        // Collapse multiple whitespace
    .trim();

  return text;
}

/**
 * Run Tesseract OCR on a preprocessed image.
 * Tries PSM 7 (single line) first, falls back to PSM 3 (auto).
 *
 * @param {string} tempPath - Path to the preprocessed temp image.
 * @param {string} imageId - Image UUID (for logging).
 * @returns {Promise<string>} The raw OCR text.
 */
async function _runTesseract(tempPath, imageId) {
  const { data } = await Tesseract.recognize(tempPath, 'eng', {
    // PSM 7 = Treat image as single text line (best for number plates)
    tessedit_pageseg_mode: '7',
    // OEM 1 = LSTM neural network only (most accurate for print text)
    tessedit_ocr_engine_mode: '1',
    preserve_interword_spaces: '1',
    logger: (info) => {
      if (info.status === 'recognizing text' && info.progress) {
        logger.debug(
          `[OCR] Progress: ${Math.round(info.progress * 100)}%`,
          imageId,
          PROCESSING_STEPS.OCR_ANALYSIS
        );
      }
    },
  });

  let rawText = data.text || '';

  // Fallback: if PSM 7 gave empty or low-confidence text, retry with PSM 3
  if (!rawText.trim() || (data.confidence !== undefined && data.confidence < 30)) {
    logger.debug(
      `PSM 7 gave low quality (conf=${data.confidence}), retrying with PSM 3`,
      imageId,
      PROCESSING_STEPS.OCR_ANALYSIS
    );
    const fallbackResult = await Tesseract.recognize(tempPath, 'eng', {
      tessedit_pageseg_mode: '3',
      tessedit_ocr_engine_mode: '1',
      preserve_interword_spaces: '1',
    });
    rawText = fallbackResult.data.text || rawText;
  }

  return rawText;
}

/**
 * Extract visible text from the image using automatic plate detection + OCR.
 *
 * Pipeline:
 *   1. Auto-detect the license plate region (edge density projection)
 *   2. If plate found → crop + enhance preprocessing → Tesseract on cropped region
 *   3. If no plate → fallback to full-image OCR
 *   4. Post-process text (uppercase, clean whitespace)
 *
 * @param {string} filePath - Absolute path to the image file.
 * @param {string} imageId - Image UUID (for logging).
 * @returns {{ ocrText: string }}
 */
async function extractOCR(filePath, imageId) {
  let tempPath = null;
  try {
    await processingLogModel.logStarted(
      imageId, PROCESSING_STEPS.OCR_ANALYSIS, 'Starting OCR (Tesseract.js)'
    );

    // ---- Step A: Auto-detect license plate region ----
    await processingLogModel.logSuccess(
      imageId, PROCESSING_STEPS.OCR_ANALYSIS,
      'Attempting automatic plate region detection'
    );

    const plateRegion = await _detectPlateRegion(filePath);

    if (plateRegion) {
      logger.info(
        `Plate region detected: ${plateRegion.width}x${plateRegion.height} at ` +
        `(${plateRegion.left},${plateRegion.top})`,
        imageId,
        PROCESSING_STEPS.OCR_ANALYSIS
      );
      await processingLogModel.logSuccess(
        imageId, PROCESSING_STEPS.OCR_ANALYSIS,
        `Plate region detected: ${plateRegion.width}x${plateRegion.height}`
      );
    } else {
      logger.info(
        'No plate region detected — falling back to full-image OCR',
        imageId,
        PROCESSING_STEPS.OCR_ANALYSIS
      );
      await processingLogModel.logSuccess(
        imageId, PROCESSING_STEPS.OCR_ANALYSIS,
        'No plate region found, using full image'
      );
    }

    // ---- Step B: Preprocess the image/cropped region for OCR ----
    await processingLogModel.logSuccess(
      imageId, PROCESSING_STEPS.OCR_ANALYSIS,
      'Preprocessing image (grayscale + normalise + gamma + sharpen + resize)'
    );

    tempPath = await _preprocessForOCR(filePath, plateRegion);
    logger.debug(
      `OCR preprocessed temp file: ${tempPath}`,
      imageId,
      PROCESSING_STEPS.OCR_ANALYSIS
    );

    // ---- Step C: Run Tesseract ----
    await processingLogModel.logSuccess(
      imageId, PROCESSING_STEPS.OCR_ANALYSIS,
      'Running Tesseract.js recognition engine'
    );

    const rawText = await _runTesseract(tempPath, imageId);

    // ---- Step D: Post-process — normalise and clean ----
    const ocrText = _normalizeOCRText(rawText);

    await processingLogModel.logSuccess(
      imageId, PROCESSING_STEPS.OCR_ANALYSIS,
      `Extracted ${ocrText.length} chars: "${ocrText.substring(0, 80)}..."`
    );

    return { ocrText };
  } catch (err) {
    await processingLogModel.logFailure(
      imageId, PROCESSING_STEPS.OCR_ANALYSIS, `Failed: ${err.message}`
    );
    return { ocrText: '' };
  } finally {
    // Clean up temp file
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
  }
}

// =========================================================================
// 4. VEHICLE NUMBER PLATE EXTRACTION (Improved)
// =========================================================================
// Algorithm:
//   - Normalize OCR text to uppercase and strip noise.
//   - Generate ALL candidate plate patterns by:
//     1. Searching each OCR line individually (line-by-line).
//     2. Searching the entire OCR text.
//     3. Searching the text with common OCR character substitutions
//        (O↔0, I↔1, S↔5, B↔8, G↔6) to handle recognition errors.
//   - Rank candidates by:
//     a) Length (longer = more complete plate)
//     b) Character pattern match quality
//     c) Position in text (earlier occurrences preferred)
//   - Return the best valid candidate.
//
// Indian Vehicle Number Plate Formats supported:
//   AA00AA0000  (e.g., KA19AB1234) — Standard 10-char format
//   AA00A0000   (e.g., DL01C5678)  — 9-char format (single middle letter)
// =========================================================================

// Primary regex — strict Indian plate pattern
// Explanation:
//   [A-Z]{2}    — 2 state letters (e.g., KA, MH, DL, TN)
//   [0-9]{1,2}  — 1 or 2 district digits (e.g., 19, 01, 05)
//   [A-Z]{1,2}  — 1 or 2 series letters (e.g., AB, N, C)
//   [0-9]{4}    — 4-digit sequential number
// Strict regex (global) — for iterating all matches via matchAll()
const VEHICLE_NUMBER_REGEX_STRICT = /[A-Z]{2}[0-9]{1,2}[A-Z]{1,2}[0-9]{4}/g;
// Strict regex (non-global) — for single-match validation (avoid .test() statefulness)
const VEHICLE_NUMBER_REGEX_STRICT_SINGLE = /[A-Z]{2}[0-9]{1,2}[A-Z]{1,2}[0-9]{4}/;

// Relaxed regex (global) — handles OCR character substitution errors
const VEHICLE_NUMBER_REGEX_RELAXED = /[A-Z0-9]{2}[A-Z0-9]{1,2}[A-Z0-9]{1,2}[A-Z0-9]{4}/g;

// Common OCR character confusion map for vehicle plates
// Tesseract frequently misreads these pairs:
//   O (letter) ↔ 0 (digit)
//   I (letter) ↔ 1 (digit)
//   S (letter) ↔ 5 (digit)
//   B (letter) ↔ 8 (digit)
//   G (letter) ↔ 6 (digit)
const OCR_SUBSTITUTIONS = [
  (s) => s,                                                                           // Original
  (s) => s.replace(/O/g, '0').replace(/I/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/G/g, '6'), // Letters → Digits
  (s) => s.replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B').replace(/6/g, 'G'), // Digits → Letters
];

/**
 * Score a candidate vehicle number for quality ranking.
 * Higher score = more likely to be correct.
 * @param {string} candidate - The matched candidate string.
 * @param {number} position - Index in the original text (earlier = better).
 * @returns {number} Quality score.
 */
function _scoreCandidate(candidate, position) {
  let score = 0;

  // Prefer longer candidates (10-char plates over 9-char)
  score += candidate.length * 10;

  // Prefer candidates that match the strict pattern exactly
  if (VEHICLE_NUMBER_REGEX_STRICT_SINGLE.test(candidate)) {
    score += 50;
  }

  // Penalize if the relaxed pattern needed substitutions (i.e. non-strict)
  // Lower score for candidates with digits in letter positions or vice versa
  const letters = (candidate.match(/[A-Z]/g) || []).length;
  const digits = (candidate.match(/[0-9]/g) || []).length;
  // A valid Indian plate should have 4-5 letters and 5-6 digits
  if (letters >= 4 && letters <= 5 && digits >= 5 && digits <= 6) {
    score += 30;
  }

  // Position bonus: earlier in text is slightly better
  score += Math.max(0, 100 - position);

  return score;
}

/**
 * Normalize a candidate vehicle number string.
 * Removes whitespace, converts to uppercase.
 * @param {string} raw - Raw match string.
 * @returns {string} Cleaned candidate.
 */
function _cleanCandidate(raw) {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Extract the best vehicle number from OCR text using Indian plate regex.
 *
 * Strategy:
 *   1. Split OCR text into individual lines and search each.
 *   2. Search the entire concatenated OCR text.
 *   3. Apply OCR character substitutions and re-search.
 *   4. Collect all unique candidates, rank by quality, return the best.
 *
 * @param {string} ocrText - The text extracted via OCR.
 * @param {string} imageId - Image UUID (for logging).
 * @returns {{ vehicleNumber: string }}
 */
function extractVehicleNumber(ocrText, imageId) {
  try {
    if (!ocrText || !ocrText.trim()) {
      logger.info(
        'No OCR text available for plate extraction',
        imageId,
        PROCESSING_STEPS.PLATE_EXTRACTION
      );
      return { vehicleNumber: '' };
    }

    const candidateMap = new Map(); // candidate → best score

    // ---- Step A: Normalize base text ----
    const raw = ocrText.toUpperCase();
    const cleaned = raw.replace(/[^A-Z0-9\n]/g, ' ');

    // ---- Step B: Search individual lines (line-by-line) ----
    const lines = cleaned.split('\n');
    for (const [lineIdx, line] of lines.entries()) {
      const trimmedLine = line.trim();
      if (trimmedLine.length < 5) continue; // skip very short lines

      // For each OCR substitution variant, search the line
      for (const substitute of OCR_SUBSTITUTIONS) {
        const variant = substitute(trimmedLine).replace(/\s+/g, ' ');

        // Try strict regex
        const strictMatches = variant.matchAll(VEHICLE_NUMBER_REGEX_STRICT);
        for (const match of strictMatches) {
          const candidate = _cleanCandidate(match[0]);
          if (candidate.length >= 8) {
            const score = _scoreCandidate(candidate, lineIdx * 100);
            const existing = candidateMap.get(candidate);
            if (!existing || score > existing) {
              candidateMap.set(candidate, score);
            }
          }
        }

        // Try relaxed regex
        const relaxedMatches = variant.matchAll(VEHICLE_NUMBER_REGEX_RELAXED);
        for (const match of relaxedMatches) {
          const candidate = _cleanCandidate(match[0]);
          // Only accept relaxed matches that are close to valid format
          const letters = (candidate.match(/[A-Z]/g) || []).length;
          const digits = (candidate.match(/[0-9]/g) || []).length;
          if (candidate.length >= 8 && letters >= 3 && digits >= 4) {
            const score = _scoreCandidate(candidate, lineIdx * 100 + 50);
            const existing = candidateMap.get(candidate);
            if (!existing || score > existing) {
              candidateMap.set(candidate, score);
            }
          }
        }
      }
    }

    // ---- Step C: Search the entire combined text ----
    const combined = cleaned.replace(/\n/g, ' ');
    for (const substitute of OCR_SUBSTITUTIONS) {
      const variant = substitute(combined).replace(/\s+/g, ' ');

      const strictMatches = variant.matchAll(VEHICLE_NUMBER_REGEX_STRICT);
      for (const match of strictMatches) {
        const candidate = _cleanCandidate(match[0]);
        if (candidate.length >= 8) {
          const score = _scoreCandidate(candidate, match.index || 0);
          const existing = candidateMap.get(candidate);
          if (!existing || score > existing) {
            candidateMap.set(candidate, score);
          }
        }
      }

      const relaxedMatches = variant.matchAll(VEHICLE_NUMBER_REGEX_RELAXED);
      for (const match of relaxedMatches) {
        const candidate = _cleanCandidate(match[0]);
        const letters = (candidate.match(/[A-Z]/g) || []).length;
        const digits = (candidate.match(/[0-9]/g) || []).length;
        if (candidate.length >= 8 && letters >= 3 && digits >= 4) {
          const score = _scoreCandidate(candidate, (match.index || 0) + 25);
          const existing = candidateMap.get(candidate);
          if (!existing || score > existing) {
            candidateMap.set(candidate, score);
          }
        }
      }
    }

    // ---- Step D: Rank and select the best candidate ----
    const candidates = Array.from(candidateMap.entries())
      .sort((a, b) => b[1] - a[1]); // descending by score

    const vehicleNumber = candidates.length > 0 ? candidates[0][0] : '';

    logger.info(
      `Plate extraction: candidates=${candidates.length}, ` +
      `best="${vehicleNumber}"${candidates.length > 1 ? ', alt=["' + candidates.slice(1, 3).map(c => c[0]).join('","') + '"]' : ''}`,
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
    const valid = VEHICLE_NUMBER_REGEX_STRICT_SINGLE.test((vehicleNumber || '').toUpperCase());

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

