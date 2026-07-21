const { MAX_RETRY_COUNT } = require('../utils/constants');
const imageModel = require('../models/imageModel');
const { logger } = require('../utils/logger');

/**
 * Retry service — wraps an async function with automatic retry logic.
 *
 * @param {string} imageId - The image UUID (for logging & DB updates).
 * @param {Function} fn - Async function to execute with retry.
 * @param {Object} [options]
 * @param {number} [options.maxRetries=3] - Maximum retry attempts.
 * @param {number} [options.delayMs=1000] - Delay between retries (ms).
 * @returns {Promise<boolean>} true if succeeded, false if all retries exhausted.
 */
async function withRetry(imageId, fn, options = {}) {
  const maxRetries = options.maxRetries || MAX_RETRY_COUNT;
  const delayMs = options.delayMs || 1000;

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Record retry count in DB for every attempt > 0
      if (attempt > 0) {
        logger.info(`[Retry] Image ${imageId}: attempt ${attempt}/${maxRetries}`, imageId, 'RETRY');
        await imageModel.updateRetryCount(imageId, attempt);
      }

      // Execute the wrapped function
      await fn(imageId, attempt);

      // If we got here, it succeeded
      return true;
    } catch (err) {
      lastError = err;
      logger.error(
        `[Retry] Image ${imageId}: attempt ${attempt + 1}/${maxRetries + 1} failed - ${err.message}`,
        imageId,
        'RETRY'
      );

      if (attempt < maxRetries) {
        // Wait before retrying (exponential backoff would be better in production)
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  // All attempts exhausted — mark as permanently failed
  logger.error(
    `[Retry] Image ${imageId}: all ${maxRetries + 1} attempts failed. Last error: ${lastError.message}`,
    imageId,
    'RETRY'
  );

  try {
    await imageModel.updateAnalysis(imageId, {
      status: 'failed',
      error: `Processing failed after ${maxRetries + 1} attempts: ${lastError.message}`,
    });
  } catch (dbErr) {
    logger.error(
      `[Retry] Failed to save failure state for ${imageId}: ${dbErr.message}`,
      imageId,
      'RETRY'
    );
  }

  return false;
}

module.exports = { withRetry };

