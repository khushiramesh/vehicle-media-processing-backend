const { logger } = require('../utils/logger');

/**
 * Simple in-memory background job queue.
 *
 * @class JobQueue
 */
class JobQueue {
  constructor(options = {}) {
    this.queue = [];
    this.processing = new Set();
    this.concurrency = options.concurrency || 2;
    this.pollIntervalMs = options.pollIntervalMs || 500;
    this.handlers = new Map();
    this._intervalId = null;
  }

  /**
   * Register a handler for a specific job type.
   * @param {string} type - The job type.
   * @param {Function} handler - Async function(jobData) to process the job.
   */
  registerHandler(type, handler) {
    if (typeof handler !== 'function') {
      throw new Error('Handler must be a function');
    }
    this.handlers.set(type, handler);
    logger.info(`Handler registered for job type: ${type}`);
  }

  /**
   * Add a job to the queue.
   * @param {string} type - The job type.
   * @param {*} data - The job payload.
   * @returns {string} jobId
   */
  addJob(type, data) {
    const job = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      data,
      createdAt: new Date().toISOString(),
    };
    this.queue.push(job);
    logger.debug(`Job added to queue: ${job.id} (${type})`);
    return job.id;
  }

  /**
   * Get the current queue length.
   */
  length() {
    return this.queue.length;
  }

  /**
   * Get the number of jobs currently being processed.
   */
  processingCount() {
    return this.processing.size;
  }

  /**
   * Start processing jobs from the queue.
   */
  start() {
    if (this._intervalId) {
      logger.warn('Job queue is already running.');
      return;
    }

    logger.info(`Job queue started (concurrency=${this.concurrency})`);

    this._intervalId = setInterval(() => {
      this._processNext();
    }, this.pollIntervalMs);
  }

  /**
   * Stop processing jobs.
   */
  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
      logger.info('Job queue stopped.');
    }
  }

  /**
   * Internal: process the next batch of jobs.
   */
  _processNext() {
    const available = this.concurrency - this.processing.size;

    for (let i = 0; i < available; i++) {
      if (this.queue.length === 0) break;

      const job = this.queue.shift();
      this.processing.add(job.id);

      const handler = this.handlers.get(job.type);
      if (!handler) {
        logger.error(`No handler registered for job type: ${job.type}`);
        this.processing.delete(job.id);
        continue;
      }

      handler(job.data)
        .then(() => {
          logger.debug(`Job completed: ${job.id} (${job.type})`);
        })
        .catch((err) => {
          logger.error(`Job failed: ${job.id} (${job.type}) - ${err.message}`);
        })
        .finally(() => {
          this.processing.delete(job.id);
        });
    }
  }
}

module.exports = JobQueue;

