const imageModel = require('../models/imageModel');
const { logger } = require('../utils/logger');

/**
 * GET /result/:id
 */
async function getResult(req, res, next) {
  try {
    const { id } = req.params;

    const image = await imageModel.findById(id);
    if (!image) {
      return res.status(404).json({ error: true, message: 'Image not found.' });
    }

    // If still processing, return current status
    if (image.status === 'pending' || image.status === 'processing') {
      return res.json({
        id: image.id,
        status: image.status,
        message: 'Analysis is still in progress. Please check back later.',
      });
    }

    // Build processing metadata
    const processing = {
      startedAt: image.processingStartedAt || null,
      completedAt: image.processingCompletedAt || null,
      timeMs: image.processingTimeMs || null,
      retryCount: image.retryCount || 0,
    };

    // Build file metadata
    const file = {
      name: image.originalName || image.filename,
      size: image.fileSize || null,
      mimeType: image.mimeType || null,
      width: image.imageWidth || null,
      height: image.imageHeight || null,
    };

    // Build analysis results
    const analysis = {
      blur: image.blur === 1,
      blurScore: image.blurScore,
      brightness: image.brightness,
      brightnessScore: image.brightnessScore,
      ocrText: image.ocrText || '',
      vehicleNumber: image.vehicleNumber || '',
      validNumberPlate: image.validNumberPlate === 1,
      duplicate: image.duplicate === 1,
      screenshot: image.screenshot === 1,
      overallConfidence: image.overallConfidence,
    };

    res.json({
      id: image.id,
      status: image.status,
      processing,
      file,
      analysisVersion: image.analysisVersion || 'v1.0.0',
      analysis,
      error: image.error || null,
    });
  } catch (err) {
    logger.error('Result controller error:', err.message);
    next(err);
  }
}

module.exports = { getResult };

