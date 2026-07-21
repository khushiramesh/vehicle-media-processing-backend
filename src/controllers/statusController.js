const imageModel = require('../models/imageModel');
const { logger } = require('../utils/logger');

/**
 * GET /status/:id
 */
async function getStatus(req, res, next) {
  try {
    const { id } = req.params;

    const image = await imageModel.findById(id);
    if (!image) {
      return res.status(404).json({ error: true, message: 'Image not found.' });
    }

    res.json({
      id: image.id,
      status: image.status,
    });
  } catch (err) {
    logger.error('Status controller error:', err.message);
    next(err);
  }
}

module.exports = { getStatus };

