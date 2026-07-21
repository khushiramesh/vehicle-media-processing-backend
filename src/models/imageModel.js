const { getConnection } = require('../database/connection');
const { logger } = require('../utils/logger');

const imageModel = {
  /**
   * Insert a new image record.
   */
  create(image) {
    const db = getConnection();
    const stmt = db.prepare(`
      INSERT INTO images (id, filename, status, uploadTime)
      VALUES (?, ?, ?, ?)
    `);
    return new Promise((resolve, reject) => {
      stmt.run(image.id, image.filename, image.status, image.uploadTime, function (err) {
        stmt.finalize();
        if (err) {
          logger.error('Failed to insert image record:', err.message);
          return reject(err);
        }
        resolve({ id: image.id, status: image.status });
      });
    });
  },

  /**
   * Update image record with file metadata (size, dimensions, mime type, etc.)
   * Called after upload is complete and Sharp metadata is available.
   */
  updateFileMetadata(id, metadata) {
    const db = getConnection();
    const {
      fileSize,
      imageWidth,
      imageHeight,
      mimeType,
      extension,
      originalName,
    } = metadata;

    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE images SET
          fileSize = ?,
          imageWidth = ?,
          imageHeight = ?,
          mimeType = ?,
          extension = ?,
          originalName = ?
        WHERE id = ?`,
        [
          fileSize ?? null,
          imageWidth ?? null,
          imageHeight ?? null,
          mimeType ?? null,
          extension ?? null,
          originalName ?? null,
          id,
        ],
        function (err) {
          if (err) {
            logger.error('Failed to update file metadata:', err.message);
            return reject(err);
          }
          resolve({ changes: this.changes });
        }
      );
    });
  },

  /**
   * Update processing timing information.
   */
  updateProcessingTiming(id, timing) {
    const db = getConnection();
    const { processingStartedAt, processingCompletedAt, processingTimeMs } = timing;

    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE images SET
          processingStartedAt = ?,
          processingCompletedAt = ?,
          processingTimeMs = ?
        WHERE id = ?`,
        [
          processingStartedAt ?? null,
          processingCompletedAt ?? null,
          processingTimeMs ?? null,
          id,
        ],
        function (err) {
          if (err) {
            logger.error('Failed to update processing timing:', err.message);
            return reject(err);
          }
          resolve({ changes: this.changes });
        }
      );
    });
  },

  /**
   * Update retry count for an image.
   */
  updateRetryCount(id, count) {
    const db = getConnection();
    return new Promise((resolve, reject) => {
      db.run(
        'UPDATE images SET retryCount = ? WHERE id = ?',
        [count, id],
        function (err) {
          if (err) {
            logger.error('Failed to update retry count:', err.message);
            return reject(err);
          }
          resolve({ changes: this.changes });
        }
      );
    });
  },

  /**
   * Find an image by its ID.
   */
  findById(id) {
    const db = getConnection();
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM images WHERE id = ?', [id], (err, row) => {
        if (err) {
          logger.error('Failed to find image by ID:', err.message);
          return reject(err);
        }
        resolve(row || null);
      });
    });
  },

  /**
   * Find an image by its SHA256 hash.
   * Used for duplicate detection.
   */
  findByHash(hash) {
    const db = getConnection();
    return new Promise((resolve, reject) => {
      db.get('SELECT id, imageHash FROM images WHERE imageHash = ?', [hash], (err, row) => {
        if (err) {
          logger.error('Failed to find image by hash:', err.message);
          return reject(err);
        }
        resolve(row || null);
      });
    });
  },

  /**
   * Update the status of an image record.
   */
  updateStatus(id, status) {
    const db = getConnection();
    return new Promise((resolve, reject) => {
      db.run('UPDATE images SET status = ? WHERE id = ?', [status, id], function (err) {
        if (err) {
          logger.error('Failed to update image status:', err.message);
          return reject(err);
        }
        resolve({ changes: this.changes });
      });
    });
  },

  /**
   * Update the full analysis result for an image.
   * Supports both old (partial) and new (full) analysis data shapes.
   */
  updateAnalysis(id, analysisData) {
    const db = getConnection();
    const {
      blurScore,
      blur,
      brightness,
      brightnessScore,
      ocrText,
      vehicleNumber,
      validNumberPlate,
      duplicate,
      screenshot,
      imageHash,
      overallConfidence,
      analysisVersion,
      error,
      status,
    } = analysisData;

    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE images SET
          status = ?,
          blurScore = ?,
          blur = ?,
          brightness = ?,
          brightnessScore = ?,
          ocrText = ?,
          vehicleNumber = ?,
          validNumberPlate = ?,
          duplicate = ?,
          screenshot = ?,
          imageHash = ?,
          overallConfidence = ?,
          analysisVersion = COALESCE(?, analysisVersion),
          error = ?
        WHERE id = ?`,
        [
          status || 'completed',
          blurScore ?? null,
          blur ?? null,
          brightness ?? null,
          brightnessScore ?? null,
          ocrText ?? null,
          vehicleNumber ?? null,
          validNumberPlate ?? null,
          duplicate ?? 0,
          screenshot ?? 0,
          imageHash ?? null,
          overallConfidence ?? null,
          analysisVersion ?? null,
          error ?? null,
          id,
        ],
        function (err) {
          if (err) {
            logger.error('Failed to update analysis:', err.message);
            return reject(err);
          }
          resolve({ changes: this.changes });
        }
      );
    });
  },
};

module.exports = imageModel;

