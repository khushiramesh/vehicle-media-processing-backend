/**
 * Structured logger with step-level and image-context support.
 *
 * Two usage modes:
 *   1. logger.info('message')            — simple, backward-compatible
 *   2. logger.step('imageId', 'STEP_NAME', 'message')  — structured with context
 */

const LEVELS = Object.freeze({
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
});

function formatTimestamp() {
  return new Date().toISOString();
}

function formatMessage(level, message, imageId, step) {
  const ts = formatTimestamp();
  const imagePart = imageId ? ` [IMAGE ${imageId.substring(0, 8)}...]` : '';
  const stepPart = step ? ` ${step}` : '';
  return `[${ts}] [${level}]${imagePart}${stepPart} ${message}`;
}

const logger = {
  debug(message, imageId, step) {
    console.debug(formatMessage(LEVELS.DEBUG, message, imageId, step));
  },

  info(message, imageId, step) {
    console.info(formatMessage(LEVELS.INFO, message, imageId, step));
  },

  warn(message, imageId, step) {
    console.warn(formatMessage(LEVELS.WARN, message, imageId, step));
  },

  error(message, imageId, step) {
    console.error(formatMessage(LEVELS.ERROR, message, imageId, step));
  },

  /**
   * Convenience wrapper for step-level logging.
   * Usage: logger.step(imageId, 'STEP_NAME', 'message', 'INFO')
   */
  step(imageId, stepName, message, level = 'INFO') {
    const fn = this[level.toLowerCase()] || this.info;
    fn(message, imageId, stepName);
  },
};

/**
 * Create a step-aware logger bound to a specific imageId.
 * All log calls automatically include the image context.
 */
function createStepLogger(imageId) {
  return {
    debug: (message, step) => logger.debug(message, imageId, step),
    info: (message, step) => logger.info(message, imageId, step),
    warn: (message, step) => logger.warn(message, imageId, step),
    error: (message, step) => logger.error(message, imageId, step),
    step: (stepName, message, level) => logger.step(imageId, stepName, message, level),
  };
}

module.exports = { logger, createStepLogger };

