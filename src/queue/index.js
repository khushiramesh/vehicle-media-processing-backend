const JobQueue = require('./jobQueue');
const config = require('../config');
const { processImage } = require('../services/imageAnalysisService');
const { withRetry } = require('../services/retryService');
const { logger } = require('../utils/logger');

const jobQueue = new JobQueue({
  concurrency: config.queue.concurrency,
  pollIntervalMs: config.queue.pollIntervalMs,
});

/** Track job statistics */
const jobStats = {
  processedJobs: 0,
  failedJobs: 0,
};

/**
 * Register the image analysis handler.
 * Uses retry wrapper to automatically retry on failure (up to 3 times).
 */
jobQueue.registerHandler('imageAnalysis', async (jobData) => {
  const { imageId } = jobData;

  logger.info(`Processing image analysis job for imageId: ${imageId}`);

  const succeeded = await withRetry(imageId, async (id, attempt) => {
    await processImage(id, attempt);
  });

  if (succeeded) {
    jobStats.processedJobs++;
  } else {
    jobStats.failedJobs++;
  }
});

/**
 * Enqueue an image for analysis.
 * @param {string} imageId
 */
function enqueueImageAnalysis(imageId) {
  return jobQueue.addJob('imageAnalysis', { imageId });
}

function startQueue() {
  jobQueue.start();
}

function stopQueue() {
  jobQueue.stop();
}

function getQueueLength() {
  return jobQueue.length() + jobQueue.processingCount();
}

function getJobStats() {
  return { ...jobStats };
}

module.exports = {
  jobQueue,
  enqueueImageAnalysis,
  startQueue,
  stopQueue,
  getQueueLength,
  getJobStats,
};

