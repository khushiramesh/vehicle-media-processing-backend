const { getQueueLength, getJobStats } = require('../queue');
const processingLogModel = require('../models/processingLogModel');
const { APP_VERSION } = require('../utils/constants');
const { logger } = require('../utils/logger');

const serverStartTime = Date.now();

/**
 * Format uptime in a human-readable format (HH:MM:SS).
 */
function formatUptime(uptimeSeconds) {
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = Math.floor(uptimeSeconds % 60);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * GET /health
 */
async function getHealth(req, res) {
  try {
    const uptimeSeconds = process.uptime();
    const uptime = formatUptime(uptimeSeconds);
    const queueLength = getQueueLength();
    const stats = getJobStats();

    // Optionally supplement with DB stats for cross-validation
    let dbStats = { processedJobs: 0, failedJobs: 0 };
    try {
      dbStats = await processingLogModel.getStats();
    } catch (err) {
      logger.warn(`Health: failed to get DB stats: ${err.message}`);
    }

    res.json({
      status: 'running',
      uptime,
      uptimeSeconds: Math.floor(uptimeSeconds),
      queueLength,
      processedJobs: stats.processedJobs || dbStats.processedJobs || 0,
      failedJobs: stats.failedJobs || dbStats.failedJobs || 0,
      version: APP_VERSION,
    });
  } catch (err) {
    logger.error('Health controller error:', err.message);
    res.status(500).json({
      status: 'error',
      message: err.message,
    });
  }
}

module.exports = { getHealth };

