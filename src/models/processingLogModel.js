const { getConnection } = require('../database/connection');
const { logger } = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { LOG_STATUS } = require('../utils/constants');

/**
 * Data access layer for processing_logs table.
 */
const processingLogModel = {
  /**
   * Insert a processing log entry.
   * @param {string} imageId - The image UUID.
   * @param {string} step - One of PROCESSING_STEPS enum values.
   * @param {string} status - 'STARTED' | 'SUCCESS' | 'FAILURE'.
   * @param {string} message - Human-readable log message.
   */
  logStep(imageId, step, status, message) {
    const db = getConnection();
    const id = uuidv4();
    const timestamp = new Date().toISOString();

    return new Promise((resolve, reject) => {
      const stmt = db.prepare(`
        INSERT INTO processing_logs (id, imageId, step, status, message, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(id, imageId, step, status, message, timestamp, function (err) {
        stmt.finalize();
        if (err) {
          logger.error(`Failed to insert processing log: ${err.message}`);
          return reject(err);
        }
        resolve({ id, imageId, step, status, timestamp });
      });
    });
  },

  /**
   * Convenience: log a successful step with one call (persists + prints to console).
   */
  async logSuccess(imageId, step, message) {
    const log = await this.logStep(imageId, step, LOG_STATUS.SUCCESS, message);
    logger.info(message, imageId, step);
    return log;
  },

  /**
   * Convenience: log a failure step.
   */
  async logFailure(imageId, step, message) {
    const log = await this.logStep(imageId, step, LOG_STATUS.FAILURE, message);
    logger.error(message, imageId, step);
    return log;
  },

  /**
   * Convenience: log a started step.
   */
  async logStarted(imageId, step, message) {
    const log = await this.logStep(imageId, step, LOG_STATUS.STARTED, message);
    logger.info(message, imageId, step);
    return log;
  },

  /**
   * Retrieve all logs for a given image, ordered by timestamp.
   */
  getLogs(imageId) {
    const db = getConnection();
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM processing_logs WHERE imageId = ? ORDER BY timestamp ASC',
        [imageId],
        (err, rows) => {
          if (err) {
            logger.error(`Failed to get processing logs: ${err.message}`);
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  },

  /**
   * Get aggregate job statistics.
   * Returns counts of processed and failed jobs.
   */
  getStats() {
    const db = getConnection();
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT
          COUNT(DISTINCT imageId) AS totalJobs,
          SUM(CASE WHEN step = 'PROCESSING_COMPLETED' AND status = 'SUCCESS' THEN 1 ELSE 0 END) AS processedJobs,
          SUM(CASE WHEN step = 'FAILURE' THEN 1 ELSE 0 END) AS failedJobs
        FROM processing_logs`,
        (err, row) => {
          if (err) {
            logger.error(`Failed to get job stats: ${err.message}`);
            return reject(err);
          }
          resolve({
            processedJobs: row ? (row.processedJobs || 0) : 0,
            failedJobs: row ? (row.failedJobs || 0) : 0,
            totalJobs: row ? (row.totalJobs || 0) : 0,
          });
        }
      );
    });
  },
};

module.exports = processingLogModel;

