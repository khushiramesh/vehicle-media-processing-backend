const { handleUpload } = require('../services/uploadService');
const { logger } = require('../utils/logger');

/**
 * POST /upload
 */
async function uploadImage(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: true, message: 'No file uploaded.' });
    }

    const result = await handleUpload(req.file);

    res.status(201).json({
      id: result.id,
      status: result.status,
    });
  } catch (err) {
    logger.error('Upload controller error:', err.message);
    next(err);
  }
}

module.exports = { uploadImage };

